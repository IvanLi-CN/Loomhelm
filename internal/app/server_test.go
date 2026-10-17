package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
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
	runResult := make(chan error, 1)
	go func() { runResult <- server.Serve(ctx, listener) }()

	client := &http.Client{Timeout: time.Second}
	baseURL := "http://" + listener.Addr().String()
	waitForStatus(t, client, baseURL+"/readyz", http.StatusOK)
	if !server.BeginDrain("test drain") {
		t.Fatal("BeginDrain() = false, want true")
	}
	waitForStatus(t, client, baseURL+"/readyz", http.StatusServiceUnavailable)
	if live := getJSON(t, client, baseURL+"/livez"); live["live"] != true {
		t.Fatalf("unexpected draining liveness response: %+v", live)
	}
	if drain := getJSON(t, client, baseURL+"/-/drain"); drain["state"] != string(platform.StateDraining) {
		t.Fatalf("unexpected drain status response: %+v", drain)
	}
	cancel()
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
