package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

func TestServerHealthVersionAndDrainLifecycle(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runResult := make(chan error, 1)
	go func() { runResult <- server.Serve(ctx, listener) }()

	client := &http.Client{Timeout: time.Second}
	baseURL := "http://" + listener.Addr().String()
	waitForStatus(t, client, baseURL+"/readyz", http.StatusOK)

	ready := getJSON(t, client, baseURL+"/readyz")
	if ready["status"] != "ready" || ready["ready"] != true || ready["version"] != "test-version" {
		t.Fatalf("unexpected ready response: %+v", ready)
	}
	live := getJSON(t, client, baseURL+"/livez")
	if live["status"] != "alive" || live["live"] != true {
		t.Fatalf("unexpected live response: %+v", live)
	}
	version := getJSON(t, client, baseURL+"/version")
	if version["component"] != "server" || version["version"] != "test-version" {
		t.Fatalf("unexpected version response: %+v", version)
	}

	request, err := http.NewRequest(http.MethodPost, baseURL+"/-/drain", nil)
	if err != nil {
		t.Fatalf("create drain request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer test-token")
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("POST /-/drain error = %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("POST /-/drain status = %d, want %d", response.StatusCode, http.StatusAccepted)
	}
	var drain map[string]any
	if err := json.NewDecoder(response.Body).Decode(&drain); err != nil {
		t.Fatalf("decode drain response: %v", err)
	}
	if drain["state"] != string(platform.StateDraining) || drain["ready"] != false {
		t.Fatalf("unexpected drain response: %+v", drain)
	}

	select {
	case err := <-runResult:
		if err != nil {
			t.Fatalf("Serve() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Serve() did not stop after context cancellation")
	}
	if snapshot := server.Lifecycle().Snapshot(); snapshot.State != platform.StateStopped || snapshot.Ready || snapshot.Live {
		t.Fatalf("unexpected final lifecycle snapshot: %+v", snapshot)
	}
}

func TestServerSocketHealthDuringDrain(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runResult := make(chan error, 1)
	go func() { runResult <- server.Serve(ctx, listener) }()

	client := &http.Client{Timeout: time.Second}
	baseURL := "http://" + listener.Addr().String()
	waitForStatus(t, client, baseURL+"/readyz", http.StatusOK)
	if !server.BeginDrain("test drain") {
		t.Fatal("BeginDrain() did not transition the server")
	}
	waitForStatus(t, client, baseURL+"/readyz", http.StatusServiceUnavailable)
	waitForStatus(t, client, baseURL+"/livez", http.StatusOK)
	drain := getJSON(t, client, baseURL+"/-/drain")
	if drain["state"] != string(platform.StateDraining) || drain["ready"] != false || drain["live"] != true {
		t.Fatalf("unexpected socket drain response: %+v", drain)
	}

	cancel()
	waitForProcessResult(t, runResult)
}

func TestServerReadyEndpointReturnsUnavailableDuringDrain(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	if err := server.Lifecycle().Start(); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	readyRequest := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	readyResponse := httptest.NewRecorder()
	server.Router().ServeHTTP(readyResponse, readyRequest)
	if readyResponse.Code != http.StatusOK {
		t.Fatalf("ready status before drain = %d", readyResponse.Code)
	}

	if !server.BeginDrain("test drain") {
		t.Fatal("BeginDrain() did not transition the server")
	}
	drainRequest := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	drainResponse := httptest.NewRecorder()
	server.Router().ServeHTTP(drainResponse, drainRequest)
	if drainResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready status during drain = %d, want %d", drainResponse.Code, http.StatusServiceUnavailable)
	}
	var body map[string]any
	if err := json.NewDecoder(drainResponse.Body).Decode(&body); err != nil {
		t.Fatalf("decode draining readiness response: %v", err)
	}
	if body["ready"] != false || body["state"] != string(platform.StateDraining) {
		t.Fatalf("unexpected draining readiness response: %+v", body)
	}
}

func TestServerRejectsRemoteDrainRequest(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	if err := server.Lifecycle().Start(); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	for _, test := range []struct {
		name          string
		remoteAddr    string
		authorization string
	}{
		{name: "remote peer with valid token", remoteAddr: "192.0.2.10:1234", authorization: "Bearer test-token"},
		{name: "loopback peer with invalid token", remoteAddr: "127.0.0.1:1234", authorization: "Bearer wrong-token"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/-/drain", nil)
			request.RemoteAddr = test.remoteAddr
			request.Header.Set("Authorization", test.authorization)
			response := httptest.NewRecorder()
			server.Router().ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("drain status = %d, want %d", response.Code, http.StatusForbidden)
			}
		})
	}
	if snapshot := server.Lifecycle().Snapshot(); snapshot.State != platform.StateRunning || !snapshot.Ready {
		t.Fatalf("remote drain changed lifecycle: %+v", snapshot)
	}
}

func TestServerRejectsReentrantServeWithoutClosingActiveListener(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runResult := make(chan error, 1)
	go func() { runResult <- server.Serve(ctx, listener) }()

	client := &http.Client{Timeout: time.Second}
	baseURL := "http://" + listener.Addr().String()
	waitForStatus(t, client, baseURL+"/readyz", http.StatusOK)
	if err := server.Serve(context.Background(), listener); err == nil {
		t.Fatal("reentrant Serve() succeeded")
	}
	waitForStatus(t, client, baseURL+"/readyz", http.StatusOK)
	cancel()
	waitForProcessResult(t, runResult)
}

func TestServerFailureRevokesReadinessAndReturnsServeError(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	serveError := io.ErrUnexpectedEOF
	failing := &failingListener{Listener: listener, err: serveError}

	err = server.Serve(context.Background(), failing)
	if !errors.Is(err, serveError) {
		t.Fatalf("Serve() error = %v, want %v", err, serveError)
	}
	if snapshot := server.Lifecycle().Snapshot(); snapshot.State != platform.StateStopped || snapshot.Ready || snapshot.Live {
		t.Fatalf("unexpected final lifecycle snapshot: %+v", snapshot)
	}
}

func TestServerPropagatesListenerCloseErrorAfterServeFailure(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	serveErr := io.ErrUnexpectedEOF
	closeErr := errors.New("listener close failed")
	failing := &failingListener{Listener: listener, err: serveErr}
	wrapped := &closeErrorListener{Listener: failing, err: closeErr}

	err = server.Serve(context.Background(), wrapped)
	if !errors.Is(err, serveErr) || !errors.Is(err, closeErr) {
		t.Fatalf("Serve() error = %v, want serve and close errors", err)
	}
}

func TestServerPreservesUnexpectedServerClosedError(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	failing := &failingListener{Listener: listener, err: http.ErrServerClosed}

	err = server.Serve(context.Background(), failing)
	if !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("Serve() error = %v, want %v", err, http.ErrServerClosed)
	}
}

func TestServerReturnsErrorAfterReadyListenerFails(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	serveError := io.ErrUnexpectedEOF
	failing := &failingAfterFirstListener{Listener: listener, err: serveError, fail: make(chan struct{})}
	runResult := make(chan error, 1)
	go func() { runResult <- server.Serve(context.Background(), failing) }()

	client := &http.Client{Timeout: time.Second}
	waitForStatus(t, client, "http://"+listener.Addr().String()+"/readyz", http.StatusOK)
	close(failing.fail)
	select {
	case err := <-runResult:
		if !errors.Is(err, serveError) {
			t.Fatalf("Serve() error = %v, want %v", err, serveError)
		}
	case <-time.After(time.Second):
		t.Fatal("Serve() did not report listener failure")
	}
}

func TestServerContextCancellationRevokesHealthBeforeStop(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	releaseHandler := make(chan struct{})
	enteredHandler := make(chan struct{})
	server.router.Get("/block", func(writer http.ResponseWriter, _ *http.Request) {
		close(enteredHandler)
		<-releaseHandler
		writer.WriteHeader(http.StatusOK)
	})
	runResult := make(chan error, 1)
	go func() { runResult <- server.Serve(ctx, listener) }()

	client := &http.Client{Timeout: time.Second}
	baseURL := "http://" + listener.Addr().String()
	waitForStatus(t, client, baseURL+"/readyz", http.StatusOK)
	blockResult := make(chan error, 1)
	go func() {
		response, err := client.Get(baseURL + "/block")
		if response != nil {
			_ = response.Body.Close()
		}
		blockResult <- err
	}()
	select {
	case <-enteredHandler:
	case <-time.After(time.Second):
		t.Fatal("blocking handler did not start")
	}
	cancel()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		snapshot := server.Lifecycle().Snapshot()
		if snapshot.State == platform.StateDraining {
			if snapshot.Ready || !snapshot.Live {
				t.Fatalf("unexpected cancellation drain snapshot: %+v", snapshot)
			}
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if snapshot := server.Lifecycle().Snapshot(); snapshot.State != platform.StateDraining {
		t.Fatalf("server did not enter draining state after cancellation: %+v", snapshot)
	}
	close(releaseHandler)
	select {
	case err := <-blockResult:
		if err != nil {
			t.Fatalf("blocking request error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocking handler did not finish")
	}
	waitForProcessResult(t, runResult)
}

func TestServerForceClosesStuckRequestAfterDrainTimeout(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: 20 * time.Millisecond,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	releaseHandler := make(chan struct{})
	var released atomic.Bool
	release := func() {
		if released.CompareAndSwap(false, true) {
			close(releaseHandler)
		}
	}
	defer release()
	enteredHandler := make(chan struct{})
	server.router.Get("/block", func(writer http.ResponseWriter, _ *http.Request) {
		close(enteredHandler)
		<-releaseHandler
		writer.WriteHeader(http.StatusOK)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runResult := make(chan error, 1)
	go func() { runResult <- server.Serve(ctx, listener) }()

	client := &http.Client{Timeout: time.Second}
	baseURL := "http://" + listener.Addr().String()
	waitForStatus(t, client, baseURL+"/readyz", http.StatusOK)
	blockResult := make(chan error, 1)
	go func() {
		response, err := client.Get(baseURL + "/block")
		if response != nil {
			_ = response.Body.Close()
		}
		blockResult <- err
	}()
	select {
	case <-enteredHandler:
	case <-time.After(time.Second):
		t.Fatal("blocking handler did not start")
	}
	cancel()
	select {
	case err := <-runResult:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Serve() error = %v, want context deadline exceeded", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Serve() did not force close the stuck request")
	}
	release()
	select {
	case err := <-blockResult:
		if err == nil {
			t.Fatal("blocking request completed successfully after forced close")
		}
	case <-time.After(time.Second):
		t.Fatal("blocking request did not finish after forced close")
	}
	if snapshot := server.Lifecycle().Snapshot(); snapshot.State != platform.StateStopped || snapshot.Ready || snapshot.Live {
		t.Fatalf("unexpected forced-close lifecycle snapshot: %+v", snapshot)
	}
}

func TestServerCanceledRunStopsLifecycleBeforeListen(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "test-token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := server.Run(ctx); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if snapshot := server.Lifecycle().Snapshot(); snapshot.State != platform.StateStopped {
		t.Fatalf("canceled Run() lifecycle snapshot = %+v", snapshot)
	}
	if err := server.Run(context.Background()); err == nil {
		t.Fatal("second Run() succeeded after canceled startup")
	}
}

func TestServerRejectsInvalidConfiguration(t *testing.T) {
	_, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test",
		HTTPAddr:        "invalid",
		ShutdownTimeout: time.Second,
	}, nil)
	if err == nil {
		t.Fatal("NewServer() succeeded with invalid address")
	}
}

func waitForStatus(t *testing.T, client *http.Client, endpoint string, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.Get(endpoint)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == want {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("endpoint %s did not return status %d", endpoint, want)
}

func getJSON(t *testing.T, client *http.Client, endpoint string) map[string]any {
	t.Helper()
	response, err := client.Get(endpoint)
	if err != nil {
		t.Fatalf("GET %s error = %v", endpoint, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		t.Fatalf("GET %s status = %d", endpoint, response.StatusCode)
	}
	var value map[string]any
	if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
		t.Fatalf("decode %s response: %v", endpoint, err)
	}
	return value
}

type failingListener struct {
	net.Listener
	err error
}

type closeErrorListener struct {
	net.Listener
	err error
}

func (l *closeErrorListener) Close() error {
	_ = l.Listener.Close()
	return l.err
}

func (l *failingListener) Accept() (net.Conn, error) {
	return nil, l.err
}

type failingAfterFirstListener struct {
	net.Listener
	err      error
	accepted atomic.Bool
	fail     chan struct{}
}

func (l *failingAfterFirstListener) Accept() (net.Conn, error) {
	if l.accepted.CompareAndSwap(false, true) {
		return l.Listener.Accept()
	}
	<-l.fail
	return nil, l.err
}
