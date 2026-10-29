package jobs

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

func TestRunWorkerDeploymentLeaseFenceSerializesGenerationHandoff(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatalf("load database configuration: %v", err)
	}
	config.MinConns = 1
	config.MaxConns = 6
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: config.MinConns, MaxConns: config.MaxConns})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		t.Fatalf("migrate database: %v", err)
	}

	suffix := time.Now().UTC().Format("20060102150405.000000000")
	sessionID := "jobs-fence-session-" + strings.ReplaceAll(suffix, ".", "-")
	runID := "jobs-fence-run-" + strings.ReplaceAll(suffix, ".", "-")
	commandID := "jobs-fence-command-" + strings.ReplaceAll(suffix, ".", "-")
	leaseKey := "jobs-fence-lease-" + strings.ReplaceAll(suffix, ".", "-")
	const sessionGeneration = "session-generation-fence"
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM execution_runs WHERE id = $1`, runID)
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM execution_sessions WHERE id = $1`, sessionID)
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM platform_worker_leases WHERE lease_key = $1`, leaseKey)
		db.Close()
	})

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                sessionID,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: "jobs-fence-thread-" + strings.ReplaceAll(suffix, ".", "-"),
		Generation:        sessionGeneration,
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	store := runs.NewStore(db.Pool())
	if _, err := store.CreateRun(ctx, runs.NewRunInput{
		ID:         runID,
		SessionID:  sessionID,
		CommandID:  commandID,
		Generation: sessionGeneration,
	}); err != nil {
		t.Fatalf("create run: %v", err)
	}

	first, err := newWorkerLease(db, leaseKey, 1, "candidate-one", "artifact-one")
	if err != nil {
		t.Fatalf("create first deployment lease: %v", err)
	}
	if err := first.Acquire(ctx); err != nil {
		t.Fatalf("acquire first deployment lease: %v", err)
	}
	second, err := newWorkerLease(db, leaseKey, 2, "candidate-two", "artifact-two")
	if err != nil {
		t.Fatalf("create second deployment lease: %v", err)
	}

	fenceEntered := make(chan struct{})
	releaseFence := make(chan struct{})
	worker := &runs.RunWorker{
		Store: store,
		Observer: runs.ObserverFunc(func(context.Context, runs.Run) (runs.RunObservation, error) {
			return runs.RunObservation{
				SessionID:      sessionID,
				RunID:          runID,
				Generation:     sessionGeneration,
				Reconciliation: protocol.ReconciliationStateConfirmed,
				Status:         protocol.RunStatusRunning,
				Cursor:         "cursor-fenced",
			}, nil
		}),
		CheckDeploymentLeaseTx: func(checkCtx context.Context, tx pgx.Tx) error {
			if err := first.CheckTx(checkCtx, tx); err != nil {
				return runs.ErrDeploymentLeaseLost
			}
			close(fenceEntered)
			<-releaseFence
			return nil
		},
	}
	workerResult := make(chan error, 1)
	go func() {
		workerResult <- worker.Work(ctx, &river.Job[runs.RunJobArgs]{Args: runs.RunJobArgs{
			RunID: runID, Generation: sessionGeneration,
		}})
	}()
	select {
	case <-fenceEntered:
	case <-ctx.Done():
		t.Fatalf("worker did not enter deployment fence: %v", ctx.Err())
	}

	takeoverResult := make(chan error, 1)
	go func() { takeoverResult <- second.Acquire(ctx) }()
	select {
	case err := <-takeoverResult:
		t.Fatalf("second generation takeover completed before first Run transaction: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	close(releaseFence)
	if err := <-workerResult; err != nil {
		t.Fatalf("first-generation RunWorker error: %v", err)
	}
	if err := <-takeoverResult; err != nil {
		t.Fatalf("second generation takeover after first commit: %v", err)
	}
	current, err := store.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("read fenced run: %v", err)
	}
	if current.Status != protocol.RunStatusRunning || current.LastCursor != "cursor-fenced" {
		t.Fatalf("fenced run = %+v, want running cursor-fenced", current)
	}
	if err := second.Release(ctx); err != nil && !errors.Is(err, ErrWorkerLeaseLost) {
		t.Fatalf("release second deployment lease: %v", err)
	}
}
