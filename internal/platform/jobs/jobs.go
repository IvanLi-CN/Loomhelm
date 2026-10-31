package jobs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"strings"
	"sync"
	"sync/atomic"
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

const maxGeneration = uint64(math.MaxInt64)

type Generation interface {
	Current() uint64
	ContextFor(generation uint64) (context.Context, bool)
}

type Lifecycle interface {
	Snapshot() platform.LifecycleSnapshot
}

// WorkerEnvironment exposes process fencing without coupling the platform job
// runner to an application domain. Registrations are rebuilt after recovery.
type WorkerEnvironment struct {
	Generation         Generation
	CheckLease         func(context.Context) error
	CheckLeaseTx       func(context.Context, pgx.Tx) error
	LeaseKey           string
	OwnerID            string
	CandidateSourceSHA string
	ArtifactDigest     string
}

type WorkerRegistration func(*river.Workers, WorkerEnvironment) error

type Config struct {
	Queue                  string
	Schema                 string
	MaxWorkers             int
	SoftStopTimeout        time.Duration
	LeaseKey               string
	LeaseHeartbeatInterval time.Duration
	LeaseHeartbeatTimeout  time.Duration
	CandidateSourceSHA     string
	ArtifactDigest         string
	OwnerID                string
	RegisterWorkers        WorkerRegistration
}

func (c Config) withDefaults() (Config, error) {
	if c.Queue == "" {
		c.Queue = river.QueueDefault
	}
	if c.MaxWorkers <= 0 {
		c.MaxWorkers = 1
	}
	if c.SoftStopTimeout <= 0 {
		c.SoftStopTimeout = 10 * time.Second
	}
	if c.LeaseKey == "" {
		c.LeaseKey = "loomhelm-worker:" + c.Queue
	}
	if c.LeaseHeartbeatInterval <= 0 {
		c.LeaseHeartbeatInterval = 2 * time.Second
	}
	if c.LeaseHeartbeatTimeout <= 0 {
		c.LeaseHeartbeatTimeout = c.LeaseHeartbeatInterval
	}
	if strings.TrimSpace(c.OwnerID) == "" {
		ownerID, err := randomOwnerID("loomhelm-worker")
		if err != nil {
			return c, fmt.Errorf("generate worker owner id: %w", err)
		}
		c.OwnerID = ownerID
	}
	return c, nil
}

func randomOwnerID(prefix string) (string, error) {
	var suffix [16]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", err
	}
	return prefix + ":" + hex.EncodeToString(suffix[:]), nil
}

func (c Config) Validate() error {
	if c.MaxWorkers < 0 {
		return errors.New("job worker count must not be negative")
	}
	if c.SoftStopTimeout < 0 {
		return errors.New("job soft stop timeout must not be negative")
	}
	if c.LeaseHeartbeatInterval < 0 || c.LeaseHeartbeatTimeout < 0 {
		return errors.New("worker lease heartbeat durations must not be negative")
	}
	if c.LeaseHeartbeatInterval > 0 && c.LeaseHeartbeatTimeout > 0 && c.LeaseHeartbeatTimeout < c.LeaseHeartbeatInterval/2 {
		return errors.New("worker lease heartbeat timeout is too short for its interval")
	}
	if c.LeaseKey != "" && strings.ContainsAny(c.LeaseKey, " \t\r\n") {
		return errors.New("worker lease key must not contain whitespace")
	}
	return nil
}

type Runner struct {
	db     *database.DB
	logger *slog.Logger
	cfg    Config

	mu            sync.Mutex
	client        *river.Client[pgx.Tx]
	lease         *workerLease
	generation    Generation
	runCtx        context.Context
	monitorCancel context.CancelFunc
	monitorDone   chan struct{}
	startClient   func(context.Context, *river.Client[pgx.Tx]) error
	afterAcquire  func(*workerLease) error
	stopping      atomic.Bool
	ready         atomic.Bool
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
	defaulted, err := cfg.withDefaults()
	if err != nil {
		return nil, err
	}
	return &Runner{
		db:          db,
		logger:      logger,
		cfg:         defaulted,
		startClient: func(ctx context.Context, client *river.Client[pgx.Tx]) error { return client.Start(ctx) },
	}, nil
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

func (r *Runner) Start(ctx context.Context, generation Generation, lifecycle Lifecycle) (startErr error) {
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
	if err := validateGeneration(current); err != nil {
		return err
	}
	if _, ok := generation.ContextFor(current); !ok {
		return fmt.Errorf("job generation %d is not current", current)
	}

	r.mu.Lock()
	if r.client != nil || r.monitorDone != nil {
		r.mu.Unlock()
		return errors.New("job runner already started")
	}
	r.mu.Unlock()

	lease, err := newWorkerLease(r.db, r.cfg.LeaseKey, current, r.cfg.CandidateSourceSHA, r.cfg.ArtifactDigest)
	if err != nil {
		return err
	}

	workers, err := r.workers(generation, lease)
	if err != nil {
		return err
	}
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
	startClient := r.startClient
	if startClient == nil {
		startClient = func(startContext context.Context, startClient *river.Client[pgx.Tx]) error {
			return startClient.Start(startContext)
		}
	}
	stopClient := func() error {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), r.cfg.SoftStopTimeout)
		defer stopCancel()
		return client.StopAndCancel(stopCtx)
	}
	if err := startClient(ctx, client); err != nil {
		return errors.Join(fmt.Errorf("start River client: %w", err), stopClient())
	}
	if err := lease.Acquire(ctx); err != nil {
		return errors.Join(err, stopClient())
	}
	defer func() {
		if startErr == nil {
			return
		}
		cleanupErr := stopClient()
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), r.cfg.SoftStopTimeout)
		cleanupErr = errors.Join(cleanupErr, lease.Release(releaseCtx))
		releaseCancel()
		startErr = errors.Join(startErr, cleanupErr)
	}()
	if r.afterAcquire != nil {
		if err := r.afterAcquire(lease); err != nil {
			return err
		}
	}
	monitorCtx, monitorCancel := context.WithCancel(ctx)
	r.mu.Lock()
	if r.client != nil || r.monitorDone != nil {
		r.mu.Unlock()
		monitorCancel()
		return errors.New("job runner already started")
	}
	r.client = client
	r.lease = lease
	r.generation = generation
	r.runCtx = ctx
	r.monitorCancel = monitorCancel
	r.monitorDone = make(chan struct{})
	r.stopping.Store(false)
	r.ready.Store(true)
	monitorDone := r.monitorDone
	r.mu.Unlock()
	go r.monitorLease(monitorCtx, monitorDone)
	startErr = nil
	return nil
}

func (r *Runner) Enqueue(ctx context.Context, args ShortJobArgs) (int64, error) {
	if err := validateGeneration(args.Generation); err != nil {
		return 0, err
	}
	return r.EnqueueArgs(ctx, args, nil)
}

// EnqueueArgs retains the same readiness and durable worker lease checks as
// platform jobs. Application workers must also fence execution on receipt.
func (r *Runner) EnqueueArgs(ctx context.Context, args river.JobArgs, opts *river.InsertOpts) (int64, error) {
	if r == nil {
		return 0, errors.New("job runner is not initialized")
	}
	if ctx == nil {
		return 0, errors.New("job context must not be nil")
	}
	if args == nil {
		return 0, errors.New("job arguments must not be nil")
	}
	r.mu.Lock()
	lease := r.lease
	r.mu.Unlock()
	if lease == nil {
		return 0, errors.New("job runner lease is not initialized")
	}
	if err := lease.Check(ctx); err != nil {
		return 0, err
	}
	if !r.ready.Load() {
		return 0, errors.New("job runner is not ready for scheduling")
	}

	r.mu.Lock()
	client := r.client
	r.mu.Unlock()
	if client == nil {
		return 0, errors.New("job runner is not started")
	}
	if opts == nil {
		opts = &river.InsertOpts{}
	}
	// Do not mutate caller-owned options or permit the enqueue path to escape
	// the queue whose worker lease was checked above.
	insertOpts := *opts
	if insertOpts.Queue != "" && insertOpts.Queue != r.cfg.Queue {
		return 0, errors.New("job queue must match the runner queue")
	}
	insertOpts.Queue = r.cfg.Queue
	result, err := client.Insert(ctx, args, &insertOpts)
	if err != nil {
		return 0, fmt.Errorf("enqueue job: %w", err)
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
	if err := r.waitMonitor(ctx); err != nil {
		return err
	}
	r.mu.Lock()
	client := r.client
	lease := r.lease
	r.mu.Unlock()
	if client != nil {
		select {
		case <-client.Stopped():
			r.mu.Lock()
			if r.client == client {
				r.client = nil
			}
			r.mu.Unlock()
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	r.ready.Store(false)
	if lease == nil {
		return nil
	}
	return lease.Release(ctx)
}

func (r *Runner) stop(ctx context.Context, cancel bool) error {
	if r == nil {
		return nil
	}
	if ctx == nil {
		return errors.New("job context must not be nil")
	}
	r.stopping.Store(true)
	r.ready.Store(false)
	r.mu.Lock()
	monitorCancel := r.monitorCancel
	r.mu.Unlock()
	if monitorCancel != nil {
		monitorCancel()
	}
	if err := r.waitMonitor(ctx); err != nil {
		return err
	}
	r.mu.Lock()
	client := r.client
	lease := r.lease
	r.mu.Unlock()
	if client == nil {
		if lease == nil {
			return nil
		}
		return lease.Release(ctx)
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
	r.mu.Lock()
	if r.client == client {
		r.client = nil
	}
	r.mu.Unlock()
	if lease == nil {
		return nil
	}
	return lease.Release(ctx)
}

type ShortJobArgs struct {
	Generation uint64 `json:"generation"`
	Payload    string `json:"payload"`
}

func (ShortJobArgs) Kind() string { return ShortJobKind }

func validateGeneration(generation uint64) error {
	if generation == 0 {
		return errors.New("job generation must be greater than zero")
	}
	if generation > maxGeneration {
		return fmt.Errorf("job generation must not exceed %d", maxGeneration)
	}
	return nil
}

type shortJobWorker struct {
	river.WorkerDefaults[ShortJobArgs]
	queries    *generated.Queries
	generation Generation
	lease      *workerLease
}

func (w *shortJobWorker) Work(ctx context.Context, job *river.Job[ShortJobArgs]) error {
	if err := validateGeneration(job.Args.Generation); err != nil {
		return river.JobCancel(err)
	}
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

	if err := generationCtx.Err(); err != nil {
		return river.JobCancel(fmt.Errorf("generation %d stopped: %w", job.Args.Generation, err))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if w.lease != nil {
		if err := w.lease.Check(workCtx); err != nil {
			if errors.Is(err, ErrWorkerLeaseLost) {
				return river.JobCancel(err)
			}
			return err
		}
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

func (r *Runner) Ready() bool {
	return r != nil && r.ready.Load()
}

func (r *Runner) monitorLease(ctx context.Context, done chan struct{}) {
	defer close(done)
	ticker := time.NewTicker(r.cfg.LeaseHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		r.mu.Lock()
		lease := r.lease
		generation := r.generation
		runCtx := r.runCtx
		stopping := r.stopping.Load()
		r.mu.Unlock()
		if stopping || lease == nil || generation == nil || runCtx == nil {
			return
		}

		heartbeatCtx, cancel := context.WithTimeout(context.Background(), r.cfg.LeaseHeartbeatTimeout)
		err := lease.Renew(heartbeatCtx)
		cancel()
		if err == nil {
			if !r.ready.Load() && !r.stopping.Load() {
				if err := r.restartClient(runCtx, generation); err == nil {
					r.ready.Store(true)
				} else {
					r.logger.Warn("worker runtime recovery is waiting", "error", err)
				}
			}
			continue
		}

		r.ready.Store(false)
		if errors.Is(err, ErrWorkerLeaseLost) {
			r.logger.Error("worker generation fenced", "generation", generation.Current(), "error", err)
		} else {
			r.logger.Warn("worker lease heartbeat failed; scheduling paused", "error", err)
		}
		stopCtx, stopCancel := context.WithTimeout(context.Background(), r.cfg.SoftStopTimeout)
		if stopErr := r.stopClient(stopCtx, true); stopErr != nil {
			r.logger.Warn("worker River client stop during lease loss failed", "error", stopErr)
		}
		stopCancel()
	}
}

func (r *Runner) restartClient(ctx context.Context, generation Generation) error {
	if ctx == nil || ctx.Err() != nil {
		return ctx.Err()
	}
	r.mu.Lock()
	lease := r.lease
	r.mu.Unlock()
	workers, err := r.workers(generation, lease)
	if err != nil {
		return err
	}
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
		return fmt.Errorf("create River recovery client: %w", err)
	}
	if err := client.Start(ctx); err != nil {
		return fmt.Errorf("start River recovery client: %w", err)
	}
	r.mu.Lock()
	if r.stopping.Load() || r.client != nil {
		r.mu.Unlock()
		_ = client.StopAndCancel(context.Background())
		return nil
	}
	r.client = client
	r.mu.Unlock()
	return nil
}

func (r *Runner) workers(generation Generation, lease *workerLease) (*river.Workers, error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &shortJobWorker{
		queries: r.db.Queries(), generation: generation, lease: lease,
	})
	if register := r.cfg.RegisterWorkers; register != nil {
		checkLease := func(ctx context.Context) error {
			if lease == nil {
				return ErrWorkerLeaseLost
			}
			return lease.Check(ctx)
		}
		checkLeaseTx := func(ctx context.Context, tx pgx.Tx) error {
			if lease == nil {
				return ErrWorkerLeaseLost
			}
			return lease.CheckTx(ctx, tx)
		}
		if err := register(workers, WorkerEnvironment{
			Generation: generation, CheckLease: checkLease, CheckLeaseTx: checkLeaseTx,
			LeaseKey: r.cfg.LeaseKey, OwnerID: r.cfg.OwnerID, CandidateSourceSHA: r.cfg.CandidateSourceSHA,
			ArtifactDigest: r.cfg.ArtifactDigest,
		}); err != nil {
			return nil, fmt.Errorf("register application workers: %w", err)
		}
	}
	return workers, nil
}

func (r *Runner) stopClient(ctx context.Context, cancel bool) error {
	r.mu.Lock()
	client := r.client
	r.mu.Unlock()
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
		return fmt.Errorf("stop River client: %w", err)
	}
	r.mu.Lock()
	if r.client == client {
		r.client = nil
	}
	r.mu.Unlock()
	return nil
}

func (r *Runner) waitMonitor(ctx context.Context) error {
	r.mu.Lock()
	done := r.monitorDone
	r.mu.Unlock()
	if done == nil {
		return nil
	}
	select {
	case <-done:
		r.mu.Lock()
		r.monitorDone = nil
		r.monitorCancel = nil
		r.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
