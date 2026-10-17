package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/go-chi/chi/v5"
)

type Server struct {
	cfg       platform.Config
	logger    *slog.Logger
	lifecycle *platform.Lifecycle
	router    chi.Router

	mu         sync.RWMutex
	httpServer *http.Server
}

func NewServer(cfg platform.Config, logger *slog.Logger) (*Server, error) {
	if cfg.Component != platform.ComponentServer {
		return nil, fmt.Errorf("server requires component %q, got %q", platform.ComponentServer, cfg.Component)
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid server configuration: %w", err)
	}
	if logger == nil {
		logger = platform.NewLogger(io.Discard, cfg.Component, cfg.Version)
	}

	server := &Server{
		cfg:       cfg,
		logger:    logger,
		lifecycle: platform.NewLifecycle(),
		router:    chi.NewRouter(),
	}
	server.registerRoutes()
	return server, nil
}

func (s *Server) Run(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("server context must not be nil")
	}
	listener, err := net.Listen("tcp", s.cfg.HTTPAddr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", s.cfg.HTTPAddr, err)
	}
	return s.Serve(ctx, listener)
}

func (s *Server) Serve(ctx context.Context, listener net.Listener) error {
	if ctx == nil {
		return fmt.Errorf("server context must not be nil")
	}
	if listener == nil {
		return fmt.Errorf("server listener must not be nil")
	}
	if err := s.lifecycle.Start(); err != nil {
		_ = listener.Close()
		return err
	}

	server := &http.Server{
		Handler:           s.router,
		ReadHeaderTimeout: 5 * time.Second,
	}
	s.mu.Lock()
	s.httpServer = server
	s.mu.Unlock()

	serveResult := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if err == http.ErrServerClosed {
			err = nil
		}
		serveResult <- err
	}()

	s.logger.Info("server started", "address", listener.Addr().String())
	select {
	case <-ctx.Done():
		s.BeginDrain("context canceled")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), s.cfg.ShutdownTimeout)
		shutdownErr := server.Shutdown(shutdownCtx)
		cancel()
		if shutdownErr != nil {
			_ = server.Close()
			s.lifecycle.Stop()
			return fmt.Errorf("server shutdown: %w", shutdownErr)
		}
		<-serveResult
		s.lifecycle.Stop()
		s.logger.Info("server stopped")
		return nil
	case err := <-serveResult:
		s.lifecycle.Stop()
		if err != nil {
			return fmt.Errorf("serve HTTP: %w", err)
		}
		s.logger.Info("server stopped")
		return nil
	}
}

func (s *Server) Router() http.Handler {
	return s.router
}

func (s *Server) Lifecycle() *platform.Lifecycle {
	return s.lifecycle
}

func (s *Server) BeginDrain(reason string) bool {
	changed := s.lifecycle.BeginDrain(reason)
	if changed {
		s.logger.Info("server entering drain", "reason", reason)
	}
	return changed
}

func (s *Server) registerRoutes() {
	s.router.Get("/livez", s.handleLive)
	s.router.Get("/readyz", s.handleReady)
	s.router.Get("/version", s.handleVersion)
	s.router.Get("/-/drain", s.handleDrainStatus)
	s.router.Post("/-/drain", s.handleDrain)
}

type healthResponse struct {
	Status      string         `json:"status"`
	Component   string         `json:"component"`
	Version     string         `json:"version"`
	State       platform.State `json:"state"`
	Live        bool           `json:"live"`
	Ready       bool           `json:"ready"`
	DrainReason string         `json:"drain_reason,omitempty"`
}

type versionResponse struct {
	Component string `json:"component"`
	Version   string `json:"version"`
}

func (s *Server) handleLive(writer http.ResponseWriter, _ *http.Request) {
	snapshot := s.lifecycle.Snapshot()
	status := http.StatusOK
	statusText := "alive"
	if !snapshot.Live {
		status = http.StatusServiceUnavailable
		statusText = "not_alive"
	}
	s.writeJSON(writer, status, healthResponse{
		Status:      statusText,
		Component:   string(s.cfg.Component),
		Version:     s.cfg.Version,
		State:       snapshot.State,
		Live:        snapshot.Live,
		Ready:       snapshot.Ready,
		DrainReason: snapshot.DrainReason,
	})
}

func (s *Server) handleReady(writer http.ResponseWriter, _ *http.Request) {
	snapshot := s.lifecycle.Snapshot()
	status := http.StatusOK
	statusText := "ready"
	if !snapshot.Ready {
		status = http.StatusServiceUnavailable
		statusText = "not_ready"
	}
	s.writeJSON(writer, status, healthResponse{
		Status:      statusText,
		Component:   string(s.cfg.Component),
		Version:     s.cfg.Version,
		State:       snapshot.State,
		Live:        snapshot.Live,
		Ready:       snapshot.Ready,
		DrainReason: snapshot.DrainReason,
	})
}

func (s *Server) handleVersion(writer http.ResponseWriter, _ *http.Request) {
	s.writeJSON(writer, http.StatusOK, versionResponse{
		Component: string(s.cfg.Component),
		Version:   s.cfg.Version,
	})
}

func (s *Server) handleDrainStatus(writer http.ResponseWriter, _ *http.Request) {
	snapshot := s.lifecycle.Snapshot()
	s.writeJSON(writer, http.StatusOK, healthResponse{
		Status:      string(snapshot.State),
		Component:   string(s.cfg.Component),
		Version:     s.cfg.Version,
		State:       snapshot.State,
		Live:        snapshot.Live,
		Ready:       snapshot.Ready,
		DrainReason: snapshot.DrainReason,
	})
}

func (s *Server) handleDrain(writer http.ResponseWriter, _ *http.Request) {
	snapshot := s.lifecycle.Snapshot()
	if snapshot.State == platform.StateNew || snapshot.State == platform.StateStopped {
		s.writeJSON(writer, http.StatusConflict, healthResponse{
			Status:      "not_running",
			Component:   string(s.cfg.Component),
			Version:     s.cfg.Version,
			State:       snapshot.State,
			Live:        snapshot.Live,
			Ready:       snapshot.Ready,
			DrainReason: snapshot.DrainReason,
		})
		return
	}
	s.BeginDrain("HTTP drain request")
	snapshot = s.lifecycle.Snapshot()
	s.writeJSON(writer, http.StatusAccepted, healthResponse{
		Status:      string(snapshot.State),
		Component:   string(s.cfg.Component),
		Version:     s.cfg.Version,
		State:       snapshot.State,
		Live:        snapshot.Live,
		Ready:       snapshot.Ready,
		DrainReason: snapshot.DrainReason,
	})
}

func (s *Server) writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		s.logger.Warn("write JSON response failed", "error", err)
	}
}
