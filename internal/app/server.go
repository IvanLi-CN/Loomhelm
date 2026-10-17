package app

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/go-chi/chi/v5"
)

type Server struct {
	cfg          platform.Config
	logger       *slog.Logger
	lifecycle    *platform.Lifecycle
	router       chi.Router
	shutdown     chan struct{}
	shuttingDown atomic.Bool
	serveMu      sync.Mutex
}

type trackedListener struct {
	net.Listener
	mu       sync.Mutex
	closeErr error
}

func (l *trackedListener) Close() error {
	err := l.Listener.Close()
	if err != nil {
		l.mu.Lock()
		if l.closeErr == nil {
			l.closeErr = err
		}
		l.mu.Unlock()
	}
	return err
}

func (l *trackedListener) closeError() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.closeErr
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
		shutdown:  make(chan struct{}, 1),
	}
	server.registerRoutes()
	return server, nil
}

func (s *Server) Run(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("server context must not be nil")
	}
	if snapshot := s.lifecycle.Snapshot(); snapshot.State != platform.StateNew {
		return fmt.Errorf("server lifecycle already started in state %q", snapshot.State)
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", s.cfg.HTTPAddr)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(err, ctxErr) {
			s.serveMu.Lock()
			if s.lifecycle.Snapshot().State == platform.StateNew {
				s.lifecycle.Stop()
			}
			s.serveMu.Unlock()
			return nil
		}
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
	s.serveMu.Lock()
	if err := s.lifecycle.Start(); err != nil {
		s.serveMu.Unlock()
		// Rejected admission never takes ownership of the listener; the caller retains it.
		return err
	}
	s.serveMu.Unlock()
	if err := ctx.Err(); err != nil {
		s.BeginDrain("context canceled")
		closeErr := listener.Close()
		s.lifecycle.Stop()
		return withListenerCloseError(nil, closeErr)
	}

	server := &http.Server{
		Handler:           s.router,
		ReadHeaderTimeout: 5 * time.Second,
	}
	tracked := &trackedListener{Listener: listener}
	serveResult := make(chan error, 1)
	go func() {
		err := server.Serve(tracked)
		if err == http.ErrServerClosed && s.shuttingDown.Load() {
			err = nil
		}
		serveResult <- err
	}()

	s.logger.Info("server started", "address", listener.Addr().String())
	select {
	case <-ctx.Done():
		return s.shutdownAndWait(server, tracked, serveResult, "context canceled")
	case <-s.shutdown:
		return s.shutdownAndWait(server, tracked, serveResult, "HTTP drain request")
	case err := <-serveResult:
		s.BeginDrain("HTTP server stopped unexpectedly")
		shutdownErr := s.shutdownHTTP(server)
		closeErr := tracked.closeError()
		s.lifecycle.Stop()
		if combined := withListenerCloseError(combineServerErrors(err, shutdownErr), closeErr); combined != nil {
			return combined
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

func (s *Server) shutdownAndWait(server *http.Server, listener *trackedListener, serveResult <-chan error, reason string) error {
	s.BeginDrain(reason)
	shutdownErr := s.shutdownHTTP(server)
	serveErr := <-serveResult
	closeErr := listener.closeError()
	s.lifecycle.Stop()
	if combined := withListenerCloseError(combineServerErrors(serveErr, shutdownErr), closeErr); combined != nil {
		return combined
	}
	s.logger.Info("server stopped")
	return nil
}

func (s *Server) shutdownHTTP(server *http.Server) error {
	s.shuttingDown.Store(true)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), s.cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		s.logger.Warn("server shutdown timed out; forcing HTTP close", "error", err)
		if closeErr := server.Close(); closeErr != nil {
			return errors.Join(err, fmt.Errorf("force close HTTP server: %w", closeErr))
		}
		return err
	}
	return nil
}

func combineServerErrors(serveErr, shutdownErr error) error {
	if serveErr == nil && shutdownErr == nil {
		return nil
	}
	if serveErr == nil {
		return fmt.Errorf("server shutdown: %w", shutdownErr)
	}
	if shutdownErr == nil {
		return fmt.Errorf("serve HTTP: %w", serveErr)
	}
	return errors.Join(fmt.Errorf("serve HTTP: %w", serveErr), fmt.Errorf("server shutdown: %w", shutdownErr))
}

func withListenerCloseError(base, closeErr error) error {
	if closeErr == nil {
		return base
	}
	closeErr = fmt.Errorf("close listener: %w", closeErr)
	if base == nil {
		return closeErr
	}
	return errors.Join(base, closeErr)
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

func (s *Server) handleDrain(writer http.ResponseWriter, request *http.Request) {
	if !isLoopbackRequest(request) || !s.validDrainToken(request) {
		s.writeJSON(writer, http.StatusForbidden, healthResponse{
			Status:    "forbidden",
			Component: string(s.cfg.Component),
			Version:   s.cfg.Version,
			State:     s.lifecycle.Snapshot().State,
		})
		return
	}
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
	select {
	case s.shutdown <- struct{}{}:
	default:
	}
}

func (s *Server) validDrainToken(request *http.Request) bool {
	if s.cfg.DrainToken == "" {
		return false
	}
	const bearerPrefix = "Bearer "
	authorization := request.Header.Get("Authorization")
	if len(authorization) <= len(bearerPrefix) || authorization[:len(bearerPrefix)] != bearerPrefix {
		return false
	}
	token := authorization[len(bearerPrefix):]
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.DrainToken)) == 1
}

func isLoopbackRequest(request *http.Request) bool {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		s.logger.Warn("write JSON response failed", "error", err)
	}
}
