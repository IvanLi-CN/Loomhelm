package sessions

import (
	"errors"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestSessionLifecycleDisconnectAndReconcile(t *testing.T) {
	session, err := New(NewInput{ID: "session-1", Path: protocol.SessionPathNew, Generation: "generation-1", CreatedAt: "created"})
	if err != nil {
		t.Fatal(err)
	}
	session, err = session.Activate("generation-1", "thread-1", "active")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.Activate("generation-2", "thread-2", ""); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("active generation switch = %v, want %v", err, ErrStaleGeneration)
	}
	session, err = session.Disconnect("generation-1", "disconnected")
	if err != nil {
		t.Fatal(err)
	}
	session, err = session.BeginReconciliation("generation-1", "reconciling")
	if err != nil {
		t.Fatal(err)
	}
	unknown, err := session.Reconcile("generation-1", protocol.ReconciliationStateUnknown, "", "still-disconnected")
	if err != nil {
		t.Fatal(err)
	}
	if unknown.State != protocol.SessionStateDisconnected {
		t.Fatalf("unknown session state = %q, want disconnected", unknown.State)
	}
	if _, err := unknown.BeginReconciliation("generation-old", ""); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old-generation reconciliation error = %v, want %v", err, ErrStaleGeneration)
	}
	unknown, err = unknown.BeginReconciliation("generation-1", "reconciling-again")
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := unknown.Reconcile("generation-1", protocol.ReconciliationStateConfirmed, "thread-1", "recovered")
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State != protocol.SessionStateActive || recovered.ExternalThreadRef != "thread-1" {
		t.Fatalf("recovered session = %+v", recovered)
	}
}

func TestSessionBindingIsExplicitAndImmutable(t *testing.T) {
	session, err := New(NewInput{ID: "session-projectless", Path: protocol.SessionPathNew, Generation: "generation-1"})
	if err != nil {
		t.Fatal(err)
	}
	request := BindRequest{TaskID: "task-1", TaskProjectID: "project-1"}
	if _, err := session.BindTask(request); !errors.Is(err, ErrShareConfirmation) {
		t.Fatalf("unconfirmed projectless binding error = %v, want %v", err, ErrShareConfirmation)
	}
	request.ConfirmShare = true
	bound, err := session.BindTask(request)
	if err != nil {
		t.Fatal(err)
	}
	if optionalStringValue(bound.TaskID) != "task-1" || optionalStringValue(bound.ProjectID) != "project-1" {
		t.Fatalf("bound session = %+v", bound)
	}
	if retry, err := bound.BindTask(BindRequest{TaskID: "task-1", TaskProjectID: "project-1", CurrentTaskSessionID: bound.ID}); err != nil || optionalStringValue(retry.TaskID) != "task-1" {
		t.Fatalf("idempotent binding retry = %+v, error %v", retry, err)
	}
	if _, err := bound.BindTask(BindRequest{TaskID: "task-2", TaskProjectID: "project-1"}); !errors.Is(err, ErrSessionBound) {
		t.Fatalf("replacement binding error = %v, want %v", err, ErrSessionBound)
	}
	projectSession, err := New(NewInput{ID: "session-project", Path: protocol.SessionPathNew, ProjectID: "project-1", Generation: "generation-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projectSession.BindTask(BindRequest{TaskID: "task-2", TaskProjectID: "project-2"}); !errors.Is(err, ErrProjectMismatch) {
		t.Fatalf("different-project binding error = %v, want %v", err, ErrProjectMismatch)
	}
}

func TestSessionReconciliationNotFoundClosesAndUnsupportedIsTerminal(t *testing.T) {
	session, err := New(NewInput{ID: "session-closed", Path: protocol.SessionPathExistingActive, Generation: "generation-1"})
	if err != nil {
		t.Fatal(err)
	}
	session, err = session.BeginReconciliation("generation-1", "reconciling")
	if err != nil {
		t.Fatal(err)
	}
	session, err = session.Reconcile("generation-1", protocol.ReconciliationStateNotFound, "", "closed")
	if err != nil || session.State != protocol.SessionStateClosed {
		t.Fatalf("not-found reconciliation = %+v, error %v", session, err)
	}
	if _, err := session.Activate("generation-2", "thread-2", ""); !errors.Is(err, ErrSessionTerminal) {
		t.Fatalf("closed activation error = %v, want %v", err, ErrSessionTerminal)
	}

	unsupported, err := New(NewInput{ID: "session-unsupported", Path: protocol.SessionPathExistingActive, Generation: "generation-1"})
	if err != nil {
		t.Fatal(err)
	}
	unsupported, err = unsupported.MarkUnsupported("unsupported")
	if err != nil || unsupported.State != protocol.SessionStateUnsupported {
		t.Fatalf("unsupported session = %+v, error %v", unsupported, err)
	}
}
