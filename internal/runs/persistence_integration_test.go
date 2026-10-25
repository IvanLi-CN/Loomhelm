package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
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

type integrationCommandTransport struct {
	ack     protocol.CommandAck
	sendErr error
	calls   int
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
