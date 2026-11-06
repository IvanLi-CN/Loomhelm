package jobs

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
)

func TestRunnerStartFailureReleasesAcquiredLease(t *testing.T) {
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
			t.Skip("LOOMHELM_DATABASE_URL is not set")
		}
		t.Fatalf("load database configuration: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()

	unique := strconv.FormatInt(time.Now().UnixNano(), 10)
	runner, err := NewRunner(db, nil, Config{
		Queue:                  "loomhelm-start-failure-" + unique,
		LeaseKey:               "loomhelm-start-failure-" + unique,
		SoftStopTimeout:        time.Second,
		LeaseHeartbeatInterval: 20 * time.Millisecond,
		LeaseHeartbeatTimeout:  200 * time.Millisecond,
		CandidateSourceSHA:     "start-failure-test",
		ArtifactDigest:         "sha256:start-failure-test",
	})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}
	if err := db.WithMigrationLock(ctx, func(migrationCtx context.Context) error {
		if err := db.Migrate(migrationCtx); err != nil {
			return err
		}
		return runner.Migrate(migrationCtx)
	}); err != nil {
		t.Fatalf("database and River migration error = %v", err)
	}

	lifecycle := platform.NewLifecycle()
	if err := lifecycle.Start(); err != nil {
		t.Fatalf("lifecycle.Start() error = %v", err)
	}
	generation, err := platform.NewGenerationController(ctx, 1)
	if err != nil {
		t.Fatalf("NewGenerationController() error = %v", err)
	}
	defer generation.Stop()
	defer lifecycle.Stop()
	runner.afterAcquire = func(*workerLease) error {
		return errors.New("synthetic River startup failure after lease admission")
	}

	if err := runner.Start(ctx, generation, lifecycle); err == nil || !strings.Contains(err.Error(), "synthetic River startup failure") {
		t.Fatalf("Runner.Start() error = %v, want synthetic startup failure", err)
	}
	var leaseCount int
	if err := db.Pool().QueryRow(ctx, "SELECT COUNT(*) FROM platform_worker_leases WHERE lease_key = $1", runner.cfg.LeaseKey).Scan(&leaseCount); err != nil {
		t.Fatalf("count worker leases: %v", err)
	}
	if leaseCount != 0 {
		t.Fatalf("worker lease count = %d, want 0 after startup failure", leaseCount)
	}
	if runner.Ready() {
		t.Fatal("runner remained ready after startup failure")
	}
}
