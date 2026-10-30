package database_test

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/db/migrations"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database/generated"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

const testMigrationAdvisoryLockKey int64 = 0x4c6f6f6d68656c6d

func TestDatabaseMigrateAndReopen(t *testing.T) {
	config := databaseConfigForTest(t)
	config.MinConns = 1
	config.MaxConns = 1

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	db, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		t.Fatalf("database.Migrate() error = %v", err)
	}

	jobID := time.Now().UnixNano()
	const payload = "database-integration"
	result, err := db.Queries().RecordShortJobResult(ctx, generated.RecordShortJobResultParams{
		JobID:      jobID,
		Generation: 1,
		Payload:    payload,
	})
	if err != nil {
		db.Close()
		t.Fatalf("RecordShortJobResult() error = %v", err)
	}
	if result.JobID != jobID || result.Payload != payload {
		db.Close()
		t.Fatalf("unexpected inserted result: %+v", result)
	}
	db.Close()

	reopened, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("database.Open() after close error = %v", err)
	}
	defer reopened.Close()
	got, err := reopened.Queries().GetShortJobResult(ctx, jobID)
	if err != nil {
		t.Fatalf("GetShortJobResult() after reopen error = %v", err)
	}
	if got.Generation != 1 || got.Payload != payload {
		t.Fatalf("unexpected result after reopen: %+v", got)
	}
}

func TestDatabaseMigrateDoesNotLeakSessionSearchPathToPool(t *testing.T) {
	baseConfig := databaseConfigForTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	admin, err := pgx.Connect(ctx, baseConfig.URL)
	if err != nil {
		t.Fatalf("open migration search-path admin connection: %v", err)
	}
	schema := fmt.Sprintf("loomhelm_migration_path_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close(context.Background())
		t.Fatalf("create migration search-path schema: %v", err)
	}
	var db *database.DB
	t.Cleanup(func() {
		if db != nil {
			db.Close()
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Errorf("drop migration search-path schema: %v", err)
		}
		admin.Close(cleanupCtx)
	})

	scopedConfig := database.Config{
		URL:      withURLQuery(t, baseConfig.URL, "search_path", schema+",public"),
		MinConns: 1,
		MaxConns: 1,
	}
	db, err = database.Open(ctx, scopedConfig)
	if err != nil {
		t.Fatalf("open migration search-path database: %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate migration search-path database: %v", err)
	}

	var searchPath string
	if err := db.Pool().QueryRow(ctx, "SELECT current_setting('search_path')").Scan(&searchPath); err != nil {
		t.Fatalf("read pooled search_path after migration: %v", err)
	}
	if !strings.Contains(searchPath, schema) || !strings.Contains(searchPath, "public") {
		t.Fatalf("pooled search_path after migration = %q, want %q and public", searchPath, schema)
	}

	var indexDefinition string
	if err := db.Pool().QueryRow(ctx, `
		SELECT indexdef
		FROM pg_indexes
		WHERE schemaname = current_schema()
		  AND indexname = 'conversation_artifacts_content_mismatch_idx'
	`).Scan(&indexDefinition); err != nil {
		t.Fatalf("read content recovery index definition: %v", err)
	}
	for _, fragment := range []string{
		"staging_reclaim_after",
		"created_at",
		"id",
		"state = 'unavailable'",
		"content-mismatch",
		"final-missing",
		"final-mismatch",
	} {
		if !strings.Contains(indexDefinition, fragment) {
			t.Fatalf("content recovery index definition = %q, missing %q", indexDefinition, fragment)
		}
	}

	planTx, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin content recovery explain transaction: %v", err)
	}
	defer planTx.Rollback(ctx)
	if _, err := planTx.Exec(ctx, "SET LOCAL enable_seqscan = off"); err != nil {
		t.Fatalf("disable sequential scan for content recovery explain: %v", err)
	}
	planRows, err := planTx.Query(ctx, `
		EXPLAIN (COSTS OFF)
		SELECT id
		FROM conversation_artifacts
		WHERE state = 'unavailable'
		  AND unavailable_reason IN ('content-mismatch', 'final-missing', 'final-mismatch')
		  AND staging_reclaim_after <= NOW()
		ORDER BY staging_reclaim_after, created_at, id
		LIMIT 100
	`)
	if err != nil {
		t.Fatalf("explain content recovery selection: %v", err)
	}
	var planLines []string
	for planRows.Next() {
		var line string
		if err := planRows.Scan(&line); err != nil {
			planRows.Close()
			t.Fatalf("scan content recovery explain plan: %v", err)
		}
		planLines = append(planLines, line)
	}
	if err := planRows.Err(); err != nil {
		planRows.Close()
		t.Fatalf("read content recovery explain plan: %v", err)
	}
	planRows.Close()
	if plan := strings.Join(planLines, "\n"); !strings.Contains(plan, "conversation_artifacts_content_mismatch_idx") {
		t.Fatalf("content recovery explain plan = %q, want partial index", plan)
	}
	if err := planTx.Rollback(ctx); err != nil {
		t.Fatalf("finish content recovery explain transaction: %v", err)
	}

	migrationConnConfig, err := pgx.ParseConfig(scopedConfig.URL)
	if err != nil {
		t.Fatalf("parse migration re-entry config: %v", err)
	}
	migrationSQLDB := stdlib.OpenDB(*migrationConnConfig)
	migrationSQLDB.SetMaxOpenConns(1)
	migrationSQLDB.SetMaxIdleConns(1)
	t.Cleanup(func() { migrationSQLDB.Close() })
	migrationProvider, err := goose.NewProvider(goose.DialectPostgres, migrationSQLDB, migrations.FS)
	if err != nil {
		t.Fatalf("create migration re-entry provider: %v", err)
	}
	if _, err := migrationProvider.DownTo(ctx, 15); err != nil {
		t.Fatalf("roll back migration 00016 for re-entry: %v", err)
	}
	if _, err := migrationProvider.UpTo(ctx, 16); err != nil {
		t.Fatalf("re-apply migration 00016 after rollback: %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT indexdef
		FROM pg_indexes
		WHERE schemaname = current_schema()
		  AND indexname = 'conversation_artifacts_content_mismatch_idx'
	`).Scan(&indexDefinition); err != nil {
		t.Fatalf("read re-entered content recovery index definition: %v", err)
	}
}

func TestMigrationLockSerializesConcurrentCallbacksWithSinglePoolConnection(t *testing.T) {
	config := databaseConfigForTest(t)
	config.MinConns = 1
	config.MaxConns = 1

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()

	var active atomic.Int32
	var maximum atomic.Int32
	var group sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			if err := db.WithMigrationLock(ctx, func(context.Context) error {
				current := active.Add(1)
				for {
					previous := maximum.Load()
					if current <= previous || maximum.CompareAndSwap(previous, current) {
						break
					}
				}
				time.Sleep(150 * time.Millisecond)
				active.Add(-1)
				return nil
			}); err != nil {
				t.Errorf("WithMigrationLock() error = %v", err)
			}
		}()
	}
	close(start)
	group.Wait()
	if got := maximum.Load(); got != 1 {
		t.Fatalf("maximum concurrent migration callbacks = %d, want 1", got)
	}
}

func TestMigrationLockAcceptsPoolOnlyURLOptionsWithSinglePoolConnection(t *testing.T) {
	config := databaseConfigForTest(t)
	config.URL = withPoolMaxConnsOne(t, config.URL)
	config.MinConns = 1
	config.MaxConns = 1

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()

	if err := db.WithMigrationLock(ctx, func(lockCtx context.Context) error {
		var one int
		return db.Pool().QueryRow(lockCtx, "SELECT 1").Scan(&one)
	}); err != nil {
		t.Fatalf("WithMigrationLock() with pool_max_conns=1 error = %v", err)
	}
}

func TestMigrationLockPreservesContextErrorDuringConnectionSetup(t *testing.T) {
	config := databaseConfigForTest(t)
	config.MinConns = 1
	config.MaxConns = 1

	db, err := database.Open(context.Background(), config)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()

	for _, test := range []struct {
		name string
		ctx  func() (context.Context, context.CancelFunc)
		want error
	}{
		{name: "canceled", ctx: canceledContext, want: context.Canceled},
		{name: "deadline exceeded", ctx: expiredContext, want: context.DeadlineExceeded},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := test.ctx()
			defer cancel()

			err := db.WithMigrationLock(ctx, func(context.Context) error {
				t.Fatal("migration callback ran with a terminated context")
				return nil
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("WithMigrationLock() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestMigrationLockPreservesContextErrorDuringAdvisoryLockWait(t *testing.T) {
	baseConfig := databaseConfigForTest(t)
	baseConfig.MinConns = 1
	baseConfig.MaxConns = 1
	const applicationName = "loomhelm-migration-lock-waiter-test"
	config := baseConfig
	config.URL = withURLQuery(t, config.URL, "application_name", applicationName)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()

	holder, err := pgx.Connect(ctx, baseConfig.URL)
	if err != nil {
		t.Fatalf("pgx.Connect() lock holder error = %v", err)
	}
	defer holder.Close(context.Background())
	if _, err := holder.Exec(ctx, "SELECT pg_advisory_lock($1)", testMigrationAdvisoryLockKey); err != nil {
		t.Fatalf("acquire test advisory lock error = %v", err)
	}

	waiterCtx, cancelWaiter := context.WithCancel(context.Background())
	defer cancelWaiter()
	result := make(chan error, 1)
	go func() {
		result <- db.WithMigrationLock(waiterCtx, func(context.Context) error {
			return errors.New("migration callback acquired a held advisory lock")
		})
	}()

	monitor, err := pgx.Connect(ctx, baseConfig.URL)
	if err != nil {
		t.Fatalf("pgx.Connect() monitor error = %v", err)
	}
	defer monitor.Close(context.Background())
	if err := waitForMigrationLockWaiter(ctx, monitor, applicationName); err != nil {
		t.Fatalf("wait for advisory lock waiter: %v", err)
	}
	cancelWaiter()

	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("WithMigrationLock() error = %v, want context canceled", err)
		}
	case <-ctx.Done():
		t.Fatalf("WithMigrationLock() did not return after cancellation: %v", ctx.Err())
	}
}

func databaseConfigForTest(t *testing.T) database.Config {
	t.Helper()
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
			t.Skip("LOOMHELM_DATABASE_URL is not set")
		}
		t.Fatalf("load database configuration: %v", err)
	}
	return database.Config{URL: config.URL, MinConns: config.MinConns, MaxConns: config.MaxConns}
}

func withPoolMaxConnsOne(t *testing.T, rawURL string) string {
	return withURLQuery(t, rawURL, "pool_max_conns", "1")
}

func withURLQuery(t *testing.T, rawURL, key, value string) string {
	t.Helper()
	if strings.Contains(rawURL, "://") {
		parsed, err := url.Parse(rawURL)
		if err != nil {
			t.Fatalf("url.Parse() error = %v", err)
		}
		query := parsed.Query()
		query.Set(key, value)
		parsed.RawQuery = query.Encode()
		return parsed.String()
	}
	return strings.TrimSpace(rawURL) + " " + key + "=" + value
}

func canceledContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx, cancel
}

func expiredContext() (context.Context, context.CancelFunc) {
	return context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
}

func waitForMigrationLockWaiter(ctx context.Context, monitor *pgx.Conn, applicationName string) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		var count int
		err := monitor.QueryRow(waitCtx, `
			SELECT count(*)
			FROM pg_stat_activity
			WHERE application_name = $1
			  AND state = 'active'
			  AND query ILIKE '%pg_advisory_lock%'`, applicationName).Scan(&count)
		if err == nil && count > 0 {
			return nil
		}
		select {
		case <-waitCtx.Done():
			if err != nil {
				return err
			}
			return waitCtx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}
