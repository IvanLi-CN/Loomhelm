package platform

import "testing"

func TestLifecycleRevokesReadinessBeforeStop(t *testing.T) {
	lifecycle := NewLifecycle()
	if snapshot := lifecycle.Snapshot(); snapshot.Live || snapshot.Ready || snapshot.State != StateNew {
		t.Fatalf("unexpected initial snapshot: %+v", snapshot)
	}
	if err := lifecycle.Start(); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if snapshot := lifecycle.Snapshot(); !snapshot.Live || !snapshot.Ready || snapshot.State != StateRunning {
		t.Fatalf("unexpected running snapshot: %+v", snapshot)
	}
	if !lifecycle.BeginDrain("test signal") {
		t.Fatal("BeginDrain() = false, want true")
	}
	if snapshot := lifecycle.Snapshot(); !snapshot.Live || snapshot.Ready || snapshot.State != StateDraining || snapshot.DrainReason != "test signal" {
		t.Fatalf("unexpected draining snapshot: %+v", snapshot)
	}
	if !lifecycle.Stop() {
		t.Fatal("Stop() = false, want true")
	}
	if snapshot := lifecycle.Snapshot(); snapshot.Live || snapshot.Ready || snapshot.State != StateStopped {
		t.Fatalf("unexpected stopped snapshot: %+v", snapshot)
	}
}
