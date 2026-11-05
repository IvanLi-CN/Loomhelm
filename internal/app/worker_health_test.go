package app

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/deployment"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

func TestWorkerHealthAndDrainEndpoints(t *testing.T) {
	_, controlSubnet, err := net.ParseCIDR("10.42.0.0/24")
	if err != nil {
		t.Fatal(err)
	}
	worker, err := newTestWorker(platform.Config{
		Component:          platform.ComponentWorker,
		Version:            "test",
		CandidateSourceSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ArtifactDigest:     "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		DrainToken:         "test-token",
		DrainControlSubnet: controlSubnet,
		ShutdownTimeout:    time.Second,
		WorkerGeneration:   1,
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
	versionResponse := httptest.NewRecorder()
	worker.healthRouter().ServeHTTP(versionResponse, httptest.NewRequest(http.MethodGet, "/version", nil))
	var version map[string]any
	if err := json.NewDecoder(versionResponse.Body).Decode(&version); err != nil {
		t.Fatalf("decode version response: %v", err)
	}
	if version["candidate_source_sha"] != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || version["artifact_digest"] != "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" {
		t.Fatalf("unexpected version identity: %+v", version)
	}
	observationResponse := httptest.NewRecorder()
	worker.healthRouter().ServeHTTP(observationResponse, httptest.NewRequest(http.MethodGet, "/-/observe", nil))
	if observationResponse.Code != http.StatusOK {
		t.Fatalf("observation status = %d, want %d", observationResponse.Code, http.StatusOK)
	}
	var observation deployment.ComponentObservation
	if err := json.NewDecoder(observationResponse.Body).Decode(&observation); err != nil {
		t.Fatalf("decode observation: %v", err)
	}
	if observation.State != deployment.ObservationMeasured || observation.LoadState != deployment.ObservationUnavailable || observation.WorkerGeneration == nil || *observation.WorkerGeneration != 1 || observation.QueueDepth != nil {
		t.Fatalf("unexpected worker observation: %+v", observation)
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

	controlWorker, err := newTestWorker(platform.Config{
		Component:          platform.ComponentWorker,
		Version:            "test",
		DrainToken:         "test-token",
		DrainControlSubnet: controlSubnet,
		ShutdownTimeout:    time.Second,
		WorkerGeneration:   1,
	}, nil)
	if err != nil {
		t.Fatalf("NewWorker() control-network error = %v", err)
	}
	if err := controlWorker.lifecycle.Start(); err != nil {
		t.Fatalf("control worker lifecycle.Start() error = %v", err)
	}
	controlRequest := httptest.NewRequest(http.MethodPost, "/-/drain", nil)
	controlRequest.RemoteAddr = "10.42.0.15:1234"
	controlRequest.Header.Set("Authorization", "Bearer test-token")
	controlResponse := httptest.NewRecorder()
	controlWorker.healthRouter().ServeHTTP(controlResponse, controlRequest)
	if controlResponse.Code != http.StatusAccepted {
		t.Fatalf("control-network worker drain status = %d, want %d", controlResponse.Code, http.StatusAccepted)
	}
}
