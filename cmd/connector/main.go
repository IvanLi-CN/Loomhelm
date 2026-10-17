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
	config, err := platform.LoadConfig(platform.ComponentConnector)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid configuration: %v\n", err)
		os.Exit(2)
	}
	logger := platform.NewLogger(os.Stderr, config.Component, config.Version)
	connector, err := app.NewConnector(config, logger)
	if err != nil {
		logger.Error("connector initialization failed", "error", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := connector.Run(ctx); err != nil {
		logger.Error("connector exited with error", "error", err)
		os.Exit(1)
	}
}
