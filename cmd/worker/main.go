package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/IvanLi-CN/Loomhelm/internal/app"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

func main() {
	config, err := platform.LoadConfig(platform.ComponentWorker)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid configuration: %v\n", err)
		os.Exit(2)
	}
	logger := platform.NewLogger(os.Stderr, config.Component, config.Version)
	worker, err := app.NewWorker(config, logger)
	if err != nil {
		logger.Error("worker initialization failed", "error", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := worker.Run(ctx); err != nil {
		logger.Error("worker exited with error", "error", err)
		os.Exit(1)
	}
}
