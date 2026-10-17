package platform

import (
	"context"
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
