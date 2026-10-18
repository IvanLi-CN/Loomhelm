package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
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
	url := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	if url == "" {
		return errors.New("LOOMHELM_DATABASE_URL must be set")
	}
	if err := platform.ValidateDevelopmentDatabaseTarget(url, strings.TrimSpace(os.Getenv("LOOMHELM_POSTGRES_PORT"))); err != nil {
		return err
	}

	db, err := database.Open(ctx, database.Config{URL: url})
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
