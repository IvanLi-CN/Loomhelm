package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/jobs"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "database migration failed:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		return err
	}

	db, err := database.Open(ctx, database.Config{
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
	return db.WithMigrationLock(ctx, func(migrationCtx context.Context) error {
		if err := db.Migrate(migrationCtx); err != nil {
			return err
		}
		return runner.Migrate(migrationCtx)
	})
}
