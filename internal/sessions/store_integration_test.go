package sessions

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/db/migrations"
	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

func TestCreationIntentLifecycleAndCompatibility(t *testing.T) {
	db := openSessionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	ids := sessionIntegrationIDs{user: "e01-session-user-" + suffix, project: "e01-session-project-" + suffix, task: "e01-session-task-" + suffix}
	host := ensureSessionHost(t, ctx, db)
	seedSessionIdentity(t, ctx, db, ids, host.ID)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanupSessionIdentity(t, cleanupCtx, db, ids, host)
	})

	store := NewStore(db.Pool())
	legacy, err := store.Create(ctx, NewInput{
		ID:                "e01-legacy-session-" + suffix,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: "e01-legacy-thread-" + suffix,
		Generation:        "legacy-execution-" + suffix,
	})
	if err != nil {
		t.Fatalf("create legacy session: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := db.Pool().Exec(cleanupCtx, `DELETE FROM execution_sessions WHERE id = $1`, legacy.ID); err != nil {
			t.Errorf("cleanup legacy session %q: %v", legacy.ID, err)
		}
	})
	if got, err := store.Get(ctx, legacy.ID); err != nil || got.ExternalThreadRef != legacy.ExternalThreadRef {
		t.Fatalf("read legacy session = %+v, error = %v", got, err)
	}
	legacyAccess, err := store.GetAccess(ctx, legacy.ID)
	if err != nil {
		t.Fatalf("read legacy access facts: %v", err)
	}
	if legacyAccess.CreatorUserID != `` || legacyAccess.HostID != `` || !legacyAccess.Confirmed {
		t.Fatalf("legacy access facts = %+v", legacyAccess)
	}

	input := CreationIntentInput{
		SessionID:     "e01-intent-session-" + suffix,
		CommandID:     "e01-intent-command-" + suffix,
		CreatorUserID: ids.user,
		HostID:        host.ID,
		Path:          protocol.SessionPathNew,
		ProjectID:     ids.project,
		TaskID:        ids.task,
		Parameters:    []byte(`{"path":"new","prompt":"persisted before side effect"}`),
		Summary:       "create a project task conversation",
	}
	intent, err := store.CreateIntent(ctx, input)
	if err != nil {
		t.Fatalf("create session intent: %v", err)
	}
	if intent.SessionID != input.SessionID || intent.State != IntentStatePending || intent.ExternalThreadRef != `` || intent.ExecutionGeneration != `` {
		t.Fatalf("created session intent = %+v", intent)
	}
	if _, err := store.Get(ctx, input.SessionID); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("Get(unconfirmed) error = %v, want ErrSessionNotFound", err)
	}
	access, err := store.GetAccess(ctx, input.SessionID)
	if err != nil {
		t.Fatalf("read intent access facts: %v", err)
	}
	if access.CreatorUserID != ids.user || access.HostID != host.ID || access.ProjectID != ids.project || access.Confirmed {
		t.Fatalf("intent access facts = %+v", access)
	}

	retryWithNewSessionID := input
	retryWithNewSessionID.SessionID = input.SessionID + "-retry"
	retried, err := store.CreateIntent(ctx, retryWithNewSessionID)
	if err != nil {
		t.Fatalf("retry session intent: %v", err)
	}
	if retried.SessionID != input.SessionID {
		t.Fatalf("retry returned session id %q, want %q", retried.SessionID, input.SessionID)
	}
	conflict := input
	conflict.Parameters = []byte(`{"path":"new","prompt":"different"}`)
	if _, err := store.CreateIntent(ctx, conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("changed creation parameters error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}

	unknown, err := store.MarkIntentUnknown(ctx, UnknownIntentInput{
		SessionID: input.SessionID,
		Reason:    "Gateway response was lost",
	})
	if err != nil {
		t.Fatalf("mark session intent unknown: %v", err)
	}
	if unknown.State != IntentStateUnknown || unknown.UnknownReason != "Gateway response was lost" {
		t.Fatalf("unknown session intent = %+v", unknown)
	}
	unknownRetry, err := store.CreateIntent(ctx, input)
	if err != nil {
		t.Fatalf("retry unknown session intent: %v", err)
	}
	if unknownRetry.State != IntentStateUnknown || unknownRetry.SessionID != input.SessionID {
		t.Fatalf("unknown retry = %+v", unknownRetry)
	}

	active, err := store.ActivateIntent(ctx, ActivationInput{
		SessionID:           input.SessionID,
		ExternalThreadRef:   "e01-confirmed-thread-" + suffix,
		ExecutionGeneration: "codex-execution-" + suffix,
	})
	if err != nil {
		t.Fatalf("activate session intent: %v", err)
	}
	if active.State != protocol.SessionStateActive || active.ExternalThreadRef == `` || active.Generation == `` || optionalStringValue(active.TaskID) != ids.task {
		t.Fatalf("activated session = %+v", active)
	}
	var taskSessionID string
	if err := db.Pool().QueryRow(ctx, `SELECT session_id FROM tasks WHERE id = $1`, ids.task).Scan(&taskSessionID); err != nil {
		t.Fatalf("read activated task binding: %v", err)
	}
	if taskSessionID != input.SessionID {
		t.Fatalf("task session id = %q, want %q", taskSessionID, input.SessionID)
	}
	confirmedRetry := input
	confirmedRetry.SessionID = input.SessionID + "-confirmed-retry"
	confirmed, err := store.CreateIntent(ctx, confirmedRetry)
	if err != nil {
		t.Fatalf("retry confirmed session intent with a new provisional id: %v", err)
	}
	if confirmed.SessionID != input.SessionID || confirmed.State != IntentStateConfirmed || confirmed.ExternalThreadRef != active.ExternalThreadRef || confirmed.ExecutionGeneration != active.Generation {
		t.Fatalf("confirmed retry = %+v", confirmed)
	}
	var intentCount int
	if err := db.Pool().QueryRow(ctx, `
		SELECT count(*)
		FROM execution_sessions
		WHERE creator_user_id = $1 AND creation_command_id = $2
	`, input.CreatorUserID, input.CommandID).Scan(&intentCount); err != nil {
		t.Fatalf("count persisted creation intents: %v", err)
	}
	if intentCount != 1 {
		t.Fatalf("persisted creation intents = %d, want 1", intentCount)
	}
	conflictVariants := []struct {
		name   string
		mutate func(*CreationIntentInput)
	}{
		{name: "payload", mutate: func(candidate *CreationIntentInput) {
			candidate.Parameters = []byte(`{"path":"new","prompt":"different after activation"}`)
		}},
		{name: "summary", mutate: func(candidate *CreationIntentInput) { candidate.Summary = "different summary" }},
		{name: "host", mutate: func(candidate *CreationIntentInput) { candidate.HostID = candidate.HostID + "-different" }},
		{name: "target", mutate: func(candidate *CreationIntentInput) { candidate.TaskID = candidate.TaskID + "-different" }},
	}
	for _, variant := range conflictVariants {
		t.Run("confirmed retry conflict/"+variant.name, func(t *testing.T) {
			candidate := confirmedRetry
			variant.mutate(&candidate)
			if _, err := store.CreateIntent(ctx, candidate); !errors.Is(err, protocol.ErrIdempotencyConflict) {
				t.Fatalf("changed %s error = %v, want %v", variant.name, err, protocol.ErrIdempotencyConflict)
			}
		})
	}
	if _, err := store.ActivateIntent(ctx, ActivationInput{
		SessionID:           input.SessionID,
		ExternalThreadRef:   active.ExternalThreadRef,
		ExecutionGeneration: active.Generation,
	}); err != nil {
		t.Fatalf("repeat session activation: %v", err)
	}
	if _, err := store.ActivateIntent(ctx, ActivationInput{
		SessionID:           input.SessionID,
		ExternalThreadRef:   "different-thread",
		ExecutionGeneration: active.Generation,
	}); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("conflicting activation error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}
}

func TestCreationIntentConcurrentSameCommandConverges(t *testing.T) {
	db := openSessionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "e01-race-user-" + suffix
	host := ensureSessionHost(t, ctx, db)
	seedSessionUser(t, ctx, db, userID)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanupSessionIdentity(t, cleanupCtx, db, sessionIntegrationIDs{user: userID}, host)
	})

	base := CreationIntentInput{
		SessionID:     "e01-race-session-" + suffix,
		CommandID:     "e01-race-command-" + suffix,
		CreatorUserID: userID,
		HostID:        host.ID,
		Path:          protocol.SessionPathNew,
		Parameters:    []byte(`{"prompt":"same intent"}`),
		Summary:       "race",
	}
	const attempts = 8
	results := make(chan CreationIntent, attempts)
	errs := make(chan error, attempts)
	var group sync.WaitGroup
	for i := 0; i < attempts; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			intent, err := NewStore(db.Pool()).CreateIntent(ctx, base)
			if err != nil {
				errs <- err
				return
			}
			results <- intent
		}()
	}
	group.Wait()
	close(results)
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent intent creation: %v", err)
	}
	for intent := range results {
		if intent.SessionID != base.SessionID || intent.State != IntentStatePending {
			t.Fatalf("concurrent intent result = %+v", intent)
		}
	}
}

func TestSessionIntentMigrationReentry(t *testing.T) {
	db := openSessionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("repeat database migration: %v", err)
	}
	var appliedCount int
	if err := db.Pool().QueryRow(ctx, `
		SELECT count(*)
		FROM goose_db_version
		WHERE version_id IN (9, 10, 11, 12) AND is_applied
	`).Scan(&appliedCount); err != nil {
		t.Fatalf("read applied migration versions: %v", err)
	}
	if appliedCount != 4 {
		t.Fatalf("applied 00009/00010/00011/00012 migration records = %d, want 4", appliedCount)
	}
	var intentIndexCount int
	if err := db.Pool().QueryRow(ctx, `
		SELECT count(*)
		FROM pg_indexes
		WHERE schemaname = current_schema()
		  AND indexname IN (
			'execution_sessions_creator_command_idx',
			'execution_sessions_creator_idx',
			'execution_sessions_host_idx',
			'execution_sessions_creation_task_idx'
		  )
	`).Scan(&intentIndexCount); err != nil {
		t.Fatalf("read session intent indexes: %v", err)
	}
	if intentIndexCount != 4 {
		t.Fatalf("session intent index count = %d, want 4", intentIndexCount)
	}

}

func TestSessionIntentMigrationFrom00009(t *testing.T) {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == `` {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}

	config := sessionTestDatabaseConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	root, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 1})
	if err != nil {
		t.Fatalf("open migration fixture database: %v", err)
	}
	defer root.Close()

	schema := fmt.Sprintf("e01_session_migration_%d", time.Now().UnixNano())
	if _, err := root.Pool().Exec(ctx, "CREATE SCHEMA "+quoteSessionTestIdentifier(schema)); err != nil {
		t.Fatalf("create migration fixture schema: %v", err)
	}
	defer func() {
		if _, err := root.Pool().Exec(context.Background(), "DROP SCHEMA "+quoteSessionTestIdentifier(schema)+" CASCADE"); err != nil {
			t.Errorf("drop migration fixture schema: %v", err)
		}
	}()

	scopedURL, err := sessionURLWithSearchPath(config.URL, schema)
	if err != nil {
		t.Fatalf("scope migration fixture database URL: %v", err)
	}
	scoped, err := database.Open(ctx, database.Config{URL: scopedURL, MinConns: 1, MaxConns: 1})
	if err != nil {
		t.Fatalf("open scoped migration fixture database: %v", err)
	}
	defer scoped.Close()
	sqlDB := stdlib.OpenDBFromPool(scoped.Pool())
	defer sqlDB.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		t.Fatalf("create session intent migration provider: %v", err)
	}
	defer provider.Close()
	if _, err := provider.UpTo(ctx, 9); err != nil {
		t.Fatalf("apply migration fixture through 00009: %v", err)
	}
	const (
		legacyID         = "e01-migration-legacy-00009"
		legacyThread     = "e01-migration-legacy-thread"
		legacyGeneration = "e01-migration-legacy-generation"
	)
	if _, err := scoped.Pool().Exec(ctx, `
		INSERT INTO execution_sessions (id, external_thread_ref, path, state, project_id, generation, last_cursor, terminal_reason)
		VALUES ($1, $2, 'new', 'active', NULL, $3, '', '')
	`, legacyID, legacyThread, legacyGeneration); err != nil {
		t.Fatalf("seed pre-00010 legacy session row: %v", err)
	}
	if _, err := scoped.Pool().Exec(ctx, `CREATE INDEX execution_sessions_creator_command_idx ON execution_sessions (id)`); err != nil {
		t.Fatalf("create deliberate 00010 migration collision: %v", err)
	}
	if _, err := provider.UpTo(ctx, 10); err == nil {
		t.Fatal("00010 migration collision unexpectedly succeeded")
	}
	var applied10 int
	if err := scoped.Pool().QueryRow(ctx, `SELECT count(*) FROM goose_db_version WHERE version_id = 10 AND is_applied`).Scan(&applied10); err != nil {
		t.Fatalf("read failed 00010 migration history: %v", err)
	}
	if applied10 != 0 {
		t.Fatalf("failed 00010 migration recorded as applied: %d", applied10)
	}
	var creationStateColumns int
	if err := scoped.Pool().QueryRow(ctx, `
		SELECT count(*)
		FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'execution_sessions' AND column_name = 'creation_state'
	`).Scan(&creationStateColumns); err != nil {
		t.Fatalf("read rolled-back 00010 columns: %v", err)
	}
	if creationStateColumns != 0 {
		t.Fatalf("rolled-back 00010 left creation_state column count = %d", creationStateColumns)
	}
	var externalThread, generation string
	if err := scoped.Pool().QueryRow(ctx, `SELECT external_thread_ref, generation FROM execution_sessions WHERE id = $1`, legacyID).Scan(&externalThread, &generation); err != nil {
		t.Fatalf("read legacy row after failed 00010: %v", err)
	}
	if externalThread != legacyThread || generation != legacyGeneration {
		t.Fatalf("legacy row changed after failed 00010: thread=%q generation=%q", externalThread, generation)
	}
	if _, err := scoped.Pool().Exec(ctx, `DROP INDEX execution_sessions_creator_command_idx`); err != nil {
		t.Fatalf("remove deliberate 00010 migration collision: %v", err)
	}
	if _, err := provider.UpTo(ctx, 10); err != nil {
		t.Fatalf("re-enter 00010 migration after cleanup: %v", err)
	}
	if _, err := provider.UpTo(ctx, 10); err != nil {
		t.Fatalf("repeat 00010 migration: %v", err)
	}
	if err := scoped.Pool().QueryRow(ctx, `SELECT count(*) FROM goose_db_version WHERE version_id = 10 AND is_applied`).Scan(&applied10); err != nil {
		t.Fatalf("read successful 00010 migration history: %v", err)
	}
	if applied10 != 1 {
		t.Fatalf("successful 00010 migration records = %d, want 1", applied10)
	}
	var migratedState string
	var creatorUserID, hostID, commandID *string
	if err := scoped.Pool().QueryRow(ctx, `
		SELECT external_thread_ref, generation, creation_state, creator_user_id, host_id, creation_command_id
		FROM execution_sessions WHERE id = $1
	`, legacyID).Scan(&externalThread, &generation, &migratedState, &creatorUserID, &hostID, &commandID); err != nil {
		t.Fatalf("read legacy row after successful 00010: %v", err)
	}
	if externalThread != legacyThread || generation != legacyGeneration || migratedState != "confirmed" || creatorUserID != nil || hostID != nil || commandID != nil {
		t.Fatalf("migrated legacy row = thread %q generation %q state %q creator %v host %v command %v", externalThread, generation, migratedState, creatorUserID, hostID, commandID)
	}
}

func TestApprovalHistoryMigrationFrom00010SupportsFailureReentry(t *testing.T) {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == `` {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}

	config := sessionTestDatabaseConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	root, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 2})
	if err != nil {
		t.Fatalf("open approval migration fixture database: %v", err)
	}
	defer root.Close()

	schema := fmt.Sprintf("e01_approval_migration_%d", time.Now().UnixNano())
	if _, err := root.Pool().Exec(ctx, "CREATE SCHEMA "+quoteSessionTestIdentifier(schema)); err != nil {
		t.Fatalf("create approval migration fixture schema: %v", err)
	}
	defer func() {
		if _, err := root.Pool().Exec(context.Background(), "DROP SCHEMA "+quoteSessionTestIdentifier(schema)+" CASCADE"); err != nil {
			t.Errorf("drop approval migration fixture schema: %v", err)
		}
	}()

	scopedURL, err := sessionURLWithSearchPath(config.URL, schema)
	if err != nil {
		t.Fatalf("scope approval migration fixture database URL: %v", err)
	}
	scoped, err := database.Open(ctx, database.Config{URL: scopedURL, MinConns: 1, MaxConns: 2})
	if err != nil {
		t.Fatalf("open scoped approval migration fixture database: %v", err)
	}
	defer scoped.Close()

	sqlDB := stdlib.OpenDBFromPool(scoped.Pool())
	defer sqlDB.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		t.Fatalf("create approval migration provider: %v", err)
	}
	if _, err := provider.UpTo(ctx, 10); err != nil {
		t.Fatalf("apply approval migration fixture through 00010: %v", err)
	}
	const (
		sessionID  = "e01-approval-migration-session"
		runID      = "e01-approval-migration-run"
		commandID  = "e01-approval-migration-command"
		approvalID = "e01-approval-migration-approval"
	)
	if _, err := scoped.Pool().Exec(ctx, `
		INSERT INTO execution_sessions (id, external_thread_ref, path, generation)
		VALUES ($1, $2, 'new', $3)
	`, sessionID, "e01-approval-migration-thread", "e01-approval-migration-generation"); err != nil {
		t.Fatalf("seed pre-00011 session: %v", err)
	}
	if _, err := scoped.Pool().Exec(ctx, `
		INSERT INTO execution_runs (id, session_id, command_id, generation)
		VALUES ($1, $2, $3, $4)
	`, runID, sessionID, commandID, "e01-approval-migration-generation"); err != nil {
		t.Fatalf("seed pre-00011 run: %v", err)
	}
	legacyContext := []byte(`{"legacy":true,"unknown_field":"retained"}`)
	if _, err := scoped.Pool().Exec(ctx, `
		INSERT INTO execution_approvals (id, session_id, run_id, generation, kind, requested_at, revision, status, summary, context, requested_event_id)
		VALUES ($1, $2, $3, $4, 'command', $5, 7, 'pending', 'legacy approval', $6, $7)
	`, approvalID, sessionID, runID, "e01-approval-migration-generation", "2026-10-25T00:00:00Z", legacyContext, "e01-approval-migration-event"); err != nil {
		t.Fatalf("seed pre-00011 approval: %v", err)
	}

	if _, err := scoped.Pool().Exec(ctx, `CREATE INDEX execution_approvals_run_created_idx ON execution_approvals (id)`); err != nil {
		t.Fatalf("create deliberate migration collision: %v", err)
	}
	if _, err := provider.UpTo(ctx, 11); err == nil {
		t.Fatal("00011 migration collision unexpectedly succeeded")
	}
	var applied11 int
	if err := scoped.Pool().QueryRow(ctx, `SELECT count(*) FROM goose_db_version WHERE version_id = 11 AND is_applied`).Scan(&applied11); err != nil {
		t.Fatalf("read failed 00011 history: %v", err)
	}
	if applied11 != 0 {
		t.Fatalf("failed 00011 migration recorded as applied: %d", applied11)
	}
	if _, err := scoped.Pool().Exec(ctx, `DROP INDEX execution_approvals_run_created_idx`); err != nil {
		t.Fatalf("remove deliberate migration collision: %v", err)
	}
	if _, err := provider.UpTo(ctx, 11); err != nil {
		t.Fatalf("re-enter 00011 migration after forward cleanup: %v", err)
	}
	if _, err := provider.UpTo(ctx, 11); err != nil {
		t.Fatalf("repeat 00011 migration: %v", err)
	}
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("apply 00012 approval revision history migration: %v", err)
	}

	var indexCount, appliedCount int
	if err := scoped.Pool().QueryRow(ctx, `
		SELECT count(*)
		FROM pg_indexes
		WHERE schemaname = current_schema()
		  AND indexname = 'execution_approvals_run_created_idx'
	`).Scan(&indexCount); err != nil {
		t.Fatalf("read approval history index: %v", err)
	}
	if indexCount != 1 {
		t.Fatalf("approval history index count = %d, want 1", indexCount)
	}
	if err := scoped.Pool().QueryRow(ctx, `SELECT count(*) FROM goose_db_version WHERE version_id = 11 AND is_applied`).Scan(&appliedCount); err != nil {
		t.Fatalf("read successful 00011 history: %v", err)
	}
	if appliedCount != 1 {
		t.Fatalf("successful 00011 migration records = %d, want 1", appliedCount)
	}
	page, err := approvals.NewStore(scoped.Pool()).ListByRun(ctx, runID, nil, 10)
	if err != nil {
		t.Fatalf("read legacy approval after 00011: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != approvalID || page.Items[0].Revision != 7 || string(page.Items[0].Context) != string(legacyContext) || page.Items[0].RequestedEventID != "e01-approval-migration-event" {
		t.Fatalf("legacy approval after 00011 = %+v", page.Items)
	}
}

func TestApprovalRevisionHistoryMigrationFrom00011SupportsFailureReentry(t *testing.T) {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == `` {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}

	config := sessionTestDatabaseConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	root, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 2})
	if err != nil {
		t.Fatalf("open approval revision migration fixture database: %v", err)
	}
	defer root.Close()

	schema := fmt.Sprintf("e01_approval_revision_migration_%d", time.Now().UnixNano())
	if _, err := root.Pool().Exec(ctx, "CREATE SCHEMA "+quoteSessionTestIdentifier(schema)); err != nil {
		t.Fatalf("create approval revision migration fixture schema: %v", err)
	}
	defer func() {
		if _, err := root.Pool().Exec(context.Background(), "DROP SCHEMA "+quoteSessionTestIdentifier(schema)+" CASCADE"); err != nil {
			t.Errorf("drop approval revision migration fixture schema: %v", err)
		}
	}()

	scopedURL, err := sessionURLWithSearchPath(config.URL, schema)
	if err != nil {
		t.Fatalf("scope approval revision migration fixture database URL: %v", err)
	}
	scoped, err := database.Open(ctx, database.Config{URL: scopedURL, MinConns: 1, MaxConns: 2})
	if err != nil {
		t.Fatalf("open scoped approval revision migration database: %v", err)
	}
	defer scoped.Close()

	sqlDB := stdlib.OpenDBFromPool(scoped.Pool())
	defer sqlDB.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		t.Fatalf("create approval revision migration provider: %v", err)
	}
	defer provider.Close()
	if _, err := provider.UpTo(ctx, 11); err != nil {
		t.Fatalf("apply approval revision migration fixture through 00011: %v", err)
	}
	const (
		sessionID  = "e01-approval-revision-migration-session"
		runID      = "e01-approval-revision-migration-run"
		commandID  = "e01-approval-revision-migration-command"
		approvalID = "e01-approval-revision-migration-approval"
	)
	if _, err := scoped.Pool().Exec(ctx, `
		INSERT INTO execution_sessions (id, external_thread_ref, path, generation)
		VALUES ($1, $2, 'new', $3)
	`, sessionID, "e01-approval-revision-migration-thread", "e01-approval-revision-migration-generation"); err != nil {
		t.Fatalf("seed approval revision session: %v", err)
	}
	if _, err := scoped.Pool().Exec(ctx, `
		INSERT INTO execution_runs (id, session_id, command_id, generation)
		VALUES ($1, $2, $3, $4)
	`, runID, sessionID, commandID, "e01-approval-revision-migration-generation"); err != nil {
		t.Fatalf("seed approval revision run: %v", err)
	}
	legacyContext := []byte(`{"legacy":true,"unknown_field":"retained"}`)
	if _, err := scoped.Pool().Exec(ctx, `
		INSERT INTO execution_approvals (id, session_id, run_id, generation, kind, requested_at, revision, status, summary, context, requested_event_id)
		VALUES ($1, $2, $3, $4, 'command', $5, 7, 'pending', 'legacy approval', $6, $7)
	`, approvalID, sessionID, runID, "e01-approval-revision-migration-generation", "2026-10-25T00:00:00Z", legacyContext, "e01-approval-revision-migration-event"); err != nil {
		t.Fatalf("seed approval revision projection: %v", err)
	}

	if _, err := scoped.Pool().Exec(ctx, `CREATE INDEX execution_approval_revisions_run_cursor_idx ON execution_approvals (id)`); err != nil {
		t.Fatalf("create deliberate 00012 migration collision: %v", err)
	}
	if _, err := provider.UpTo(ctx, 12); err == nil {
		t.Fatal("00012 migration collision unexpectedly succeeded")
	}
	var applied12 int
	if err := scoped.Pool().QueryRow(ctx, `SELECT count(*) FROM goose_db_version WHERE version_id = 12 AND is_applied`).Scan(&applied12); err != nil {
		t.Fatalf("read failed 00012 migration history: %v", err)
	}
	if applied12 != 0 {
		t.Fatalf("failed 00012 migration recorded as applied: %d", applied12)
	}
	var historyTableCount, historyRowCount int
	if err := scoped.Pool().QueryRow(ctx, `
		SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = 'execution_approval_revisions'
	`).Scan(&historyTableCount); err != nil {
		t.Fatalf("read rolled-back history table: %v", err)
	}
	if historyTableCount != 0 {
		t.Fatalf("rolled-back history table count = %d, want 0", historyTableCount)
	}
	if err := scoped.Pool().QueryRow(ctx, `SELECT count(*) FROM execution_approvals WHERE id = $1`, approvalID).Scan(&historyRowCount); err != nil {
		t.Fatalf("read unchanged current projection: %v", err)
	}
	if historyRowCount != 1 {
		t.Fatalf("current projection row count after failed 00012 = %d, want 1", historyRowCount)
	}
	if _, err := scoped.Pool().Exec(ctx, `DROP INDEX execution_approval_revisions_run_cursor_idx`); err != nil {
		t.Fatalf("remove deliberate 00012 migration collision: %v", err)
	}
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("re-enter 00012 migration after cleanup: %v", err)
	}
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("repeat 00012 migration: %v", err)
	}
	if err := scoped.Pool().QueryRow(ctx, `SELECT count(*) FROM goose_db_version WHERE version_id = 12 AND is_applied`).Scan(&applied12); err != nil {
		t.Fatalf("read successful 00012 migration history: %v", err)
	}
	if applied12 != 1 {
		t.Fatalf("successful 00012 migration records = %d, want 1", applied12)
	}
	if err := scoped.Pool().QueryRow(ctx, `
		SELECT count(*) FROM execution_approval_revisions
		WHERE id = $1 AND revision = 7 AND context = $2 AND requested_event_id = $3
	`, approvalID, legacyContext, "e01-approval-revision-migration-event").Scan(&historyRowCount); err != nil {
		t.Fatalf("read backfilled approval revision: %v", err)
	}
	if historyRowCount != 1 {
		t.Fatalf("backfilled approval revision count = %d, want 1", historyRowCount)
	}
	page, err := approvals.NewStore(scoped.Pool()).ListByRun(ctx, runID, nil, 10)
	if err != nil {
		t.Fatalf("read backfilled approval history: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != approvalID || page.Items[0].Revision != 7 || string(page.Items[0].Context) != string(legacyContext) {
		t.Fatalf("backfilled approval history = %+v", page.Items)
	}
}

type sessionIntegrationIDs struct {
	user    string
	project string
	task    string
}

func openSessionDatabase(t *testing.T) *database.DB {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == `` {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	config := sessionTestDatabaseConfig(t)
	db, err := database.Open(context.Background(), config)
	if err != nil {
		t.Fatalf("open session database: %v", err)
	}
	if err := db.Migrate(context.Background()); err != nil {
		db.Close()
		t.Fatalf("migrate session database: %v", err)
	}
	t.Cleanup(db.Close)
	return db
}

func sessionTestDatabaseConfig(t *testing.T) database.Config {
	t.Helper()
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatalf("load database configuration: %v", err)
	}
	return database.Config{URL: config.URL, MinConns: 1, MaxConns: 8}
}

func sessionURLWithSearchPath(rawURL, schema string) (string, error) {
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

type sessionHostFixture struct {
	ID      string
	Created bool
}

func ensureSessionHost(t *testing.T, ctx context.Context, db *database.DB) sessionHostFixture {
	t.Helper()
	var hostID string
	err := db.Pool().QueryRow(ctx, `SELECT id FROM host_registrations WHERE singleton_key = 'default'`).Scan(&hostID)
	if err == nil {
		return sessionHostFixture{ID: hostID}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("read session host: %v", err)
	}
	hostID = "e01-session-host-" + fmt.Sprintf("%d", time.Now().UnixNano())
	var insertedHostID string
	err = db.Pool().QueryRow(ctx, `
		INSERT INTO host_registrations (id, name)
		VALUES ($1, $2)
		ON CONFLICT (singleton_key) DO NOTHING
		RETURNING id
	`, hostID, "E01 session integration host").Scan(&insertedHostID)
	if err == nil {
		return sessionHostFixture{ID: insertedHostID, Created: true}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("seed session host: %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT id FROM host_registrations WHERE singleton_key = 'default'`).Scan(&hostID); err != nil {
		t.Fatalf("read session host: %v", err)
	}
	return sessionHostFixture{ID: hostID}
}

func seedSessionIdentity(t *testing.T, ctx context.Context, db *database.DB, ids sessionIntegrationIDs, hostID string) {
	t.Helper()
	seedSessionUser(t, ctx, db, ids.user)
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO projects (id, name, created_by)
		VALUES ($1, $2, $3)
	`, ids.project, "E01 session integration project", ids.user); err != nil {
		t.Fatalf("seed session project: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO tasks (id, project_id, title, goal)
		VALUES ($1, $2, $3, $4)
	`, ids.task, ids.project, "E01 session integration task", "bind atomically"); err != nil {
		t.Fatalf("seed session task: %v", err)
	}
	var exists bool
	if err := db.Pool().QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM host_registrations WHERE id = $1)`, hostID).Scan(&exists); err != nil || !exists {
		t.Fatalf("session host %q is not present, error = %v", hostID, err)
	}
}

func seedSessionUser(t *testing.T, ctx context.Context, db *database.DB, userID string) {
	t.Helper()
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject)
		VALUES ($1, $2, $3)
	`, userID, "e01-session-test", userID); err != nil {
		t.Fatalf("seed session user: %v", err)
	}
}

func cleanupSessionIdentity(t *testing.T, ctx context.Context, db *database.DB, ids sessionIntegrationIDs, host sessionHostFixture) {
	t.Helper()
	cleanup := func(label, query string, args ...any) {
		if _, err := db.Pool().Exec(ctx, query, args...); err != nil {
			t.Errorf("cleanup %s: %v", label, err)
		}
	}
	if ids.user != `` {
		cleanup("execution control leases", `
			DELETE FROM execution_control_leases
			WHERE session_id IN (SELECT id FROM execution_sessions WHERE creator_user_id = $1)
		`, ids.user)
		cleanup("execution approval revisions", `
				DELETE FROM execution_approval_revisions
				WHERE session_id IN (SELECT id FROM execution_sessions WHERE creator_user_id = $1)
			`, ids.user)
		cleanup("execution approvals", `
			DELETE FROM execution_approvals
			WHERE session_id IN (SELECT id FROM execution_sessions WHERE creator_user_id = $1)
		`, ids.user)
		cleanup("execution events", `
			DELETE FROM execution_events
			WHERE session_id IN (SELECT id FROM execution_sessions WHERE creator_user_id = $1)
		`, ids.user)
		cleanup("execution runs", `
			DELETE FROM execution_runs
			WHERE session_id IN (SELECT id FROM execution_sessions WHERE creator_user_id = $1)
		`, ids.user)
		cleanup("execution commands", `
			DELETE FROM execution_commands
			WHERE session_id IN (SELECT id FROM execution_sessions WHERE creator_user_id = $1)
		`, ids.user)
		cleanup("execution sessions", `DELETE FROM execution_sessions WHERE creator_user_id = $1`, ids.user)
	}
	if ids.task != `` {
		cleanup("task", `DELETE FROM tasks WHERE id = $1`, ids.task)
	}
	if ids.project != `` {
		cleanup("project", `DELETE FROM projects WHERE id = $1`, ids.project)
	}
	if ids.user != `` {
		cleanup("auth user", `DELETE FROM auth_users WHERE id = $1`, ids.user)
	}
	if host.Created {
		cleanup("test-owned host", `DELETE FROM host_registrations WHERE id = $1 AND singleton_key = 'default'`, host.ID)
	}
}

func quoteSessionTestIdentifier(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}
