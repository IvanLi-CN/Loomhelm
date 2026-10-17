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

	response, err := client.Post(baseURL+"/-/drain", "", nil)
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

func TestServerReadyEndpointReturnsUnavailableDuringDrain(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
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
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	if err := server.Lifecycle().Start(); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/-/drain", nil)
	request.RemoteAddr = "192.0.2.10:1234"
	response := httptest.NewRecorder()
	server.Router().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("remote drain status = %d, want %d", response.Code, http.StatusForbidden)
	}
	if snapshot := server.Lifecycle().Snapshot(); snapshot.State != platform.StateRunning || !snapshot.Ready {
		t.Fatalf("remote drain changed lifecycle: %+v", snapshot)
	}
}

func TestServerFailureRevokesReadinessAndReturnsServeError(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
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

func TestServerPreservesUnexpectedServerClosedError(t *testing.T) {
	server, err := NewServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
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
