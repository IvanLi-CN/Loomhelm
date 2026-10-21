package connector

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestGatewayKeepsDesktopAttachUnsupportedAndColdResumeExplicit(t *testing.T) {
	startTransport := newFakeTransport()
	startTransport.responses["initialize"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"userAgent":"fixture"}`)}}}
	recoveryTransport := newFakeTransport()
	recoveryTransport.responses["initialize"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"userAgent":"fixture"}`)}}}
	recoveryTransport.responses["thread/resume"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-known"}}`)}}}
	transports := []RPCTransport{startTransport, recoveryTransport}
	created := 0
	gateway, err := NewGateway(GatewayConfig{
		ClientInfo: ClientInfo{Name: "test-client", Title: "Test Client", Version: "1.0.0"},
		TransportFactory: func(context.Context) (RPCTransport, error) {
			transport := transports[created]
			created++
			return transport, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := gateway.StartNewSession(context.Background(), protocol.NewSessionRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if session.Path != protocol.SessionPathNew || session.Handle == "" || session.Generation == "" {
		t.Fatalf("new gateway session = %+v", session)
	}
	if _, err := gateway.AttachActiveSession(context.Background(), protocol.ExistingSessionRequest{ActiveThreadRef: "thread-known"}); !errors.Is(err, protocol.ErrUnsupportedSessionPath) {
		t.Fatalf("active attach error = %v", err)
	}
	if created != 1 {
		t.Fatalf("active attach created %d transports, want 1", created)
	}
	reconciliation, err := gateway.ReconcileSession(context.Background(), "thread-known")
	if err != nil || reconciliation.State != protocol.ReconciliationStateConfirmed {
		t.Fatalf("cold reconciliation = %+v, error = %v", reconciliation, err)
	}
	recovered, err := gateway.RecoveredSession("thread-known")
	if err != nil {
		t.Fatal(err)
	}
	if recovered.ExternalThreadRef != "thread-known" || recovered.Path != protocol.SessionPathNew {
		t.Fatalf("recovered gateway session = %+v", recovered)
	}
	if countCalls(startTransport, "initialize") != 1 || countCalls(recoveryTransport, "thread/resume") != 1 {
		t.Fatalf("gateway calls = start %+v, recovery %+v", startTransport.calls, recoveryTransport.calls)
	}
	if err := gateway.CloseSession(context.Background(), recovered); err != nil {
		t.Fatal(err)
	}
	if err := gateway.CloseSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
}
