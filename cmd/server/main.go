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
	config, err := platform.LoadConfig(platform.ComponentServer)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid configuration: %v\n", err)
		os.Exit(2)
	}
	logger := platform.NewLogger(os.Stderr, config.Component, config.Version)
	server, err := app.NewServer(config, logger)
	if err != nil {
		logger.Error("server initialization failed", "error", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := server.Run(ctx); err != nil {
		logger.Error("server exited with error", "error", err)
		os.Exit(1)
	}
}
