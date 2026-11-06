package protocol

import (
	"context"
	"errors"
	"testing"
)

type fakeGateway struct {
	started  int
	attached int
	newIDs   []string
	attachID string
}

func (f *fakeGateway) StartNewSession(_ context.Context, request NewSessionRequest) (GatewaySession, error) {
	f.started++
	f.newIDs = append(f.newIDs, request.CommandID)
	return GatewaySession{Handle: "new", Path: SessionPathNew}, nil
}

func (f *fakeGateway) AttachActiveSession(_ context.Context, request ExistingSessionRequest) (GatewaySession, error) {
	f.attached++
	f.attachID = request.CommandID
	return GatewaySession{Handle: "active", Path: SessionPathExistingActive}, nil
}

func (*fakeGateway) ReconcileSession(context.Context, string) (Reconciliation, error) {
	return Reconciliation{}, nil
}

func (*fakeGateway) CloseSession(context.Context, GatewaySession) error { return nil }

type fakeAdapter struct {
	started  int
	attached int
	newIDs   []string
	attachID string
}

func (f *fakeAdapter) StartSession(_ context.Context, _ GatewaySession, request NewSessionRequest) (AdapterSession, error) {
	f.started++
	f.newIDs = append(f.newIDs, request.CommandID)
	return AdapterSession{SessionID: "new-session"}, nil
}

func (f *fakeAdapter) AttachSession(_ context.Context, _ GatewaySession, request ExistingSessionRequest) (AdapterSession, error) {
	f.attached++
	f.attachID = request.CommandID
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
	_, err := OpenSession(context.Background(), gateway, adapter, CreateSessionRequest{CommandID: "create-1", Path: SessionPathNew})
	if err != nil {
		t.Fatal(err)
	}
	if gateway.started != 1 || adapter.started != 1 || gateway.attached != 0 || adapter.attached != 0 {
		t.Fatalf("new path calls = gateway start %d, adapter start %d, gateway attach %d, adapter attach %d", gateway.started, adapter.started, gateway.attached, adapter.attached)
	}

	activeRef := "active-thread-ref"
	_, err = OpenSession(context.Background(), gateway, adapter, CreateSessionRequest{
		CommandID:       "attach-1",
		Path:            SessionPathExistingActive,
		ActiveThreadRef: &activeRef,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gateway.attached != 1 || adapter.attached != 1 {
		t.Fatalf("existing path calls = gateway attach %d, adapter attach %d", gateway.attached, adapter.attached)
	}
	if gateway.newIDs[0] != "create-1" || adapter.newIDs[0] != "create-1" || gateway.attachID != "attach-1" || adapter.attachID != "attach-1" {
		t.Fatal("session creation identity was not preserved across the service boundary")
	}

	_, err = OpenSession(context.Background(), gateway, adapter, CreateSessionRequest{CommandID: "attach-2", Path: SessionPathExistingActive})
	if !errors.Is(err, ErrUnsupportedSessionPath) {
		t.Fatalf("missing active reference error = %v, want %v", err, ErrUnsupportedSessionPath)
	}
	if gateway.started != 1 || adapter.started != 1 {
		t.Fatal("existing path fell back to the new-session path")
	}
}

func TestOpenSessionWithIdentityRetainsGatewayResult(t *testing.T) {
	gateway := &fakeGateway{}
	adapter := &fakeAdapter{}
	opened, err := OpenSessionWithIdentity(context.Background(), gateway, adapter, CreateSessionRequest{CommandID: "create-with-identity", Path: SessionPathNew})
	if err != nil {
		t.Fatal(err)
	}
	if opened.GatewaySession.Handle != "new" || opened.GatewaySession.Path != SessionPathNew || opened.AdapterSession.SessionID != "new-session" {
		t.Fatalf("opened session = %+v, want gateway and adapter identities", opened)
	}
}

func TestOpenSessionRejectsMissingCreationIdentityBeforeSideEffects(t *testing.T) {
	for _, id := range []string{"", " \t\n"} {
		gateway := &fakeGateway{}
		adapter := &fakeAdapter{}
		_, err := OpenSession(context.Background(), gateway, adapter, CreateSessionRequest{CommandID: id, Path: SessionPathNew})
		if err == nil || gateway.started != 0 || adapter.started != 0 || gateway.attached != 0 || adapter.attached != 0 {
			t.Fatal("invalid creation identity reached a side-effecting dependency")
		}
	}
}

func TestOpenSessionKeepsDistinctIntentsWithIdenticalPrompts(t *testing.T) {
	gateway := &fakeGateway{}
	adapter := &fakeAdapter{}
	prompt := "same work"
	for _, id := range []string{"create-1", "create-2"} {
		_, err := OpenSession(context.Background(), gateway, adapter, CreateSessionRequest{CommandID: id, Path: SessionPathNew, Prompt: &prompt})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(gateway.newIDs) != 2 || len(adapter.newIDs) != 2 || gateway.newIDs[0] == gateway.newIDs[1] || adapter.newIDs[0] == adapter.newIDs[1] {
		t.Fatal("distinct creation identities were collapsed by prompt content")
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
