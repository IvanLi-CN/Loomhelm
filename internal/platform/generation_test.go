package platform

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
)

func TestGenerationControllerCancelsStaleGenerationOnAdvance(t *testing.T) {
	controller, err := NewGenerationController(context.Background(), 4)
	if err != nil {
		t.Fatalf("NewGenerationController() error = %v", err)
	}
	oldContext := controller.Context()

	if err := controller.Advance(5); err != nil {
		t.Fatalf("Advance() error = %v", err)
	}
	select {
	case <-oldContext.Done():
	default:
		t.Fatal("old generation context was not canceled")
	}
	if controller.Current() != 5 {
		t.Fatalf("Current() = %d, want 5", controller.Current())
	}
	if controller.IsCurrent(4) {
		t.Fatal("stale generation is still current")
	}
	newContext, ok := controller.ContextFor(5)
	if !ok || newContext == nil {
		t.Fatal("current generation context is unavailable")
	}
	select {
	case <-newContext.Done():
		t.Fatal("new generation context is already canceled")
	default:
	}

	if controller.Cancel(4) {
		t.Fatal("Cancel() accepted stale generation")
	}
	if !controller.Cancel(5) {
		t.Fatal("Cancel() rejected current generation")
	}
	select {
	case <-newContext.Done():
	default:
		t.Fatal("current generation context was not canceled")
	}
}

func TestGenerationControllerStopPreventsResurrection(t *testing.T) {
	controller, err := NewGenerationController(context.Background(), 1)
	if err != nil {
		t.Fatalf("NewGenerationController() error = %v", err)
	}
	if !controller.Stop() {
		t.Fatal("Stop() = false, want true")
	}
	if controller.Advance(2) == nil {
		t.Fatal("Advance() succeeded after Stop()")
	}
	if controller.IsCurrent(1) {
		t.Fatal("stopped generation is still current")
	}
}

func TestGenerationControllerConcurrentAccess(t *testing.T) {
	controller, err := NewGenerationController(context.Background(), 1)
	if err != nil {
		t.Fatalf("NewGenerationController() error = %v", err)
	}

	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for j := 0; j < 1000; j++ {
				_ = controller.Current()
				_ = controller.Context()
				_, _ = controller.ContextFor(1)
				_ = controller.IsCurrent(1)
				_ = controller.Cancel(99)
			}
		}()
	}
	if err := controller.Advance(2); err != nil {
		t.Fatalf("Advance() error = %v", err)
	}
	group.Wait()
	if controller.Current() != 2 {
		t.Fatalf("current generation = %d, want 2", controller.Current())
	}
}

func TestGenerationControllerConcurrentTransitions(t *testing.T) {
	controller, err := NewGenerationController(context.Background(), 1)
	if err != nil {
		t.Fatalf("NewGenerationController() error = %v", err)
	}
	if err := controller.Advance(2); err != nil {
		t.Fatalf("initial Advance() error = %v", err)
	}
	currentContext := controller.Context()
	if !controller.CancelCurrent() {
		t.Fatal("initial CancelCurrent() = false, want true")
	}
	select {
	case <-currentContext.Done():
	default:
		t.Fatal("initial generation context was not canceled")
	}
	if err := controller.Advance(3); err != nil {
		t.Fatalf("second Advance() error = %v", err)
	}

	var advances atomic.Int64
	var cancellations atomic.Int64
	var group sync.WaitGroup
	for i := 0; i < 4; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for generation := uint64(4); generation < 102; generation++ {
				if err := controller.Advance(generation); err == nil {
					advances.Add(1)
				}
				if controller.CancelCurrent() {
					cancellations.Add(1)
				}
			}
		}()
	}
	group.Wait()
	if advances.Load() == 0 {
		t.Fatal("concurrent transitions accepted no generation advance")
	}
	if cancellations.Load() == 0 {
		t.Fatal("concurrent transitions accepted no generation cancellation")
	}
	if !controller.IsCurrent(controller.Current()) {
		t.Fatal("active controller rejected its current generation")
	}
	if !controller.Stop() {
		t.Fatal("Stop() = false, want true")
	}
	if controller.IsCurrent(controller.Current()) {
		t.Fatal("stopped controller still reports a current generation")
	}
}
