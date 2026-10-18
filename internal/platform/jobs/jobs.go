package jobs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database/generated"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
)

const ShortJobKind = "platform_short_job"

type Generation interface {
	Current() uint64
	ContextFor(generation uint64) (context.Context, bool)
}

type Lifecycle interface {
	Snapshot() platform.LifecycleSnapshot
}

type Config struct {
	Queue           string
	Schema          string
	MaxWorkers      int
	SoftStopTimeout time.Duration
}

func (c Config) withDefaults() Config {
	if c.Queue == "" {
		c.Queue = river.QueueDefault
	}
	if c.MaxWorkers <= 0 {
		c.MaxWorkers = 1
	}
	if c.SoftStopTimeout <= 0 {
		c.SoftStopTimeout = 10 * time.Second
	}
	return c
}

func (c Config) Validate() error {
	if c.MaxWorkers < 0 {
		return errors.New("job worker count must not be negative")
	}
	if c.SoftStopTimeout < 0 {
		return errors.New("job soft stop timeout must not be negative")
	}
	return nil
}

type Runner struct {
	db     *database.DB
	logger *slog.Logger
	cfg    Config

	mu     sync.Mutex
	client *river.Client[pgx.Tx]
}

func NewRunner(db *database.DB, logger *slog.Logger, cfg Config) (*Runner, error) {
	if db == nil || db.Pool() == nil || db.Queries() == nil {
		return nil, errors.New("job runner database must be open")
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Runner{db: db, logger: logger, cfg: cfg.withDefaults()}, nil
}

func (r *Runner) Migrate(ctx context.Context) error {
	if r == nil || r.db == nil {
		return errors.New("job runner is not initialized")
	}
	if ctx == nil {
		return errors.New("job context must not be nil")
	}
	if database.MigrationLockHeld(ctx) {
		return r.migrate(ctx)
	}
	return r.db.WithMigrationLock(ctx, r.migrate)
}

func (r *Runner) migrate(ctx context.Context) error {
	if r == nil || r.db == nil {
		return errors.New("job runner is not initialized")
	}
	if ctx == nil {
		return errors.New("job context must not be nil")
	}
	migrator, err := rivermigrate.New(riverpgxv5.New(r.db.Pool()), &rivermigrate.Config{
		Logger: r.logger,
		Schema: r.cfg.Schema,
	})
	if err != nil {
		return fmt.Errorf("create River migration runner: %w", err)
	}
	if _, err := migrator.Migrate(ctx, rivermigrate.DirectionUp, nil); err != nil {
		return fmt.Errorf("apply River migrations: %w", err)
	}
	return nil
}

func (r *Runner) Start(ctx context.Context, generation Generation, lifecycle Lifecycle) error {
	if r == nil || r.db == nil {
		return errors.New("job runner is not initialized")
	}
	if ctx == nil {
		return errors.New("job context must not be nil")
	}
	if generation == nil {
		return errors.New("job generation must not be nil")
	}
	if lifecycle == nil {
		return errors.New("job lifecycle must not be nil")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot := lifecycle.Snapshot(); !snapshot.Ready {
		return fmt.Errorf("job runner requires a ready lifecycle, got %q", snapshot.State)
	}
	current := generation.Current()
	if current == 0 {
		return errors.New("job generation must be greater than zero")
	}
	if _, ok := generation.ContextFor(current); !ok {
		return fmt.Errorf("job generation %d is not current", current)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.client != nil {
		return errors.New("job runner already started")
	}

	workers := river.NewWorkers()
	river.AddWorker(workers, &shortJobWorker{
		queries:    r.db.Queries(),
		generation: generation,
	})
	client, err := river.NewClient(riverpgxv5.New(r.db.Pool()), &river.Config{
		Logger:          r.logger,
		Schema:          r.cfg.Schema,
		SoftStopTimeout: r.cfg.SoftStopTimeout,
		Queues: map[string]river.QueueConfig{
			r.cfg.Queue: {MaxWorkers: r.cfg.MaxWorkers},
		},
		Workers: workers,
	})
	if err != nil {
		return fmt.Errorf("create River client: %w", err)
	}
	if err := client.Start(ctx); err != nil {
		return fmt.Errorf("start River client: %w", err)
	}
	r.client = client
	return nil
}

func (r *Runner) Enqueue(ctx context.Context, args ShortJobArgs) (int64, error) {
	if r == nil {
		return 0, errors.New("job runner is not initialized")
	}
	if ctx == nil {
		return 0, errors.New("job context must not be nil")
	}
	if args.Generation == 0 {
		return 0, errors.New("job generation must be greater than zero")
	}

	r.mu.Lock()
	client := r.client
	r.mu.Unlock()
	if client == nil {
		return 0, errors.New("job runner is not started")
	}
	result, err := client.Insert(ctx, args, nil)
	if err != nil {
		return 0, fmt.Errorf("enqueue short job: %w", err)
	}
	return result.Job.ID, nil
}

func (r *Runner) Stop(ctx context.Context) error {
	return r.stop(ctx, false)
}

// StopAndCancel cancels running jobs and waits for the River client to stop.
// A context error leaves the client reference available for a bounded retry.
func (r *Runner) StopAndCancel(ctx context.Context) error {
	return r.stop(ctx, true)
}

// WaitStopped waits for a previously requested stop without changing the
// stop mode. It also clears the client reference after River reports stopped.
func (r *Runner) WaitStopped(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if ctx == nil {
		return errors.New("job context must not be nil")
	}
	r.mu.Lock()
	client := r.client
	r.mu.Unlock()
	if client == nil {
		return nil
	}
	select {
	case <-client.Stopped():
		r.mu.Lock()
		if r.client == client {
			r.client = nil
		}
		r.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Runner) stop(ctx context.Context, cancel bool) error {
	if r == nil {
		return nil
	}
	if ctx == nil {
		return errors.New("job context must not be nil")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	client := r.client
	if client == nil {
		return nil
	}
	var err error
	if cancel {
		err = client.StopAndCancel(ctx)
	} else {
		err = client.Stop(ctx)
	}
	if err != nil {
		// Keep the client for a bounded retry when the caller's context expires.
		return fmt.Errorf("stop River client: %w", err)
	}
	r.client = nil
	return nil
}

type ShortJobArgs struct {
	Generation uint64 `json:"generation"`
	Payload    string `json:"payload"`
}

func (ShortJobArgs) Kind() string { return ShortJobKind }

type shortJobWorker struct {
	river.WorkerDefaults[ShortJobArgs]
	queries    *generated.Queries
	generation Generation
}

func (w *shortJobWorker) Work(ctx context.Context, job *river.Job[ShortJobArgs]) error {
	generationCtx, ok := w.generation.ContextFor(job.Args.Generation)
	if !ok {
		return river.JobCancel(fmt.Errorf("generation %d is no longer current", job.Args.Generation))
	}
	workCtx, cancel := context.WithCancel(ctx)
	stopGenerationCancel := context.AfterFunc(generationCtx, cancel)
	defer func() {
		stopGenerationCancel()
		cancel()
	}()

	if err := workCtx.Err(); err != nil {
		return river.JobCancel(fmt.Errorf("generation %d stopped: %w", job.Args.Generation, err))
	}
	_, err := w.queries.RecordShortJobResult(workCtx, generated.RecordShortJobResultParams{
		JobID:      job.ID,
		Generation: int64(job.Args.Generation),
		Payload:    job.Args.Payload,
	})
	if err != nil && generationCtx.Err() != nil {
		return river.JobCancel(fmt.Errorf("generation %d stopped: %w", job.Args.Generation, generationCtx.Err()))
	}
	return err
}
