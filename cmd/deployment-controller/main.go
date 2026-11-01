package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/deployment"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
)

func main() {
	config, err := platform.LoadConfig(platform.ComponentDeploymentController)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid configuration: %v\n", err)
		os.Exit(2)
	}
	logger := platform.NewLogger(os.Stderr, config.Component, config.Version)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := database.Open(ctx, database.Config{URL: config.DatabaseURL, MinConns: config.DatabaseMinConns, MaxConns: config.DatabaseMaxConns})
	if err != nil {
		logger.Error("deployment controller database initialization failed", "error", err)
		os.Exit(2)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		logger.Error("deployment controller migration failed", "error", err)
		os.Exit(2)
	}
	authService, err := auth.NewService(db.Pool(), auth.Config{SecureCookies: config.BrowserAuth.SecureCookies}, nil)
	if err != nil {
		logger.Error("deployment controller authentication initialization failed", "error", err)
		os.Exit(2)
	}
	executor, err := deployment.NewCommandExecutorFromEnvironment()
	if err != nil {
		logger.Error("deployment executor initialization failed", "error", err)
		os.Exit(2)
	}
	service, err := deployment.NewService(db.Pool(), deployment.Config{
		OwnerUserIDs: config.DeploymentOwnerUserIDs,
		Executor:     executor,
	})
	if err != nil {
		logger.Error("deployment service initialization failed", "error", err)
		os.Exit(2)
	}
	if err := service.RecoverPending(ctx); err != nil {
		logger.Error("deployment controller recovery failed", "error", err)
		os.Exit(2)
	}
	handler, err := deployment.NewControllerHTTPHandler(authService, service, config.Version)
	if err != nil {
		logger.Error("deployment controller handler initialization failed", "error", err)
		os.Exit(2)
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", config.DeploymentHTTPAddr)
	if err != nil {
		logger.Error("deployment controller listen failed", "error", err)
		os.Exit(1)
	}
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveErr <- err
	}()
	logger.Info("deployment controller started", "address", listener.Addr().String())
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), config.ShutdownTimeout)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		if err := <-serveErr; err != nil {
			logger.Error("deployment controller stopped with error", "error", err)
			os.Exit(1)
		}
	case err := <-serveErr:
		if err != nil {
			logger.Error("deployment controller exited with error", "error", err)
			os.Exit(1)
		}
	}
}
