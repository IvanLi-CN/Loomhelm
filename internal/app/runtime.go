package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/events"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/jobs"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
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
	db              *database.DB
	runner          *jobs.Runner
	api             http.Handler
	gateway         *gateway.Server
	shutdownTimeout time.Duration
}

func openDatabaseRuntime(ctx context.Context, cfg platform.Config, logger *slog.Logger) (processRuntime, error) {
	db, err := database.Open(ctx, database.Config{
		URL: cfg.DatabaseURL, MinConns: cfg.DatabaseMinConns, MaxConns: cfg.DatabaseMaxConns,
	})
	if err != nil {
		return nil, fmt.Errorf("open persistence: %w", err)
	}
	runner, err := jobs.NewRunner(db, logger, jobs.Config{
		SoftStopTimeout:    cfg.ShutdownTimeout,
		LeaseKey:           cfg.WorkerLeaseKey,
		CandidateSourceSHA: cfg.CandidateSource(),
		ArtifactDigest:     cfg.CandidateArtifactDigest(),
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
	runtime := &databaseRuntime{db: db, runner: runner, shutdownTimeout: cfg.ShutdownTimeout}
	if cfg.Component == platform.ComponentServer {
		sessionStore := sessions.NewStore(db.Pool())
		runStore := runs.NewStore(db.Pool())
		approvalStore := approvals.NewStore(db.Pool())
		services, serviceErr := newApplicationServices(ctx, db.Pool(), cfg.BrowserAuth)
		if serviceErr != nil {
			db.Close()
			return nil, serviceErr
		}
		transport := &gatewayExecutionTransport{
			sessions:   sessionStore,
			runs:       runStore,
			eventStore: events.NewStore(db.Pool()),
			now:        time.Now,
		}
		hostRegistry := hosts.NewService(db.Pool())
		runtime.gateway, err = gateway.NewServer(hostRegistry, gateway.ServerOptions{EventHandler: transport.HandleEvent})
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
		runtime.api = services.handler(control)
	}
	return runtime, nil
}

func (r *databaseRuntime) APIHandler() http.Handler { return r.api }

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

func (r *databaseRuntime) Close() {
	if r == nil {
		return
	}
	if r.gateway != nil {
		timeout := r.shutdownTimeout
		if timeout <= 0 {
			timeout = 10 * time.Second
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		_ = r.gateway.Shutdown(ctx)
		cancel()
	}
	if r.db != nil {
		r.db.Close()
	}
}
