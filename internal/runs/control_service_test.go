package runs

import (
	"context"
	"errors"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
)

func TestInterruptRunGenerationFailureDoesNotReserveRun(t *testing.T) {
	resolverErr := errors.New("generation lookup failed")
	commandID := "interrupt-generation-failure"
	run := Run{
		ID:         "run-1",
		SessionID:  "session-1",
		Generation: "generation-1",
		Status:     protocol.RunStatusRunning,
		Interrupt:  InterruptNone,
	}
	runs := &controlServiceRunStore{run: run}
	controller, err := NewController(&Store{}, controlServiceTransport{}, ControllerConfig{
		ResolveGeneration: func(context.Context, string) (string, error) {
			return "", resolverErr
		},
	})
	if err != nil {
		t.Fatalf("NewController() error = %v", err)
	}
	service, err := NewControlService(ControlServiceConfig{
		Controller: controller,
		Sessions: controlServiceSessionReader{session: sessions.Session{
			Session:    protocol.Session{ID: run.SessionID},
			Generation: run.Generation,
		}},
		Runs:      runs,
		Approvals: controlServiceApprovalStore{},
		Authorize: func(context.Context, auth.Principal, string, bool) error { return nil },
	})
	if err != nil {
		t.Fatalf("NewControlService() error = %v", err)
	}

	_, err = service.InterruptRun(context.Background(), auth.Principal{UserID: "user-1"}, run.ID, protocol.InterruptRunRequest{CommandID: commandID})
	if !errors.Is(err, resolverErr) {
		t.Fatalf("InterruptRun() error = %v, want %v", err, resolverErr)
	}
	if runs.requestInterruptCalls != 0 {
		t.Fatalf("RequestInterrupt calls = %d, want 0", runs.requestInterruptCalls)
	}
}

type controlServiceTransport struct{}

func (controlServiceTransport) SendCommand(context.Context, protocol.Command) (protocol.CommandAck, error) {
	return protocol.CommandAck{}, nil
}

func (controlServiceTransport) ReconcileCommand(context.Context, protocol.Command) (protocol.Reconciliation, error) {
	return protocol.Reconciliation{}, nil
}

type controlServiceSessionReader struct {
	session sessions.Session
}

func (r controlServiceSessionReader) Get(context.Context, string) (sessions.Session, error) {
	return r.session, nil
}

type controlServiceRunStore struct {
	run                   Run
	requestInterruptCalls int
}

func (s *controlServiceRunStore) GetRun(context.Context, string) (Run, error) {
	return s.run, nil
}

func (s *controlServiceRunStore) RequestInterrupt(context.Context, string, string) (Run, error) {
	s.requestInterruptCalls++
	return s.run, nil
}

type controlServiceApprovalStore struct{}

func (controlServiceApprovalStore) Get(context.Context, string) (approvals.Approval, error) {
	return approvals.Approval{}, nil
}

func (controlServiceApprovalStore) ListByRun(context.Context, string, *approvals.Cursor, int) (approvals.ListPage, error) {
	return approvals.ListPage{}, nil
}

func (controlServiceApprovalStore) Resolve(context.Context, approvals.ResolveRequest) (approvals.Resolution, error) {
	return approvals.Resolution{}, nil
}
