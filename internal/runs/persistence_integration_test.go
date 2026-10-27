package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPersistentExecutionDomainRoundTripAndFencing(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)

	sessionStore := sessions.NewStore(db.Pool())
	runStore := NewStore(db.Pool())
	approvalStore := approvals.NewStore(db.Pool())
	session, err := sessionStore.Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        "1",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if session.State != protocol.SessionStateStarting || session.Generation != "1" {
		t.Fatalf("created session = %+v", session)
	}

	runCommand := protocol.Command{
		CommandID: ids.command,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"persist this"}`),
		SessionID: ids.session,
	}
	runIntent := CommandIntent{Command: runCommand, Generation: "1", ReceivedAt: "2026-10-25T00:00:00Z"}
	accepted, run, err := runStore.AcceptRun(ctx, runIntent, NewRunInput{
		ID:         ids.run,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: "1",
	})
	if err != nil {
		t.Fatalf("accept run: %v", err)
	}
	if accepted.Deduplicated || accepted.Record.State != protocol.CommandStateAccepted || run.Status != protocol.RunStatusPending {
		t.Fatalf("first acceptance = %+v, run = %+v", accepted, run)
	}
	duplicate, duplicateRun, err := runStore.AcceptRun(ctx, runIntent, NewRunInput{
		ID:         ids.run,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: "1",
	})
	if err != nil {
		t.Fatalf("duplicate accept run: %v", err)
	}
	if !duplicate.Deduplicated || duplicate.Record.Digest != accepted.Record.Digest || duplicateRun.ID != run.ID {
		t.Fatalf("duplicate acceptance = %+v, run = %+v", duplicate, duplicateRun)
	}

	runID := ids.run
	event, err := runStore.ApplyEvent(ctx, "1", protocol.Event{
		SessionID: ids.session,
		RunID:     &runID,
		Type:      protocol.EventTypeRunStarted,
		Source:    protocol.EventSourceHostObservation,
		Payload:   json.RawMessage(`{"turn":"started","unknown_field":42}`),
	})
	if err != nil {
		t.Fatalf("apply run started event: %v", err)
	}
	duplicateEvent, err := runStore.ApplyEvent(ctx, "1", protocol.Event{
		SessionID: ids.session,
		RunID:     &runID,
		EventID:   event.EventID,
		Cursor:    event.Cursor,
		Type:      event.Type,
		Source:    event.Source,
		Payload:   event.Payload,
	})
	if err != nil {
		t.Fatalf("duplicate event: %v", err)
	}
	if duplicateEvent.Sequence != event.Sequence || duplicateEvent.Cursor != event.Cursor {
		t.Fatalf("duplicate event = %+v, original = %+v", duplicateEvent, event)
	}
	page, err := runStore.ReadEvents(ctx, protocol.EventQuery{SessionID: ids.session, RunID: ids.run, Limit: 10})
	if err != nil {
		t.Fatalf("read events: %v", err)
	}
	if len(page.Events) != 1 || string(page.Events[0].Payload) != string(event.Payload) {
		t.Fatalf("event page = %+v", page)
	}
	started, err := runStore.GetRun(ctx, ids.run)
	if err != nil {
		t.Fatalf("read started run: %v", err)
	}
	if started.Status != protocol.RunStatusRunning || started.StartedAt == "" {
		t.Fatalf("started run = %+v", started)
	}
	if _, err := runStore.ObserveTerminal(ctx, ids.run, "1", protocol.RunStatusCompleted, event.Cursor, "done"); err != nil {
		t.Fatalf("complete run: %v", err)
	}

	unknownCommand := protocol.Command{
		CommandID: ids.unknownCommand,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"ambiguous"}`),
		SessionID: ids.session,
	}
	if _, err := runStore.Accept(ctx, CommandIntent{Command: unknownCommand, Generation: "1"}); err != nil {
		t.Fatalf("accept unknown command: %v", err)
	}
	unknownRun, err := runStore.CreateRun(ctx, NewRunInput{ID: ids.unknownRun, SessionID: ids.session, CommandID: ids.unknownCommand, Generation: "1"})
	if err != nil {
		t.Fatalf("create unknown run: %v", err)
	}
	if _, err := runStore.Start(ctx, unknownRun.ID, "1", "cursor-unknown-start"); err != nil {
		t.Fatalf("start unknown run: %v", err)
	}
	if _, err := runStore.MarkRunUnknown(ctx, unknownRun.ID, "1", "cursor-disconnect", "connection closed after send"); err != nil {
		t.Fatalf("mark unknown run: %v", err)
	}
	reconciled, err := runStore.ReconcileRun(ctx, unknownRun.ID, "1", Observation{
		Reconciliation: protocol.ReconciliationStateConfirmed,
		Status:         protocol.RunStatusCompleted,
		Cursor:         "cursor-recovered",
	})
	if err != nil {
		t.Fatalf("reconcile run: %v", err)
	}
	if reconciled.Status != protocol.RunStatusCompleted || reconciled.LastCursor != "cursor-recovered" {
		t.Fatalf("reconciled run = %+v", reconciled)
	}

	approval, err := approvalStore.Create(ctx, approvals.CreateRequest{
		NewInput: approvals.NewInput{
			ID:          ids.approval,
			RunID:       ids.unknownRun,
			SessionID:   ids.session,
			Generation:  "1",
			Revision:    1,
			Kind:        "command",
			RequestedAt: "2026-10-25T00:00:00Z",
		},
		Context:          json.RawMessage(`{"scope":"write"}`),
		RequestedEventID: event.EventID,
	})
	if err != nil {
		t.Fatalf("create approval: %v", err)
	}
	resolution, err := approvalStore.Resolve(ctx, approvals.ResolveRequest{
		ApprovalID: approval.ID,
		RunID:      ids.unknownRun,
		SessionID:  ids.session,
		Generation: "1",
		Request: protocol.ResolveApprovalRequest{
			CommandID: ids.approvalCommand,
			Decision:  protocol.ApprovalDecisionApprove,
			Revision:  1,
		},
	})
	if err != nil || resolution.Approval.Status != protocol.ApprovalStatusApproved {
		t.Fatalf("resolve approval = %+v, error = %v", resolution, err)
	}
	duplicateResolution, err := approvalStore.Resolve(ctx, approvals.ResolveRequest{
		ApprovalID: approval.ID,
		RunID:      ids.unknownRun,
		SessionID:  ids.session,
		Generation: "1",
		Request: protocol.ResolveApprovalRequest{
			CommandID: ids.approvalCommand,
			Decision:  protocol.ApprovalDecisionApprove,
			Revision:  1,
		},
	})
	if err != nil || !duplicateResolution.Deduplicated {
		t.Fatalf("duplicate approval resolution = %+v, error = %v", duplicateResolution, err)
	}
	_, err = approvalStore.Resolve(ctx, approvals.ResolveRequest{
		ApprovalID: approval.ID,
		RunID:      ids.unknownRun,
		SessionID:  ids.session,
		Generation: "stale",
		Request: protocol.ResolveApprovalRequest{
			CommandID: ids.approvalCommand,
			Decision:  protocol.ApprovalDecisionApprove,
			Revision:  1,
		},
	})
	if !errors.Is(err, approvals.ErrApprovalGeneration) {
		t.Fatalf("stale approval generation error = %v", err)
	}

	leaseIdentity := DurableLeaseIdentity{
		LeaseKey:           ids.lease,
		SessionID:          ids.session,
		RunID:              ids.unknownRun,
		Generation:         "1",
		OwnerID:            "owner-a",
		CandidateSourceSHA: "source-a",
		ArtifactDigest:     "artifact-a",
	}
	if _, err := runStore.AcquireLease(ctx, leaseIdentity, LeaseStoreConfig{TTL: time.Minute}); err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	if _, err := runStore.RenewLease(ctx, leaseIdentity, LeaseStoreConfig{TTL: time.Minute}); err != nil {
		t.Fatalf("renew lease: %v", err)
	}
	otherOwner := leaseIdentity
	otherOwner.OwnerID = "owner-b"
	if _, err := runStore.AcquireLease(ctx, otherOwner, LeaseStoreConfig{TTL: time.Minute}); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("same-generation lease replacement error = %v, want %v", err, ErrLeaseHeld)
	}
	differentGeneration := leaseIdentity
	differentGeneration.Generation = "2"
	differentGeneration.OwnerID = "owner-c"
	if _, err := runStore.AcquireLease(ctx, differentGeneration, LeaseStoreConfig{TTL: time.Minute}); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("different-generation lease replacement error = %v, want %v", err, ErrStaleGeneration)
	}
	if _, err := runStore.CheckLease(ctx, leaseIdentity); err != nil {
		t.Fatalf("current lease check after rejected replacement = %v", err)
	}

	db.Close()
	db = reopenExecutionDatabase(t, ctx)
	reopenedRunStore := NewStore(db.Pool())
	reopenedRun, err := reopenedRunStore.GetRun(ctx, ids.run)
	if err != nil {
		t.Fatalf("read run after reopen: %v", err)
	}
	if reopenedRun.Status != protocol.RunStatusCompleted || reopenedRun.FinishedAt == "" {
		t.Fatalf("reopened run = %+v", reopenedRun)
	}
	reopenedPage, err := reopenedRunStore.ReadEvents(ctx, protocol.EventQuery{SessionID: ids.session, RunID: ids.run, Limit: 10})
	if err != nil {
		t.Fatalf("read events after reopen: %v", err)
	}
	if len(reopenedPage.Events) != 1 || string(reopenedPage.Events[0].Payload) != string(event.Payload) {
		t.Fatalf("reopened events = %+v", reopenedPage)
	}
	storedApproval, err := approvals.NewStore(db.Pool()).Get(ctx, ids.approval)
	if err != nil {
		t.Fatalf("read approval after reopen: %v", err)
	}
	if storedApproval.Status != protocol.ApprovalStatusApproved || string(storedApproval.Context) != `{"scope":"write"}` {
		t.Fatalf("reopened approval = %+v", storedApproval)
	}
}

func TestApprovalAdmissionRejectsTerminalRunBeforeResolver(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	sessionStore := sessions.NewStore(db.Pool())
	runStore := NewStore(db.Pool())
	approvalStore := approvals.NewStore(db.Pool())
	if _, err := sessionStore.Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        "1",
	}); err != nil {
		t.Fatalf("create approval admission session: %v", err)
	}
	run, err := runStore.CreateRun(ctx, NewRunInput{ID: ids.run, SessionID: ids.session, CommandID: ids.command, Generation: "1"})
	if err != nil {
		t.Fatalf("create approval admission run: %v", err)
	}
	if _, err := runStore.Start(ctx, run.ID, "1", "approval-admission-start"); err != nil {
		t.Fatalf("start approval admission run: %v", err)
	}
	approval, err := approvalStore.Create(ctx, approvals.CreateRequest{
		NewInput: approvals.NewInput{
			ID:          ids.approval,
			RunID:       ids.run,
			SessionID:   ids.session,
			Generation:  "1",
			Revision:    1,
			Kind:        "command",
			RequestedAt: "2026-10-27T00:00:00Z",
		},
		Context: json.RawMessage(`{"scope":"write"}`),
	})
	if err != nil {
		t.Fatalf("create approval admission approval: %v", err)
	}
	runID := run.ID
	command := protocol.Command{
		CommandID: ids.approvalCommand,
		Kind:      protocol.CommandKindRunApprove,
		Payload:   json.RawMessage(fmt.Sprintf(`{"approval_id":%q}`, approval.ID)),
		RunID:     &runID,
		SessionID: ids.session,
	}
	request := approvals.ResolveRequest{
		ApprovalID: ids.approval,
		RunID:      ids.run,
		SessionID:  ids.session,
		Generation: "1",
		Request: protocol.ResolveApprovalRequest{
			CommandID: ids.approvalCommand,
			Decision:  protocol.ApprovalDecisionApprove,
			Revision:  1,
		},
	}
	terminalTx, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin terminal winner transaction: %v", err)
	}
	defer terminalTx.Rollback(context.Background())
	var blockerPID int32
	if err := terminalTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatalf("read terminal winner backend pid: %v", err)
	}
	var lockedRunID string
	if err := terminalTx.QueryRow(ctx, `SELECT id FROM execution_runs WHERE id = $1 FOR UPDATE`, ids.run).Scan(&lockedRunID); err != nil {
		t.Fatalf("lock terminal winner run: %v", err)
	}
	resolver := &countingApprovalResolver{store: approvalStore}
	result := make(chan error, 1)
	go func() {
		_, _, acceptErr := runStore.AcceptApproval(ctx, resolver, CommandIntent{Command: command, Generation: "1"}, request)
		result <- acceptErr
	}()
	if err := waitForApprovalAdmissionRunLock(ctx, db.Pool(), blockerPID); err != nil {
		t.Fatalf("wait for terminal approval admission run lock: %v", err)
	}
	if _, err := terminalTx.Exec(ctx, `
		UPDATE execution_runs
		SET status = 'completed', terminal_reason = 'terminal winner', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = $1
	`, ids.run); err != nil {
		t.Fatalf("mark terminal winner run: %v", err)
	}
	if err := terminalTx.Commit(ctx); err != nil {
		t.Fatalf("commit terminal winner transaction: %v", err)
	}
	if err := <-result; !errors.Is(err, ErrRunTerminal) {
		t.Fatalf("terminal approval admission error = %v, want %v", err, ErrRunTerminal)
	}
	if resolver.calls != 0 {
		t.Fatalf("approval resolver calls = %d, want 0", resolver.calls)
	}
	if _, err := runStore.Lookup(ctx, ids.session, ids.approvalCommand); !errors.Is(err, ErrCommandNotFound) {
		t.Fatalf("rolled-back terminal approval command lookup error = %v, want %v", err, ErrCommandNotFound)
	}
	pending, err := approvalStore.Pending(ctx, ids.session, ids.run, "1")
	if err != nil {
		t.Fatalf("read pending approval after terminal admission: %v", err)
	}
	if len(pending) != 1 || pending[0].ID != ids.approval {
		t.Fatalf("pending approval after terminal admission = %+v", pending)
	}
}

func TestApprovalAdmissionDuplicateAcceptedSurvivesTerminalRun(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	sessionStore := sessions.NewStore(db.Pool())
	runStore := NewStore(db.Pool())
	approvalStore := approvals.NewStore(db.Pool())
	if _, err := sessionStore.Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        "1",
	}); err != nil {
		t.Fatalf("create duplicate approval session: %v", err)
	}
	run, err := runStore.CreateRun(ctx, NewRunInput{ID: ids.run, SessionID: ids.session, CommandID: ids.command, Generation: "1"})
	if err != nil {
		t.Fatalf("create duplicate approval run: %v", err)
	}
	if _, err := runStore.Start(ctx, run.ID, "1", "duplicate-approval-start"); err != nil {
		t.Fatalf("start duplicate approval run: %v", err)
	}
	approval, err := approvalStore.Create(ctx, approvals.CreateRequest{
		NewInput: approvals.NewInput{
			ID:          ids.approval,
			RunID:       ids.run,
			SessionID:   ids.session,
			Generation:  "1",
			Revision:    1,
			Kind:        "command",
			RequestedAt: "2026-10-27T00:00:00Z",
		},
		Context: json.RawMessage(`{"scope":"write"}`),
	})
	if err != nil {
		t.Fatalf("create duplicate approval: %v", err)
	}
	runID := ids.run
	command := protocol.Command{
		CommandID: ids.approvalCommand,
		Kind:      protocol.CommandKindRunApprove,
		Payload:   json.RawMessage(fmt.Sprintf(`{"approval_id":%q}`, approval.ID)),
		RunID:     &runID,
		SessionID: ids.session,
	}
	request := approvals.ResolveRequest{
		ApprovalID: ids.approval,
		RunID:      ids.run,
		SessionID:  ids.session,
		Generation: "1",
		Request: protocol.ResolveApprovalRequest{
			CommandID: ids.approvalCommand,
			Decision:  protocol.ApprovalDecisionApprove,
			Revision:  1,
		},
	}
	resolver := &countingApprovalResolver{store: approvalStore}
	accepted, _, err := runStore.AcceptApproval(ctx, resolver, CommandIntent{Command: command, Generation: "1"}, request)
	if err != nil {
		t.Fatalf("accept approval before terminal run: %v", err)
	}
	if accepted.Deduplicated || accepted.Record.State != protocol.CommandStateAccepted || resolver.calls != 1 {
		t.Fatalf("first approval acceptance = %+v, resolver calls = %d", accepted, resolver.calls)
	}
	if _, err := runStore.Transition(ctx, command.CommandID, "1", protocol.CommandStateExecuting, "", nil, nil); err != nil {
		t.Fatalf("transition accepted approval to executing: %v", err)
	}
	if _, err := runStore.ObserveTerminal(ctx, ids.run, "1", protocol.RunStatusCompleted, "duplicate-approval-terminal", "done"); err != nil {
		t.Fatalf("complete duplicate approval run: %v", err)
	}

	duplicate, _, err := runStore.AcceptApproval(ctx, resolver, CommandIntent{Command: command, Generation: "1"}, request)
	if err != nil {
		t.Fatalf("duplicate accepted approval after terminal run: %v", err)
	}
	if !duplicate.Deduplicated || duplicate.Record.State != protocol.CommandStateExecuting || resolver.calls != 1 {
		t.Fatalf("duplicate terminal approval = %+v, resolver calls = %d", duplicate, resolver.calls)
	}

	newCommand := command
	newCommand.CommandID = ids.approvalCommand + "-new"
	newRequest := request
	newRequest.Request.CommandID = newCommand.CommandID
	if _, _, err := runStore.AcceptApproval(ctx, resolver, CommandIntent{Command: newCommand, Generation: "1"}, newRequest); !errors.Is(err, ErrRunTerminal) {
		t.Fatalf("new approval command after terminal run error = %v, want %v", err, ErrRunTerminal)
	}
	if resolver.calls != 1 {
		t.Fatalf("resolver calls after new terminal command = %d, want 1", resolver.calls)
	}
	if _, err := runStore.Lookup(ctx, ids.session, newCommand.CommandID); !errors.Is(err, ErrCommandNotFound) {
		t.Fatalf("new terminal approval command lookup error = %v, want %v", err, ErrCommandNotFound)
	}
}

type countingApprovalResolver struct {
	store *approvals.Store
	calls int
}

func (r *countingApprovalResolver) ResolveTx(ctx context.Context, tx pgx.Tx, request approvals.ResolveRequest) (approvals.Resolution, error) {
	r.calls++
	return r.store.ResolveTx(ctx, tx, request)
}

func TestPersistentApprovalRequestedEventAtomicity(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	sessionStore := sessions.NewStore(db.Pool())
	runStore := NewStore(db.Pool())
	approvalStore := approvals.NewStore(db.Pool())
	if _, err := sessionStore.Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        "1",
	}); err != nil {
		t.Fatalf("create approval event session: %v", err)
	}
	run, err := runStore.CreateRun(ctx, NewRunInput{
		ID:         ids.run,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: "1",
	})
	if err != nil {
		t.Fatalf("create approval event run: %v", err)
	}
	if _, err := runStore.Start(ctx, run.ID, "1", "cursor-started"); err != nil {
		t.Fatalf("start approval event run: %v", err)
	}

	runID := run.ID
	event := protocol.Event{
		Cursor:    ids.approval + "-cursor",
		EventID:   ids.approval + "-event",
		Payload:   json.RawMessage(`{"approval":{"kind":"command"},"unknown":{"keep":true}}`),
		RunID:     &runID,
		SessionID: ids.session,
		Source:    protocol.EventSourceAppServer,
		Type:      protocol.EventTypeApprovalRequested,
	}
	request := approvals.CreateRequest{
		NewInput: approvals.NewInput{
			ID:          ids.approval,
			RunID:       run.ID,
			SessionID:   ids.session,
			Generation:  "1",
			Revision:    1,
			Kind:        "command",
			Summary:     "write approval",
			RequestedAt: "2026-10-25T00:00:00Z",
		},
		Context:          json.RawMessage(`{"scope":"write","opaque":{"keep":true}}`),
		RequestedEventID: event.EventID,
	}
	persistedEvent, approval, err := runStore.ApplyApprovalRequestedEvent(ctx, "1", event, request)
	if err != nil {
		t.Fatalf("apply approval requested event: %v", err)
	}
	if persistedEvent.EventID != event.EventID || string(persistedEvent.Payload) != string(event.Payload) {
		t.Fatalf("persisted approval event = %+v", persistedEvent)
	}
	if approval.ID != request.ID || approval.RequestedEventID != event.EventID {
		t.Fatalf("created approval = %+v", approval)
	}
	storedRun, err := runStore.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("read waiting approval run: %v", err)
	}
	if storedRun.Status != protocol.RunStatusWaitingApproval || storedRun.LastCursor != event.Cursor {
		t.Fatalf("waiting approval run = %+v", storedRun)
	}
	page, err := runStore.ReadEvents(ctx, protocol.EventQuery{SessionID: ids.session, RunID: run.ID, Limit: 10})
	if err != nil {
		t.Fatalf("read approval events: %v", err)
	}
	if len(page.Events) != 1 || string(page.Events[0].Payload) != string(event.Payload) {
		t.Fatalf("approval event page = %+v", page)
	}

	duplicateEvent, duplicateApproval, err := runStore.ApplyApprovalRequestedEvent(ctx, "1", event, request)
	if err != nil {
		t.Fatalf("duplicate approval requested event: %v", err)
	}
	if duplicateEvent.EventID != event.EventID || duplicateApproval.ID != approval.ID {
		t.Fatalf("duplicate approval event = %+v, approval = %+v", duplicateEvent, duplicateApproval)
	}
	pending, err := approvalStore.Pending(ctx, ids.session, run.ID, "1")
	if err != nil {
		t.Fatalf("list pending approvals after duplicate: %v", err)
	}
	if len(pending) != 1 || pending[0].ID != approval.ID {
		t.Fatalf("pending approvals after duplicate = %+v", pending)
	}
	differentApproval := request
	differentApproval.ID = ids.approval + "-duplicate-id"
	if _, _, err := runStore.ApplyApprovalRequestedEvent(ctx, "1", event, differentApproval); !errors.Is(err, approvals.ErrApprovalContext) {
		t.Fatalf("duplicate event with different approval identity = %v, want %v", err, approvals.ErrApprovalContext)
	}
	pending, err = approvalStore.Pending(ctx, ids.session, run.ID, "1")
	if err != nil {
		t.Fatalf("list pending approvals after conflicting duplicate: %v", err)
	}
	if len(pending) != 1 || pending[0].ID != approval.ID {
		t.Fatalf("pending approvals after conflicting duplicate = %+v", pending)
	}

	rollbackRunID := ids.run + "-rollback"
	rollbackRun, err := runStore.CreateRun(ctx, NewRunInput{
		ID:         rollbackRunID,
		SessionID:  ids.session,
		CommandID:  ids.command + "-rollback",
		Generation: "1",
	})
	if err != nil {
		t.Fatalf("create rollback run: %v", err)
	}
	if _, err := runStore.Start(ctx, rollbackRun.ID, "1", "cursor-rollback-started"); err != nil {
		t.Fatalf("start rollback run: %v", err)
	}
	rollbackRunIDCopy := rollbackRun.ID
	rollbackEvent := event
	rollbackEvent.EventID = ids.approval + "-rollback-event"
	rollbackEvent.Cursor = ids.approval + "-rollback-cursor"
	rollbackEvent.RunID = &rollbackRunIDCopy
	rollbackRequest := request
	rollbackRequest.NewInput.RunID = rollbackRun.ID
	rollbackRequest.RequestedEventID = rollbackEvent.EventID
	if _, _, err := runStore.ApplyApprovalRequestedEvent(ctx, "1", rollbackEvent, rollbackRequest); !errors.Is(err, approvals.ErrApprovalContext) {
		t.Fatalf("approval persistence conflict = %v, want %v", err, approvals.ErrApprovalContext)
	}
	rollbackStored, err := runStore.GetRun(ctx, rollbackRun.ID)
	if err != nil {
		t.Fatalf("read rollback run: %v", err)
	}
	if rollbackStored.Status != protocol.RunStatusRunning {
		t.Fatalf("rollback run after rejected approval = %+v", rollbackStored)
	}
	rollbackPage, err := runStore.ReadEvents(ctx, protocol.EventQuery{SessionID: ids.session, RunID: rollbackRun.ID, Limit: 10})
	if err != nil {
		t.Fatalf("read rolled back approval events: %v", err)
	}
	if len(rollbackPage.Events) != 0 {
		t.Fatalf("rolled back approval events = %+v", rollbackPage.Events)
	}

	staleEvent := event
	staleEvent.EventID = ids.approval + "-stale-event"
	staleEvent.Cursor = ids.approval + "-stale-cursor"
	staleRequest := request
	staleRequest.NewInput.ID = ids.approval + "-stale"
	staleRequest.NewInput.Generation = "stale"
	staleRequest.RequestedEventID = staleEvent.EventID
	if _, _, err := runStore.ApplyApprovalRequestedEvent(ctx, "stale", staleEvent, staleRequest); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale approval event generation = %v, want %v", err, ErrStaleGeneration)
	}
	stalePage, err := runStore.ReadEvents(ctx, protocol.EventQuery{SessionID: ids.session, RunID: run.ID, Limit: 10})
	if err != nil {
		t.Fatalf("read stale approval events: %v", err)
	}
	if len(stalePage.Events) != 1 {
		t.Fatalf("stale approval events = %+v", stalePage.Events)
	}

	identityEvent := event
	identityEvent.EventID = ids.approval + "-identity-event"
	identityEvent.Cursor = ids.approval + "-identity-cursor"
	identityRequest := request
	identityRequest.NewInput.ID = ids.approval + "-identity"
	identityRequest.NewInput.RunID = rollbackRun.ID
	identityRequest.RequestedEventID = identityEvent.EventID
	if _, _, err := runStore.ApplyApprovalRequestedEvent(ctx, "1", identityEvent, identityRequest); !errors.Is(err, approvals.ErrApprovalContext) {
		t.Fatalf("approval identity conflict = %v, want %v", err, approvals.ErrApprovalContext)
	}

	resolveStart := make(chan struct{})
	resolveErrors := make(chan error, 2)
	go func() {
		<-resolveStart
		_, _, err := runStore.ApplyApprovalRequestedEvent(ctx, "1", event, request)
		resolveErrors <- err
	}()
	go func() {
		<-resolveStart
		_, err := approvalStore.Resolve(ctx, approvals.ResolveRequest{
			ApprovalID: approval.ID,
			RunID:      run.ID,
			SessionID:  ids.session,
			Generation: "1",
			Request: protocol.ResolveApprovalRequest{
				CommandID: ids.approvalCommand,
				Decision:  protocol.ApprovalDecisionApprove,
				Revision:  1,
			},
		})
		resolveErrors <- err
	}()
	close(resolveStart)
	for range 2 {
		if err := <-resolveErrors; err != nil {
			t.Fatalf("concurrent approval event and resolve: %v", err)
		}
	}
	resolved, err := approvalStore.Get(ctx, approval.ID)
	if err != nil {
		t.Fatalf("read concurrently resolved approval: %v", err)
	}
	if resolved.Status != protocol.ApprovalStatusApproved {
		t.Fatalf("concurrently resolved approval = %+v", resolved)
	}
}

func TestPersistentUnknownRunRetainsLateNativeFacts(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	runStore, approvalStore, runID := createApprovalResumeFixture(t, ctx, db, ids, false)
	if _, err := runStore.MarkRunUnknown(ctx, runID, "1", ids.run+"-unknown-cursor", "connection closed after native start"); err != nil {
		t.Fatalf("mark run unknown: %v", err)
	}

	runIDCopy := runID
	lateStart := protocol.Event{
		EventID:   ids.run + "-late-start-event",
		Cursor:    ids.run + "-late-start-cursor",
		Payload:   json.RawMessage(`{"threadId":"native-thread-late"}`),
		RunID:     &runIDCopy,
		SessionID: ids.session,
		Source:    protocol.EventSourceAppServer,
		Type:      protocol.EventTypeRunStarted,
	}
	persistedStart, err := runStore.ApplyEvent(ctx, "1", lateStart)
	if err != nil {
		t.Fatalf("persist late native start: %v", err)
	}
	if persistedStart.EventID != lateStart.EventID {
		t.Fatalf("persisted late start = %+v", persistedStart)
	}

	lateApproval := protocol.Event{
		EventID:   ids.approval + "-late-requested-event",
		Cursor:    ids.approval + "-late-requested-cursor",
		Payload:   json.RawMessage(`{"approval":{"kind":"command","late":true}}`),
		RunID:     &runIDCopy,
		SessionID: ids.session,
		Source:    protocol.EventSourceAppServer,
		Type:      protocol.EventTypeApprovalRequested,
	}
	approvalRequest := approvals.CreateRequest{
		NewInput: approvals.NewInput{
			ID:          ids.approval,
			RunID:       runID,
			SessionID:   ids.session,
			Generation:  "1",
			Revision:    1,
			Kind:        "command",
			Summary:     "late native approval",
			RequestedAt: "2026-10-28T00:00:00Z",
		},
		Context:          json.RawMessage(`{"scope":"late-write"}`),
		RequestedEventID: lateApproval.EventID,
	}
	persistedApprovalEvent, approval, err := runStore.ApplyApprovalRequestedEvent(ctx, "1", lateApproval, approvalRequest)
	if err != nil {
		t.Fatalf("persist late approval request: %v", err)
	}
	if persistedApprovalEvent.EventID != lateApproval.EventID || approval.ID != approvalRequest.ID || approval.Status != protocol.ApprovalStatusPending {
		t.Fatalf("persisted late approval = event=%+v approval=%+v", persistedApprovalEvent, approval)
	}

	if _, err := runStore.ApplyEvent(ctx, "1", lateStart); err != nil {
		t.Fatalf("deduplicate late native start: %v", err)
	}
	if _, _, err := runStore.ApplyApprovalRequestedEvent(ctx, "1", lateApproval, approvalRequest); err != nil {
		t.Fatalf("deduplicate late approval request: %v", err)
	}
	storedRun, err := runStore.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("read unknown run after late facts: %v", err)
	}
	if storedRun.Status != protocol.RunStatusUnknown || storedRun.LastCursor != ids.run+"-unknown-cursor" {
		t.Fatalf("late facts reopened run = %+v", storedRun)
	}
	storedApproval, err := approvalStore.Get(ctx, approval.ID)
	if err != nil {
		t.Fatalf("read late approval: %v", err)
	}
	if storedApproval.Status != protocol.ApprovalStatusPending || string(storedApproval.Context) != `{"scope":"late-write"}` {
		t.Fatalf("late approval after replay = %+v", storedApproval)
	}
	eventsPage, err := runStore.ReadEvents(ctx, protocol.EventQuery{SessionID: ids.session, RunID: runID, Limit: 10})
	if err != nil {
		t.Fatalf("read late native facts: %v", err)
	}
	if len(eventsPage.Events) != 2 || eventsPage.Events[0].EventID != lateStart.EventID || eventsPage.Events[1].EventID != lateApproval.EventID {
		t.Fatalf("late native facts = %+v", eventsPage.Events)
	}
}

func TestPersistentApprovalResolvedResumesOnlyFromNativeEvidence(t *testing.T) {
	t.Run("native running fact and no pending approvals", func(t *testing.T) {
		db := openExecutionDatabase(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ids := executionTestIDs()
		cleanupExecutionRows(t, &db, ids)
		runStore, approvalStore, runID := createApprovalResumeFixture(t, ctx, db, ids, true)
		approval := applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, ids.approval, ids.approval+"-requested")
		resolveApprovalResumeFixture(t, ctx, approvalStore, approval.ID, runID, ids.session, "1", ids.approvalCommand)
		applyApprovalResolvedResumeEvent(t, ctx, runStore, ids.session, runID, ids.approval+"-resolved", "accept")
		stored, err := runStore.GetRun(ctx, runID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status != protocol.RunStatusRunning || stored.LastCursor != ids.approval+"-resolved-cursor" {
			t.Fatalf("resumed run = %+v, want running at resolved cursor", stored)
		}
	})

	t.Run("approval callback without native running fact stays waiting", func(t *testing.T) {
		db := openExecutionDatabase(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ids := executionTestIDs()
		cleanupExecutionRows(t, &db, ids)
		runStore, approvalStore, runID := createApprovalResumeFixture(t, ctx, db, ids, false)
		approval := applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, ids.approval, ids.approval+"-requested")
		resolveApprovalResumeFixture(t, ctx, approvalStore, approval.ID, runID, ids.session, "1", ids.approvalCommand)
		applyApprovalResolvedResumeEvent(t, ctx, runStore, ids.session, runID, ids.approval+"-resolved", "accept")
		stored, err := runStore.GetRun(ctx, runID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status != protocol.RunStatusWaitingApproval {
			t.Fatalf("run resumed without native running fact = %+v", stored)
		}
	})

	t.Run("other pending approval keeps run waiting", func(t *testing.T) {
		db := openExecutionDatabase(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ids := executionTestIDs()
		cleanupExecutionRows(t, &db, ids)
		secondApprovalID := ids.approval + "-second"
		t.Cleanup(func() {
			if db == nil {
				return
			}
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cleanupCancel()
			if err := execApprovalProjectionMutation(cleanupCtx, db, `DELETE FROM execution_approvals WHERE id = $1`, secondApprovalID); err != nil {
				t.Errorf("cleanup second approval: %v", err)
			}
		})
		runStore, approvalStore, runID := createApprovalResumeFixture(t, ctx, db, ids, true)
		first := applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, ids.approval, ids.approval+"-first-requested")
		applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, secondApprovalID, ids.approval+"-second-requested")
		resolveApprovalResumeFixture(t, ctx, approvalStore, first.ID, runID, ids.session, "1", ids.approvalCommand)
		applyApprovalResolvedResumeEvent(t, ctx, runStore, ids.session, runID, ids.approval+"-first-resolved", "accept")
		stored, err := runStore.GetRun(ctx, runID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status != protocol.RunStatusWaitingApproval {
			t.Fatalf("run resumed with another pending approval = %+v", stored)
		}
	})

	t.Run("unconfirmed approval response keeps run waiting", func(t *testing.T) {
		db := openExecutionDatabase(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ids := executionTestIDs()
		cleanupExecutionRows(t, &db, ids)
		secondApprovalID := ids.approval + "-second"
		t.Cleanup(func() {
			if db == nil {
				return
			}
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cleanupCancel()
			if err := execApprovalProjectionMutation(cleanupCtx, db, `DELETE FROM execution_approvals WHERE id = $1`, secondApprovalID); err != nil {
				t.Errorf("cleanup second unconfirmed approval: %v", err)
			}
		})
		runStore, approvalStore, runID := createApprovalResumeFixture(t, ctx, db, ids, true)
		first := applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, ids.approval, ids.approval+"-first-requested")
		second := applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, secondApprovalID, ids.approval+"-second-requested")
		firstCommand := acceptApprovalResumeCommand(t, ctx, runStore, approvalStore, first, ids.approvalCommand)
		secondCommand := acceptApprovalResumeCommand(t, ctx, runStore, approvalStore, second, ids.approvalCommand+"-second")
		if _, err := runStore.Transition(ctx, firstCommand.CommandID, "1", protocol.CommandStateSucceeded, "first-response-succeeded", nil, nil); err != nil {
			t.Fatalf("record first native approval response: %v", err)
		}
		if _, err := runStore.MarkUnknown(ctx, secondCommand.CommandID, "1"); err != nil {
			t.Fatalf("record second native approval response unknown: %v", err)
		}

		applyApprovalResolvedResumeEvent(t, ctx, runStore, ids.session, runID, ids.approval+"-first-resolved", "accept")
		stored, err := runStore.GetRun(ctx, runID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status != protocol.RunStatusWaitingApproval {
			t.Fatalf("run resumed with an unconfirmed approval response = %+v", stored)
		}

		if _, err := runStore.Reconcile(ctx, secondCommand.CommandID, "1", CommandObservation{
			State:          protocol.CommandStateSucceeded,
			Reconciliation: protocol.ReconciliationStateConfirmed,
			EventCursor:    ids.approval + "-second-ack-cursor",
		}); err != nil {
			t.Fatalf("reconcile second native approval response: %v", err)
		}
		applyApprovalResolvedResumeEvent(t, ctx, runStore, ids.session, runID, ids.approval+"-second-resolved", "accept")
		stored, err = runStore.GetRun(ctx, runID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status != protocol.RunStatusRunning || stored.LastCursor != ids.approval+"-second-resolved-cursor" {
			t.Fatalf("run after both native approval responses = %+v", stored)
		}
	})

	t.Run("native resolution before final approval ACK converges on the late ACK", func(t *testing.T) {
		db := openExecutionDatabase(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ids := executionTestIDs()
		cleanupExecutionRows(t, &db, ids)
		secondApprovalID := ids.approval + "-second"
		t.Cleanup(func() {
			if db == nil {
				return
			}
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cleanupCancel()
			if err := execApprovalProjectionMutation(cleanupCtx, db, `DELETE FROM execution_approvals WHERE id = $1`, secondApprovalID); err != nil {
				t.Errorf("cleanup second late-ACK approval: %v", err)
			}
		})
		runStore, approvalStore, runID := createApprovalResumeFixture(t, ctx, db, ids, true)
		first := applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, ids.approval, ids.approval+"-first-requested")
		second := applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, secondApprovalID, ids.approval+"-second-requested")
		firstCommand := acceptApprovalResumeCommand(t, ctx, runStore, approvalStore, first, ids.approvalCommand)
		secondCommand := acceptApprovalResumeCommand(t, ctx, runStore, approvalStore, second, ids.approvalCommand+"-second")
		if _, err := runStore.Transition(ctx, firstCommand.CommandID, "1", protocol.CommandStateSucceeded, "first-response-succeeded", nil, nil); err != nil {
			t.Fatalf("record first native approval response: %v", err)
		}

		applyApprovalResolvedResumeEvent(t, ctx, runStore, ids.session, runID, ids.approval+"-first-resolved", "accept")
		applyApprovalResolvedResumeEvent(t, ctx, runStore, ids.session, runID, ids.approval+"-second-resolved", "accept")
		waiting, err := runStore.GetRun(ctx, runID)
		if err != nil {
			t.Fatal(err)
		}
		if waiting.Status != protocol.RunStatusWaitingApproval {
			t.Fatalf("run resumed before final approval ACK = %+v", waiting)
		}
		beforeAckEvents, err := runStore.ReadEvents(ctx, protocol.EventQuery{SessionID: ids.session, RunID: runID, Limit: 20})
		if err != nil {
			t.Fatalf("read events before final approval ACK: %v", err)
		}

		ackRunID := runID
		ack, err := runStore.RecordExactCommandAck(ctx, ids.session, protocol.CommandAck{
			CommandID: secondCommand.CommandID,
			RunID:     &ackRunID,
			State:     protocol.CommandStateSucceeded,
			EventCursor: func() *string {
				cursor := ids.approval + "-second-ack-cursor"
				return &cursor
			}(),
		})
		if err != nil {
			t.Fatalf("record final approval ACK after native resolution: %v", err)
		}
		if ack.State != protocol.CommandStateSucceeded {
			t.Fatalf("final approval ACK = %+v", ack)
		}
		resumed, err := runStore.GetRun(ctx, runID)
		if err != nil {
			t.Fatal(err)
		}
		if resumed.Status != protocol.RunStatusRunning || resumed.LastCursor != ids.approval+"-second-resolved-cursor" {
			t.Fatalf("run after late final approval ACK = %+v", resumed)
		}
		afterAckEvents, err := runStore.ReadEvents(ctx, protocol.EventQuery{SessionID: ids.session, RunID: runID, Limit: 20})
		if err != nil {
			t.Fatalf("read events after final approval ACK: %v", err)
		}
		if len(afterAckEvents.Events) != len(beforeAckEvents.Events) {
			t.Fatalf("late approval ACK changed event count from %d to %d", len(beforeAckEvents.Events), len(afterAckEvents.Events))
		}
		resolvedEvents := 0
		for _, event := range afterAckEvents.Events {
			if event.Type == protocol.EventTypeApprovalResolved {
				resolvedEvents++
			}
		}
		if resolvedEvents != 2 {
			t.Fatalf("approval resolution event count after late ACK = %d, want 2", resolvedEvents)
		}
	})

	t.Run("failed or rejected approval response does not prove native confirmation", func(t *testing.T) {
		for _, responseState := range []protocol.CommandState{protocol.CommandStateFailed, protocol.CommandStateRejected} {
			responseState := responseState
			t.Run(string(responseState), func(t *testing.T) {
				db := openExecutionDatabase(t)
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				ids := executionTestIDs()
				cleanupExecutionRows(t, &db, ids)
				secondApprovalID := ids.approval + "-second"
				t.Cleanup(func() {
					if db == nil {
						return
					}
					cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cleanupCancel()
					if err := execApprovalProjectionMutation(cleanupCtx, db, `DELETE FROM execution_approvals WHERE id = $1`, secondApprovalID); err != nil {
						t.Errorf("cleanup second terminal approval: %v", err)
					}
				})
				runStore, approvalStore, runID := createApprovalResumeFixture(t, ctx, db, ids, true)
				first := applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, ids.approval, ids.approval+"-first-requested")
				second := applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, secondApprovalID, ids.approval+"-second-requested")
				firstCommand := acceptApprovalResumeCommand(t, ctx, runStore, approvalStore, first, ids.approvalCommand)
				secondCommand := acceptApprovalResumeCommand(t, ctx, runStore, approvalStore, second, ids.approvalCommand+"-second")
				if _, err := runStore.Transition(ctx, firstCommand.CommandID, "1", protocol.CommandStateSucceeded, "first-response-succeeded", nil, nil); err != nil {
					t.Fatalf("record first native approval response: %v", err)
				}
				ackRunID := runID
				ack, err := runStore.RecordExactCommandAck(ctx, ids.session, protocol.CommandAck{
					CommandID: secondCommand.CommandID,
					RunID:     &ackRunID,
					State:     responseState,
				})
				if err != nil {
					t.Fatalf("record %s approval response: %v", responseState, err)
				}
				if ack.State != responseState {
					t.Fatalf("recorded %s approval response = %+v", responseState, ack)
				}

				applyApprovalResolvedResumeEvent(t, ctx, runStore, ids.session, runID, ids.approval+"-first-resolved", "accept")
				stored, err := runStore.GetRun(ctx, runID)
				if err != nil {
					t.Fatal(err)
				}
				if stored.Status != protocol.RunStatusWaitingApproval {
					t.Fatalf("run resumed after %s ACK without native confirmation = %+v", responseState, stored)
				}
			})
		}
	})

	t.Run("terminal run is not reopened", func(t *testing.T) {
		db := openExecutionDatabase(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ids := executionTestIDs()
		cleanupExecutionRows(t, &db, ids)
		runStore, approvalStore, runID := createApprovalResumeFixture(t, ctx, db, ids, true)
		approval := applyApprovalResumeRequest(t, ctx, runStore, ids.session, runID, ids.approval, ids.approval+"-requested")
		if _, err := runStore.ObserveTerminal(ctx, runID, "1", protocol.RunStatusCompleted, ids.approval+"-terminal-cursor", "terminal winner"); err != nil {
			t.Fatal(err)
		}
		resolveApprovalResumeFixture(t, ctx, approvalStore, approval.ID, runID, ids.session, "1", ids.approvalCommand)
		applyApprovalResolvedResumeEvent(t, ctx, runStore, ids.session, runID, ids.approval+"-resolved", "accept")
		stored, err := runStore.GetRun(ctx, runID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status != protocol.RunStatusCompleted || stored.LastCursor != ids.approval+"-terminal-cursor" {
			t.Fatalf("terminal run changed after approval callback = %+v", stored)
		}
	})
}

func createApprovalResumeFixture(t *testing.T, ctx context.Context, db *database.DB, ids executionIDs, nativeRunningFact bool) (*Store, *approvals.Store, string) {
	t.Helper()
	sessionStore := sessions.NewStore(db.Pool())
	runStore := NewStore(db.Pool())
	approvalStore := approvals.NewStore(db.Pool())
	if _, err := sessionStore.Create(ctx, sessions.NewInput{ID: ids.session, Path: protocol.SessionPathNew, ExternalThreadRef: ids.thread, Generation: "1"}); err != nil {
		t.Fatalf("create approval resume session: %v", err)
	}
	run, err := runStore.CreateRun(ctx, NewRunInput{ID: ids.run, SessionID: ids.session, CommandID: ids.command, Generation: "1"})
	if err != nil {
		t.Fatalf("create approval resume run: %v", err)
	}
	if nativeRunningFact {
		runID := run.ID
		if _, err := runStore.ApplyEvent(ctx, "1", protocol.Event{EventID: ids.run + "-started-event", Cursor: ids.run + "-started-cursor", Payload: json.RawMessage(`{"threadId":"native-thread"}`), RunID: &runID, SessionID: ids.session, Source: protocol.EventSourceAppServer, Type: protocol.EventTypeRunStarted}); err != nil {
			t.Fatalf("apply native run started event: %v", err)
		}
	} else if _, err := runStore.Start(ctx, run.ID, "1", ids.run+"-started-without-fact"); err != nil {
		t.Fatalf("start run without native fact: %v", err)
	}
	return runStore, approvalStore, run.ID
}

func applyApprovalResumeRequest(t *testing.T, ctx context.Context, runStore *Store, sessionID, runID, approvalID, eventPrefix string) approvals.Approval {
	t.Helper()
	event := protocol.Event{EventID: eventPrefix + "-event", Cursor: eventPrefix + "-cursor", Payload: json.RawMessage(`{"approval":{"kind":"command"}}`), RunID: &runID, SessionID: sessionID, Source: protocol.EventSourceAppServer, Type: protocol.EventTypeApprovalRequested}
	request := approvals.CreateRequest{NewInput: approvals.NewInput{ID: approvalID, RunID: runID, SessionID: sessionID, Generation: "1", Revision: 1, Kind: "command", Summary: "approval resume test", RequestedAt: "2026-10-28T00:00:00Z"}, Context: json.RawMessage(`{"scope":"write"}`), RequestedEventID: event.EventID}
	_, approval, err := runStore.ApplyApprovalRequestedEvent(ctx, "1", event, request)
	if err != nil {
		t.Fatalf("apply approval request %q: %v", approvalID, err)
	}
	return approval
}

func resolveApprovalResumeFixture(t *testing.T, ctx context.Context, approvalStore *approvals.Store, approvalID, runID, sessionID, generation, commandID string) {
	t.Helper()
	_, err := approvalStore.Resolve(ctx, approvals.ResolveRequest{ApprovalID: approvalID, RunID: runID, SessionID: sessionID, Generation: generation, Request: protocol.ResolveApprovalRequest{CommandID: commandID, Decision: protocol.ApprovalDecisionApprove, Revision: 1}})
	if err != nil {
		t.Fatalf("resolve approval %q: %v", approvalID, err)
	}
}

func acceptApprovalResumeCommand(t *testing.T, ctx context.Context, runStore *Store, approvalStore *approvals.Store, approval approvals.Approval, commandID string) protocol.Command {
	t.Helper()
	runID := approval.RunID
	command := protocol.Command{
		CommandID: commandID,
		Kind:      protocol.CommandKindRunApprove,
		Payload:   json.RawMessage(fmt.Sprintf(`{"approval_id":%q}`, approval.ID)),
		RunID:     &runID,
		SessionID: approval.SessionID,
	}
	request := approvals.ResolveRequest{
		ApprovalID: approval.ID,
		RunID:      approval.RunID,
		SessionID:  approval.SessionID,
		Generation: approval.Generation,
		Request: protocol.ResolveApprovalRequest{
			CommandID: commandID,
			Decision:  protocol.ApprovalDecisionApprove,
			Revision:  approval.Revision,
		},
	}
	accepted, _, err := runStore.AcceptApproval(ctx, &countingApprovalResolver{store: approvalStore}, CommandIntent{Command: command, Generation: approval.Generation}, request)
	if err != nil {
		t.Fatalf("accept approval response %q: %v", commandID, err)
	}
	if accepted.Deduplicated || accepted.Record.State != protocol.CommandStateAccepted {
		t.Fatalf("accepted approval response %q = %+v", commandID, accepted)
	}
	return command
}

func applyApprovalResolvedResumeEvent(t *testing.T, ctx context.Context, runStore *Store, sessionID, runID, eventPrefix, resolution string) {
	t.Helper()
	if _, err := runStore.ApplyEvent(ctx, "1", protocol.Event{EventID: eventPrefix + "-event", Cursor: eventPrefix + "-cursor", Payload: json.RawMessage(fmt.Sprintf(`{"params":{"resolution":%q}}`, resolution)), RunID: &runID, SessionID: sessionID, Source: protocol.EventSourceAppServer, Type: protocol.EventTypeApprovalResolved}); err != nil {
		t.Fatalf("apply approval resolved event %q: %v", eventPrefix, err)
	}
}

func TestPersistentOpaqueLeaseBindsSessionAndRun(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	secondSessionID := ids.session + "-second"
	secondRunID := ids.run + "-second"
	mismatchRunID := ids.run + "-generation-mismatch"
	t.Cleanup(func() {
		if db == nil {
			return
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := (*db).Pool().Exec(cleanupCtx, `DELETE FROM execution_control_leases WHERE lease_key = $1`, ids.lease); err != nil {
			t.Errorf("cleanup opaque lease: %v", err)
		}
		for _, runID := range []string{secondRunID, mismatchRunID} {
			if _, err := (*db).Pool().Exec(cleanupCtx, `DELETE FROM execution_runs WHERE id = $1`, runID); err != nil {
				t.Errorf("cleanup opaque lease run %q: %v", runID, err)
			}
		}
		if _, err := (*db).Pool().Exec(cleanupCtx, `DELETE FROM execution_sessions WHERE id = $1`, secondSessionID); err != nil {
			t.Errorf("cleanup opaque lease session: %v", err)
		}
	})

	const firstGeneration = "generation-codex-1"
	const secondGeneration = "generation-codex-2"
	sessionStore := sessions.NewStore(db.Pool())
	if _, err := sessionStore.Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        firstGeneration,
	}); err != nil {
		t.Fatalf("create first opaque-generation session: %v", err)
	}
	if _, err := NewStore(db.Pool()).CreateRun(ctx, NewRunInput{
		ID:         ids.run,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: firstGeneration,
	}); err != nil {
		t.Fatalf("create first opaque-generation run: %v", err)
	}
	if _, err := sessionStore.Create(ctx, sessions.NewInput{
		ID:                secondSessionID,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread + "-second",
		Generation:        secondGeneration,
	}); err != nil {
		t.Fatalf("create second opaque-generation session: %v", err)
	}
	if _, err := NewStore(db.Pool()).CreateRun(ctx, NewRunInput{
		ID:         secondRunID,
		SessionID:  secondSessionID,
		CommandID:  ids.command + "-second",
		Generation: secondGeneration,
	}); err != nil {
		t.Fatalf("create second opaque-generation run: %v", err)
	}
	if _, err := NewStore(db.Pool()).CreateRun(ctx, NewRunInput{
		ID:         mismatchRunID,
		SessionID:  ids.session,
		CommandID:  ids.command + "-generation-mismatch",
		Generation: secondGeneration,
	}); err != nil {
		t.Fatalf("create generation-mismatch run: %v", err)
	}

	store := NewStore(db.Pool())
	firstIdentity := DurableLeaseIdentity{
		LeaseKey:           ids.lease,
		SessionID:          ids.session,
		RunID:              ids.run,
		Generation:         firstGeneration,
		OwnerID:            "owner-first",
		CandidateSourceSHA: "source-first",
		ArtifactDigest:     "artifact-first",
	}
	if _, err := store.AcquireLease(ctx, firstIdentity, LeaseStoreConfig{TTL: time.Minute}); err != nil {
		t.Fatalf("acquire first opaque lease: %v", err)
	}
	leaseBoundaryCases := []struct {
		name      string
		identity  DurableLeaseIdentity
		wantError error
	}{
		{
			name: "missing session",
			identity: func() DurableLeaseIdentity {
				identity := firstIdentity
				identity.SessionID = ids.session + "-missing"
				identity.OwnerID = "owner-missing-session"
				return identity
			}(),
			wantError: ErrLeaseLost,
		},
		{
			name: "missing run",
			identity: func() DurableLeaseIdentity {
				identity := firstIdentity
				identity.RunID = ids.run + "-missing"
				identity.OwnerID = "owner-missing-run"
				return identity
			}(),
			wantError: ErrRunNotFound,
		},
		{
			name: "run belongs to another session",
			identity: func() DurableLeaseIdentity {
				identity := firstIdentity
				identity.RunID = secondRunID
				identity.OwnerID = "owner-cross-session"
				return identity
			}(),
			wantError: ErrInvalidLease,
		},
		{
			name: "session generation mismatch",
			identity: func() DurableLeaseIdentity {
				identity := firstIdentity
				identity.Generation = secondGeneration
				identity.OwnerID = "owner-session-generation-mismatch"
				return identity
			}(),
			wantError: ErrStaleGeneration,
		},
		{
			name: "run generation mismatch",
			identity: func() DurableLeaseIdentity {
				identity := firstIdentity
				identity.RunID = mismatchRunID
				identity.OwnerID = "owner-run-generation-mismatch"
				return identity
			}(),
			wantError: ErrStaleGeneration,
		},
	}
	for _, testCase := range leaseBoundaryCases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := store.AcquireLease(ctx, testCase.identity, LeaseStoreConfig{TTL: time.Minute}); !errors.Is(err, testCase.wantError) {
				t.Fatalf("boundary error = %v, want %v", err, testCase.wantError)
			}
			if _, err := store.CheckLease(ctx, firstIdentity); err != nil {
				t.Fatalf("original lease after rejected boundary case = %v", err)
			}
		})
	}
	secondIdentity := DurableLeaseIdentity{
		LeaseKey:           ids.lease,
		SessionID:          secondSessionID,
		RunID:              secondRunID,
		Generation:         secondGeneration,
		OwnerID:            "owner-second",
		CandidateSourceSHA: "source-second",
		ArtifactDigest:     "artifact-second",
	}
	if _, err := store.AcquireLease(ctx, secondIdentity, LeaseStoreConfig{TTL: time.Minute}); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("active opaque-generation lease replacement error = %v, want %v", err, ErrLeaseHeld)
	}
	if _, err := store.RenewLease(ctx, firstIdentity, LeaseStoreConfig{TTL: time.Minute}); err != nil {
		t.Fatalf("renew first opaque lease: %v", err)
	}

	if _, err := store.RenewLease(ctx, firstIdentity, LeaseStoreConfig{TTL: 20 * time.Millisecond}); err != nil {
		t.Fatalf("shorten first opaque lease: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := store.CheckLease(ctx, firstIdentity); errors.Is(err, ErrLeaseLost) {
			break
		} else if err != nil {
			t.Fatalf("check expiring first opaque lease: %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatal("first opaque lease did not expire")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := store.AcquireLease(ctx, secondIdentity, LeaseStoreConfig{TTL: time.Minute}); err != nil {
		t.Fatalf("acquire second opaque lease after expiry: %v", err)
	}
	if _, err := store.CheckLease(ctx, secondIdentity); err != nil {
		t.Fatalf("check second opaque lease after expiry: %v", err)
	}
}

func TestPersistentDistinctRunAdmissionLocksSessionBeforeForeignKeys(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	const generation = "distinct-admission-generation"

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        generation,
	}); err != nil {
		t.Fatalf("create distinct-admission session: %v", err)
	}
	store := NewStore(db.Pool())
	firstRunID := ids.run + "-distinct-a"
	secondRunID := ids.run + "-distinct-b"
	firstCommandID := ids.command + "-distinct-a"
	secondCommandID := ids.command + "-distinct-b"
	firstLeaseKey := ids.lease + "-distinct-a"
	secondLeaseKey := ids.lease + "-distinct-b"
	for _, leaseKey := range []string{firstLeaseKey, secondLeaseKey} {
		leaseKey := leaseKey
		t.Cleanup(func() {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cleanupCancel()
			if _, err := db.Pool().Exec(cleanupCtx, `DELETE FROM execution_control_leases WHERE lease_key = $1`, leaseKey); err != nil {
				t.Errorf("cleanup distinct-admission lease %q: %v", leaseKey, err)
			}
		})
	}

	blocker, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin distinct-admission blocker: %v", err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT id FROM execution_sessions WHERE id = $1 FOR UPDATE`, ids.session); err != nil {
		t.Fatalf("hold distinct-admission session lock: %v", err)
	}

	results := make(chan error, 2)
	start := func(commandID, runID, leaseKey, prompt string) {
		runIDCopy := runID
		go func() {
			_, _, err := store.AcceptRunWithLease(ctx, CommandIntent{Command: protocol.Command{
				CommandID: commandID,
				Kind:      protocol.CommandKindRunSend,
				Payload:   json.RawMessage(fmt.Sprintf(`{"prompt":%q}`, prompt)),
				RunID:     &runIDCopy,
				SessionID: ids.session,
			}, Generation: generation}, NewRunInput{
				ID:         runIDCopy,
				SessionID:  ids.session,
				CommandID:  commandID,
				Generation: generation,
			}, DurableLeaseIdentity{
				LeaseKey:           leaseKey,
				SessionID:          ids.session,
				RunID:              runIDCopy,
				Generation:         generation,
				OwnerID:            "distinct-admission-owner-" + prompt,
				CandidateSourceSHA: "distinct-admission-source-" + prompt,
				ArtifactDigest:     "distinct-admission-artifact-" + prompt,
			})
			results <- err
		}()
	}
	start(firstCommandID, firstRunID, firstLeaseKey, "first")
	start(secondCommandID, secondRunID, secondLeaseKey, "second")
	if err := waitForDistinctRunAdmissionWaiters(ctx, db.Pool()); err != nil {
		t.Fatalf("distinct admissions did not reach the session/FK lock barrier: %v", err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release distinct-admission session lock: %v", err)
	}
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatalf("distinct run admission %d: %v", i+1, err)
		}
	}

	var runCount, commandCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM execution_runs WHERE session_id = $1`, ids.session).Scan(&runCount); err != nil {
		t.Fatalf("count distinct-admission runs: %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM execution_commands WHERE session_id = $1`, ids.session).Scan(&commandCount); err != nil {
		t.Fatalf("count distinct-admission commands: %v", err)
	}
	if runCount != 2 || commandCount != 2 {
		t.Fatalf("distinct-admission rows = runs %d, commands %d; want 2 and 2", runCount, commandCount)
	}
}

func TestPersistentTransitionWithLeaseRejectsExpiredAndReplacedOwner(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	const generation = "transition-lease-fence-generation"

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        generation,
	}); err != nil {
		t.Fatalf("create transition lease session: %v", err)
	}
	store := NewStore(db.Pool())
	runID := ids.run
	intent := CommandIntent{Command: protocol.Command{
		CommandID: ids.command,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"lease fence"}`),
		RunID:     &runID,
		SessionID: ids.session,
	}, Generation: generation}
	accepted, _, err := store.AcceptRun(ctx, intent, NewRunInput{
		ID:         runID,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: generation,
	})
	if err != nil {
		t.Fatalf("accept transition lease run: %v", err)
	}

	stale := DurableLeaseIdentity{
		LeaseKey:           ids.lease,
		SessionID:          ids.session,
		RunID:              runID,
		Generation:         generation,
		OwnerID:            "transition-stale-owner",
		CandidateSourceSHA: "transition-stale-source",
		ArtifactDigest:     "transition-stale-artifact",
	}
	if _, err := store.AcquireLease(ctx, stale, LeaseStoreConfig{TTL: 20 * time.Millisecond}); err != nil {
		t.Fatalf("acquire short transition lease: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, checkErr := store.CheckLease(ctx, stale)
		if errors.Is(checkErr, ErrLeaseLost) {
			break
		}
		if checkErr != nil {
			t.Fatalf("check short transition lease: %v", checkErr)
		}
		if time.Now().After(deadline) {
			t.Fatal("short transition lease did not expire")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := store.TransitionWithLease(ctx, ids.command, generation, protocol.CommandStateExecuting, "", nil, nil, stale); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("expired transition lease error = %v, want %v", err, ErrLeaseLost)
	}
	current, err := store.Lookup(ctx, ids.session, ids.command)
	if err != nil {
		t.Fatalf("read command after expired transition lease: %v", err)
	}
	if current.State != protocol.CommandStateAccepted {
		t.Fatalf("command after expired transition lease = %q, want accepted", current.State)
	}

	replacement := stale
	replacement.OwnerID = "transition-replacement-owner"
	replacement.CandidateSourceSHA = "transition-replacement-source"
	replacement.ArtifactDigest = "transition-replacement-artifact"
	if _, err := store.AcquireLease(ctx, replacement, LeaseStoreConfig{TTL: time.Minute}); err != nil {
		t.Fatalf("acquire replacement transition lease: %v", err)
	}
	if _, err := store.TransitionWithLease(ctx, ids.command, generation, protocol.CommandStateExecuting, "", nil, nil, stale); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("replaced transition lease error = %v, want %v", err, ErrLeaseLost)
	}
	current, err = store.Lookup(ctx, ids.session, ids.command)
	if err != nil {
		t.Fatalf("read command after replaced transition lease: %v", err)
	}
	if current.State != protocol.CommandStateAccepted {
		t.Fatalf("command after replaced transition lease = %q, want accepted", current.State)
	}
	if _, err := store.TransitionWithLease(ctx, ids.command, generation, protocol.CommandStateExecuting, "", nil, nil, replacement); err != nil {
		t.Fatalf("valid replacement transition lease: %v", err)
	}
	if current, err = store.Lookup(ctx, ids.session, ids.command); err != nil {
		t.Fatalf("read command after valid transition lease: %v", err)
	} else if current.State != protocol.CommandStateExecuting {
		t.Fatalf("command after valid transition lease = %q, want executing", current.State)
	}
	if accepted.Record.State != protocol.CommandStateAccepted {
		t.Fatalf("initial accepted command = %+v", accepted.Record)
	}
}

func TestPersistentDuplicateRunAdmissionAndRecoveryUseSameLockOrder(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	const generation = "duplicate-recovery-lock-order-generation"

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        generation,
	}); err != nil {
		t.Fatalf("create duplicate-recovery session: %v", err)
	}
	store := NewStore(db.Pool())
	runID := ids.run
	intent := CommandIntent{Command: protocol.Command{
		CommandID: ids.command,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"duplicate recovery"}`),
		RunID:     &runID,
		SessionID: ids.session,
	}, Generation: generation}
	if _, _, err := store.AcceptRun(ctx, intent, NewRunInput{ID: runID, SessionID: ids.session, CommandID: ids.command, Generation: generation}); err != nil {
		t.Fatalf("accept duplicate-recovery run: %v", err)
	}
	lease := DurableLeaseIdentity{
		LeaseKey:           ids.lease,
		SessionID:          ids.session,
		RunID:              runID,
		Generation:         generation,
		OwnerID:            "duplicate-recovery-owner",
		CandidateSourceSHA: "duplicate-recovery-source",
		ArtifactDigest:     "duplicate-recovery-artifact",
	}
	if _, err := store.AcquireLease(ctx, lease, LeaseStoreConfig{TTL: time.Minute}); err != nil {
		t.Fatalf("acquire duplicate-recovery lease: %v", err)
	}

	start := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		<-start
		_, _, err := store.AcceptRunWithLease(ctx, intent, NewRunInput{ID: runID, SessionID: ids.session, CommandID: ids.command, Generation: generation}, lease)
		results <- err
	}()
	go func() {
		<-start
		_, err := store.MarkCommandAndRunUnknownWithLease(ctx, ids.command, generation, "duplicate admission recovery", lease)
		results <- err
	}()
	close(start)
	for i := 0; i < 2; i++ {
		select {
		case err := <-results:
			if err != nil {
				t.Fatalf("duplicate admission/recovery result %d: %v", i+1, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("duplicate admission and recovery did not converge")
		}
	}
	current, err := store.Lookup(ctx, ids.session, ids.command)
	if err != nil {
		t.Fatalf("read duplicate-recovery command: %v", err)
	}
	if current.State != protocol.CommandStateUnknown {
		t.Fatalf("duplicate-recovery command = %q, want unknown", current.State)
	}
}

func TestPersistentInterruptAdmissionAndEventUseSessionRunLockOrder(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	const generation = "lock-order-generation"

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        generation,
	}); err != nil {
		t.Fatalf("create lock-order session: %v", err)
	}
	store := NewStore(db.Pool())
	runID := ids.run
	if _, _, err := store.AcceptRun(ctx, CommandIntent{Command: protocol.Command{
		CommandID: ids.command,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"lock-order fixture"}`),
		RunID:     &runID,
		SessionID: ids.session,
	}, Generation: generation}, NewRunInput{
		ID:         ids.run,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: generation,
	}); err != nil {
		t.Fatalf("accept lock-order run: %v", err)
	}
	if _, err := store.Start(ctx, ids.run, generation, "cursor-start"); err != nil {
		t.Fatalf("start lock-order run: %v", err)
	}
	lease := DurableLeaseIdentity{
		LeaseKey:           ids.lease,
		SessionID:          ids.session,
		RunID:              ids.run,
		Generation:         generation,
		OwnerID:            "lock-order-owner",
		CandidateSourceSHA: "lock-order-source",
		ArtifactDigest:     "lock-order-artifact",
	}
	interruptCommand := protocol.Command{
		CommandID: ids.command + "-interrupt",
		Kind:      protocol.CommandKindRunInterrupt,
		Payload:   json.RawMessage(`{"reason":"lock-order overlap"}`),
		RunID:     &runID,
		SessionID: ids.session,
	}

	blocker, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin lock-order advisory blocker: %v", err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, lease.LeaseKey); err != nil {
		t.Fatalf("hold lock-order advisory barrier: %v", err)
	}

	acceptDone := make(chan error, 1)
	go func() {
		_, err := store.AcceptInterruptWithLease(ctx, CommandIntent{Command: interruptCommand, Generation: generation}, lease)
		acceptDone <- err
	}()
	if err := waitForExecutionAdvisoryWaiter(ctx, db.Pool(), lease.LeaseKey); err != nil {
		t.Fatalf("interrupt admission did not reach advisory barrier: %v", err)
	}

	oldOrder := false
	lockDeadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(lockDeadline) {
		locked, err := tryExecutionRowLock(ctx, db.Pool(), `SELECT 1 FROM execution_runs WHERE id = $1 FOR UPDATE NOWAIT`, ids.run)
		if err != nil {
			t.Fatalf("probe run lock order: %v", err)
		}
		if locked {
			oldOrder = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	eventDone := make(chan error, 1)
	go func() {
		_, err := store.ApplyEvent(ctx, generation, protocol.Event{
			EventID:   ids.command + "-message",
			Cursor:    "cursor-message",
			SessionID: ids.session,
			RunID:     &runID,
			Type:      protocol.EventTypeMessageDelta,
			Source:    protocol.EventSourceHostObservation,
			Payload:   json.RawMessage(`{"delta":"overlap"}`),
		})
		eventDone <- err
	}()
	if oldOrder {
		if err := waitForExecutionRowLock(ctx, db.Pool(), `SELECT 1 FROM execution_sessions WHERE id = $1 FOR UPDATE NOWAIT`, ids.session); err != nil {
			t.Fatalf("event application did not hold session before waiting on run: %v", err)
		}
	} else {
		select {
		case err := <-eventDone:
			if err != nil {
				t.Fatalf("event application blocked before interrupt admission released: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("event application did not complete while interrupt admission waited on lease advisory lock")
		}
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release lock-order advisory barrier: %v", err)
	}
	if err := <-acceptDone; err != nil {
		t.Fatalf("interrupt admission after lock-order overlap: %v", err)
	}
	if oldOrder {
		if err := <-eventDone; err != nil {
			t.Fatalf("event application after lock-order overlap: %v", err)
		}
	}

	current, err := store.GetRun(ctx, ids.run)
	if err != nil {
		t.Fatalf("read lock-order run: %v", err)
	}
	if current.Interrupt != InterruptRequested {
		t.Fatalf("lock-order run interrupt state = %q, want %q", current.Interrupt, InterruptRequested)
	}
}

func TestPersistentUnknownTransitionLocksSessionRunBeforeLeaseCheck(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	const generation = "unknown-lock-order-generation"

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        generation,
	}); err != nil {
		t.Fatalf("create unknown-transition session: %v", err)
	}
	store := NewStore(db.Pool())
	runID := ids.run
	if _, _, err := store.AcceptRun(ctx, CommandIntent{Command: protocol.Command{
		CommandID: ids.command,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"unknown lock order"}`),
		RunID:     &runID,
		SessionID: ids.session,
	}, Generation: generation}, NewRunInput{
		ID:         ids.run,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: generation,
	}); err != nil {
		t.Fatalf("accept unknown-transition run: %v", err)
	}
	lease := DurableLeaseIdentity{
		LeaseKey:           ids.lease,
		SessionID:          ids.session,
		RunID:              ids.run,
		Generation:         generation,
		OwnerID:            "unknown-lock-order-owner",
		CandidateSourceSHA: "unknown-lock-order-source",
		ArtifactDigest:     "unknown-lock-order-artifact",
	}
	if _, err := store.AcquireLease(ctx, lease, LeaseStoreConfig{TTL: time.Minute}); err != nil {
		t.Fatalf("acquire unknown-transition lease: %v", err)
	}

	leaseHolder, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin lease-row blocker: %v", err)
	}
	defer leaseHolder.Rollback(ctx)
	if _, err := leaseHolder.Exec(ctx, `SELECT lease_key FROM execution_control_leases WHERE lease_key = $1 FOR UPDATE`, lease.LeaseKey); err != nil {
		t.Fatalf("hold lease row: %v", err)
	}
	identityHolder, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin session-run blocker: %v", err)
	}
	defer identityHolder.Rollback(ctx)
	if _, err := identityHolder.Exec(ctx, `SELECT id FROM execution_sessions WHERE id = $1 FOR UPDATE`, lease.SessionID); err != nil {
		t.Fatalf("hold session row: %v", err)
	}
	if _, err := identityHolder.Exec(ctx, `SELECT id FROM execution_runs WHERE id = $1 FOR UPDATE`, lease.RunID); err != nil {
		t.Fatalf("hold run row: %v", err)
	}

	markDone := make(chan error, 1)
	go func() {
		_, err := store.MarkCommandAndRunUnknownWithLease(ctx, ids.command, generation, "unknown lock-order regression", lease)
		markDone <- err
	}()
	if err := identityHolder.Rollback(ctx); err != nil {
		t.Fatalf("release session-run blocker: %v", err)
	}
	if err := waitForExecutionRowLock(ctx, db.Pool(), `SELECT 1 FROM execution_runs WHERE id = $1 FOR UPDATE NOWAIT`, lease.RunID); err != nil {
		t.Fatalf("unknown transition did not lock session and run before waiting on lease: %v", err)
	}
	if err := leaseHolder.Rollback(ctx); err != nil {
		t.Fatalf("release lease-row blocker: %v", err)
	}
	if err := <-markDone; err != nil {
		t.Fatalf("unknown transition after lock-order overlap: %v", err)
	}
	current, err := store.GetRun(ctx, ids.run)
	if err != nil {
		t.Fatalf("read unknown-transition run: %v", err)
	}
	if current.Status != protocol.RunStatusUnknown {
		t.Fatalf("unknown-transition run status = %q, want %q", current.Status, protocol.RunStatusUnknown)
	}
}

func TestPersistentLeaseUsesDatabaseClockAfterLockWait(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	const generation = "database-clock-generation"

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        generation,
	}); err != nil {
		t.Fatalf("create database-clock session: %v", err)
	}
	if _, err := NewStore(db.Pool()).CreateRun(ctx, NewRunInput{
		ID:         ids.run,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: generation,
	}); err != nil {
		t.Fatalf("create database-clock run: %v", err)
	}
	identity := DurableLeaseIdentity{
		LeaseKey:           ids.lease,
		SessionID:          ids.session,
		RunID:              ids.run,
		Generation:         generation,
		OwnerID:            "database-clock-owner",
		CandidateSourceSHA: "database-clock-source",
		ArtifactDigest:     "database-clock-artifact",
	}
	blocker, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin database-clock advisory blocker: %v", err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, identity.LeaseKey); err != nil {
		t.Fatalf("hold database-clock advisory barrier: %v", err)
	}

	result := make(chan struct {
		lease ControlLease
		err   error
	}, 1)
	go func() {
		lease, err := NewStore(db.Pool()).AcquireLease(ctx, identity, LeaseStoreConfig{TTL: 250 * time.Millisecond})
		result <- struct {
			lease ControlLease
			err   error
		}{lease: lease, err: err}
	}()
	if err := waitForExecutionAdvisoryWaiter(ctx, db.Pool(), identity.LeaseKey); err != nil {
		t.Fatalf("lease acquisition did not reach advisory barrier: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release database-clock advisory barrier: %v", err)
	}
	acquired := <-result
	if acquired.err != nil {
		t.Fatalf("acquire lease after lock wait: %v", acquired.err)
	}
	var databaseNow time.Time
	if err := db.Pool().QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&databaseNow); err != nil {
		t.Fatalf("read database clock after lease acquisition: %v", err)
	}
	if !acquired.lease.ExpiresAt.After(databaseNow.Add(100 * time.Millisecond)) {
		t.Fatalf("lease expiry = %s, database now = %s; expiry was not based on post-lock database time", acquired.lease.ExpiresAt, databaseNow)
	}
}

func waitForExecutionAdvisoryWaiter(ctx context.Context, pool *pgxpool.Pool, leaseKey string) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pid int32
		err := pool.QueryRow(waitCtx, `
			SELECT activity.pid
			FROM pg_locks AS lock
			JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
			WHERE lock.locktype = 'advisory'
			  AND lock.mode = 'ExclusiveLock'
			  AND NOT lock.granted
			  AND lock.classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
			  AND lock.objid = (hashtext($1)::bigint & 4294967295)::oid
			  AND lock.objsubid = 1
			  AND activity.wait_event_type = 'Lock'
			  AND activity.query ILIKE '%pg_advisory_xact_lock%'
			ORDER BY activity.pid
			LIMIT 1
		`, leaseKey).Scan(&pid)
		if err == nil && pid > 0 {
			return nil
		}
		select {
		case <-waitCtx.Done():
			if err != nil {
				return err
			}
			return waitCtx.Err()
		case <-ticker.C:
		}
	}
}

func waitForDistinctRunAdmissionWaiters(ctx context.Context, pool *pgxpool.Pool) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiters int
		err := pool.QueryRow(waitCtx, `
			SELECT count(*)
			FROM pg_stat_activity AS activity
			WHERE activity.wait_event_type = 'Lock'
			  AND (
				activity.query ILIKE '%INSERT INTO execution_commands%'
				OR activity.query ILIKE '%FROM execution_sessions%FOR UPDATE%'
			  )
		`).Scan(&waiters)
		if err == nil && waiters >= 2 {
			return nil
		}
		select {
		case <-waitCtx.Done():
			if err != nil {
				return err
			}
			return waitCtx.Err()
		case <-ticker.C:
		}
	}
}

func waitForApprovalAdmissionRunLock(ctx context.Context, pool *pgxpool.Pool, blockerPID int32) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiters int
		err := pool.QueryRow(waitCtx, `
			SELECT count(*)
			FROM pg_stat_activity AS activity
			WHERE activity.wait_event_type = 'Lock'
			  AND activity.query ILIKE '%FROM execution_runs AS run%'
			  AND activity.query ILIKE '%FOR UPDATE%'
			  AND $1 = ANY(pg_blocking_pids(activity.pid))
		`, blockerPID).Scan(&waiters)
		if err == nil && waiters >= 1 {
			return nil
		}
		select {
		case <-waitCtx.Done():
			if err != nil {
				return err
			}
			return waitCtx.Err()
		case <-ticker.C:
		}
	}
}

func waitForExecutionRowLock(ctx context.Context, pool *pgxpool.Pool, query, id string) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		locked, err := tryExecutionRowLock(waitCtx, pool, query, id)
		if err != nil {
			return err
		}
		if locked {
			return nil
		}
		select {
		case <-waitCtx.Done():
			return waitCtx.Err()
		case <-ticker.C:
		}
	}
}

func tryExecutionRowLock(ctx context.Context, pool *pgxpool.Pool, query, id string) (bool, error) {
	var marker int
	err := pool.QueryRow(ctx, query, id).Scan(&marker)
	if err == nil || errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	var pgError *pgconn.PgError
	if errors.As(err, &pgError) && pgError.Code == "55P03" {
		return true, nil
	}
	return false, err
}

func TestPersistentControllerDeduplicatesAndFreezesUnknownDelivery(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        "1",
	}); err != nil {
		t.Fatalf("create controller session: %v", err)
	}

	transport := &integrationCommandTransport{ack: protocol.CommandAck{State: protocol.CommandStateSucceeded}}
	controller, err := NewController(NewStore(db.Pool()), transport, ControllerConfig{Generation: "1"})
	if err != nil {
		t.Fatalf("create controller: %v", err)
	}
	command := protocol.Command{
		CommandID: ids.command,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"one side effect"}`),
		SessionID: ids.session,
	}
	first, err := controller.AcceptCommand(ctx, command)
	if err != nil {
		t.Fatalf("first controller command: %v", err)
	}
	second, err := controller.AcceptCommand(ctx, command)
	if err != nil {
		t.Fatalf("duplicate controller command: %v", err)
	}
	if first.State != protocol.CommandStateSucceeded || second.State != protocol.CommandStateSucceeded || !second.Deduplicated || transport.calls != 1 {
		t.Fatalf("controller ACKs = first=%+v second=%+v calls=%d", first, second, transport.calls)
	}

	unknownTransport := &integrationCommandTransport{sendErr: errors.New("connection closed after send")}
	unknownController, err := NewController(NewStore(db.Pool()), unknownTransport, ControllerConfig{Generation: "1"})
	if err != nil {
		t.Fatalf("create unknown controller: %v", err)
	}
	unknownCommand := command
	unknownCommand.CommandID = ids.unknownCommand
	if _, err := unknownController.AcceptCommand(ctx, unknownCommand); !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("unknown controller error = %v, want %v", err, protocol.ErrUnknownCommandResult)
	}
	unknownRecord, err := NewStore(db.Pool()).Lookup(ctx, ids.session, ids.unknownCommand)
	if err != nil {
		t.Fatalf("lookup unknown command: %v", err)
	}
	if unknownRecord.State != protocol.CommandStateUnknown {
		t.Fatalf("unknown command record = %+v", unknownRecord)
	}
	if unknownRecord.Intent.Command.RunID == nil {
		t.Fatal("unknown command has no durable run identity")
	}
	unknownRun, err := NewStore(db.Pool()).GetRun(ctx, *unknownRecord.Intent.Command.RunID)
	if err != nil {
		t.Fatalf("lookup unknown run: %v", err)
	}
	if unknownRun.Status != protocol.RunStatusUnknown {
		t.Fatalf("unknown run = %+v", unknownRun)
	}
}

func TestPersistentControllerReconcilesOrphanedAdmissionAfterRestart(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        "1",
	}); err != nil {
		t.Fatalf("create controller session: %v", err)
	}

	command := protocol.Command{
		CommandID: ids.command,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"orphaned admission"}`),
		SessionID: ids.session,
	}
	runID := ids.run
	command.RunID = &runID
	store := NewStore(db.Pool())
	if _, _, err := store.AcceptRun(ctx, CommandIntent{Command: command, Generation: "1"}, NewRunInput{
		ID:         runID,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: "1",
	}); err != nil {
		t.Fatalf("persist admitted command: %v", err)
	}

	transport := &integrationCommandTransport{}
	controller, err := NewController(NewStore(db.Pool()), transport, ControllerConfig{Generation: "1"})
	if err != nil {
		t.Fatalf("create recovery controller: %v", err)
	}
	ack, err := controller.AcceptCommand(ctx, command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("orphaned admission error = %v, want unknown result", err)
	}
	if ack.State != protocol.CommandStateUnknown || !ack.Deduplicated {
		t.Fatalf("orphaned admission ACK = %+v", ack)
	}
	if transport.calls != 0 {
		t.Fatalf("orphaned admission sent %d native commands, want 0", transport.calls)
	}
	record, err := store.Lookup(ctx, command.SessionID, command.CommandID)
	if err != nil {
		t.Fatalf("lookup recovered command: %v", err)
	}
	if record.State != protocol.CommandStateUnknown {
		t.Fatalf("recovered command = %+v, want unknown", record)
	}
	run, err := store.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("lookup recovered run: %v", err)
	}
	if run.Status != protocol.RunStatusUnknown {
		t.Fatalf("recovered run = %+v, want unknown", run)
	}

	executingCommand := command
	executingCommand.CommandID = ids.command + "-executing"
	executingRunID := ids.run + "-executing"
	executingCommand.RunID = &executingRunID
	if _, _, err := store.AcceptRun(ctx, CommandIntent{Command: executingCommand, Generation: "1"}, NewRunInput{
		ID:         executingRunID,
		SessionID:  ids.session,
		CommandID:  executingCommand.CommandID,
		Generation: "1",
	}); err != nil {
		t.Fatalf("persist executing command: %v", err)
	}
	if _, err := store.Transition(ctx, executingCommand.CommandID, "1", protocol.CommandStateExecuting, "", nil, nil); err != nil {
		t.Fatalf("persist executing state: %v", err)
	}
	executingAck, err := controller.AcceptCommand(ctx, executingCommand)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("orphaned executing error = %v, want unknown result", err)
	}
	if executingAck.State != protocol.CommandStateUnknown || !executingAck.Deduplicated {
		t.Fatalf("orphaned executing ACK = %+v", executingAck)
	}
	if transport.calls != 0 {
		t.Fatalf("orphaned executing sent %d native commands, want 0", transport.calls)
	}
	executingRun, err := store.GetRun(ctx, executingRunID)
	if err != nil {
		t.Fatalf("lookup executing recovery run: %v", err)
	}
	if executingRun.Status != protocol.RunStatusUnknown {
		t.Fatalf("executing recovery run = %+v, want unknown", executingRun)
	}
}

func TestPersistentControllerPreservesActiveConcurrentDuplicate(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        "1",
	}); err != nil {
		t.Fatalf("create concurrent session: %v", err)
	}
	transport := newBlockingIntegrationCommandTransport()
	controller, err := NewController(NewStore(db.Pool()), transport, ControllerConfig{Generation: "1"})
	if err != nil {
		t.Fatalf("create concurrent controller: %v", err)
	}
	command := protocol.Command{
		CommandID: ids.command,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"concurrent duplicate"}`),
		SessionID: ids.session,
	}
	type result struct {
		ack protocol.CommandAck
		err error
	}
	firstDone := make(chan result, 1)
	go func() {
		ack, err := controller.AcceptCommand(ctx, command)
		firstDone <- result{ack: ack, err: err}
	}()
	select {
	case <-transport.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("first command did not reach transport")
	}

	secondDone := make(chan result, 1)
	go func() {
		ack, err := controller.AcceptCommand(ctx, command)
		secondDone <- result{ack: ack, err: err}
	}()
	select {
	case second := <-secondDone:
		if second.err != nil || second.ack.State != protocol.CommandStateExecuting || !second.ack.Deduplicated {
			t.Fatalf("active duplicate = %+v, want executing deduplicated ACK", second)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("active duplicate did not return while original delivery was in flight")
	}
	if got := transport.sendCount(); got != 1 {
		t.Fatalf("active duplicate send count = %d, want 1", got)
	}
	close(transport.release)
	first := <-firstDone
	if first.err != nil || first.ack.State != protocol.CommandStateSucceeded {
		t.Fatalf("first command = %+v, want succeeded ACK", first)
	}
	third, err := controller.AcceptCommand(ctx, command)
	if err != nil || third.State != protocol.CommandStateSucceeded || !third.Deduplicated {
		t.Fatalf("post-delivery duplicate = %+v, error = %v", third, err)
	}
	if got := transport.sendCount(); got != 1 {
		t.Fatalf("post-delivery duplicate send count = %d, want 1", got)
	}
}

func TestPersistentControllerRepairsUnknownCommandRunSplit(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        "1",
	}); err != nil {
		t.Fatalf("create split-state session: %v", err)
	}
	command := protocol.Command{
		CommandID: ids.command,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"repair split state"}`),
		SessionID: ids.session,
	}
	runID := ids.run
	command.RunID = &runID
	store := NewStore(db.Pool())
	if _, _, err := store.AcceptRun(ctx, CommandIntent{Command: command, Generation: "1"}, NewRunInput{
		ID:         runID,
		SessionID:  ids.session,
		CommandID:  command.CommandID,
		Generation: "1",
	}); err != nil {
		t.Fatalf("persist split-state command and run: %v", err)
	}
	if _, err := store.MarkUnknown(ctx, command.CommandID, "1"); err != nil {
		t.Fatalf("seed unknown command: %v", err)
	}
	if _, err := store.Start(ctx, runID, "1", "cursor-split-running"); err != nil {
		t.Fatalf("seed non-terminal run: %v", err)
	}

	transport := &integrationCommandTransport{}
	controller, err := NewController(store, transport, ControllerConfig{Generation: "1"})
	if err != nil {
		t.Fatalf("create split-state controller: %v", err)
	}
	if _, err := controller.ReconcileCommand(ctx, command.SessionID, command.CommandID); !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("split-state reconciliation error = %v, want unknown result", err)
	}
	run, err := store.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("read repaired run: %v", err)
	}
	if run.Status != protocol.RunStatusUnknown {
		t.Fatalf("repaired run = %+v, want unknown", run)
	}
	if _, err := store.MarkCommandAndRunUnknown(ctx, command.CommandID, "1", "retry unknown convergence"); err != nil {
		t.Fatalf("repeat unknown convergence: %v", err)
	}
}

func TestPersistentStoreUnknownTransitionRollsBackOnRunIdentityConflict(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        "1",
	}); err != nil {
		t.Fatalf("create conflict session: %v", err)
	}
	command := protocol.Command{
		CommandID: ids.command,
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"rollback unknown transition"}`),
		SessionID: ids.session,
	}
	runID := ids.run
	command.RunID = &runID
	store := NewStore(db.Pool())
	if _, _, err := store.AcceptRun(ctx, CommandIntent{Command: command, Generation: "1"}, NewRunInput{
		ID:         runID,
		SessionID:  ids.session,
		CommandID:  command.CommandID,
		Generation: "1",
	}); err != nil {
		t.Fatalf("persist conflict command and run: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `UPDATE execution_runs SET command_id = $1 WHERE id = $2`, ids.unknownCommand, runID); err != nil {
		t.Fatalf("seed mismatched run identity: %v", err)
	}
	if _, err := store.MarkCommandAndRunUnknown(ctx, command.CommandID, "1", "mismatched association"); !errors.Is(err, ErrRunConflict) {
		t.Fatalf("mismatched run error = %v, want %v", err, ErrRunConflict)
	}
	commandRecord, err := store.Lookup(ctx, command.SessionID, command.CommandID)
	if err != nil {
		t.Fatalf("read rolled-back command: %v", err)
	}
	if commandRecord.State != protocol.CommandStateAccepted {
		t.Fatalf("rolled-back command = %+v, want accepted", commandRecord)
	}
	run, err := store.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("read rolled-back run: %v", err)
	}
	if run.Status != protocol.RunStatusPending {
		t.Fatalf("rolled-back run = %+v, want pending", run)
	}
}

type integrationCommandTransport struct {
	ack     protocol.CommandAck
	sendErr error
	calls   int
}

type blockingIntegrationCommandTransport struct {
	entered   chan struct{}
	release   chan struct{}
	enteredMu sync.Once
	mu        sync.Mutex
	calls     int
}

func newBlockingIntegrationCommandTransport() *blockingIntegrationCommandTransport {
	return &blockingIntegrationCommandTransport{entered: make(chan struct{}), release: make(chan struct{})}
}

func (t *blockingIntegrationCommandTransport) SendCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, error) {
	t.mu.Lock()
	t.calls++
	t.mu.Unlock()
	t.enteredMu.Do(func() { close(t.entered) })
	select {
	case <-t.release:
		return protocol.CommandAck{CommandID: command.CommandID, RunID: command.RunID, State: protocol.CommandStateSucceeded}, nil
	case <-ctx.Done():
		return protocol.CommandAck{}, ctx.Err()
	}
}

func (t *blockingIntegrationCommandTransport) ReconcileCommand(context.Context, protocol.Command) (protocol.Reconciliation, error) {
	return protocol.Reconciliation{State: protocol.ReconciliationStateUnknown}, nil
}

func (t *blockingIntegrationCommandTransport) sendCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.calls
}

func (t *integrationCommandTransport) SendCommand(_ context.Context, command protocol.Command) (protocol.CommandAck, error) {
	t.calls++
	if t.sendErr != nil {
		return protocol.CommandAck{}, t.sendErr
	}
	ack := t.ack
	ack.CommandID = command.CommandID
	return ack, nil
}

func (t *integrationCommandTransport) ReconcileCommand(_ context.Context, command protocol.Command) (protocol.Reconciliation, error) {
	return protocol.Reconciliation{CommandID: command.CommandID, State: protocol.ReconciliationStateUnknown}, nil
}

type executionIDs struct {
	session         string
	thread          string
	command         string
	run             string
	unknownCommand  string
	unknownRun      string
	approval        string
	approvalCommand string
	lease           string
}

func executionTestIDs() executionIDs {
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	return executionIDs{
		session:         "e01-session-" + suffix,
		thread:          "e01-thread-" + suffix,
		command:         "e01-command-" + suffix,
		run:             "e01-run-" + suffix,
		unknownCommand:  "e01-unknown-command-" + suffix,
		unknownRun:      "e01-unknown-run-" + suffix,
		approval:        "e01-approval-" + suffix,
		approvalCommand: "e01-approval-command-" + suffix,
		lease:           "e01-lease-" + suffix,
	}
}

func openExecutionDatabase(t *testing.T) *database.DB {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatalf("load database configuration: %v", err)
	}
	config.MinConns = 1
	config.MaxConns = 4
	db, err := database.Open(context.Background(), database.Config{URL: config.URL, MinConns: config.MinConns, MaxConns: config.MaxConns})
	if err != nil {
		t.Fatalf("open execution database: %v", err)
	}
	if err := db.Migrate(context.Background()); err != nil {
		db.Close()
		t.Fatalf("migrate execution database: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	migrator := database.NewApprovalHistoryMigrator(db.Pool(), database.ApprovalHistoryMigratorConfig{LeaseOwner: "runs-integration-test"})
	options := database.ApprovalHistoryMigrationOptions{
		BatchSize:          32,
		WorkBudget:         10000,
		PreDrainBatchSize:  32,
		PreDrainWorkBudget: 10000,
		FinalRowBudget:     100,
		FinalWorkBudget:    300,
	}
	progress, err := migrator.Progress(ctx)
	if err != nil {
		if _, adoptErr := migrator.AdoptAtomic00012(ctx, options); adoptErr != nil && !errors.Is(adoptErr, database.ErrApprovalHistoryAtomicAdoption) {
			db.Close()
			t.Fatalf("adopt old atomic approval history fixture: %v", adoptErr)
		}
		progress, err = migrator.Progress(ctx)
		if err != nil {
			db.Close()
			t.Fatalf("read adopted approval history fixture state: %v", err)
		}
	}
	if progress.Phase != database.ApprovalHistoryPhaseCutoverComplete {
		if _, err := migrator.RunBackfill(ctx, options); err != nil {
			db.Close()
			t.Fatalf("backfill execution database: %v", err)
		}
		if _, err := migrator.Validate(ctx, options); err != nil {
			db.Close()
			t.Fatalf("validate execution database: %v", err)
		}
		if _, err := migrator.BuildIndexes(ctx, options); err != nil {
			db.Close()
			t.Fatalf("build execution database indexes: %v", err)
		}
		if _, err := migrator.Cutover(ctx, options); err != nil {
			db.Close()
			t.Fatalf("cut over execution database: %v", err)
		}
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func reopenExecutionDatabase(t *testing.T, ctx context.Context) *database.DB {
	t.Helper()
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatalf("load database configuration for reopen: %v", err)
	}
	config.MinConns = 1
	config.MaxConns = 4
	db, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: config.MinConns, MaxConns: config.MaxConns})
	if err != nil {
		t.Fatalf("reopen execution database: %v", err)
	}
	return db
}

func cleanupExecutionRows(t *testing.T, db **database.DB, ids executionIDs) {
	t.Helper()
	t.Cleanup(func() {
		if db == nil || *db == nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, query := range []string{
			`DELETE FROM execution_control_leases WHERE lease_key = $1`,
			`DELETE FROM execution_approval_revisions WHERE id = $1`,
			`DELETE FROM execution_approvals WHERE id = $1`,
			`DELETE FROM execution_events WHERE session_id = $1`,
			`DELETE FROM execution_runs WHERE session_id = $1`,
			`DELETE FROM execution_commands WHERE session_id = $1`,
			`DELETE FROM execution_sessions WHERE id = $1`,
		} {
			var arg string
			switch {
			case strings.Contains(query, "lease_key"):
				arg = ids.lease
			case strings.Contains(query, "id ="):
				arg = ids.approval
			default:
				arg = ids.session
			}
			var err error
			if strings.Contains(query, "DELETE FROM execution_approvals") {
				err = execApprovalProjectionMutation(ctx, *db, query, arg)
			} else {
				_, err = (*db).Pool().Exec(ctx, query, arg)
			}
			if err != nil {
				t.Errorf("cleanup query %q: %v", query, err)
			}
		}
		(*db).Close()
		*db = nil
	})
}

func execApprovalProjectionMutation(ctx context.Context, db *database.DB, query string, args ...any) error {
	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin approval projection mutation: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL loomhelm.approval_writer_capability = 'revision-history-v1'`); err != nil {
		return fmt.Errorf("set approval projection mutation capability: %w", err)
	}
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		return fmt.Errorf("execute approval projection mutation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit approval projection mutation: %w", err)
	}
	return nil
}
