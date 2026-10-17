package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/url"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

type Connector struct {
	cfg       platform.Config
	logger    *slog.Logger
	lifecycle *platform.Lifecycle
}

func NewConnector(cfg platform.Config, logger *slog.Logger) (*Connector, error) {
	if cfg.Component != platform.ComponentConnector {
		return nil, fmt.Errorf("connector requires component %q, got %q", platform.ComponentConnector, cfg.Component)
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid connector configuration: %w", err)
	}
	if logger == nil {
		logger = platform.NewLogger(io.Discard, cfg.Component, cfg.Version)
	}
	return &Connector{
		cfg:       cfg,
		logger:    logger,
		lifecycle: platform.NewLifecycle(),
	}, nil
}

func (c *Connector) Run(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("connector context must not be nil")
	}
	if err := c.lifecycle.Start(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		c.lifecycle.BeginDrain("context canceled")
		c.lifecycle.Stop()
		return nil
	}
	serverURL, _ := url.Parse(c.cfg.ConnectorServerURL)
	c.logger.Info("connector started", "server_host", serverURL.Host)
	<-ctx.Done()
	if c.lifecycle.BeginDrain("context canceled") {
		c.logger.Info("connector entering drain", "reason", "context canceled")
	}
	c.lifecycle.Stop()
	c.logger.Info("connector stopped")
	return nil
}

func (c *Connector) Lifecycle() *platform.Lifecycle {
	return c.lifecycle
}
