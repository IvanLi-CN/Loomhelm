package database_test

import (
	"context"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database/generated"
)

func TestDatabaseMigrateAndReopen(t *testing.T) {
	url := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	if url == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	db, err := database.Open(ctx, database.Config{URL: url, MinConns: 1, MaxConns: 1})
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

	reopened, err := database.Open(ctx, database.Config{URL: url, MinConns: 1, MaxConns: 1})
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
	url := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	if url == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: url, MinConns: 1, MaxConns: 1})
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
	rawURL := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	if rawURL == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	connectionURL := withPoolMaxConnsOne(t, rawURL)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: connectionURL, MinConns: 1, MaxConns: 1})
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

func withPoolMaxConnsOne(t *testing.T, rawURL string) string {
	t.Helper()
	if strings.Contains(rawURL, "://") {
		parsed, err := url.Parse(rawURL)
		if err != nil {
			t.Fatalf("url.Parse() error = %v", err)
		}
		query := parsed.Query()
		query.Set("pool_max_conns", "1")
		parsed.RawQuery = query.Encode()
		return parsed.String()
	}
	return strings.TrimSpace(rawURL) + " pool_max_conns=1"
}
