package app

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/jobs"
)

// processRuntime keeps resource ownership in the application composition layer.
// Tests may replace its factory; production always opens the real database.
type processRuntime interface {
	Ping(context.Context) error
	Start(context.Context, *platform.GenerationController, *platform.Lifecycle) error
	Stop(context.Context) error
	StopAndCancel(context.Context) error
	Close()
}

type runtimeFactory func(context.Context, platform.Config, *slog.Logger) (processRuntime, error)

type databaseRuntime struct {
	db     *database.DB
	runner *jobs.Runner
}

func openDatabaseRuntime(ctx context.Context, cfg platform.Config, logger *slog.Logger) (processRuntime, error) {
	db, err := database.Open(ctx, database.Config{
		URL: cfg.DatabaseURL, MinConns: cfg.DatabaseMinConns, MaxConns: cfg.DatabaseMaxConns,
	})
	if err != nil {
		return nil, fmt.Errorf("open persistence: %w", err)
	}
	runner, err := jobs.NewRunner(db, logger, jobs.Config{SoftStopTimeout: cfg.ShutdownTimeout})
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
	return &databaseRuntime{db: db, runner: runner}, nil
}

func (r *databaseRuntime) Ping(ctx context.Context) error { return r.db.Ping(ctx) }

func (r *databaseRuntime) Start(ctx context.Context, generation *platform.GenerationController, lifecycle *platform.Lifecycle) error {
	return r.runner.Start(ctx, generation, lifecycle)
}

func (r *databaseRuntime) Stop(ctx context.Context) error { return r.runner.Stop(ctx) }

func (r *databaseRuntime) StopAndCancel(ctx context.Context) error {
	return r.runner.StopAndCancel(ctx)
}

func (r *databaseRuntime) Close() { r.db.Close() }
