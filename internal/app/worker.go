package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

type Worker struct {
	cfg       platform.Config
	logger    *slog.Logger
	lifecycle *platform.Lifecycle

	runMu        sync.Mutex
	mu           sync.RWMutex
	generation   *platform.GenerationController
	openRuntime  runtimeFactory
	runtimeReady atomic.Bool
}

func NewWorker(cfg platform.Config, logger *slog.Logger) (*Worker, error) {
	if cfg.Component != platform.ComponentWorker {
		return nil, fmt.Errorf("worker requires component %q, got %q", platform.ComponentWorker, cfg.Component)
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid worker configuration: %w", err)
	}
	if logger == nil {
		logger = platform.NewLogger(io.Discard, cfg.Component, cfg.Version)
	}
	return &Worker{
		cfg:         cfg,
		logger:      logger,
		lifecycle:   platform.NewLifecycle(),
		openRuntime: openDatabaseRuntime,
	}, nil
}

func (w *Worker) Run(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("worker context must not be nil")
	}
	w.runMu.Lock()
	if snapshot := w.lifecycle.Snapshot(); snapshot.State != platform.StateNew {
		w.runMu.Unlock()
		return fmt.Errorf("worker lifecycle already started in state %q", snapshot.State)
	}
	if ctx.Err() != nil {
		w.lifecycle.Stop()
		w.runMu.Unlock()
		return nil
	}
	startup, cancelStartup := context.WithTimeout(ctx, w.cfg.StartupBudget())
	resources, err := w.openRuntime(startup, w.cfg, w.logger)
	if err != nil {
		cancelStartup()
		w.lifecycle.Stop()
		w.runMu.Unlock()
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	defer resources.Close()
	// Keep cancellation under Run so readiness is revoked before generation work is stopped.
	generation, err := platform.NewGenerationController(context.Background(), w.cfg.WorkerGeneration)
	if err != nil {
		cancelStartup()
		w.runMu.Unlock()
		return err
	}
	w.mu.Lock()
	w.generation = generation
	w.mu.Unlock()
	if err := ctx.Err(); err != nil {
		cancelStartup()
		generation.Stop()
		w.lifecycle.Stop()
		w.runMu.Unlock()
		return nil
	}
	if err := w.lifecycle.Start(); err != nil {
		cancelStartup()
		generation.Stop()
		w.runMu.Unlock()
		return err
	}
	// River's lifetime is owned by Run, not by the startup deadline or caller
	// cancellation; orderly shutdown first revokes readiness and stops fetching.
	runnerCtx, cancelRunner := context.WithCancel(context.Background())
	stopStartupCancel := context.AfterFunc(startup, cancelRunner)
	startErr := resources.Start(runnerCtx, generation, w.lifecycle)
	stopStartupCancel()
	if startErr == nil {
		startErr = startup.Err()
	}
	cancelStartup()
	if startErr != nil {
		w.runMu.Unlock()
		stopErr := w.stopRuntime(resources, cancelRunner, generation, "startup failed")
		if ctx.Err() != nil && stopErr == nil {
			return nil
		}
		return errors.Join(startErr, stopErr)
	}
	w.runtimeReady.Store(true)
	w.runMu.Unlock()

	w.logger.Info("worker started", "generation", generation.Current())
	<-ctx.Done()
	err = w.stopRuntime(resources, cancelRunner, generation, "context canceled")
	w.logger.Info("worker stopped", "generation", generation.Current())
	return err
}

func (w *Worker) stopRuntime(resources processRuntime, cancelRunner context.CancelFunc, generation *platform.GenerationController, reason string) error {
	w.runtimeReady.Store(false)
	if w.lifecycle.BeginDrain(reason) {
		w.logger.Info("worker entering drain", "reason", reason)
	}
	shutdown, cancel := context.WithTimeout(context.Background(), w.cfg.ShutdownTimeout)
	err := resources.Stop(shutdown)
	cancel()
	cancelRunner()
	generation.Stop()
	if err != nil {
		// A bounded graceful stop may expire. Cancel the lifetime before waiting
		// again, so no active River worker retains the pool when it is closed.
		forced, forceCancel := context.WithTimeout(context.Background(), w.cfg.ShutdownTimeout)
		err = errors.Join(err, resources.StopAndCancel(forced))
		forceCancel()
	}
	w.lifecycle.Stop()
	return err
}

func (w *Worker) Lifecycle() platform.LifecycleSnapshot {
	snapshot := w.lifecycle.Snapshot()
	snapshot.Ready = snapshot.Ready && w.runtimeReady.Load()
	return snapshot
}

func (w *Worker) GenerationController() *platform.GenerationController {
	if w.lifecycle.Snapshot().State == platform.StateNew {
		return nil
	}
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.generation
}
