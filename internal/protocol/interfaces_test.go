package protocol

import (
	"context"
	"errors"
	"testing"
)

type fakeGateway struct {
	started  int
	attached int
}

func (f *fakeGateway) StartNewSession(context.Context, NewSessionRequest) (GatewaySession, error) {
	f.started++
	return GatewaySession{Handle: "new", Path: SessionPathNew}, nil
}

func (f *fakeGateway) AttachActiveSession(context.Context, ExistingSessionRequest) (GatewaySession, error) {
	f.attached++
	return GatewaySession{Handle: "active", Path: SessionPathExistingActive}, nil
}

func (*fakeGateway) ReconcileSession(context.Context, string) (Reconciliation, error) {
	return Reconciliation{}, nil
}

func (*fakeGateway) CloseSession(context.Context, GatewaySession) error { return nil }

type fakeAdapter struct {
	started  int
	attached int
}

func (f *fakeAdapter) StartSession(context.Context, GatewaySession, NewSessionRequest) (AdapterSession, error) {
	f.started++
	return AdapterSession{SessionID: "new-session"}, nil
}

func (f *fakeAdapter) AttachSession(context.Context, GatewaySession, ExistingSessionRequest) (AdapterSession, error) {
	f.attached++
	return AdapterSession{SessionID: "active-session"}, nil
}

func (*fakeAdapter) SendCommand(context.Context, AdapterSession, Command) (CommandAck, error) {
	return CommandAck{}, nil
}

func (*fakeAdapter) ReconcileCommand(context.Context, AdapterSession, string) (Reconciliation, error) {
	return Reconciliation{}, nil
}

func (*fakeAdapter) CloseSession(context.Context, AdapterSession) error { return nil }

func TestOpenSessionKeepsR01PathsSeparate(t *testing.T) {
	gateway := &fakeGateway{}
	adapter := &fakeAdapter{}
	_, err := OpenSession(context.Background(), gateway, adapter, CreateSessionRequest{Path: SessionPathNew})
	if err != nil {
		t.Fatal(err)
	}
	if gateway.started != 1 || adapter.started != 1 || gateway.attached != 0 || adapter.attached != 0 {
		t.Fatalf("new path calls = gateway start %d, adapter start %d, gateway attach %d, adapter attach %d", gateway.started, adapter.started, gateway.attached, adapter.attached)
	}

	activeRef := "active-thread-ref"
	_, err = OpenSession(context.Background(), gateway, adapter, CreateSessionRequest{
		Path:            SessionPathExistingActive,
		ActiveThreadRef: &activeRef,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gateway.attached != 1 || adapter.attached != 1 {
		t.Fatalf("existing path calls = gateway attach %d, adapter attach %d", gateway.attached, adapter.attached)
	}

	_, err = OpenSession(context.Background(), gateway, adapter, CreateSessionRequest{Path: SessionPathExistingActive})
	if !errors.Is(err, ErrUnsupportedSessionPath) {
		t.Fatalf("missing active reference error = %v, want %v", err, ErrUnsupportedSessionPath)
	}
	if gateway.started != 1 || adapter.started != 1 {
		t.Fatal("existing path fell back to the new-session path")
	}
}

func TestValidateCommandRequiresStableIdentityAndPayload(t *testing.T) {
	if err := ValidateCommand(Command{}); err == nil {
		t.Fatal("empty command was accepted")
	}
	if err := ValidateCommand(Command{CommandID: "command-1", Kind: CommandKindRunSend, SessionID: "session-1"}); err == nil {
		t.Fatal("command without payload was accepted")
	}
	if err := ValidateCommand(Command{CommandID: "command-1", Kind: CommandKindRunSend, SessionID: "session-1", Payload: []byte(`{"prompt":"hello"}`)}); err != nil {
		t.Fatal(err)
	}
}
