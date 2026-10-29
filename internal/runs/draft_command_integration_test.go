package runs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/db/migrations"
	"github.com/IvanLi-CN/Loomhelm/internal/drafts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
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
	duplicateCommand := protocol.Command{
		CommandID: fixture.command + "-draft-duplicate-revision",
		IssuedAt:  "2026-10-30T00:00:00Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"first input"}`),
		SessionID: sessionID,
	}
	_, _, err = runStore.AcceptRunWithMutation(ctx, CommandIntent{Command: duplicateCommand, Generation: fixture.generation}, NewRunInput{
		ID:         fixture.run + "-draft-duplicate-revision",
		SessionID:  sessionID,
		CommandID:  duplicateCommand.CommandID,
		Generation: fixture.generation,
	}, func(mutationCtx context.Context, tx pgx.Tx, _ AcceptResult) error {
		return draftStore.PrepareCommandTx(mutationCtx, tx, drafts.CommandDraftInput{
			CommandID:        duplicateCommand.CommandID,
			SessionID:        sessionID,
			OwnerUserID:      ownerID,
			ExpectedRevision: first.Revision,
			Content:          first.Content,
		})
	})
	if !errors.Is(err, drafts.ErrDraftRevisionStale) {
		t.Fatalf("duplicate draft revision admission error = %v, want %v", err, drafts.ErrDraftRevisionStale)
	}
	if _, err := runStore.Lookup(ctx, sessionID, duplicateCommand.CommandID); !errors.Is(err, ErrCommandNotFound) {
		t.Fatalf("rolled-back duplicate draft command lookup error = %v, want %v", err, ErrCommandNotFound)
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

	payloadMismatchCommand := protocol.Command{
		CommandID: fixture.command + "-draft-payload-mismatch",
		IssuedAt:  "2026-10-30T00:00:01Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"different persisted payload"}`),
		SessionID: sessionID,
	}
	_, _, err = runStore.AcceptRunWithMutation(ctx, CommandIntent{Command: payloadMismatchCommand, Generation: fixture.generation}, NewRunInput{
		ID:         fixture.run + "-draft-payload-mismatch",
		SessionID:  sessionID,
		CommandID:  payloadMismatchCommand.CommandID,
		Generation: fixture.generation,
	}, func(mutationCtx context.Context, tx pgx.Tx, _ AcceptResult) error {
		return draftStore.PrepareCommandTx(mutationCtx, tx, drafts.CommandDraftInput{
			CommandID:        payloadMismatchCommand.CommandID,
			SessionID:        sessionID,
			OwnerUserID:      ownerID,
			ExpectedRevision: consumable.Revision,
			Content:          consumable.Content,
		})
	})
	if !errors.Is(err, drafts.ErrDraftMutation) {
		t.Fatalf("payload/content mismatch admission error = %v, want %v", err, drafts.ErrDraftMutation)
	}
	if _, err := runStore.Lookup(ctx, sessionID, payloadMismatchCommand.CommandID); !errors.Is(err, ErrCommandNotFound) {
		t.Fatalf("payload/content mismatch command lookup error = %v, want %v", err, ErrCommandNotFound)
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

func TestPersistentDraftModificationOrderIgnoresLateArrival(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := newControlFixture(t, db, 1)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for _, query := range []string{
			`DELETE FROM conversation_draft_mutations WHERE session_id = $1`,
			`DELETE FROM conversation_drafts WHERE session_id = $1`,
		} {
			if _, err := db.Pool().Exec(cleanupCtx, query, fixture.sessionIDs[0]); err != nil {
				t.Errorf("cleanup draft rows with query %q: %v", query, err)
			}
		}
	})

	draftStore := drafts.NewStore(db.Pool())
	baseMillis := time.Now().Add(-time.Second).UnixMilli()
	higher := drafts.ModificationOrder{PhysicalMillis: baseMillis + 2, ClientID: "desktop"}
	current, err := draftStore.Apply(ctx, drafts.UpdateInput{
		SessionID:         fixture.sessionIDs[0],
		OwnerUserID:       fixture.userID,
		MutationID:        "draft-order-higher",
		ClientID:          "desktop",
		ClientSequence:    1,
		Content:           "higher order",
		ModificationOrder: &higher,
	})
	if err != nil {
		t.Fatalf("apply higher-order draft: %v", err)
	}

	lower := drafts.ModificationOrder{PhysicalMillis: baseMillis + 1, ClientID: "mobile"}
	stale, err := draftStore.Apply(ctx, drafts.UpdateInput{
		SessionID:         fixture.sessionIDs[0],
		OwnerUserID:       fixture.userID,
		MutationID:        "draft-order-lower",
		ClientID:          "mobile",
		ClientSequence:    1,
		Content:           "lower order",
		ModificationOrder: &lower,
	})
	if err != nil {
		t.Fatalf("apply late lower-order draft: %v", err)
	}
	if stale.Revision != current.Revision || stale.Content != current.Content || !stale.ModificationOrder.Equal(current.ModificationOrder) {
		t.Fatalf("late lower-order draft = %+v, want unchanged higher-order projection %+v", stale, current)
	}

	latestOrder := drafts.ModificationOrder{PhysicalMillis: baseMillis + 3, ClientID: "mobile"}
	latest, err := draftStore.Apply(ctx, drafts.UpdateInput{
		SessionID:         fixture.sessionIDs[0],
		OwnerUserID:       fixture.userID,
		MutationID:        "draft-order-latest",
		ClientID:          "mobile",
		ClientSequence:    2,
		Content:           "latest order",
		ModificationOrder: &latestOrder,
	})
	if err != nil {
		t.Fatalf("apply later higher-order draft: %v", err)
	}
	if latest.Revision != current.Revision+1 || latest.Content != "latest order" || !latest.ModificationOrder.Equal(latestOrder) {
		t.Fatalf("later higher-order draft = %+v, want revision %d and latest content", latest, current.Revision+1)
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
		name             string
		sessionIndex     int
		reconciliation   protocol.ReconciliationState
		wantState        protocol.CommandState
		wantContent      string
		wantRevisionAdd  int64
		wantBindingState drafts.CommandDraftState
	}{
		{
			name:             "confirmed",
			sessionIndex:     0,
			reconciliation:   protocol.ReconciliationStateConfirmed,
			wantState:        protocol.CommandStateSucceeded,
			wantRevisionAdd:  1,
			wantBindingState: drafts.CommandDraftConsumed,
		},
		{
			name:             "not-found",
			sessionIndex:     1,
			reconciliation:   protocol.ReconciliationStateNotFound,
			wantState:        protocol.CommandStateRejected,
			wantContent:      "retain after not-found reconciliation",
			wantBindingState: drafts.CommandDraftPreserved,
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
			payload, err := json.Marshal(struct {
				Prompt string `json:"prompt"`
			}{Prompt: draft.Content})
			if err != nil {
				t.Fatalf("encode draft command payload: %v", err)
			}
			command := protocol.Command{
				CommandID: commandID,
				IssuedAt:  "2026-10-30T00:00:05Z",
				Kind:      protocol.CommandKindRunSend,
				Payload:   payload,
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
			var bindingState string
			if err := db.Pool().QueryRow(ctx, `
			SELECT state FROM conversation_draft_commands WHERE command_id = $1
		`, commandID).Scan(&bindingState); err != nil {
				t.Fatalf("read reconciled draft binding: %v", err)
			}
			if bindingState != string(tc.wantBindingState) {
				t.Fatalf("reconciled draft binding state = %q, want %q", bindingState, tc.wantBindingState)
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

	var beforeState, beforeMarker, beforeReconciliation, beforeOperation, beforeCursor string
	var beforeResult, beforeError []byte
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, exact_ack_state, reconciliation_state, operation_id, event_cursor, result, error
		FROM execution_commands
		WHERE command_id = $1
	`, commandID).Scan(&beforeState, &beforeMarker, &beforeReconciliation, &beforeOperation, &beforeCursor, &beforeResult, &beforeError); err != nil {
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
	var afterState, afterMarker, afterReconciliation, afterOperation, afterCursor string
	var afterResult, afterError []byte
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, exact_ack_state, reconciliation_state, operation_id, event_cursor, result, error
		FROM execution_commands
		WHERE command_id = $1
	`, commandID).Scan(&afterState, &afterMarker, &afterReconciliation, &afterOperation, &afterCursor, &afterResult, &afterError); err != nil {
		t.Fatalf("read command after migration re-entry: %v", err)
	}
	afterDraft, err := draftStore.Get(ctx, sessionID, fixture.userID)
	if err != nil {
		t.Fatalf("read draft after migration re-entry: %v", err)
	}
	if afterState != beforeState || afterMarker != beforeMarker || afterReconciliation != beforeReconciliation || afterOperation != beforeOperation || afterCursor != beforeCursor || !bytes.Equal(afterResult, beforeResult) || !bytes.Equal(afterError, beforeError) || afterDraft != beforeDraft {
		t.Fatalf("migration re-entry changed command or draft: before command=(%q,%q,%q,%q,%q,%q,%q) draft=%+v after command=(%q,%q,%q,%q,%q,%q,%q) draft=%+v", beforeState, beforeMarker, beforeReconciliation, beforeOperation, beforeCursor, beforeResult, beforeError, beforeDraft, afterState, afterMarker, afterReconciliation, afterOperation, afterCursor, afterResult, afterError, afterDraft)
	}

	// A 00013 writer can record the first executing ACK without knowing the
	// additive marker. The candidate must keep that outcome unresolved rather
	// than infer delivery from the ambiguous state and consume the draft.
	if _, err := db.Pool().Exec(ctx, `
		UPDATE execution_commands
		SET state = 'executing', operation_id = 'legacy-operation',
		    result = convert_to('{"legacy":true}', 'UTF8'), error = NULL,
		    event_cursor = 'legacy-cursor', reconciliation_state = ''
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
	if record.State != protocol.CommandStateUnknown || record.ExactAckState != "" || record.OperationID != "legacy-operation" || record.EventCursor != "legacy-cursor" || string(record.Result) != `{"legacy":true}` {
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

	transport.state = protocol.ReconciliationStateConfirmed
	transport.eventCursor = "recovered-cursor"
	if _, err := controller.ReconcileCommand(ctx, sessionID, commandID); err != nil {
		t.Fatalf("definitive markerless reconciliation: %v", err)
	}
	record, err = runStore.Lookup(ctx, sessionID, commandID)
	if err != nil {
		t.Fatalf("read definitively reconciled markerless command: %v", err)
	}
	if record.State != protocol.CommandStateSucceeded || record.EventCursor != "recovered-cursor" || record.OperationID != "legacy-operation" || string(record.Result) != `{"legacy":true}` {
		t.Fatalf("definitively reconciled markerless command = %+v", record)
	}
	current, err = draftStore.Get(ctx, sessionID, fixture.userID)
	if err != nil {
		t.Fatalf("read finalized markerless legacy draft: %v", err)
	}
	if current.Content != "" || current.Revision != draft.Revision+1 {
		t.Fatalf("finalized markerless legacy draft = %+v, want empty revision %d", current, draft.Revision+1)
	}
	if transport.sendCalls != 0 {
		t.Fatalf("definitive markerless reconciliation sent %d commands, want 0", transport.sendCalls)
	}
}

func TestDraftCommandMigrationFrom00013PreservesExistingState(t *testing.T) {
	db, provider := openDraftMigrationFixtureDatabaseThrough(t, 13)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const (
		userID    = "e01-draft-migration-user"
		sessionID = "e01-draft-migration-session"
		commandID = "e01-draft-migration-command"
	)
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject)
		VALUES ($1, 'https://issuer.example.test', $1)
	`, userID); err != nil {
		t.Fatalf("seed migration user: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_sessions (id, external_thread_ref, path, state, generation)
		VALUES ($1, $2, 'new', 'active', 'legacy-generation')
	`, sessionID, "thread-"+sessionID); err != nil {
		t.Fatalf("seed migration session: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_commands (
			command_id, session_id, generation, kind, issued_at, payload, digest,
			received_at, state, operation_id, result, event_cursor, reconciliation_state
		)
		VALUES ($1, $2, 'legacy-generation', 'run.send', '2026-10-30T00:00:00Z',
			$3, repeat('a', 64), '2026-10-30T00:00:00Z', 'executing',
			'legacy-operation', convert_to('{"legacy":true}', 'UTF8'), 'legacy-cursor', '')
	`, commandID, sessionID, []byte(`{"prompt":"legacy draft"}`)); err != nil {
		t.Fatalf("seed migration command: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO conversation_drafts (
			session_id, owner_user_id, content, revision, mutation_id, client_id, client_sequence
		)
		VALUES ($1, $2, 'legacy draft', 1, 'legacy-mutation', 'desktop', 1)
	`, sessionID, userID); err != nil {
		t.Fatalf("seed migration draft: %v", err)
	}
	var beforeContent string
	var beforeRevision int64
	var beforeState, beforeOperationID, beforeEventCursor, beforeReconciliationState string
	var beforeResult []byte
	if err := db.Pool().QueryRow(ctx, `
		SELECT content, revision FROM conversation_drafts WHERE session_id = $1
	`, sessionID).Scan(&beforeContent, &beforeRevision); err != nil {
		t.Fatalf("read pre-00014 draft: %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, operation_id, result, event_cursor, reconciliation_state
		FROM execution_commands WHERE command_id = $1
	`, commandID).Scan(&beforeState, &beforeOperationID, &beforeResult, &beforeEventCursor, &beforeReconciliationState); err != nil {
		t.Fatalf("read pre-00014 command: %v", err)
	}
	if _, err := provider.UpTo(ctx, 16); err != nil {
		t.Fatalf("apply 00016 migration: %v", err)
	}
	var afterContent string
	var afterRevision int64
	var afterModificationPhysicalMillis, afterModificationLogicalCounter int64
	var afterModificationClientID string
	var exactAckState string
	var afterState, afterOperationID, afterEventCursor, afterReconciliationState string
	var afterResult []byte
	if err := db.Pool().QueryRow(ctx, `
		SELECT content, revision, modification_physical_ms,
		       modification_logical_counter, modification_client_id
		FROM conversation_drafts WHERE session_id = $1
	`, sessionID).Scan(&afterContent, &afterRevision, &afterModificationPhysicalMillis, &afterModificationLogicalCounter, &afterModificationClientID); err != nil {
		t.Fatalf("read post-00016 draft: %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT exact_ack_state FROM execution_commands WHERE command_id = $1
	`, commandID).Scan(&exactAckState); err != nil {
		t.Fatalf("read post-00014 ACK marker: %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, operation_id, result, event_cursor, reconciliation_state
		FROM execution_commands WHERE command_id = $1
	`, commandID).Scan(&afterState, &afterOperationID, &afterResult, &afterEventCursor, &afterReconciliationState); err != nil {
		t.Fatalf("read post-00014 command: %v", err)
	}
	if afterContent != beforeContent || afterRevision != beforeRevision || exactAckState != "" ||
		afterState != beforeState || afterOperationID != beforeOperationID || !bytes.Equal(afterResult, beforeResult) ||
		afterEventCursor != beforeEventCursor || afterReconciliationState != beforeReconciliationState {
		t.Fatalf("post-00016 state = draft %q/%d command state %q operation %q result %s cursor %q reconciliation %q exact_ack_state %q, want unchanged state", afterContent, afterRevision, afterState, afterOperationID, afterResult, afterEventCursor, afterReconciliationState, exactAckState)
	}
	if afterModificationPhysicalMillis != 0 || afterModificationLogicalCounter != 0 || afterModificationClientID != "" {
		t.Fatalf("post-00016 legacy draft order = %d/%d/%q, want explicit zero order", afterModificationPhysicalMillis, afterModificationLogicalCounter, afterModificationClientID)
	}
	var invalidMarkerCount int
	if err := db.Pool().QueryRow(ctx, `
		SELECT count(*) FROM execution_commands
		WHERE exact_ack_state NOT IN ('', 'executing', 'succeeded', 'failed', 'rejected')
	`).Scan(&invalidMarkerCount); err != nil {
		t.Fatalf("validate migrated ACK markers: %v", err)
	}
	if invalidMarkerCount != 0 {
		t.Fatalf("migrated invalid ACK marker rows = %d, want 0", invalidMarkerCount)
	}

	if _, err := db.Pool().Exec(ctx, `
		UPDATE execution_commands
		SET exact_ack_state = 'executing'
		WHERE command_id = $1
	`, commandID); err != nil {
		t.Fatalf("seed existing ACK marker: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `
		UPDATE execution_commands
		SET state = 'failed', operation_id = 'legacy-terminal-operation',
		    result = convert_to('{"failed":true}', 'UTF8'), event_cursor = 'legacy-terminal-cursor',
		    reconciliation_state = 'confirmed'
		WHERE command_id = $1
	`, commandID); err != nil {
		t.Fatalf("simulate 00013 writer update: %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT exact_ack_state FROM execution_commands WHERE command_id = $1
	`, commandID).Scan(&exactAckState); err != nil {
		t.Fatalf("read preserved ACK marker: %v", err)
	}
	if exactAckState != "executing" {
		t.Fatalf("preserved ACK marker = %q, want executing", exactAckState)
	}
	if _, err := provider.UpTo(ctx, 16); err != nil {
		t.Fatalf("re-enter 00016 migration: %v", err)
	}
}

func openDraftMigrationFixtureDatabaseThrough(t *testing.T, targetVersion int64) (*database.DB, *goose.Provider) {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatalf("load migration database configuration: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	root, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 2})
	if err != nil {
		t.Fatalf("open migration root database: %v", err)
	}
	schema := fmt.Sprintf("e01_draft_migration_%d", time.Now().UnixNano())
	quotedSchema := quoteDraftMigrationIdentifier(schema)
	if _, err := root.Pool().Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		root.Close()
		t.Fatalf("create migration fixture schema: %v", err)
	}
	scopedURL, err := draftMigrationURLWithSearchPath(config.URL, schema)
	if err != nil {
		_, _ = root.Pool().Exec(context.Background(), "DROP SCHEMA "+quotedSchema+" CASCADE")
		root.Close()
		t.Fatalf("scope migration fixture database URL: %v", err)
	}
	scoped, err := database.Open(ctx, database.Config{URL: scopedURL, MinConns: 1, MaxConns: 2})
	if err != nil {
		_, _ = root.Pool().Exec(context.Background(), "DROP SCHEMA "+quotedSchema+" CASCADE")
		root.Close()
		t.Fatalf("open scoped migration fixture database: %v", err)
	}
	sqlDB := stdlib.OpenDBFromPool(scoped.Pool())
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		sqlDB.Close()
		scoped.Close()
		_, _ = root.Pool().Exec(context.Background(), "DROP SCHEMA "+quotedSchema+" CASCADE")
		root.Close()
		t.Fatalf("create migration fixture provider: %v", err)
	}
	if _, err := provider.UpTo(ctx, targetVersion); err != nil {
		provider.Close()
		sqlDB.Close()
		scoped.Close()
		_, _ = root.Pool().Exec(context.Background(), "DROP SCHEMA "+quotedSchema+" CASCADE")
		root.Close()
		t.Fatalf("migrate fixture to %d: %v", targetVersion, err)
	}
	t.Cleanup(func() {
		provider.Close()
		sqlDB.Close()
		scoped.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := root.Pool().Exec(cleanupCtx, "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Errorf("drop migration fixture schema: %v", err)
		}
		root.Close()
	})
	return scoped, provider
}

func draftMigrationURLWithSearchPath(rawURL, schema string) (string, error) {
	if strings.Contains(rawURL, "://") {
		parsed, err := url.Parse(rawURL)
		if err != nil {
			return "", err
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		return parsed.String(), nil
	}
	return strings.TrimSpace(rawURL) + " search_path=" + schema, nil
}

func quoteDraftMigrationIdentifier(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
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
	state       protocol.ReconciliationState
	eventCursor string
	sendCalls   int
}

func (t *matchingReconciliationTransport) SendCommand(context.Context, protocol.Command) (protocol.CommandAck, error) {
	t.sendCalls++
	return protocol.CommandAck{}, errors.New("unexpected command send during reconciliation")
}

func (t *matchingReconciliationTransport) ReconcileCommand(_ context.Context, command protocol.Command) (protocol.Reconciliation, error) {
	var eventCursor *string
	if t.eventCursor != "" {
		cursor := t.eventCursor
		eventCursor = &cursor
	}
	return protocol.Reconciliation{CommandID: command.CommandID, EventCursor: eventCursor, State: t.state}, nil
}
