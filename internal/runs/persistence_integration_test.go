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
	unknownRecord, err := NewStore(db.Pool()).Lookup(ctx, ids.unknownCommand)
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
	record, err := store.Lookup(ctx, command.CommandID)
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
			if _, err := (*db).Pool().Exec(ctx, query, arg); err != nil {
				t.Errorf("cleanup query %q: %v", query, err)
			}
		}
		(*db).Close()
		*db = nil
	})
}
