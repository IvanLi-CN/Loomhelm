package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/artifacts"
	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/events"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	loomhelmMCP "github.com/IvanLi-CN/Loomhelm/internal/mcp"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/jobs"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

// processRuntime keeps resource ownership in the application composition layer.
// Tests may replace its factory; production always opens the real database.
type processRuntime interface {
	Ping(context.Context) error
	Ready() bool
	Start(context.Context, *platform.GenerationController, *platform.Lifecycle) error
	Stop(context.Context) error
	StopAndCancel(context.Context) error
	WaitStopped(context.Context) error
	Close()
}

type runtimeFactory func(context.Context, platform.Config, *slog.Logger) (processRuntime, error)

type databaseRuntime struct {
	db                     *database.DB
	runner                 *jobs.Runner
	api                    http.Handler
	mcpHandler             http.Handler
	gateway                *gateway.Server
	logger                 *slog.Logger
	shutdownTimeout        time.Duration
	artifactRecoveryMu     sync.Mutex
	artifactRecoveryCancel context.CancelFunc
	artifactRecoveryDone   chan struct{}
	closeOnce              sync.Once
}

type artifactRecoveryStore interface {
	Recover(context.Context, int) (artifacts.RecoveryReport, error)
}

const (
	artifactRecoveryInterval   = time.Minute
	artifactRecoveryPassBudget = 10 * time.Second
)

func recoverArtifactStoreAtStartup(ctx context.Context, store artifactRecoveryStore, logger *slog.Logger) (artifacts.RecoveryReport, error) {
	report, err := store.Recover(ctx, artifacts.DefaultRecoveryLimit)
	if err == nil {
		return report, nil
	}
	if !errors.Is(err, artifacts.ErrRecoveryDeferred) {
		return report, err
	}
	if logger != nil {
		logger.Warn("artifact recovery deferred during startup", "error", err, "failed", report.Failed, "deferred", report.Deferred)
	}
	return report, nil
}

func openDatabaseRuntime(ctx context.Context, cfg platform.Config, logger *slog.Logger) (processRuntime, error) {
	db, err := database.Open(ctx, database.Config{
		URL: cfg.DatabaseURL, MinConns: cfg.DatabaseMinConns, MaxConns: cfg.DatabaseMaxConns,
	})
	if err != nil {
		return nil, fmt.Errorf("open persistence: %w", err)
	}
	var enqueueRunJob runs.RunJobEnqueuer
	var registerWorkers jobs.WorkerRegistration
	if cfg.Component == platform.ComponentWorker {
		workerRunStore := runs.NewStore(db.Pool())
		workerObserver := runs.NewDurableObserver(workerRunStore)
		registerWorkers = func(workerSet *river.Workers, environment jobs.WorkerEnvironment) error {
			river.AddWorker(workerSet, &runs.RunWorker{
				Store:                workerRunStore,
				Observer:             workerObserver,
				RequireLease:         true,
				CheckDeploymentLease: environment.CheckLease,
				CheckDeploymentLeaseTx: func(checkCtx context.Context, tx pgx.Tx) error {
					if environment.CheckLeaseTx == nil {
						return runs.ErrDeploymentLeaseLost
					}
					if err := environment.CheckLeaseTx(checkCtx, tx); err != nil {
						if errors.Is(err, jobs.ErrWorkerLeaseLost) {
							return runs.ErrDeploymentLeaseLost
						}
						return err
					}
					return nil
				},
				ControlLeaseOwnerID: environment.OwnerID,
				CandidateSourceSHA:  environment.CandidateSourceSHA,
				ArtifactDigest:      environment.ArtifactDigest,
			})
			return nil
		}
	}
	runner, err := jobs.NewRunner(db, logger, jobs.Config{
		SoftStopTimeout:    cfg.ShutdownTimeout,
		LeaseKey:           cfg.WorkerLeaseKey,
		CandidateSourceSHA: cfg.CandidateSource(),
		ArtifactDigest:     cfg.CandidateArtifactDigest(),
		RegisterWorkers:    registerWorkers,
	})
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize jobs: %w", err)
	}
	// Both processes may start together. The database adapter owns the lock
	// across application and River migrations, independently of the pool size.
	if err := db.WithMigrationLock(ctx, func(locked context.Context) error {
		if err := db.Migrate(locked); err != nil {
			return err
		}
		return runner.Migrate(locked)
	}); err != nil {
		db.Close()
		return nil, fmt.Errorf("prepare persistence: %w", err)
	}
	// River schema migration above does not start workers. Both components must
	// pass the durable approval-history gate before creating writers or starting.
	approvalHistoryMigrator := database.NewApprovalHistoryMigrator(db.Pool())
	if err := approvalHistoryMigrator.Readiness(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("check approval history readiness: %w", err)
	}
	if cfg.Component == platform.ComponentServer {
		producer, producerErr := jobs.NewProducer(db, logger, jobs.ProducerConfig{})
		if producerErr != nil {
			db.Close()
			return nil, fmt.Errorf("initialize job producer: %w", producerErr)
		}
		enqueueRunJob = func(enqueueCtx context.Context, tx pgx.Tx, args runs.RunJobArgs) error {
			_, err := producer.EnqueueTx(enqueueCtx, tx, args, nil)
			return err
		}
	}
	runtime := &databaseRuntime{db: db, runner: runner, logger: logger, shutdownTimeout: cfg.ShutdownTimeout}
	var artifactRecovery artifactRecoveryStore
	var artifactUploadHandler gateway.ArtifactUploadHandler
	if cfg.Component == platform.ComponentServer {
		sessionStore := sessions.NewStore(db.Pool())
		runStore := runs.NewStore(db.Pool(), runs.StoreConfig{EnqueueRunJobTx: enqueueRunJob})
		approvalStore := approvals.NewStore(db.Pool())
		services, serviceErr := newApplicationServices(ctx, db.Pool(), cfg.BrowserAuth)
		if serviceErr != nil {
			db.Close()
			return nil, serviceErr
		}
		if cfg.ArtifactRoot != "" {
			artifactStore, artifactErr := artifacts.NewStore(db.Pool(), artifacts.Config{
				Root: cfg.ArtifactRoot,
				Authorizer: artifacts.NewResolvedAuthorizer(
					artifactOwnershipResolver{sessions: services.sessions, runs: services.runRecords},
					artifactScopeAuthorizer{principal: services.identity, sessions: services.sessionAccess()},
				),
			})
			if artifactErr != nil {
				db.Close()
				return nil, fmt.Errorf("initialize artifact store: %w", artifactErr)
			}
			recoveryCtx, cancelRecovery := context.WithTimeout(ctx, cfg.StartupBudget())
			_, artifactErr = recoverArtifactStoreAtStartup(recoveryCtx, artifactStore, logger)
			cancelRecovery()
			if artifactErr != nil {
				db.Close()
				return nil, fmt.Errorf("recover artifact store: %w", artifactErr)
			}
			services.artifactStore = artifactStore
			artifactRecovery = artifactStore
			uploadHandler, handlerErr := NewGatewayArtifactUploadHandler(artifactStore, sessionStore, runStore)
			if handlerErr != nil {
				db.Close()
				return nil, fmt.Errorf("initialize gateway artifact upload handler: %w", handlerErr)
			}
			artifactUploadHandler = uploadHandler.Handle
		}
		transport := &gatewayExecutionTransport{
			sessions:   sessionStore,
			runs:       runStore,
			eventStore: events.NewStore(db.Pool()),
			now:        time.Now,
		}
		hostRegistry := hosts.NewService(db.Pool())
		runtime.gateway, err = gateway.NewServer(hostRegistry, gateway.ServerOptions{
			EventHandler:    transport.HandleEvent,
			AckHandler:      transport.HandleCommandAck,
			ArtifactHandler: artifactUploadHandler,
		})
		if err != nil {
			db.Close()
			return nil, fmt.Errorf("initialize Connector gateway: %w", err)
		}
		transport.gateway = runtime.gateway
		controller, controllerErr := runs.NewController(runStore, transport, runs.ControllerConfig{
			ResolveGeneration: func(resolveCtx context.Context, sessionID string) (string, error) {
				session, resolveErr := sessionStore.Get(resolveCtx, sessionID)
				if resolveErr != nil {
					return "", resolveErr
				}
				return session.Generation, nil
			},
			CandidateSourceSHA: cfg.CandidateSource(),
			ArtifactDigest:     cfg.CandidateArtifactDigest(),
		})
		if controllerErr != nil {
			db.Close()
			return nil, fmt.Errorf("initialize run controller: %w", controllerErr)
		}
		authorizer := services.sessionAccess()
		control, controlErr := runs.NewControlService(runs.ControlServiceConfig{
			Controller: controller,
			Sessions:   sessionStore,
			Runs:       runStore,
			Approvals:  approvalStore,
			Authorize: func(authorizeCtx context.Context, principal auth.Principal, sessionID string, write bool) error {
				_, authorizeErr := authorizer.authorize(authorizeCtx, principal, sessionID, write)
				return authorizeErr
			},
		})
		if controlErr != nil {
			db.Close()
			return nil, fmt.Errorf("initialize run control: %w", controlErr)
		}
		services.sessionCreation = newSessionCreationService(sessionStore, services.projects, hostRegistry, transport, control)
		runtime.api, err = services.handler(control)
		if err != nil {
			db.Close()
			return nil, fmt.Errorf("initialize application handler: %w", err)
		}
		runtime.mcpHandler, err = newMCPHandler(runtime.api, cfg.Version)
		if err != nil {
			db.Close()
			return nil, fmt.Errorf("initialize MCP handler: %w", err)
		}
	}
	if artifactRecovery != nil {
		runtime.startArtifactRecovery(artifactRecovery)
	}
	return runtime, nil
}

func newMCPHandler(api http.Handler, version string) (http.Handler, error) {
	// The application handler is mounted below /api/v1 by the outer router and
	// registers relative paths, so MCP delegates to it without re-adding that
	// public mount prefix.
	return loomhelmMCP.NewHandler(loomhelmMCP.Config{
		RESTHandler:   api,
		ServerName:    "loomhelm",
		ServerVersion: version,
	})
}

func (r *databaseRuntime) APIHandler() http.Handler { return r.api }

func (r *databaseRuntime) MCPHandler() http.Handler { return r.mcpHandler }

func (r *databaseRuntime) GatewayHandler() http.Handler { return r.gateway }

func (r *databaseRuntime) ShutdownGateway(ctx context.Context) error {
	if r == nil || r.gateway == nil {
		return nil
	}
	return r.gateway.Shutdown(ctx)
}

func (r *databaseRuntime) Ping(ctx context.Context) error { return r.db.Ping(ctx) }

func (r *databaseRuntime) Ready() bool { return r.runner.Ready() }

func (r *databaseRuntime) Start(ctx context.Context, generation *platform.GenerationController, lifecycle *platform.Lifecycle) error {
	return r.runner.Start(ctx, generation, lifecycle)
}

func (r *databaseRuntime) Stop(ctx context.Context) error { return r.runner.Stop(ctx) }

func (r *databaseRuntime) StopAndCancel(ctx context.Context) error {
	return r.runner.StopAndCancel(ctx)
}

func (r *databaseRuntime) WaitStopped(ctx context.Context) error { return r.runner.WaitStopped(ctx) }

func (r *databaseRuntime) startArtifactRecovery(store artifactRecoveryStore) {
	r.startArtifactRecoveryWithInterval(store, artifactRecoveryInterval)
}

// RequestShutdown cancels background recovery as soon as the server enters
// drain. Close still waits for the canceled pass before releasing the pool.
func (r *databaseRuntime) RequestShutdown() {
	if r == nil {
		return
	}
	r.artifactRecoveryMu.Lock()
	cancel := r.artifactRecoveryCancel
	r.artifactRecoveryMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (r *databaseRuntime) startArtifactRecoveryWithInterval(store artifactRecoveryStore, interval time.Duration) {
	if r == nil || store == nil || interval <= 0 {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	r.artifactRecoveryMu.Lock()
	r.artifactRecoveryCancel = cancel
	r.artifactRecoveryDone = done
	r.artifactRecoveryMu.Unlock()
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				recoveryCtx, cancelRecovery := context.WithTimeout(ctx, artifactRecoveryPassBudget)
				report, err := store.Recover(recoveryCtx, artifacts.DefaultRecoveryLimit)
				cancelRecovery()
				if err != nil {
					if ctx.Err() != nil {
						return
					}
					if r.logger != nil {
						r.logger.Warn("artifact recovery pass incomplete", "error", err)
					}
					continue
				}
				if report.Scanned > 0 && r.logger != nil {
					r.logger.Info("artifact recovery pass completed", "scanned", report.Scanned, "ready", report.Ready, "unavailable", report.Unavailable, "cleaned", report.Cleaned)
				}
			}
		}
	}()
}

func (r *databaseRuntime) stopArtifactRecovery() bool {
	if r == nil {
		return true
	}
	r.artifactRecoveryMu.Lock()
	cancel := r.artifactRecoveryCancel
	done := r.artifactRecoveryDone
	r.artifactRecoveryMu.Unlock()
	if cancel == nil {
		return true
	}
	cancel()
	if done != nil {
		timeout := artifactRecoveryPassBudget
		if r.shutdownTimeout > 0 && r.shutdownTimeout < timeout {
			timeout = r.shutdownTimeout
		}
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
			if r.logger != nil {
				r.logger.Error("artifact recovery shutdown exceeded budget")
			}
			return false
		}
	}
	r.artifactRecoveryMu.Lock()
	r.artifactRecoveryCancel = nil
	r.artifactRecoveryDone = nil
	r.artifactRecoveryMu.Unlock()
	return true
}

func (r *databaseRuntime) Close() {
	if r == nil {
		return
	}
	r.closeOnce.Do(func() {
		recoveryStopped := r.stopArtifactRecovery()
		if r.gateway != nil {
			timeout := r.shutdownTimeout
			if timeout <= 0 {
				timeout = 10 * time.Second
			}
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			_ = r.gateway.Shutdown(ctx)
			cancel()
		}
		if r.db == nil {
			return
		}
		if recoveryStopped {
			r.db.Close()
			return
		}
		// Keep the pool alive until the canceled recovery pass exits. This
		// avoids racing a late filesystem/database operation with db.Close;
		// the process-level shutdown budget has already been honored above.
		r.artifactRecoveryMu.Lock()
		done := r.artifactRecoveryDone
		r.artifactRecoveryMu.Unlock()
		db := r.db
		go func() {
			<-done
			db.Close()
		}()
	})
}
