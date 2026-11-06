package runs

import (
	"errors"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestRunSeparatesInterruptRequestFromObservedTermination(t *testing.T) {
	run, err := New(NewRunInput{ID: "run-1", SessionID: "session-1", CommandID: "cmd-1", Generation: "generation-1"})
	if err != nil {
		t.Fatal(err)
	}
	run, err = run.Start("generation-1", "cursor-1")
	if err != nil {
		t.Fatal(err)
	}
	run, err = run.RequestInterrupt("generation-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != protocol.RunStatusRunning || run.Interrupt != InterruptRequested {
		t.Fatalf("after interrupt request = %+v", run)
	}
	if _, err := run.RequestInterrupt("generation-1"); !errors.Is(err, ErrInterruptRequested) {
		t.Fatalf("duplicate interrupt request error = %v, want %v", err, ErrInterruptRequested)
	}

	completed, err := run.ObserveTerminal("generation-1", protocol.RunStatusCompleted, "cursor-2", "finished before cancellation reached Codex")
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != protocol.RunStatusCompleted || completed.Interrupt != InterruptSuperseded {
		t.Fatalf("completion after interrupt request = %+v", completed)
	}

	interrupted, err := run.ObserveTerminal("generation-1", protocol.RunStatusInterrupted, "cursor-3", "termination observed")
	if err != nil {
		t.Fatal(err)
	}
	if interrupted.Status != protocol.RunStatusInterrupted || interrupted.Interrupt != InterruptObserved {
		t.Fatalf("actual interruption = %+v", interrupted)
	}
}

func TestRunUnknownReconcilesOnlyOnCurrentGeneration(t *testing.T) {
	run, err := New(NewRunInput{ID: "run-unknown", SessionID: "session-1", CommandID: "cmd-unknown", Generation: "generation-1"})
	if err != nil {
		t.Fatal(err)
	}
	run, err = run.Start("generation-1", "cursor-start")
	if err != nil {
		t.Fatal(err)
	}
	run, err = run.MarkUnknown("generation-1", "cursor-disconnect", "connection closed after send")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != protocol.RunStatusUnknown {
		t.Fatalf("unknown run status = %q", run.Status)
	}
	if _, err := run.Reconcile("generation-old", Observation{Reconciliation: protocol.ReconciliationStateConfirmed, Status: protocol.RunStatusCompleted}); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old-generation reconciliation error = %v, want %v", err, ErrStaleGeneration)
	}
	stillUnknown, err := run.Reconcile("generation-1", Observation{Reconciliation: protocol.ReconciliationStateUnknown})
	if !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("unknown reconciliation error = %v, want %v", err, protocol.ErrUnknownCommandResult)
	}
	if stillUnknown.Status != protocol.RunStatusUnknown {
		t.Fatalf("still-unknown run status = %q", stillUnknown.Status)
	}
	completed, err := run.Reconcile("generation-1", Observation{Reconciliation: protocol.ReconciliationStateConfirmed, Status: protocol.RunStatusCompleted, Cursor: "cursor-recovered"})
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != protocol.RunStatusCompleted || completed.LastCursor != "cursor-recovered" {
		t.Fatalf("reconciled run = %+v", completed)
	}
}

func TestRunRejectsInvalidTerminalTransitions(t *testing.T) {
	run, err := New(NewRunInput{ID: "run-transition", SessionID: "session-1", CommandID: "cmd-transition", Generation: "generation-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.ObserveTerminal("generation-1", protocol.RunStatusCompleted, "", ""); !errors.Is(err, ErrRunTransition) {
		t.Fatalf("pending terminal event error = %v, want %v", err, ErrRunTransition)
	}
	run, err = run.Start("generation-1", "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = run.ObserveTerminal("generation-1", protocol.RunStatusFailed, "", "failed")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Start("generation-1", ""); !errors.Is(err, ErrRunTransition) {
		t.Fatalf("terminal restart error = %v, want %v", err, ErrRunTransition)
	}
	if _, err := run.ObserveTerminal("generation-old", protocol.RunStatusFailed, "", ""); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old-generation terminal event error = %v, want %v", err, ErrStaleGeneration)
	}
}

func TestGenerationFenceAndLeaseGateFenceOldOwners(t *testing.T) {
	fence, err := NewGenerationFence(1)
	if err != nil {
		t.Fatal(err)
	}
	if err := fence.Check(1); err != nil {
		t.Fatal(err)
	}
	if err := fence.Advance(2); err != nil {
		t.Fatal(err)
	}
	if err := fence.Check(1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old generation check = %v, want %v", err, ErrStaleGeneration)
	}
	if !fence.Stop() || fence.Stop() {
		t.Fatal("GenerationFence.Stop() did not be idempotent")
	}
	if _, ok := fence.Current(); ok {
		t.Fatal("stopped fence still reports an active generation")
	}

	gate := NewLeaseGate()
	old := LeaseIdentity{Key: "worker", Generation: 1, CandidateSHA: "sha-1", ArtifactDigest: "digest-1"}
	current := LeaseIdentity{Key: "worker", Generation: 2, CandidateSHA: "sha-2", ArtifactDigest: "digest-2"}
	if err := gate.Acquire(old); err != nil {
		t.Fatal(err)
	}
	if err := gate.Acquire(current); err != nil {
		t.Fatal(err)
	}
	if err := gate.Check(old); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("old lease check = %v, want %v", err, ErrLeaseLost)
	}
	if gate.Release(old) {
		t.Fatal("old lease released the current lease")
	}
	if err := gate.Check(current); err != nil {
		t.Fatal(err)
	}
	if err := gate.Acquire(LeaseIdentity{Key: "other-worker", Generation: 3}); !errors.Is(err, ErrLeaseKeyMismatch) {
		t.Fatalf("different lease key acquire = %v, want %v", err, ErrLeaseKeyMismatch)
	}
	if !gate.Release(current) {
		t.Fatal("current lease was not released")
	}
	if err := gate.Acquire(old); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("released old generation reacquire = %v, want %v", err, ErrLeaseHeld)
	}
}
