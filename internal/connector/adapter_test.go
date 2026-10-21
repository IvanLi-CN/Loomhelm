package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

type fakeTransport struct {
	mu sync.Mutex

	calls     []fakeCall
	responded []fakeResponse
	responses map[string][]fakeResult
	events    chan RPCMessage
	closed    bool
}

type fakeCall struct {
	method string
	params json.RawMessage
}

type fakeResponse struct {
	id     json.RawMessage
	result json.RawMessage
}

type fakeResult struct {
	message RPCMessage
	err     error
}

func newFakeTransport() *fakeTransport {
	return &fakeTransport{responses: make(map[string][]fakeResult), events: make(chan RPCMessage, 32)}
}

func (f *fakeTransport) Call(_ context.Context, method string, params json.RawMessage) (RPCMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fakeCall{method: method, params: append(json.RawMessage(nil), params...)})
	results := f.responses[method]
	if len(results) == 0 {
		return RPCMessage{Result: json.RawMessage(`{}`)}, nil
	}
	result := results[0]
	f.responses[method] = results[1:]
	return result.message, result.err
}

func (f *fakeTransport) Notify(_ context.Context, _ string, _ json.RawMessage) error { return nil }

func (f *fakeTransport) Respond(_ context.Context, id json.RawMessage, result json.RawMessage) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.responded = append(f.responded, fakeResponse{id: append(json.RawMessage(nil), id...), result: append(json.RawMessage(nil), result...)})
	return nil
}

func (f *fakeTransport) Events() <-chan RPCMessage { return f.events }

func (f *fakeTransport) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		close(f.events)
	}
	return nil
}

type fakeProvider struct{ transport RPCTransport }

func (f fakeProvider) TransportFor(context.Context, protocol.GatewaySession) (RPCTransport, error) {
	return f.transport, nil
}

func TestAdapterSendsRunAndDeduplicatesWithoutReplay(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-1"}}`)}}}
	transport.responses["turn/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"turn":{"id":"turn-1","status":"inProgress","unknownField":{"kept":true}}}`)}}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-1", Generation: "generation-1", Path: protocol.SessionPathNew}, protocol.NewSessionRequest{})
	if err != nil {
		t.Fatal(err)
	}
	command := testCommand("run-1", `{"prompt":"hello"}`)
	command.SessionID = session.SessionID
	ack, err := adapter.SendCommand(context.Background(), session, command)
	if err != nil {
		t.Fatal(err)
	}
	if ack.State != protocol.CommandStateSucceeded || valueOrEmpty(ack.RunID) != "turn-1" {
		t.Fatalf("run ACK = %+v", ack)
	}
	if !bytesContains(ack.Result, []byte(`"unknownField"`)) {
		t.Fatalf("run result did not preserve unknown fields: %s", ack.Result)
	}

	duplicate, deduplicated, err := journal.BeginCommand(command)
	if err != nil || !deduplicated || duplicate.State != protocol.CommandStateSucceeded {
		t.Fatalf("journal duplicate = %+v, deduplicated = %v, error = %v", duplicate, deduplicated, err)
	}
	if got := countCalls(transport, "turn/start"); got != 1 {
		t.Fatalf("turn/start call count after duplicate = %d, want 1", got)
	}
	conflict := command
	conflict.Payload = []byte(`{"prompt":"different"}`)
	if _, err := adapter.SendCommand(context.Background(), session, conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("conflicting adapter command error = %v", err)
	}
	_ = adapter.CloseSession(context.Background(), session)
}

func TestAdapterMarksAckLossUnknownAndReconcileNeverReplays(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-2"}}`)}}}
	transport.responses["turn/start"] = []fakeResult{{err: ErrUnknownOutcome}, {message: RPCMessage{Result: json.RawMessage(`{"turn":{"id":"turn-2","status":"completed"}}`)}}}
	transport.responses["thread/turns/list"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"data":[{"id":"turn-2","status":"completed","input":[{"type":"text","text":"uncertain"}]}]}`)}}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-2", Generation: "generation-2", Path: protocol.SessionPathNew}, protocol.NewSessionRequest{})
	if err != nil {
		t.Fatal(err)
	}
	command := testCommand("unknown-1", `{"prompt":"uncertain"}`)
	command.SessionID = session.SessionID
	ack, err := adapter.SendCommand(context.Background(), session, command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) || ack.State != protocol.CommandStateUnknown {
		t.Fatalf("unknown ACK = %+v, error = %v", ack, err)
	}
	reconciled, err := adapter.ReconcileCommand(context.Background(), session, command.CommandID)
	if err != nil || reconciled.State != protocol.ReconciliationStateConfirmed {
		t.Fatalf("reconciliation = %+v, error = %v", reconciled, err)
	}
	if got := countCalls(transport, "turn/start"); got != 1 {
		t.Fatalf("turn/start calls after reconciliation = %d, want 1", got)
	}
	if got := countCalls(transport, "thread/turns/list"); got != 1 {
		t.Fatalf("history calls after reconciliation = %d, want 1", got)
	}
}

func TestAdapterApprovalDecisionAndControlMethods(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-3"}}`)}}}
	transport.responses["turn/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"turn":{"id":"turn-3","status":"inProgress"}}`)}}}
	transport.responses["turn/steer"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"turnId":"turn-3"}`)}}}
	transport.responses["turn/interrupt"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{}`)}}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-3", Generation: "generation-3", Path: protocol.SessionPathNew}, protocol.NewSessionRequest{})
	if err != nil {
		t.Fatal(err)
	}
	transport.events <- rpcEvent(7, "item/commandExecution/requestApproval", `{"threadId":"thread-3","turnId":"turn-3","item":{"id":"item-3","type":"commandExecution"}}`)
	waitForPendingApproval(t, journal, session.SessionID)
	approve := protocol.Command{
		CommandID: "approve-3",
		IssuedAt:  now(),
		Kind:      protocol.CommandKindRunApprove,
		Payload:   []byte(`{"request_id":7}`),
		RunID:     stringPointer("turn-3"),
		SessionID: session.SessionID,
	}
	ack, err := adapter.SendCommand(context.Background(), session, approve)
	if err != nil || ack.State != protocol.CommandStateSucceeded {
		t.Fatalf("approval ACK = %+v, error = %v", ack, err)
	}
	if len(transport.responded) != 1 || string(transport.responded[0].id) != "7" || !bytesContains(transport.responded[0].result, []byte(`"accept"`)) {
		t.Fatalf("approval response = %+v", transport.responded)
	}
	if len(journal.PendingApprovals(session.SessionID, "turn-3")) != 0 {
		t.Fatal("approval remained pending after response")
	}

	transport.events <- rpcEvent(8, "turn/started", `{"threadId":"thread-3","turn":{"id":"turn-3","status":"inProgress"}}`)
	waitForActiveTurn(t, adapter, session.SessionID, "turn-3")
	steer := protocol.Command{CommandID: "steer-3", IssuedAt: now(), Kind: protocol.CommandKindRunSend, Payload: []byte(`{"steer":true,"prompt":"stop"}`), RunID: stringPointer("turn-3"), SessionID: session.SessionID}
	if _, err := adapter.Steer(context.Background(), session, steer); err != nil {
		t.Fatal(err)
	}
	interrupt := protocol.Command{CommandID: "interrupt-3", IssuedAt: now(), Kind: protocol.CommandKindRunInterrupt, Payload: []byte(`{"reason":"owner requested"}`), RunID: stringPointer("turn-3"), SessionID: session.SessionID}
	if _, err := adapter.SendCommand(context.Background(), session, interrupt); err != nil {
		t.Fatal(err)
	}
	if countCalls(transport, "turn/steer") != 1 || countCalls(transport, "turn/interrupt") != 1 {
		t.Fatalf("control calls = %+v", transport.calls)
	}
}

func TestAdapterRejectsUnsupportedAttach(t *testing.T) {
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: newFakeTransport()}, journal)
	if err != nil {
		t.Fatal(err)
	}
	_, err = adapter.AttachSession(context.Background(), protocol.GatewaySession{Handle: "desktop"}, protocol.ExistingSessionRequest{ActiveThreadRef: "thread"})
	if !errors.Is(err, protocol.ErrUnsupportedSessionPath) {
		t.Fatalf("attach error = %v", err)
	}
}

func TestAdapterBindsGatewayReconciledSessionWithoutSecondResume(t *testing.T) {
	transport := newFakeTransport()
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	gatewaySession := protocol.GatewaySession{
		Handle:            "gateway-recovered",
		ExternalThreadRef: "thread-recovered",
		Generation:        "generation-recovered",
		Path:              protocol.SessionPathNew,
	}
	session, err := adapter.BindRecoveredSession(context.Background(), gatewaySession, "thread-recovered")
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.CloseSession(context.Background(), session)
	if got, ok := journal.Session(session.SessionID); !ok || got.ExternalThreadRef != "thread-recovered" {
		t.Fatalf("bound journal session = %+v, present = %v", got, ok)
	}
	if got := countCalls(transport, "thread/resume"); got != 0 {
		t.Fatalf("thread/resume calls = %d, want 0", got)
	}
}

func rpcEvent(id int, method, params string) RPCMessage {
	raw := []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":%q,"params":%s}`, id, method, params))
	message, err := parseRPCMessage(raw)
	if err != nil {
		panic(err)
	}
	return message
}

func countCalls(transport *fakeTransport, method string) int {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	count := 0
	for _, call := range transport.calls {
		if call.method == method {
			count++
		}
	}
	return count
}

func waitForPendingApproval(t *testing.T, journal *Journal, sessionID string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(journal.PendingApprovals(sessionID, "turn-3")) == 1 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("approval was not journaled")
}

func waitForActiveTurn(t *testing.T, adapter *Adapter, sessionID, turnID string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		state := adapter.sessionState(sessionID)
		if state != nil && adapter.activeTurn(state, turnID) == turnID {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("active turn %q was not observed", turnID)
}

func bytesContains(haystack, needle []byte) bool {
	return len(haystack) >= len(needle) && string(haystack) != "" && bytesIndex(haystack, needle) >= 0
}

func bytesIndex(haystack, needle []byte) int {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		match := true
		for offset := range needle {
			if haystack[index+offset] != needle[offset] {
				match = false
				break
			}
		}
		if match {
			return index
		}
	}
	return -1
}
