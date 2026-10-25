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

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
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

func TestSessionIntentMigrationReentryAndAtomicRollback(t *testing.T) {
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
		WHERE version_id IN (9, 10) AND is_applied
	`).Scan(&appliedCount); err != nil {
		t.Fatalf("read applied migration versions: %v", err)
	}
	if appliedCount != 2 {
		t.Fatalf("applied 00009/00010 migration records = %d, want 2", appliedCount)
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

	probe := fmt.Sprintf("e01_session_schema_atomic_probe_%d", time.Now().UnixNano())
	quotedProbe := quoteSessionTestIdentifier(probe)
	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin atomic schema probe: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "CREATE TABLE "+quotedProbe+" (id TEXT PRIMARY KEY)"); err != nil {
		t.Fatalf("create atomic schema probe: %v", err)
	}
	if _, err := tx.Exec(ctx, "ALTER TABLE "+quotedProbe+" ADD COLUMN creation_state TEXT"); err != nil {
		t.Fatalf("extend atomic schema probe: %v", err)
	}
	if _, err := tx.Exec(ctx, "CREATE INDEX "+quoteSessionTestIdentifier(probe+"_idx")+" ON "+quotedProbe+" (creation_state)"); err != nil {
		t.Fatalf("index atomic schema probe: %v", err)
	}
	if _, err := tx.Exec(ctx, "ALTER TABLE "+quotedProbe+" ADD COLUMN invalid_state e01_missing_type"); err == nil {
		t.Fatal("failing atomic schema probe unexpectedly succeeded")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback atomic schema probe: %v", err)
	}
	var probeExists bool
	if err := db.Pool().QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = $1)`, probe).Scan(&probeExists); err != nil {
		t.Fatalf("check rolled back schema probe: %v", err)
	}
	if probeExists {
		t.Fatalf("rolled back schema probe %q still exists", probe)
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
	if err := scoped.Migrate(ctx); err != nil {
		t.Fatalf("apply 00009 to 00010 migration fixture: %v", err)
	}
	var appliedCount int
	if err := scoped.Pool().QueryRow(ctx, `
		SELECT count(*)
		FROM goose_db_version
		WHERE version_id IN (9, 10) AND is_applied
	`).Scan(&appliedCount); err != nil {
		t.Fatalf("read fresh migration fixture history: %v", err)
	}
	if appliedCount != 2 {
		t.Fatalf("fresh migration fixture applied 00009/00010 records = %d, want 2", appliedCount)
	}

	legacy, err := NewStore(scoped.Pool()).Create(ctx, NewInput{
		ID:                "e01-migration-legacy-" + fmt.Sprintf("%d", time.Now().UnixNano()),
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: "e01-migration-legacy-thread",
		Generation:        "e01-migration-legacy-generation",
	})
	if err != nil {
		t.Fatalf("create legacy row after 00009 to 00010 migration: %v", err)
	}
	legacyAccess, err := NewStore(scoped.Pool()).GetAccess(ctx, legacy.ID)
	if err != nil {
		t.Fatalf("read migrated legacy access facts: %v", err)
	}
	if legacyAccess.CreatorUserID != `` || legacyAccess.HostID != `` || !legacyAccess.Confirmed {
		t.Fatalf("migrated legacy access facts = %+v", legacyAccess)
	}

	if err := scoped.Migrate(ctx); err != nil {
		t.Fatalf("re-enter scoped 00010 migration: %v", err)
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
