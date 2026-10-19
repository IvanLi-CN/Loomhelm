package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/jobs"
)

const migrationTimeout = 30 * time.Second

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "database migration failed:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	return runWithTimeout(ctx, migrationTimeout)
}

func runWithTimeout(ctx context.Context, timeout time.Duration) error {
	if ctx == nil {
		return errors.New("migration context must not be nil")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		return err
	}
	migrationCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	db, err := database.Open(migrationCtx, database.Config{
		URL:      config.URL,
		MinConns: config.MinConns,
		MaxConns: config.MaxConns,
	})
	if err != nil {
		return err
	}
	defer db.Close()
	runner, err := jobs.NewRunner(db, nil, jobs.Config{})
	if err != nil {
		return err
	}
	return db.WithMigrationLock(migrationCtx, func(lockCtx context.Context) error {
		if err := db.Migrate(lockCtx); err != nil {
			return err
		}
		return runner.Migrate(lockCtx)
	})
}
