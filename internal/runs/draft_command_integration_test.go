package runs

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/drafts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func TestPersistentDraftCommandBindingFinalizesWithoutClobberingNewerInput(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := newControlFixture(t, db, 1)

	// The shared fixture predates the draft tables' foreign keys, so remove
	// this test's rows before its normal Session cleanup runs.
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for _, query := range []string{
			`DELETE FROM conversation_draft_commands WHERE session_id = $1`,
			`DELETE FROM conversation_draft_mutations WHERE session_id = $1`,
			`DELETE FROM conversation_drafts WHERE session_id = $1`,
		} {
			if _, err := db.Pool().Exec(cleanupCtx, query, fixture.sessionIDs[0]); err != nil {
				t.Errorf("cleanup draft rows with query %q: %v", query, err)
			}
		}
	})

	draftStore := drafts.NewStore(db.Pool())
	runStore := NewStore(db.Pool())
	sessionID := fixture.sessionIDs[0]
	ownerID := fixture.userID
	first, err := draftStore.Apply(ctx, drafts.UpdateInput{
		SessionID:      sessionID,
		OwnerUserID:    ownerID,
		MutationID:     "draft-command-first",
		ClientID:       "desktop",
		ClientSequence: 1,
		Content:        "first input",
	})
	if err != nil {
		t.Fatalf("seed first draft: %v", err)
	}

	command := protocol.Command{
		CommandID: fixture.command + "-draft-delivered",
		IssuedAt:  "2026-10-30T00:00:00Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"first input"}`),
		SessionID: sessionID,
	}
	intent := CommandIntent{Command: command, Generation: fixture.generation}
	_, _, err = runStore.AcceptRunWithMutation(ctx, intent, NewRunInput{
		ID:         fixture.run + "-draft-delivered",
		SessionID:  sessionID,
		CommandID:  command.CommandID,
		Generation: fixture.generation,
	}, func(mutationCtx context.Context, tx pgx.Tx, _ AcceptResult) error {
		return draftStore.PrepareCommandTx(mutationCtx, tx, drafts.CommandDraftInput{
			CommandID:        command.CommandID,
			SessionID:        sessionID,
			OwnerUserID:      ownerID,
			ExpectedRevision: first.Revision,
			Content:          first.Content,
		})
	})
	if err != nil {
		t.Fatalf("accept draft command: %v", err)
	}

	newer, err := draftStore.Apply(ctx, drafts.UpdateInput{
		SessionID:      sessionID,
		OwnerUserID:    ownerID,
		MutationID:     "draft-command-newer",
		ClientID:       "mobile",
		ClientSequence: 1,
		Content:        "newer input",
	})
	if err != nil {
		t.Fatalf("apply newer draft: %v", err)
	}
	finalized, err := draftStore.FinalizeCommand(ctx, command.CommandID, true)
	if err != nil {
		t.Fatalf("finalize delivered draft command: %v", err)
	}
	if finalized.State != drafts.CommandDraftPreserved || finalized.Consumed {
		t.Fatalf("delivered stale draft result = %+v, want preserved", finalized)
	}
	current, err := draftStore.Get(ctx, sessionID, ownerID)
	if err != nil {
		t.Fatalf("read preserved newer draft: %v", err)
	}
	if current.Revision != newer.Revision || current.Content != newer.Content {
		t.Fatalf("preserved newer draft = %+v, want revision %d content %q", current, newer.Revision, newer.Content)
	}
	repeated, err := draftStore.FinalizeCommand(ctx, command.CommandID, true)
	if err != nil {
		t.Fatalf("repeat draft finalization: %v", err)
	}
	if repeated.State != drafts.CommandDraftPreserved || repeated.Consumed {
		t.Fatalf("repeat finalization = %+v, want preserved idempotently", repeated)
	}

	consumable, err := draftStore.Apply(ctx, drafts.UpdateInput{
		SessionID:      sessionID,
		OwnerUserID:    ownerID,
		MutationID:     "draft-command-consumable",
		ClientID:       "desktop",
		ClientSequence: 2,
		Content:        "consume me",
	})
	if err != nil {
		t.Fatalf("apply consumable draft: %v", err)
	}
	failedCommand := protocol.Command{
		CommandID: fixture.command + "-draft-failed",
		IssuedAt:  "2026-10-30T00:00:01Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"consume me"}`),
		SessionID: sessionID,
	}
	_, _, err = runStore.AcceptRunWithMutation(ctx, CommandIntent{Command: failedCommand, Generation: fixture.generation}, NewRunInput{
		ID:         fixture.run + "-draft-failed",
		SessionID:  sessionID,
		CommandID:  failedCommand.CommandID,
		Generation: fixture.generation,
	}, func(mutationCtx context.Context, tx pgx.Tx, _ AcceptResult) error {
		return draftStore.PrepareCommandTx(mutationCtx, tx, drafts.CommandDraftInput{
			CommandID:        failedCommand.CommandID,
			SessionID:        sessionID,
			OwnerUserID:      ownerID,
			ExpectedRevision: consumable.Revision,
			Content:          consumable.Content,
		})
	})
	if err != nil {
		t.Fatalf("accept failed draft command: %v", err)
	}
	failed, err := draftStore.FinalizeCommand(ctx, failedCommand.CommandID, false)
	if err != nil {
		t.Fatalf("finalize failed draft command: %v", err)
	}
	if failed.State != drafts.CommandDraftPreserved || failed.Consumed {
		t.Fatalf("failed draft result = %+v, want preserved", failed)
	}
	current, err = draftStore.Get(ctx, sessionID, ownerID)
	if err != nil {
		t.Fatalf("read failed draft: %v", err)
	}
	if current.Content != consumable.Content || current.Revision != consumable.Revision {
		t.Fatalf("failed command changed draft = %+v, want %+v", current, consumable)
	}

	staleCommand := protocol.Command{
		CommandID: fixture.command + "-draft-stale",
		IssuedAt:  "2026-10-30T00:00:02Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"old input"}`),
		SessionID: sessionID,
	}
	_, _, err = runStore.AcceptRunWithMutation(ctx, CommandIntent{Command: staleCommand, Generation: fixture.generation}, NewRunInput{
		ID:         fixture.run + "-draft-stale",
		SessionID:  sessionID,
		CommandID:  staleCommand.CommandID,
		Generation: fixture.generation,
	}, func(mutationCtx context.Context, tx pgx.Tx, _ AcceptResult) error {
		return draftStore.PrepareCommandTx(mutationCtx, tx, drafts.CommandDraftInput{
			CommandID:        staleCommand.CommandID,
			SessionID:        sessionID,
			OwnerUserID:      ownerID,
			ExpectedRevision: first.Revision,
			Content:          first.Content,
		})
	})
	if !errors.Is(err, drafts.ErrDraftRevisionStale) {
		t.Fatalf("stale draft admission error = %v, want %v", err, drafts.ErrDraftRevisionStale)
	}
	if _, err := runStore.Lookup(ctx, sessionID, staleCommand.CommandID); !errors.Is(err, ErrCommandNotFound) {
		t.Fatalf("rolled-back stale command lookup error = %v, want %v", err, ErrCommandNotFound)
	}
}

func TestPersistentDraftCommandReconciliationRejectsMismatchedCommandID(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := newControlFixture(t, db, 1)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for _, query := range []string{
			`DELETE FROM conversation_draft_commands WHERE session_id = $1`,
			`DELETE FROM conversation_draft_mutations WHERE session_id = $1`,
			`DELETE FROM conversation_drafts WHERE session_id = $1`,
		} {
			if _, err := db.Pool().Exec(cleanupCtx, query, fixture.sessionIDs[0]); err != nil {
				t.Errorf("cleanup draft rows with query %q: %v", query, err)
			}
		}
	})

	draftStore := drafts.NewStore(db.Pool())
	runStore := NewStore(db.Pool())
	sessionID := fixture.sessionIDs[0]
	draft, err := draftStore.Apply(ctx, drafts.UpdateInput{
		SessionID:      sessionID,
		OwnerUserID:    fixture.userID,
		MutationID:     "draft-command-reconcile-mismatch",
		ClientID:       "desktop",
		ClientSequence: 1,
		Content:        "retain after mismatched reconciliation",
	})
	if err != nil {
		t.Fatalf("seed draft: %v", err)
	}
	command := protocol.Command{
		CommandID: fixture.command + "-draft-reconcile-mismatch",
		IssuedAt:  "2026-10-30T00:00:03Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"retain after mismatched reconciliation"}`),
		SessionID: sessionID,
	}
	_, _, err = runStore.AcceptRunWithMutation(ctx, CommandIntent{Command: command, Generation: fixture.generation}, NewRunInput{
		ID:         fixture.run + "-draft-reconcile-mismatch",
		SessionID:  sessionID,
		CommandID:  command.CommandID,
		Generation: fixture.generation,
	}, func(mutationCtx context.Context, tx pgx.Tx, _ AcceptResult) error {
		return draftStore.PrepareCommandTx(mutationCtx, tx, drafts.CommandDraftInput{
			CommandID:        command.CommandID,
			SessionID:        sessionID,
			OwnerUserID:      fixture.userID,
			ExpectedRevision: draft.Revision,
			Content:          draft.Content,
		})
	})
	if err != nil {
		t.Fatalf("accept draft command: %v", err)
	}
	transport := &mismatchedReconciliationTransport{
		response: protocol.Reconciliation{
			CommandID: "different-command",
			State:     protocol.ReconciliationStateConfirmed,
		},
	}
	controller, err := NewController(runStore, transport, ControllerConfig{
		Generation:    fixture.generation,
		DraftCommands: draftStore,
	})
	if err != nil {
		t.Fatalf("create reconciliation controller: %v", err)
	}
	if _, err := controller.ReconcileCommand(ctx, sessionID, command.CommandID); err == nil || !strings.Contains(err.Error(), "transport returned command id") {
		t.Fatalf("mismatched reconciliation error = %v, want command identity error", err)
	}
	current, err := draftStore.Get(ctx, sessionID, fixture.userID)
	if err != nil {
		t.Fatalf("read draft after mismatched reconciliation: %v", err)
	}
	if current.Content != draft.Content || current.Revision != draft.Revision {
		t.Fatalf("mismatched reconciliation changed draft = %+v, want %+v", current, draft)
	}
	record, err := runStore.Lookup(ctx, sessionID, command.CommandID)
	if err != nil {
		t.Fatalf("read command after mismatched reconciliation: %v", err)
	}
	if record.State != protocol.CommandStateUnknown {
		t.Fatalf("command after mismatched reconciliation = %s, want unknown", record.State)
	}
}

func TestPersistentDraftCommandReconciliationFinalizesMatchingObservation(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := newControlFixture(t, db, 2)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := db.Pool().Exec(cleanupCtx, `DELETE FROM conversation_draft_commands WHERE session_id = ANY($1::text[])`, fixture.sessionIDs); err != nil {
			t.Errorf("cleanup draft command bindings: %v", err)
		}
		if _, err := db.Pool().Exec(cleanupCtx, `DELETE FROM conversation_draft_mutations WHERE session_id = ANY($1::text[])`, fixture.sessionIDs); err != nil {
			t.Errorf("cleanup draft mutations: %v", err)
		}
		if _, err := db.Pool().Exec(cleanupCtx, `DELETE FROM conversation_drafts WHERE session_id = ANY($1::text[])`, fixture.sessionIDs); err != nil {
			t.Errorf("cleanup drafts: %v", err)
		}
	})

	cases := []struct {
		name            string
		sessionIndex    int
		reconciliation  protocol.ReconciliationState
		wantState       protocol.CommandState
		wantContent     string
		wantRevisionAdd int64
	}{
		{
			name:            "confirmed",
			sessionIndex:    0,
			reconciliation:  protocol.ReconciliationStateConfirmed,
			wantState:       protocol.CommandStateSucceeded,
			wantRevisionAdd: 1,
		},
		{
			name:           "not-found",
			sessionIndex:   1,
			reconciliation: protocol.ReconciliationStateNotFound,
			wantState:      protocol.CommandStateRejected,
			wantContent:    "retain after not-found reconciliation",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sessionID := fixture.sessionIDs[tc.sessionIndex]
			commandID := fixture.command + "-draft-reconcile-" + tc.name
			runID := fixture.run + "-draft-reconcile-" + tc.name
			draftStore := drafts.NewStore(db.Pool())
			runStore := NewStore(db.Pool())
			draft, err := draftStore.Apply(ctx, drafts.UpdateInput{
				SessionID:      sessionID,
				OwnerUserID:    fixture.userID,
				MutationID:     "draft-reconcile-matching-" + tc.name,
				ClientID:       "desktop",
				ClientSequence: 1,
				Content:        firstNonEmpty(tc.wantContent, "consume after confirmed reconciliation"),
			})
			if err != nil {
				t.Fatalf("seed draft: %v", err)
			}
			command := protocol.Command{
				CommandID: commandID,
				IssuedAt:  "2026-10-30T00:00:05Z",
				Kind:      protocol.CommandKindRunSend,
				Payload:   json.RawMessage(`{"prompt":"draft reconciliation"}`),
				RunID:     &runID,
				SessionID: sessionID,
			}
			_, _, err = runStore.AcceptRunWithMutation(ctx, CommandIntent{Command: command, Generation: fixture.generation}, NewRunInput{
				ID:         runID,
				SessionID:  sessionID,
				CommandID:  commandID,
				Generation: fixture.generation,
			}, func(mutationCtx context.Context, tx pgx.Tx, _ AcceptResult) error {
				return draftStore.PrepareCommandTx(mutationCtx, tx, drafts.CommandDraftInput{
					CommandID:        commandID,
					SessionID:        sessionID,
					OwnerUserID:      fixture.userID,
					ExpectedRevision: draft.Revision,
					Content:          draft.Content,
				})
			})
			if err != nil {
				t.Fatalf("accept draft command: %v", err)
			}
			transport := &matchingReconciliationTransport{state: tc.reconciliation}
			controller, err := NewController(runStore, transport, ControllerConfig{
				Generation:    fixture.generation,
				DraftCommands: draftStore,
			})
			if err != nil {
				t.Fatalf("create reconciliation controller: %v", err)
			}
			reconciliation, err := controller.ReconcileCommand(ctx, sessionID, commandID)
			if err != nil {
				t.Fatalf("matching reconciliation: %v", err)
			}
			if reconciliation.State != tc.reconciliation || transport.sendCalls != 0 {
				t.Fatalf("reconciliation = %+v, send calls = %d", reconciliation, transport.sendCalls)
			}
			record, err := runStore.Lookup(ctx, sessionID, commandID)
			if err != nil {
				t.Fatalf("read reconciled command: %v", err)
			}
			if record.State != tc.wantState {
				t.Fatalf("reconciled command state = %s, want %s", record.State, tc.wantState)
			}
			current, err := draftStore.Get(ctx, sessionID, fixture.userID)
			if err != nil {
				t.Fatalf("read reconciled draft: %v", err)
			}
			if current.Content != tc.wantContent || current.Revision != draft.Revision+tc.wantRevisionAdd {
				t.Fatalf("reconciled draft = %+v, want content %q revision %d", current, tc.wantContent, draft.Revision+tc.wantRevisionAdd)
			}
		})
	}
}

func TestPersistentDraftCommandLegacyMarkerlessAckRemainsUnknown(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := newControlFixture(t, db, 1)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for _, query := range []string{
			`DELETE FROM conversation_draft_commands WHERE session_id = $1`,
			`DELETE FROM conversation_draft_mutations WHERE session_id = $1`,
			`DELETE FROM conversation_drafts WHERE session_id = $1`,
		} {
			if _, err := db.Pool().Exec(cleanupCtx, query, fixture.sessionIDs[0]); err != nil {
				t.Errorf("cleanup legacy markerless draft rows with query %q: %v", query, err)
			}
		}
	})

	draftStore := drafts.NewStore(db.Pool())
	runStore := NewStore(db.Pool())
	sessionID := fixture.sessionIDs[0]
	commandID := "draft-command-legacy-markerless-" + sessionID
	runID := fixture.run + "-draft-legacy-markerless"
	draft, err := draftStore.Apply(ctx, drafts.UpdateInput{
		SessionID:      sessionID,
		OwnerUserID:    fixture.userID,
		MutationID:     "draft-legacy-markerless",
		ClientID:       "desktop",
		ClientSequence: 1,
		Content:        "legacy ACK content",
	})
	if err != nil {
		t.Fatalf("seed legacy markerless draft: %v", err)
	}
	command := protocol.Command{
		CommandID: commandID,
		IssuedAt:  "2026-10-30T00:00:06Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"legacy ACK content"}`),
		RunID:     &runID,
		SessionID: sessionID,
	}
	_, _, err = runStore.AcceptRunWithMutation(ctx, CommandIntent{Command: command, Generation: fixture.generation}, NewRunInput{
		ID:         runID,
		SessionID:  sessionID,
		CommandID:  commandID,
		Generation: fixture.generation,
	}, func(mutationCtx context.Context, tx pgx.Tx, _ AcceptResult) error {
		return draftStore.PrepareCommandTx(mutationCtx, tx, drafts.CommandDraftInput{
			CommandID:        commandID,
			SessionID:        sessionID,
			OwnerUserID:      fixture.userID,
			ExpectedRevision: draft.Revision,
			Content:          draft.Content,
		})
	})
	if err != nil {
		t.Fatalf("accept legacy markerless draft command: %v", err)
	}

	var beforeState, beforeMarker, beforeReconciliation string
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, exact_ack_state, reconciliation_state
		FROM execution_commands
		WHERE command_id = $1
	`, commandID).Scan(&beforeState, &beforeMarker, &beforeReconciliation); err != nil {
		t.Fatalf("read command before migration re-entry: %v", err)
	}
	beforeDraft, err := draftStore.Get(ctx, sessionID, fixture.userID)
	if err != nil {
		t.Fatalf("read draft before migration re-entry: %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("first migration re-entry: %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("second migration re-entry: %v", err)
	}
	var afterState, afterMarker, afterReconciliation string
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, exact_ack_state, reconciliation_state
		FROM execution_commands
		WHERE command_id = $1
	`, commandID).Scan(&afterState, &afterMarker, &afterReconciliation); err != nil {
		t.Fatalf("read command after migration re-entry: %v", err)
	}
	afterDraft, err := draftStore.Get(ctx, sessionID, fixture.userID)
	if err != nil {
		t.Fatalf("read draft after migration re-entry: %v", err)
	}
	if afterState != beforeState || afterMarker != beforeMarker || afterReconciliation != beforeReconciliation || afterDraft != beforeDraft {
		t.Fatalf("migration re-entry changed command or draft: before command=(%q,%q,%q) draft=%+v after command=(%q,%q,%q) draft=%+v", beforeState, beforeMarker, beforeReconciliation, beforeDraft, afterState, afterMarker, afterReconciliation, afterDraft)
	}

	// A 00013 writer can record the first executing ACK without knowing the
	// additive marker. The candidate must keep that outcome unresolved rather
	// than infer delivery from the ambiguous state and consume the draft.
	if _, err := db.Pool().Exec(ctx, `
		UPDATE execution_commands
		SET state = 'executing', operation_id = '', result = NULL, error = NULL,
		    event_cursor = '', reconciliation_state = ''
		WHERE command_id = $1
	`, commandID); err != nil {
		t.Fatalf("simulate markerless legacy ACK: %v", err)
	}
	transport := &matchingReconciliationTransport{state: protocol.ReconciliationStateUnknown}
	controller, err := NewController(runStore, transport, ControllerConfig{
		Generation:    fixture.generation,
		DraftCommands: draftStore,
	})
	if err != nil {
		t.Fatalf("create markerless recovery controller: %v", err)
	}
	if _, err := controller.ReconcileCommand(ctx, sessionID, commandID); !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("markerless legacy reconciliation error = %v, want unknown result", err)
	}
	record, err := runStore.Lookup(ctx, sessionID, commandID)
	if err != nil {
		t.Fatalf("read markerless legacy command: %v", err)
	}
	if record.State != protocol.CommandStateUnknown || record.ExactAckState != "" {
		t.Fatalf("markerless legacy command = %+v, want unknown without exact marker", record)
	}
	current, err := draftStore.Get(ctx, sessionID, fixture.userID)
	if err != nil {
		t.Fatalf("read markerless legacy draft: %v", err)
	}
	if current.Content != draft.Content || current.Revision != draft.Revision {
		t.Fatalf("markerless legacy draft = %+v, want preserved %+v", current, draft)
	}
	if transport.sendCalls != 0 {
		t.Fatalf("markerless reconciliation sent %d commands, want 0", transport.sendCalls)
	}
}

type mismatchedReconciliationTransport struct {
	response protocol.Reconciliation
}

func (t *mismatchedReconciliationTransport) SendCommand(_ context.Context, command protocol.Command) (protocol.CommandAck, error) {
	return protocol.CommandAck{CommandID: command.CommandID, State: protocol.CommandStateSucceeded}, nil
}

func (t *mismatchedReconciliationTransport) ReconcileCommand(context.Context, protocol.Command) (protocol.Reconciliation, error) {
	return t.response, nil
}

type matchingReconciliationTransport struct {
	state     protocol.ReconciliationState
	sendCalls int
}

func (t *matchingReconciliationTransport) SendCommand(context.Context, protocol.Command) (protocol.CommandAck, error) {
	t.sendCalls++
	return protocol.CommandAck{}, errors.New("unexpected command send during reconciliation")
}

func (t *matchingReconciliationTransport) ReconcileCommand(_ context.Context, command protocol.Command) (protocol.Reconciliation, error) {
	return protocol.Reconciliation{CommandID: command.CommandID, State: t.state}, nil
}
