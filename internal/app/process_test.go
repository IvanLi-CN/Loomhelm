package app

import (
	"context"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

func TestWorkerAndConnectorStopOnContextCancellation(t *testing.T) {
	worker, err := NewWorker(platform.Config{
		Component:        platform.ComponentWorker,
		Version:          "test",
		ShutdownTimeout:  time.Second,
		WorkerGeneration: 7,
	}, nil)
	if err != nil {
		t.Fatalf("NewWorker() error = %v", err)
	}
	if worker.GenerationController() != nil {
		t.Fatal("worker exposed a generation controller before it was running")
	}
	workerContext, cancelWorker := context.WithCancel(context.Background())
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(workerContext) }()
	waitForLifecycleState(t, worker.lifecycle, platform.StateRunning)
	if generation := worker.GenerationController(); generation == nil || generation.Current() != 7 {
		t.Fatalf("unexpected worker generation controller: %#v", generation)
	}
	generation := worker.GenerationController()
	cancelWorker()
	waitForProcessResult(t, workerResult)
	select {
	case <-generation.Context().Done():
	default:
		t.Fatal("worker generation context was not canceled")
	}
	if snapshot := worker.Lifecycle(); snapshot.State != platform.StateStopped || snapshot.Ready || snapshot.Live {
		t.Fatalf("unexpected worker snapshot: %+v", snapshot)
	}

	connector, err := NewConnector(platform.Config{
		Component:          platform.ComponentConnector,
		Version:            "test",
		ShutdownTimeout:    time.Second,
		ConnectorServerURL: "https://platform.example.test",
	}, nil)
	if err != nil {
		t.Fatalf("NewConnector() error = %v", err)
	}
	connectorContext, cancelConnector := context.WithCancel(context.Background())
	connectorResult := make(chan error, 1)
	go func() { connectorResult <- connector.Run(connectorContext) }()
	waitForLifecycleState(t, connector.lifecycle, platform.StateRunning)
	cancelConnector()
	waitForProcessResult(t, connectorResult)
	if snapshot := connector.Lifecycle(); snapshot.State != platform.StateStopped {
		t.Fatalf("unexpected connector snapshot: %+v", snapshot)
	}
}

func TestConnectorPreCanceledContextStopsBeforeReadiness(t *testing.T) {
	connector, err := NewConnector(platform.Config{
		Component:          platform.ComponentConnector,
		Version:            "test",
		ShutdownTimeout:    time.Second,
		ConnectorServerURL: "https://platform.example.test",
	}, nil)
	if err != nil {
		t.Fatalf("NewConnector() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := connector.Run(ctx); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if snapshot := connector.Lifecycle(); snapshot.State != platform.StateStopped || snapshot.Ready || snapshot.Live {
		t.Fatalf("unexpected pre-canceled connector snapshot: %+v", snapshot)
	}
}

func TestConnectorRejectsSecondRunWithoutStoppingActiveProcess(t *testing.T) {
	connector, err := NewConnector(platform.Config{
		Component:          platform.ComponentConnector,
		Version:            "test",
		ShutdownTimeout:    time.Second,
		ConnectorServerURL: "https://platform.example.test",
	}, nil)
	if err != nil {
		t.Fatalf("NewConnector() error = %v", err)
	}
	firstContext, cancelFirst := context.WithCancel(context.Background())
	firstResult := make(chan error, 1)
	go func() { firstResult <- connector.Run(firstContext) }()
	waitForLifecycleState(t, connector.lifecycle, platform.StateRunning)

	secondContext, cancelSecond := context.WithCancel(context.Background())
	cancelSecond()
	if err := connector.Run(secondContext); err == nil {
		t.Fatal("second Run() succeeded")
	}
	if snapshot := connector.Lifecycle(); snapshot.State != platform.StateRunning || !snapshot.Ready {
		t.Fatalf("second Run() changed active connector snapshot: %+v", snapshot)
	}
	cancelFirst()
	waitForProcessResult(t, firstResult)
}

func TestWorkerRejectsSecondRunWithoutReplacingGeneration(t *testing.T) {
	worker, err := NewWorker(platform.Config{
		Component:        platform.ComponentWorker,
		Version:          "test",
		ShutdownTimeout:  time.Second,
		WorkerGeneration: 3,
	}, nil)
	if err != nil {
		t.Fatalf("NewWorker() error = %v", err)
	}
	firstContext, cancelFirst := context.WithCancel(context.Background())
	firstResult := make(chan error, 1)
	go func() { firstResult <- worker.Run(firstContext) }()
	waitForLifecycleState(t, worker.lifecycle, platform.StateRunning)
	firstGeneration := worker.GenerationController()
	secondContext, cancelSecond := context.WithCancel(context.Background())
	cancelSecond()
	if err := worker.Run(secondContext); err == nil {
		t.Fatal("second Run() succeeded")
	}
	if worker.GenerationController() != firstGeneration {
		t.Fatal("second Run() replaced the active generation controller")
	}
	cancelFirst()
	waitForProcessResult(t, firstResult)
}

func waitForLifecycleState(t *testing.T, lifecycle *platform.Lifecycle, want platform.State) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if lifecycle.Snapshot().State == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("lifecycle did not reach state %q", want)
}

func waitForProcessResult(t *testing.T, result <-chan error) {
	t.Helper()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("process returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("process did not stop after context cancellation")
	}
}
