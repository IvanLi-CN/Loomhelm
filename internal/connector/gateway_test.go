package connector

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

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
	session, err := gateway.StartNewSession(context.Background(), protocol.NewSessionRequest{CommandID: "gateway-test-create"})
	if err != nil {
		t.Fatal(err)
	}
	if session.Path != protocol.SessionPathNew || session.Handle == "" || session.Generation == "" {
		t.Fatalf("new gateway session = %+v", session)
	}
	if err := gateway.SetExternalThreadRef(session, "thread-known"); err != nil {
		t.Fatal(err)
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
	retried, err := gateway.StartNewSession(context.Background(), protocol.NewSessionRequest{CommandID: "gateway-test-create"})
	if err != nil {
		t.Fatal(err)
	}
	if retried.Handle != recovered.Handle || retried.Generation != recovered.Generation {
		t.Fatalf("reused creation identity returned stale gateway session: retried=%+v recovered=%+v", retried, recovered)
	}
	if _, err := gateway.TransportFor(context.Background(), retried); err != nil {
		t.Fatalf("reused creation identity returned unavailable session: %v", err)
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

func TestGatewaySerializesConcurrentSessionStartsByCreationIdentity(t *testing.T) {
	transport := newFakeTransport()
	factoryEntered := make(chan struct{})
	releaseFactory := make(chan struct{})
	var factoryMu sync.Mutex
	created := 0
	gateway, err := NewGateway(GatewayConfig{
		TransportFactory: func(context.Context) (RPCTransport, error) {
			factoryMu.Lock()
			created++
			factoryMu.Unlock()
			select {
			case <-factoryEntered:
			default:
				close(factoryEntered)
			}
			<-releaseFactory
			return transport, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := protocol.NewSessionRequest{CommandID: "gateway-concurrent-create"}
	firstDone := make(chan struct {
		session protocol.GatewaySession
		err     error
	}, 1)
	go func() {
		session, startErr := gateway.StartNewSession(context.Background(), request)
		firstDone <- struct {
			session protocol.GatewaySession
			err     error
		}{session: session, err: startErr}
	}()
	select {
	case <-factoryEntered:
	case <-time.After(time.Second):
		t.Fatal("first gateway session did not reach the transport factory")
	}

	secondDone := make(chan struct {
		session protocol.GatewaySession
		err     error
	}, 1)
	go func() {
		session, startErr := gateway.StartNewSession(context.Background(), request)
		secondDone <- struct {
			session protocol.GatewaySession
			err     error
		}{session: session, err: startErr}
	}()
	gateway.startMu.Lock()
	startCall := gateway.startCalls[request.CommandID]
	gateway.startMu.Unlock()
	if startCall == nil {
		t.Fatal("gateway session start call was not registered")
	}
	select {
	case <-startCall.waiterEntered:
	case result := <-secondDone:
		t.Fatalf("second gateway session returned before the first completed: %+v", result)
	case <-time.After(time.Second):
		t.Fatal("second gateway session did not enter the single-flight waiter")
	}
	close(releaseFactory)
	first := <-firstDone
	second := <-secondDone
	if first.err != nil || second.err != nil {
		t.Fatalf("concurrent gateway starts = first %+v, second %+v", first, second)
	}
	if first.session != second.session {
		t.Fatalf("concurrent gateway sessions differ: first=%+v second=%+v", first.session, second.session)
	}
	factoryMu.Lock()
	factoryCalls := created
	factoryMu.Unlock()
	if factoryCalls != 1 {
		t.Fatalf("transport factory calls = %d, want 1", factoryCalls)
	}
	if err := gateway.CloseSession(context.Background(), first.session); err != nil {
		t.Fatal(err)
	}
}

func TestGatewayRejectsCreationIdentityConflictWithoutClosingCachedSession(t *testing.T) {
	transport := newFakeTransport()
	gateway, err := NewGateway(GatewayConfig{
		TransportFactory: func(context.Context) (RPCTransport, error) {
			return transport, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	firstRequest := protocol.NewSessionRequest{CommandID: "gateway-conflict", Prompt: "first"}
	first, err := gateway.StartNewSession(context.Background(), firstRequest)
	if err != nil {
		t.Fatal(err)
	}
	conflict := firstRequest
	conflict.Prompt = "different"
	if _, err := gateway.StartNewSession(context.Background(), conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("conflicting gateway start error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}
	if _, err := gateway.TransportFor(context.Background(), first); err != nil {
		t.Fatalf("cached session was closed after identity conflict: %v", err)
	}
	if err := gateway.CloseSession(context.Background(), first); err != nil {
		t.Fatal(err)
	}
}

func TestGatewayScopesSameCreationCommandIDByPlatformNamespace(t *testing.T) {
	created := 0
	gateway, err := NewGateway(GatewayConfig{
		TransportFactory: func(context.Context) (RPCTransport, error) {
			created++
			return newFakeTransport(), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := protocol.NewSessionRequest{CommandID: "shared-gateway-command", Prompt: "same prompt"}
	first, err := gateway.StartNewSessionInNamespace(context.Background(), PlatformSessionCommandNamespace("platform-gateway-a"), request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := gateway.StartNewSessionInNamespace(context.Background(), PlatformSessionCommandNamespace("platform-gateway-b"), request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Handle == second.Handle {
		t.Fatalf("different platform namespaces reused gateway handle %q", first.Handle)
	}
	retry, err := gateway.StartNewSessionInNamespace(context.Background(), PlatformSessionCommandNamespace("platform-gateway-a"), request)
	if err != nil || retry != first {
		t.Fatalf("same platform namespace retry = %+v error=%v, want %+v", retry, err, first)
	}
	if created != 2 {
		t.Fatalf("transport factory calls = %d, want 2", created)
	}
	conflict := request
	conflict.Prompt = "changed prompt"
	if _, err := gateway.StartNewSessionInNamespace(context.Background(), PlatformSessionCommandNamespace("platform-gateway-a"), conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("same namespace payload conflict = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}
	if err := gateway.CloseSession(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if err := gateway.CloseSession(context.Background(), second); err != nil {
		t.Fatal(err)
	}
}
