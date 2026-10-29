package app

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/artifacts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

type fakeRuntime struct {
	ping   func(context.Context) error
	ready  func() bool
	start  func(context.Context, *platform.GenerationController, *platform.Lifecycle) error
	stop   func(context.Context) error
	wait   func(context.Context) error
	mcp    http.Handler
	closed atomic.Bool
}

func (r *fakeRuntime) Ping(ctx context.Context) error {
	if r.ping != nil {
		return r.ping(ctx)
	}
	return nil
}
func (r *fakeRuntime) Ready() bool {
	if r.ready != nil {
		return r.ready()
	}
	return true
}
func (r *fakeRuntime) Start(ctx context.Context, gen *platform.GenerationController, lifecycle *platform.Lifecycle) error {
	if r.start != nil {
		return r.start(ctx, gen, lifecycle)
	}
	return nil
}
func (r *fakeRuntime) Stop(ctx context.Context) error {
	if r.stop != nil {
		return r.stop(ctx)
	}
	return nil
}
func (r *fakeRuntime) StopAndCancel(ctx context.Context) error { return r.Stop(ctx) }
func (r *fakeRuntime) WaitStopped(ctx context.Context) error {
	if r.wait != nil {
		return r.wait(ctx)
	}
	return nil
}
func (r *fakeRuntime) Close()                   { r.closed.Store(true) }
func (r *fakeRuntime) MCPHandler() http.Handler { return r.mcp }

func fakeFactory(r *fakeRuntime) runtimeFactory {
	return func(context.Context, platform.Config, *slog.Logger) (processRuntime, error) { return r, nil }
}

func newTestServer(cfg platform.Config, logger *slog.Logger) (*Server, error) {
	cfg.DatabaseURL = "postgres://test@localhost/loomhelm"
	s, err := NewServer(cfg, logger)
	if err == nil {
		s.openRuntime = fakeFactory(&fakeRuntime{})
	}
	return s, err
}

func newTestWorker(cfg platform.Config, logger *slog.Logger) (*Worker, error) {
	cfg.DatabaseURL = "postgres://test@localhost/loomhelm"
	w, err := NewWorker(cfg, logger)
	if err == nil {
		w.openRuntime = fakeFactory(&fakeRuntime{})
	}
	return w, err
}

type repeatedArtifactRecoveryStore struct {
	calls atomic.Int32
}

func (s *repeatedArtifactRecoveryStore) Recover(context.Context, int) (artifacts.RecoveryReport, error) {
	call := s.calls.Add(1)
	return artifacts.RecoveryReport{Scanned: int(call)}, nil
}

func TestDatabaseRuntimeRepeatsArtifactRecoveryUntilClosed(t *testing.T) {
	store := &repeatedArtifactRecoveryStore{}
	runtime := &databaseRuntime{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	runtime.startArtifactRecoveryWithInterval(store, time.Millisecond)
	t.Cleanup(func() { runtime.stopArtifactRecovery() })

	deadline := time.After(time.Second)
	for store.calls.Load() < 2 {
		select {
		case <-deadline:
			t.Fatalf("artifact recovery calls = %d, want at least 2", store.calls.Load())
		case <-time.After(time.Millisecond):
		}
	}
	runtime.stopArtifactRecovery()
	callsAtStop := store.calls.Load()
	time.Sleep(10 * time.Millisecond)
	if store.calls.Load() != callsAtStop {
		t.Fatalf("artifact recovery calls continued after stop: before=%d after=%d", callsAtStop, store.calls.Load())
	}
}

func TestServerPersistenceFailureRetainsCallerListener(t *testing.T) {
	s, err := newTestServer(platform.Config{Component: platform.ComponentServer, Version: "test", HTTPAddr: "127.0.0.1:0", DrainToken: "token", ShutdownTimeout: time.Second}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := errors.New("database unavailable")
	s.openRuntime = func(context.Context, platform.Config, *slog.Logger) (processRuntime, error) { return nil, want }
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := s.Serve(context.Background(), listener); !errors.Is(err, want) {
		t.Fatalf("Serve error = %v", err)
	}
	if s.Lifecycle().Ready {
		t.Fatal("server reported ready after persistence failed")
	}
	if err := listener.Close(); err != nil {
		t.Fatalf("failed preparation took listener ownership: %v", err)
	}
}

func TestServerReadinessTracksPersistenceAvailability(t *testing.T) {
	s, err := newTestServer(platform.Config{Component: platform.ComponentServer, Version: "test", HTTPAddr: "127.0.0.1:0", DrainToken: "token", ShutdownTimeout: time.Second}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var unavailable atomic.Bool
	r := &fakeRuntime{ping: func(context.Context) error {
		if unavailable.Load() {
			return errors.New("unavailable")
		}
		return nil
	}}
	s.openRuntime = fakeFactory(r)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, listener) }()
	waitForLifecycleState(t, s.lifecycle, platform.StateRunning)
	for _, state := range []bool{false, true, false} {
		unavailable.Store(state)
		response := httptest.NewRecorder()
		s.Router().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		want := http.StatusOK
		if state {
			want = http.StatusServiceUnavailable
		}
		if response.Code != want {
			t.Fatalf("unavailable=%t: readiness = %d", state, response.Code)
		}
		live := httptest.NewRecorder()
		s.Router().ServeHTTP(live, httptest.NewRequest(http.MethodGet, "/livez", nil))
		if live.Code != http.StatusOK {
			t.Fatal("database availability changed process liveness")
		}
	}
	cancel()
	waitForProcessResult(t, done)
	if !r.closed.Load() {
		t.Fatal("server retained resources after stopping")
	}
}

func TestWorkerReadinessWaitsForRunnerAndDrainPrecedesStop(t *testing.T) {
	w, err := newTestWorker(platform.Config{Component: platform.ComponentWorker, Version: "test", ShutdownTimeout: time.Second, WorkerGeneration: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var generation *platform.GenerationController
	var wrongOrder atomic.Bool
	r := &fakeRuntime{
		start: func(ctx context.Context, gen *platform.GenerationController, _ *platform.Lifecycle) error {
			generation = gen
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
		stop: func(context.Context) error {
			if w.Lifecycle().Ready || generation.Context().Err() != nil {
				wrongOrder.Store(true)
			}
			return nil
		},
	}
	w.openRuntime = fakeFactory(r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("runner did not enter startup")
	}
	if w.Lifecycle().Ready {
		t.Fatal("worker reported ready before runner started")
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for !w.Lifecycle().Ready && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !w.Lifecycle().Ready {
		t.Fatal("worker never reported ready")
	}
	cancel()
	waitForProcessResult(t, done)
	if wrongOrder.Load() {
		t.Fatal("runner stopped before readiness was revoked, or after generation cancellation")
	}
	if generation.Context().Err() == nil || !r.closed.Load() {
		t.Fatal("worker retained resources after stopping")
	}
}

func TestWorkerStartupFailureClosesResources(t *testing.T) {
	w, err := newTestWorker(platform.Config{Component: platform.ComponentWorker, Version: "test", ShutdownTimeout: time.Second, WorkerGeneration: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := errors.New("runner startup failed")
	r := &fakeRuntime{start: func(context.Context, *platform.GenerationController, *platform.Lifecycle) error { return want }}
	w.openRuntime = fakeFactory(r)
	if err := w.Run(context.Background()); !errors.Is(err, want) {
		t.Fatalf("Run error = %v", err)
	}
	if w.Lifecycle().Ready || w.Lifecycle().State != platform.StateStopped || !r.closed.Load() {
		t.Fatal("failed startup retained ready state or resources")
	}
	if w.GenerationController().Context().Err() == nil {
		t.Fatal("failed startup retained generation")
	}
}

func TestWorkerStartupDeadlineCancelsRunner(t *testing.T) {
	w, err := newTestWorker(platform.Config{Component: platform.ComponentWorker, Version: "test", ShutdownTimeout: time.Second, StartupTimeout: 20 * time.Millisecond, WorkerGeneration: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := &fakeRuntime{start: func(ctx context.Context, _ *platform.GenerationController, _ *platform.Lifecycle) error {
		<-ctx.Done()
		return ctx.Err()
	}}
	w.openRuntime = fakeFactory(r)
	if err := w.Run(context.Background()); err == nil {
		t.Fatal("Run accepted startup timeout")
	}
	if w.Lifecycle().Ready || !r.closed.Load() {
		t.Fatal("startup timeout retained readiness or resources")
	}
}

func TestWorkerStopTimeoutKeepsGenerationUntilForcedStopCompletes(t *testing.T) {
	w, err := newTestWorker(platform.Config{Component: platform.ComponentWorker, Version: "test", ShutdownTimeout: 20 * time.Millisecond, WorkerGeneration: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	var generation *platform.GenerationController
	var attempts atomic.Int32
	var wrongOrder atomic.Bool
	r := &fakeRuntime{
		start: func(_ context.Context, gen *platform.GenerationController, _ *platform.Lifecycle) error {
			generation = gen
			close(started)
			return nil
		},
		stop: func(ctx context.Context) error {
			if w.Lifecycle().Ready {
				wrongOrder.Store(true)
			}
			if attempts.Add(1) == 1 {
				<-ctx.Done()
				return ctx.Err()
			}
			if generation.Context().Err() != nil {
				wrongOrder.Store(true)
			}
			return nil
		},
	}
	w.openRuntime = fakeFactory(r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("runner did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Run error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not finish forced stop")
	}
	if attempts.Load() != 2 || wrongOrder.Load() || !r.closed.Load() {
		t.Fatal("forced stop order or resource cleanup was incorrect")
	}
	if generation.Context().Err() == nil {
		t.Fatal("generation was not stopped after runner cleanup")
	}
}

func TestWorkerRetainsRuntimeAfterBothStopDeadlinesUntilStopped(t *testing.T) {
	w, err := newTestWorker(platform.Config{Component: platform.ComponentWorker, Version: "test", ShutdownTimeout: 20 * time.Millisecond, WorkerGeneration: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	started, stopped := make(chan struct{}), make(chan struct{})
	var generation *platform.GenerationController
	var attempts atomic.Int32
	r := &fakeRuntime{
		start: func(_ context.Context, gen *platform.GenerationController, _ *platform.Lifecycle) error {
			generation = gen
			close(started)
			return nil
		},
		stop: func(ctx context.Context) error {
			attempts.Add(1)
			<-ctx.Done()
			return ctx.Err()
		},
		wait: func(ctx context.Context) error {
			select {
			case <-stopped:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	}
	w.openRuntime = fakeFactory(r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("runner did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Run error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not return its shutdown timeout")
	}
	retained := !r.closed.Load() && generation.Context().Err() == nil && w.Lifecycle().State == platform.StateDraining && !w.Lifecycle().Ready
	close(stopped)
	deadline := time.Now().Add(time.Second)
	for w.Lifecycle().State != platform.StateStopped && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !retained {
		t.Fatal("runtime or generation was released before the runner stopped")
	}
	if attempts.Load() != 2 || !r.closed.Load() || generation.Context().Err() == nil || w.Lifecycle().State != platform.StateStopped {
		t.Fatal("retained runtime was not released after the runner stopped")
	}
}
