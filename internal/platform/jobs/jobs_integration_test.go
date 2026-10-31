package jobs_test

import (
	"context"
	"errors"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/jobs"
	"github.com/jackc/pgx/v5"
)

func TestRunnerProcessesShortJobAndPersistsAcrossReopen(t *testing.T) {
	config := databaseConfigForTest(t)
	config.MinConns = 1
	config.MaxConns = 4

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	db, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()
	const queueName = "loomhelm-jobs-integration"
	runner, err := jobs.NewRunner(db, nil, jobs.Config{Queue: queueName, MaxWorkers: 1, SoftStopTimeout: 5 * time.Second})
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
	invalidGeneration := &fixedGeneration{current: uint64(math.MaxInt64) + 1, ctx: context.Background()}
	if err := runner.Start(ctx, invalidGeneration, lifecycle); err == nil {
		t.Fatal("Runner.Start() accepted a generation outside the signed database range")
	}
	const generationNumber = uint64(math.MaxInt64)
	generation, err := platform.NewGenerationController(ctx, generationNumber)
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
	if _, err := runner.Enqueue(ctx, jobs.ShortJobArgs{Generation: uint64(math.MaxInt64) + 1}); err == nil {
		t.Fatal("Runner.Enqueue() accepted a generation outside the signed database range")
	}
	var queue string
	if err := db.Pool().QueryRow(ctx, "SELECT queue FROM river_job WHERE id = $1", jobID).Scan(&queue); err != nil {
		t.Fatalf("read River queue = %v", err)
	}
	if queue != queueName {
		t.Fatalf("River queue = %q, want %q", queue, queueName)
	}

	var completed bool
	for !completed {
		result, err := db.Queries().GetShortJobResult(ctx, jobID)
		switch {
		case err == nil:
			if result.Generation != int64(generationNumber) || result.Payload != payload {
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

	reopened, err := database.Open(ctx, config)
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

func TestRunnerRetriesInterruptedShortJobAfterSameGenerationRestart(t *testing.T) {
	config := databaseConfigForTest(t)
	config.MinConns = 1
	config.MaxConns = 4

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()
	if err := db.WithMigrationLock(ctx, func(migrationCtx context.Context) error {
		if err := db.Migrate(migrationCtx); err != nil {
			return err
		}
		runner, err := jobs.NewRunner(db, nil, jobs.Config{})
		if err != nil {
			return err
		}
		return runner.Migrate(migrationCtx)
	}); err != nil {
		t.Fatalf("database and River migration error = %v", err)
	}

	const queueName = "loomhelm-jobs-restart-integration"
	runner, err := jobs.NewRunner(db, nil, jobs.Config{Queue: queueName, MaxWorkers: 1, SoftStopTimeout: 500 * time.Millisecond})
	if err != nil {
		t.Fatalf("jobs.NewRunner() error = %v", err)
	}
	lifecycle := platform.NewLifecycle()
	if err := lifecycle.Start(); err != nil {
		t.Fatalf("lifecycle.Start() error = %v", err)
	}
	generation, err := platform.NewGenerationController(context.Background(), 1)
	if err != nil {
		t.Fatalf("NewGenerationController() error = %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if err := runner.StopAndCancel(cleanupCtx); err != nil {
			t.Logf("cleanup runner stop error = %v", err)
		}
		generation.Stop()
		lifecycle.Stop()
	}()

	blockedConn, err := db.Pool().Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire() blocking connection error = %v", err)
	}
	blockedTx, err := blockedConn.Begin(ctx)
	if err != nil {
		blockedConn.Release()
		t.Fatalf("Begin() blocking transaction error = %v", err)
	}
	releaseTableLock := func() {
		if blockedTx != nil {
			_ = blockedTx.Rollback(context.Background())
			blockedTx = nil
		}
		if blockedConn != nil {
			blockedConn.Release()
			blockedConn = nil
		}
	}
	defer releaseTableLock()
	if _, err := blockedTx.Exec(ctx, "LOCK TABLE platform_short_job_results IN SHARE MODE"); err != nil {
		t.Fatalf("LOCK TABLE error = %v", err)
	}

	if err := runner.Start(ctx, generation, lifecycle); err != nil {
		t.Fatalf("Runner.Start() error = %v", err)
	}
	jobID, err := runner.Enqueue(ctx, jobs.ShortJobArgs{Generation: generation.Current(), Payload: "restartable"})
	if err != nil {
		t.Fatalf("Runner.Enqueue() error = %v", err)
	}
	if err := waitForRiverJobState(ctx, db, jobID, "running"); err != nil {
		t.Fatalf("wait for blocked River job = %v", err)
	}

	gracefulCtx, gracefulCancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	gracefulErr := runner.Stop(gracefulCtx)
	gracefulCancel()
	if !errors.Is(gracefulErr, context.DeadlineExceeded) {
		t.Fatalf("Runner.Stop() error = %v, want deadline exceeded while result insert is blocked", gracefulErr)
	}
	forceCtx, forceCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := runner.StopAndCancel(forceCtx); err != nil {
		forceCancel()
		t.Fatalf("Runner.StopAndCancel() error = %v", err)
	}
	forceCancel()

	if err := runner.Start(ctx, generation, lifecycle); err != nil {
		t.Fatalf("Runner.Start() after interruption error = %v", err)
	}
	releaseTableLock()

	if err := waitForShortJobResult(ctx, db, jobID, "restartable"); err != nil {
		t.Fatalf("wait for retried short job result = %v", err)
	}
	if err := waitForRiverJobState(ctx, db, jobID, "completed"); err != nil {
		t.Fatalf("wait for completed River job = %v", err)
	}
	var state string
	if err := db.Pool().QueryRow(ctx, "SELECT state FROM river_job WHERE id = $1", jobID).Scan(&state); err != nil {
		t.Fatalf("read final River state = %v", err)
	}
	if state == "cancelled" {
		t.Fatalf("River job state = %q, shutdown cancellation must remain retryable", state)
	}
}

func TestRunnerFencesOlderGeneration(t *testing.T) {
	config := databaseConfigForTest(t)
	config.MinConns = 1
	config.MaxConns = 6

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()

	unique := strconv.FormatInt(time.Now().UnixNano(), 10)
	queueName := "loomhelm-fence-" + unique
	leaseKey := "loomhelm-fence-" + unique
	newRunner := func() *jobs.Runner {
		runner, err := jobs.NewRunner(db, nil, jobs.Config{
			Queue:                  queueName,
			LeaseKey:               leaseKey,
			MaxWorkers:             1,
			SoftStopTimeout:        2 * time.Second,
			LeaseHeartbeatInterval: 20 * time.Millisecond,
			LeaseHeartbeatTimeout:  200 * time.Millisecond,
			CandidateSourceSHA:     "fence-test",
			ArtifactDigest:         "sha256:fence-test",
		})
		if err != nil {
			t.Fatalf("jobs.NewRunner() error = %v", err)
		}
		return runner
	}
	first := newRunner()
	second := newRunner()
	if err := db.WithMigrationLock(ctx, func(migrationCtx context.Context) error {
		if err := db.Migrate(migrationCtx); err != nil {
			return err
		}
		return first.Migrate(migrationCtx)
	}); err != nil {
		t.Fatalf("database and River migration error = %v", err)
	}

	firstLifecycle := platform.NewLifecycle()
	secondLifecycle := platform.NewLifecycle()
	if err := firstLifecycle.Start(); err != nil {
		t.Fatalf("first lifecycle.Start() error = %v", err)
	}
	if err := secondLifecycle.Start(); err != nil {
		t.Fatalf("second lifecycle.Start() error = %v", err)
	}
	firstGeneration, err := platform.NewGenerationController(context.Background(), 10)
	if err != nil {
		t.Fatalf("first NewGenerationController() error = %v", err)
	}
	secondGeneration, err := platform.NewGenerationController(context.Background(), 11)
	if err != nil {
		t.Fatalf("second NewGenerationController() error = %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if err := first.StopAndCancel(cleanupCtx); err != nil {
			t.Logf("first runner cleanup error = %v", err)
		}
		if err := second.StopAndCancel(cleanupCtx); err != nil {
			t.Logf("second runner cleanup error = %v", err)
		}
		firstGeneration.Stop()
		secondGeneration.Stop()
		firstLifecycle.Stop()
		secondLifecycle.Stop()
	}()

	if err := first.Start(ctx, firstGeneration, firstLifecycle); err != nil {
		t.Fatalf("first Runner.Start() error = %v", err)
	}
	if err := second.Start(ctx, secondGeneration, secondLifecycle); err != nil {
		t.Fatalf("second Runner.Start() error = %v", err)
	}
	if err := waitForRunnerNotReady(ctx, first); err != nil {
		t.Fatalf("wait for fenced runner = %v", err)
	}
	if _, err := first.Enqueue(ctx, jobs.ShortJobArgs{Generation: firstGeneration.Current(), Payload: "old"}); !errors.Is(err, jobs.ErrWorkerLeaseLost) {
		t.Fatalf("fenced Runner.Enqueue() error = %v, want ErrWorkerLeaseLost", err)
	}

	jobID, err := second.Enqueue(ctx, jobs.ShortJobArgs{Generation: secondGeneration.Current(), Payload: "new"})
	if err != nil {
		t.Fatalf("current Runner.Enqueue() error = %v", err)
	}
	if err := waitForShortJobResult(ctx, db, jobID, "new"); err != nil {
		t.Fatalf("wait for current generation result = %v", err)
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

func waitForRiverJobState(ctx context.Context, db *database.DB, jobID int64, want string) error {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		var state string
		if err := db.Pool().QueryRow(ctx, "SELECT state FROM river_job WHERE id = $1", jobID).Scan(&state); err == nil && state == want {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func waitForShortJobResult(ctx context.Context, db *database.DB, jobID int64, payload string) error {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		result, err := db.Queries().GetShortJobResult(ctx, jobID)
		if err == nil {
			if result.Payload != payload {
				return errors.New("short job result payload did not match")
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func waitForRunnerNotReady(ctx context.Context, runner *jobs.Runner) error {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for runner.Ready() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
	return nil
}

type fixedGeneration struct {
	current uint64
	ctx     context.Context
}

func (g *fixedGeneration) Current() uint64 { return g.current }

func (g *fixedGeneration) ContextFor(generation uint64) (context.Context, bool) {
	return g.ctx, generation == g.current
}
