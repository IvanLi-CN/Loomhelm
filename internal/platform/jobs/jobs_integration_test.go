package jobs_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/jobs"
	"github.com/jackc/pgx/v5"
)

func TestRunnerProcessesShortJobAndPersistsAcrossReopen(t *testing.T) {
	url := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	if url == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	db, err := database.Open(ctx, database.Config{URL: url, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()
	runner, err := jobs.NewRunner(db, nil, jobs.Config{MaxWorkers: 1, SoftStopTimeout: 5 * time.Second})
	if err != nil {
		t.Fatalf("jobs.NewRunner() error = %v", err)
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
	if err := runner.Start(ctx, generation, lifecycle); err != nil {
		t.Fatalf("Runner.Start() error = %v", err)
	}

	const payload = "jobs-integration"
	jobID, err := runner.Enqueue(ctx, jobs.ShortJobArgs{Generation: generation.Current(), Payload: payload})
	if err != nil {
		runner.Stop(context.Background())
		t.Fatalf("Runner.Enqueue() error = %v", err)
	}

	var completed bool
	for !completed {
		result, err := db.Queries().GetShortJobResult(ctx, jobID)
		switch {
		case err == nil:
			if result.Generation != int64(generation.Current()) || result.Payload != payload {
				t.Fatalf("unexpected job result: %+v", result)
			}
			completed = true
		case errors.Is(err, pgx.ErrNoRows):
			select {
			case <-ctx.Done():
				t.Fatalf("timed out waiting for job result: %v", ctx.Err())
			case <-time.After(50 * time.Millisecond):
			}
		default:
			t.Fatalf("GetShortJobResult() error = %v", err)
		}
	}

	failedStopCtx, failedStopCancel := context.WithCancel(context.Background())
	failedStopCancel()
	if err := runner.Stop(failedStopCtx); err == nil {
		t.Fatal("Runner.Stop() with canceled context = nil, want error")
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer stopCancel()
	if err := runner.StopAndCancel(stopCtx); err != nil {
		t.Fatalf("Runner.StopAndCancel() after failed stop error = %v", err)
	}
	generation.Stop()
	lifecycle.Stop()
	db.Close()

	reopened, err := database.Open(ctx, database.Config{URL: url, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("database.Open() after worker stop error = %v", err)
	}
	defer reopened.Close()
	result, err := reopened.Queries().GetShortJobResult(ctx, jobID)
	if err != nil {
		t.Fatalf("GetShortJobResult() after reopen error = %v", err)
	}
	if result.Payload != payload {
		t.Fatalf("payload after reopen = %q, want %q", result.Payload, payload)
	}
}
