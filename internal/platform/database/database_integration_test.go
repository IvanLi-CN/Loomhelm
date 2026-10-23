package database_test

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database/generated"
	"github.com/jackc/pgx/v5"
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
