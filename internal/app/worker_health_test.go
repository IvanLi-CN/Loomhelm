package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

func TestWorkerHealthAndDrainEndpoints(t *testing.T) {
	worker, err := newTestWorker(platform.Config{
		Component:        platform.ComponentWorker,
		Version:          "test",
		DrainToken:       "test-token",
		ShutdownTimeout:  time.Second,
		WorkerGeneration: 1,
	}, nil)
	if err != nil {
		t.Fatalf("NewWorker() error = %v", err)
	}
	worker.resourceMu.Lock()
	worker.resources = &fakeRuntime{}
	worker.resourceMu.Unlock()
	worker.runtimeReady.Store(true)
	if err := worker.lifecycle.Start(); err != nil {
		t.Fatalf("lifecycle.Start() error = %v", err)
	}

	readyResponse := httptest.NewRecorder()
	worker.healthRouter().ServeHTTP(readyResponse, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if readyResponse.Code != http.StatusOK {
		t.Fatalf("ready status = %d, want %d", readyResponse.Code, http.StatusOK)
	}
	var ready healthResponse
	if err := json.NewDecoder(readyResponse.Body).Decode(&ready); err != nil {
		t.Fatalf("decode ready response: %v", err)
	}
	if !ready.Ready || ready.Component != "worker" {
		t.Fatalf("unexpected ready response: %+v", ready)
	}

	for _, authorization := range []string{"", "Bearer wrong-token"} {
		request := httptest.NewRequest(http.MethodPost, "/-/drain", nil)
		request.RemoteAddr = "127.0.0.1:1234"
		request.Header.Set("Authorization", authorization)
		response := httptest.NewRecorder()
		worker.healthRouter().ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("drain status for %q = %d, want %d", authorization, response.Code, http.StatusForbidden)
		}
	}

	drainRequest := httptest.NewRequest(http.MethodPost, "/-/drain", nil)
	drainRequest.RemoteAddr = "127.0.0.1:1234"
	drainRequest.Header.Set("Authorization", "Bearer test-token")
	drainResponse := httptest.NewRecorder()
	worker.healthRouter().ServeHTTP(drainResponse, drainRequest)
	if drainResponse.Code != http.StatusAccepted {
		t.Fatalf("drain status = %d, want %d", drainResponse.Code, http.StatusAccepted)
	}
	if snapshot := worker.Lifecycle(); snapshot.Ready || snapshot.State != platform.StateDraining {
		t.Fatalf("unexpected draining snapshot: %+v", snapshot)
	}
	select {
	case <-worker.shutdown:
	default:
		t.Fatal("drain endpoint did not request worker shutdown")
	}
}
