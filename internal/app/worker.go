package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

type Worker struct {
	cfg       platform.Config
	logger    *slog.Logger
	lifecycle *platform.Lifecycle

	mu         sync.RWMutex
	generation *platform.GenerationController
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
		cfg:       cfg,
		logger:    logger,
		lifecycle: platform.NewLifecycle(),
	}, nil
}

func (w *Worker) Run(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("worker context must not be nil")
	}
	generation, err := platform.NewGenerationController(context.Background(), w.cfg.WorkerGeneration)
	if err != nil {
		return err
	}
	w.mu.Lock()
	w.generation = generation
	w.mu.Unlock()
	if err := ctx.Err(); err != nil {
		generation.Stop()
		w.lifecycle.Stop()
		return nil
	}
	if err := w.lifecycle.Start(); err != nil {
		generation.Stop()
		return err
	}

	w.logger.Info("worker started", "generation", generation.Current())
	<-ctx.Done()
	w.lifecycle.BeginDrain("context canceled")
	generation.Stop()
	w.lifecycle.Stop()
	w.logger.Info("worker stopped", "generation", generation.Current())
	return nil
}

func (w *Worker) Lifecycle() *platform.Lifecycle {
	return w.lifecycle
}

func (w *Worker) GenerationController() *platform.GenerationController {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.generation
}
