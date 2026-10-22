package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

type fakeTransport struct {
	mu sync.Mutex

	calls          []fakeCall
	responded      []fakeResponse
	responses      map[string][]fakeResult
	responseEvents map[string]RPCMessage
	respondHook    func()
	events         chan RPCMessage
	closed         bool
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
	return &fakeTransport{responses: make(map[string][]fakeResult), responseEvents: make(map[string]RPCMessage), events: make(chan RPCMessage, 32)}
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
	f.responded = append(f.responded, fakeResponse{id: append(json.RawMessage(nil), id...), result: append(json.RawMessage(nil), result...)})
	event, ok := f.responseEvents[string(id)]
	hook := f.respondHook
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	if ok {
		f.events <- event
	}
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

type blockingTransport struct {
	*fakeTransport
	entered chan struct{}
	release chan struct{}
}

func (t *blockingTransport) Call(ctx context.Context, method string, params json.RawMessage) (RPCMessage, error) {
	if method == "thread/start" {
		select {
		case t.entered <- struct{}{}:
		default:
		}
		select {
		case <-t.release:
		case <-ctx.Done():
			return RPCMessage{}, ctx.Err()
		}
	}
	return t.fakeTransport.Call(ctx, method, params)
}

type fakeProvider struct{ transport RPCTransport }

func (f fakeProvider) TransportFor(context.Context, protocol.GatewaySession) (RPCTransport, error) {
	return f.transport, nil
}

type sessionTransportProvider struct {
	mu             sync.Mutex
	transports     map[string]RPCTransport
	transportCalls int
	closeCalls     int
}

func (p *sessionTransportProvider) TransportFor(_ context.Context, session protocol.GatewaySession) (RPCTransport, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.transportCalls++
	transport, ok := p.transports[session.Handle]
	if !ok {
		return nil, fmt.Errorf("transport for %q is not configured", session.Handle)
	}
	return transport, nil
}

func (p *sessionTransportProvider) CloseSession(_ context.Context, session protocol.GatewaySession) error {
	p.mu.Lock()
	transport, ok := p.transports[session.Handle]
	if ok {
		delete(p.transports, session.Handle)
	}
	p.closeCalls++
	p.mu.Unlock()
	if !ok {
		return nil
	}
	return transport.Close()
}

func testSessionRequest() protocol.NewSessionRequest {
	return protocol.NewSessionRequest{CommandID: "test-session-create"}
}

func TestAdapterRejectsMissingSessionCreationIdentityBeforeTransport(t *testing.T) {
	transport := newFakeTransport()
	provider := &sessionTransportProvider{transports: map[string]RPCTransport{"missing-id": transport}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(provider, journal)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "missing-id", Generation: "generation-missing-id"}, protocol.NewSessionRequest{}); err == nil {
		t.Fatal("empty session creation identity was accepted")
	}
	provider.mu.Lock()
	transportCalls := provider.transportCalls
	provider.mu.Unlock()
	if transportCalls != 0 {
		t.Fatalf("transport calls for missing identity = %d, want 0", transportCalls)
	}
}

func TestAdapterSerializesConcurrentSessionStartsByCreationIdentity(t *testing.T) {
	firstTransport := &blockingTransport{
		fakeTransport: newFakeTransport(),
		entered:       make(chan struct{}, 1),
		release:       make(chan struct{}),
	}
	firstTransport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-concurrent"}}`)}}}
	secondTransport := newFakeTransport()
	secondTransport.responses["thread/resume"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-concurrent"}}`), Raw: json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"thread":{"id":"thread-concurrent"}}}`)}}}
	provider := &sessionTransportProvider{transports: map[string]RPCTransport{
		"gateway-concurrent-1": firstTransport,
		"gateway-concurrent-2": secondTransport,
	}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(provider, journal)
	if err != nil {
		t.Fatal(err)
	}
	request := protocol.NewSessionRequest{CommandID: "concurrent-session", ProjectID: "project-concurrent"}
	firstDone := make(chan struct {
		session protocol.AdapterSession
		err     error
	}, 1)
	go func() {
		session, startErr := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-concurrent-1", Generation: "generation-concurrent-1", Path: protocol.SessionPathNew}, request)
		firstDone <- struct {
			session protocol.AdapterSession
			err     error
		}{session: session, err: startErr}
	}()
	select {
	case <-firstTransport.entered:
	case <-time.After(time.Second):
		t.Fatal("first thread/start did not reach the transport")
	}
	secondDone := make(chan struct {
		session protocol.AdapterSession
		err     error
	}, 1)
	go func() {
		session, startErr := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-concurrent-2", Generation: "generation-concurrent-2", Path: protocol.SessionPathNew}, request)
		secondDone <- struct {
			session protocol.AdapterSession
			err     error
		}{session: session, err: startErr}
	}()
	adapter.startMu.Lock()
	startCall := adapter.startCalls[request.CommandID]
	adapter.startMu.Unlock()
	if startCall == nil {
		t.Fatal("session start call was not registered")
	}
	select {
	case result := <-secondDone:
		t.Fatalf("second session start returned before the first completed: %+v", result)
	case <-startCall.waiterEntered:
	case <-time.After(time.Second):
		t.Fatal("second session start did not enter the single-flight waiter")
	}
	close(firstTransport.release)
	first := <-firstDone
	if first.err != nil {
		t.Fatal(first.err)
	}
	second := <-secondDone
	if second.err != nil {
		t.Fatal(second.err)
	}
	if second.session != first.session {
		t.Fatalf("concurrent session identities differ: first=%+v second=%+v", first.session, second.session)
	}
	if got := countCalls(firstTransport.fakeTransport, "thread/start"); got != 1 {
		t.Fatalf("thread/start calls = %d, want 1", got)
	}
	if got := countCalls(secondTransport, "thread/start"); got != 0 {
		t.Fatalf("second transport thread/start calls = %d, want 0", got)
	}
	if got := countCalls(secondTransport, "thread/resume"); got != 0 {
		t.Fatalf("second transport thread/resume calls = %d, want 0 for active-session reuse", got)
	}
	if err := adapter.CloseSession(context.Background(), first.session); err != nil {
		t.Fatal(err)
	}
}

func TestAdapterClosesCanceledConcurrentSessionStart(t *testing.T) {
	firstTransport := &blockingTransport{
		fakeTransport: newFakeTransport(),
		entered:       make(chan struct{}, 1),
		release:       make(chan struct{}),
	}
	firstTransport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-cancelled"}}`)}}}
	secondTransport := newFakeTransport()
	provider := &sessionTransportProvider{transports: map[string]RPCTransport{
		"gateway-cancel-1": firstTransport,
		"gateway-cancel-2": secondTransport,
	}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(provider, journal)
	if err != nil {
		t.Fatal(err)
	}
	request := protocol.NewSessionRequest{CommandID: "cancelled-session"}
	firstDone := make(chan error, 1)
	go func() {
		_, startErr := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-cancel-1", Generation: "generation-cancel-1"}, request)
		firstDone <- startErr
	}()
	select {
	case <-firstTransport.entered:
	case <-time.After(time.Second):
		t.Fatal("first thread/start did not reach the transport")
	}

	secondCtx, cancel := context.WithCancel(context.Background())
	secondDone := make(chan error, 1)
	go func() {
		_, startErr := adapter.StartSession(secondCtx, protocol.GatewaySession{Handle: "gateway-cancel-2", Generation: "generation-cancel-2"}, request)
		secondDone <- startErr
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case startErr := <-secondDone:
		if !errors.Is(startErr, context.Canceled) {
			t.Fatalf("canceled concurrent session start error = %v", startErr)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled concurrent session start did not return")
	}
	provider.mu.Lock()
	closeCalls := provider.closeCalls
	provider.mu.Unlock()
	if closeCalls != 1 {
		t.Fatalf("canceled gateway close calls = %d, want 1", closeCalls)
	}
	secondTransport.mu.Lock()
	secondClosed := secondTransport.closed
	secondTransport.mu.Unlock()
	if !secondClosed {
		t.Fatal("canceled gateway transport remained open")
	}
	close(firstTransport.release)
	if startErr := <-firstDone; startErr != nil {
		t.Fatal(startErr)
	}
}

func TestAdapterClosesFreshTransportWhenReusingResolvedSession(t *testing.T) {
	firstTransport := newFakeTransport()
	firstTransport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-reused"}}`)}}}
	secondTransport := newFakeTransport()
	thirdTransport := newFakeTransport()
	provider := &sessionTransportProvider{transports: map[string]RPCTransport{
		"gateway-reuse-1": firstTransport,
		"gateway-reuse-2": secondTransport,
		"gateway-reuse-3": thirdTransport,
	}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(provider, journal)
	if err != nil {
		t.Fatal(err)
	}
	request := protocol.NewSessionRequest{CommandID: "reuse-session", ProjectID: "project-reuse", TaskID: "task-reuse"}
	first, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-reuse-1", Generation: "generation-reuse-1"}, request)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.CloseSession(context.Background(), first)
	second, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-reuse-2", Generation: "generation-reuse-2"}, request)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("reused session = %+v, first session = %+v", second, first)
	}
	provider.mu.Lock()
	closeCalls := provider.closeCalls
	provider.mu.Unlock()
	if closeCalls != 1 {
		t.Fatalf("fresh gateway close calls = %d, want 1", closeCalls)
	}
	secondTransport.mu.Lock()
	secondClosed := secondTransport.closed
	secondTransport.mu.Unlock()
	if !secondClosed {
		t.Fatal("fresh transport remained open after session reuse")
	}
	conflict := request
	conflict.Prompt = "changed prompt"
	if _, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-reuse-3", Generation: "generation-reuse-3"}, conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("same identity changed payload error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}
	thirdTransport.mu.Lock()
	thirdClosed := thirdTransport.closed
	thirdTransport.mu.Unlock()
	if !thirdClosed {
		t.Fatal("conflicting session transport remained open")
	}
}

func TestAdapterSendsRunAndDeduplicatesWithoutReplay(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-1"}}`)}}}
	turnResult := json.RawMessage(`{"turn":{"id":"turn-1","status":"inProgress","unknownField":{"kept":true}}}`)
	transport.responses["turn/start"] = []fakeResult{{message: RPCMessage{Raw: json.RawMessage(`{"jsonrpc":"2.0","id":2,"result":{"turn":{"id":"turn-1","status":"inProgress","unknownField":{"kept":true}}}}`), Result: turnResult}}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-1", Generation: "generation-1", Path: protocol.SessionPathNew}, testSessionRequest())
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
	if ack.EventCursor == nil {
		t.Fatal("run ACK did not point to the durable response observation")
	}
	page, err := journal.ReadEvents(protocol.EventQuery{SessionID: session.SessionID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	var rawResponseObserved bool
	for _, event := range page.Events {
		if event.Type == protocol.EventTypeUnknown && bytesContains(event.Payload, []byte(`"jsonrpc":"2.0"`)) {
			rawResponseObserved = true
			break
		}
	}
	if !rawResponseObserved {
		t.Fatal("durable response observation did not preserve the raw envelope")
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
	transport.responses["thread/turns/list"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"data":[{"id":"turn-2","status":"completed","createdAt":"2026-10-21T00:00:01Z","items":[{"type":"userMessage","content":[{"type":"text","text":"uncertain"}]}]}]}`)}}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-2", Generation: "generation-2", Path: protocol.SessionPathNew}, testSessionRequest())
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

func TestAdapterPersistsUnknownRPCOperationIdentity(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-operation-id"}}`)}}}
	transport.responses["turn/start"] = []fakeResult{{message: RPCMessage{ID: json.RawMessage(`41`)}, err: ErrUnknownOutcome}}
	j := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, j)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-operation-id", Generation: "generation-operation-id", Path: protocol.SessionPathNew}, testSessionRequest())
	if err != nil {
		t.Fatal(err)
	}
	command := testCommand("unknown-operation-id", `{"prompt":"unknown operation"}`)
	command.SessionID = session.SessionID
	ack, err := adapter.SendCommand(context.Background(), session, command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) || ack.State != protocol.CommandStateUnknown {
		t.Fatalf("unknown ACK = %+v, error = %v", ack, err)
	}
	if ack.OperationID == nil || *ack.OperationID != "41" {
		t.Fatalf("unknown ACK operation ID = %v, want 41", ack.OperationID)
	}
	_, stored, err := j.Command(command.CommandID)
	if err != nil || stored.OperationID == nil || *stored.OperationID != "41" {
		t.Fatalf("stored unknown ACK = %+v, error = %v, want operation ID 41", stored, err)
	}
}

func TestAdapterApprovalDecisionAndControlMethods(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-3"}}`)}}}
	transport.responses["turn/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"turn":{"id":"turn-3","status":"inProgress"}}`)}}}
	transport.responses["turn/steer"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"turnId":"turn-3"}`)}}}
	transport.responses["turn/interrupt"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{}`)}}}
	journal := openTestJournal(t)
	var stateAtRespond protocol.CommandState
	transport.respondHook = func() {
		stored, lookupErr := journal.LookupCommand("approve-3")
		if lookupErr == nil {
			stateAtRespond = stored.State
		}
	}
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-3", Generation: "generation-3", Path: protocol.SessionPathNew}, testSessionRequest())
	if err != nil {
		t.Fatal(err)
	}
	transport.events <- rpcEvent(7, "item/commandExecution/requestApproval", `{"threadId":"thread-3","turnId":"turn-3","item":{"id":"item-3","type":"commandExecution"}}`)
	transport.responseEvents["7"] = rpcEvent(9, "serverRequest/resolved", `{"threadId":"thread-3","turnId":"turn-3","requestId":7,"resolution":"accept"}`)
	waitForPendingApproval(t, journal, session.SessionID)
	approve := protocol.Command{
		CommandID: "approve-3",
		IssuedAt:  now(),
		Kind:      protocol.CommandKindRunApprove,
		Payload:   []byte(`{"request_id":7,"decision":"approve","revision":1,"command_id":"approve-3"}`),
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
	if stateAtRespond != protocol.CommandStateExecuting {
		t.Fatalf("approval command state at Respond = %q, want %q", stateAtRespond, protocol.CommandStateExecuting)
	}
	if len(journal.PendingApprovals(session.SessionID, "turn-3")) != 0 {
		t.Fatal("approval remained pending after response")
	}
	repeated := approve
	repeated.CommandID = "approve-3-repeat"
	repeated.Payload = []byte(`{"request_id":7,"decision":"deny","revision":1,"command_id":"approve-3-repeat"}`)
	if _, err := adapter.SendCommand(context.Background(), session, repeated); err == nil {
		t.Fatal("repeated approval unexpectedly succeeded")
	}
	if len(transport.responded) != 1 {
		t.Fatalf("repeated approval wrote %d responses, want 1", len(transport.responded))
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

func TestAdapterTreatsDeterministicTransportCancellationAsFailed(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-canceled"}}`)}}}
	transport.responses["turn/start"] = []fakeResult{{err: context.Canceled}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-canceled", Generation: "generation-canceled", Path: protocol.SessionPathNew}, testSessionRequest())
	if err != nil {
		t.Fatal(err)
	}
	command := testCommand("canceled-command", `{"prompt":"cancel before write"}`)
	command.SessionID = session.SessionID
	ack, err := adapter.SendCommand(context.Background(), session, command)
	if err == nil || errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("deterministic cancellation error = %v, want a non-unknown failure", err)
	}
	if ack.State != protocol.CommandStateFailed {
		t.Fatalf("deterministic cancellation ACK = %+v, want failed", ack)
	}
	stored, err := journal.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != protocol.CommandStateFailed {
		t.Fatalf("stored deterministic cancellation ACK = %+v, want failed", stored)
	}
	_ = adapter.CloseSession(context.Background(), session)
}

func TestAdapterKeepsApprovalUnknownForUnrecognizedResolution(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-approval-unknown"}}`)}}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-approval-unknown", Generation: "generation-approval-unknown", Path: protocol.SessionPathNew}, testSessionRequest())
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.CloseSession(context.Background(), session)
	transport.events <- rpcEvent(17, "item/commandExecution/requestApproval", `{"threadId":"thread-approval-unknown","turnId":"turn-3","item":{"id":"item-approval-unknown","type":"commandExecution"}}`)
	waitForPendingApproval(t, journal, session.SessionID)
	transport.responseEvents["17"] = rpcEvent(18, "serverRequest/resolved", `{"threadId":"thread-approval-unknown","turnId":"turn-3","requestId":17,"resolution":"unexpected"}`)
	command := protocol.Command{
		CommandID: "approval-unknown",
		IssuedAt:  now(),
		Kind:      protocol.CommandKindRunApprove,
		Payload:   json.RawMessage(`{"request_id":17,"decision":"approve","revision":1,"command_id":"approval-unknown"}`),
		RunID:     stringPointer("turn-3"),
		SessionID: session.SessionID,
	}
	ack, err := adapter.SendCommand(context.Background(), session, command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) || ack.State != protocol.CommandStateUnknown {
		t.Fatalf("unknown approval ACK = %+v, error = %v", ack, err)
	}
	stored, err := journal.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != protocol.CommandStateUnknown {
		t.Fatalf("stored unknown approval ACK = %+v", stored)
	}
}

func TestAdapterKeepsApprovalUnknownWhenResolutionIsCleared(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-approval-cleared"}}`)}}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-approval-cleared", Generation: "generation-approval-cleared", Path: protocol.SessionPathNew}, testSessionRequest())
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.CloseSession(context.Background(), session)
	transport.events <- rpcEvent(27, "item/commandExecution/requestApproval", `{"threadId":"thread-approval-cleared","turnId":"turn-3","item":{"id":"item-approval-cleared","type":"commandExecution"}}`)
	waitForPendingApproval(t, journal, session.SessionID)
	transport.responseEvents["27"] = rpcEvent(28, "serverRequest/resolved", `{"threadId":"thread-approval-cleared","turnId":"turn-3","requestId":27}`)
	command := protocol.Command{
		CommandID: "approval-cleared",
		IssuedAt:  now(),
		Kind:      protocol.CommandKindRunApprove,
		Payload:   json.RawMessage(`{"request_id":27,"decision":"approve","revision":1,"command_id":"approval-cleared"}`),
		RunID:     stringPointer("turn-3"),
		SessionID: session.SessionID,
	}
	ack, err := adapter.SendCommand(context.Background(), session, command)
	if err != nil || ack.State != protocol.CommandStateSucceeded {
		t.Fatalf("cleared approval delivery ACK = %+v, error = %v", ack, err)
	}
	if result, ok := journal.ApprovalResult(command.CommandID); !ok || result != approvalResolutionCleared {
		t.Fatalf("cleared approval result = %q, found = %v", result, ok)
	}
}

func TestAdapterDoesNotReconcileClearedApprovalAsItemOutcome(t *testing.T) {
	transport := newFakeTransport()
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.BindRecoveredSession(context.Background(), protocol.GatewaySession{Handle: "gateway-approval-reconcile", ExternalThreadRef: "thread-approval-reconcile", Generation: "generation-approval-reconcile", Path: protocol.SessionPathNew}, "thread-approval-reconcile")
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.CloseSession(context.Background(), session)
	command := protocol.Command{
		CommandID: "approval-reconcile-cleared",
		IssuedAt:  now(),
		Kind:      protocol.CommandKindRunApprove,
		Payload:   json.RawMessage(`{"request_id":31,"decision":"approve","revision":1,"command_id":"approval-reconcile-cleared"}`),
		RunID:     stringPointer("turn-approval-reconcile"),
		SessionID: session.SessionID,
	}
	if _, _, err := journal.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	ack, err := journal.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	ack.State = protocol.CommandStateUnknown
	if err := journal.UpdateCommand(command.CommandID, ack); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: session.SessionID,
		RunID:     command.RunID,
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":31,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-approval-reconcile","turnId":"turn-approval-reconcile","item":{"id":"item-approval-reconcile","type":"commandExecution"}}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, already, err := journal.ClaimApproval(session.SessionID, json.RawMessage(`31`), 1, command.CommandID, "approve"); err != nil || already {
		t.Fatalf("approval claim = already %v, error %v", already, err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: session.SessionID,
		RunID:     command.RunID,
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"threadId":"thread-approval-reconcile","turnId":"turn-approval-reconcile","requestId":31}}`),
	}); err != nil {
		t.Fatal(err)
	}
	reconciliation, err := adapter.ReconcileCommand(context.Background(), session, command.CommandID)
	if err != nil || reconciliation.State != protocol.ReconciliationStateUnknown {
		t.Fatalf("cleared approval reconciliation = %+v, error = %v", reconciliation, err)
	}
	stored, err := journal.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != protocol.CommandStateUnknown {
		t.Fatalf("cleared approval ACK was finalized: %+v", stored)
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

func TestAdapterResumesResolvedSessionAndSendsMissingInitialPrompt(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/resume"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-missing-initial"}}`)}}}
	transport.responses["turn/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"turn":{"id":"turn-missing-initial","status":"inProgress"}}`)}}}
	journal := openTestJournal(t)
	request := protocol.NewSessionRequest{CommandID: "create-missing-initial", ProjectID: "project-missing-initial", Prompt: "resume exactly once"}
	gatewaySession := protocol.GatewaySession{Handle: "gateway-missing-initial", Generation: "generation-missing-initial", Path: protocol.SessionPathNew}
	intentID, err := journal.BeginSessionStart(gatewaySession, request)
	if err != nil {
		t.Fatal(err)
	}
	threadID := "thread-missing-initial"
	if err := journal.ResolveSessionStart(intentID, stableSessionID(threadID), threadID, gatewaySession.Generation); err != nil {
		t.Fatal(err)
	}
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), gatewaySession, request)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.CloseSession(context.Background(), session)
	if session.ExternalThreadRef != threadID {
		t.Fatalf("resumed session = %+v", session)
	}
	if got := countCalls(transport, "thread/start"); got != 0 {
		t.Fatalf("thread/start calls = %d, want 0", got)
	}
	if got := countCalls(transport, "thread/resume"); got != 1 {
		t.Fatalf("thread/resume calls = %d, want 1", got)
	}
	if got := countCalls(transport, "turn/start"); got != 1 {
		t.Fatalf("initial turn/start calls = %d, want 1", got)
	}
	if _, err := journal.LookupCommand(session.SessionID + ":initial"); err != nil {
		t.Fatalf("initial prompt command was not persisted: %v", err)
	}
}

func TestAdapterResolvesUnknownSessionStartFromLateResponse(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{err: ErrUnknownOutcome}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	gatewaySession := protocol.GatewaySession{Handle: "gateway-late-start", Generation: "generation-late-start", Path: protocol.SessionPathNew}
	_, err = adapter.StartSession(context.Background(), gatewaySession, testSessionRequest())
	if !errors.Is(err, ErrUnknownOutcome) {
		t.Fatalf("unknown session start error = %v", err)
	}
	threadID := "thread-late-start"
	raw := json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"thread":{"id":"thread-late-start"}}}`)
	transport.events <- RPCMessage{Raw: raw, ID: json.RawMessage(`1`), Result: json.RawMessage(`{"thread":{"id":"thread-late-start"}}`), operation: "thread/start"}
	var session protocol.AdapterSession
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if candidate, ok := journal.Session(stableSessionID(threadID)); ok {
			session = candidate
			break
		}
		time.Sleep(time.Millisecond)
	}
	if session.ExternalThreadRef != threadID {
		t.Fatalf("late session start was not resolved: %+v", session)
	}
	if err := adapter.CloseSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
}

func TestAdapterMarksUnexpectedTransportCloseForReconciliation(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/start"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-close"}}`)}}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(context.Background(), protocol.GatewaySession{Handle: "gateway-close", Generation: "generation-close", Path: protocol.SessionPathNew}, testSessionRequest())
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Close(); err != nil {
		t.Fatal(err)
	}
	defer adapter.CloseSession(context.Background(), session)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		page, readErr := journal.ReadEvents(protocol.EventQuery{SessionID: session.SessionID, Limit: 100})
		if readErr != nil {
			t.Fatal(readErr)
		}
		for _, event := range page.Events {
			if event.Type == protocol.EventTypeReconciliationRequired {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("unexpected transport close was not recorded as reconciliation required")
}

func TestAdapterRebuildsActiveTurnOnColdRecovery(t *testing.T) {
	transport := newFakeTransport()
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	externalThreadRef := "thread-active-recovery"
	sessionID := stableSessionID(externalThreadRef)
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: sessionID,
		RunID:     stringPointer("turn-active-recovery"),
		Type:      protocol.EventTypeRunStarted,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"method":"turn/started"}`),
	}); err != nil {
		t.Fatal(err)
	}
	gatewaySession := protocol.GatewaySession{Handle: "gateway-recovered-active", ExternalThreadRef: externalThreadRef, Generation: "generation-recovered-active", Path: protocol.SessionPathNew}
	session, err := adapter.BindRecoveredSession(context.Background(), gatewaySession, externalThreadRef)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.CloseSession(context.Background(), session)
	state := adapter.sessionState(session.SessionID)
	if state == nil || adapter.activeTurn(state, "turn-active-recovery") != "turn-active-recovery" {
		t.Fatalf("recovered active turns = %+v", state)
	}
}

func TestAdapterLeavesInFlightCommandUnknownDuringReconciliation(t *testing.T) {
	transport := newFakeTransport()
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	threadRef := "thread-in-flight"
	session, err := adapter.BindRecoveredSession(context.Background(), protocol.GatewaySession{Handle: "gateway-in-flight", ExternalThreadRef: threadRef, Generation: "generation-in-flight", Path: protocol.SessionPathNew}, threadRef)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.CloseSession(context.Background(), session)
	command := testCommand("in-flight", `{"prompt":"still running"}`)
	command.SessionID = session.SessionID
	if _, _, err := journal.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	ack, err := journal.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	ack.State = protocol.CommandStateExecuting
	if err := journal.UpdateCommand(command.CommandID, ack); err != nil {
		t.Fatal(err)
	}
	reconciliation, err := adapter.ReconcileCommand(context.Background(), session, command.CommandID)
	if err != nil || reconciliation.State != protocol.ReconciliationStateUnknown {
		t.Fatalf("in-flight reconciliation = %+v, error = %v", reconciliation, err)
	}
	if got := countCalls(transport, "thread/turns/list"); got != 0 {
		t.Fatalf("in-flight history calls = %d, want 0", got)
	}
}

func TestAdapterKeepsObservedRunUnknownWhenHistoryIsMissing(t *testing.T) {
	transport := newFakeTransport()
	transport.responses["thread/turns/list"] = []fakeResult{{message: RPCMessage{Result: json.RawMessage(`{"data":[]}`)}}}
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	threadRef := "thread-missing-history"
	session, err := adapter.BindRecoveredSession(context.Background(), protocol.GatewaySession{Handle: "gateway-missing-history", ExternalThreadRef: threadRef, Generation: "generation-missing-history", Path: protocol.SessionPathNew}, threadRef)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.CloseSession(context.Background(), session)
	command := testCommand("missing-history", `{"prompt":"may have run"}`)
	command.SessionID = session.SessionID
	if _, _, err := journal.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	ack, err := journal.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	ack.State = protocol.CommandStateUnknown
	if err := journal.UpdateCommand(command.CommandID, ack); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: session.SessionID,
		RunID:     stringPointer("turn-observed-but-missing"),
		Type:      protocol.EventTypeRunStarted,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"method":"turn/started"}`),
	}); err != nil {
		t.Fatal(err)
	}
	reconciliation, err := adapter.ReconcileCommand(context.Background(), session, command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if reconciliation.State != protocol.ReconciliationStateUnknown {
		t.Fatalf("missing-history reconciliation = %+v, want unknown", reconciliation)
	}
	if reconciliation.Note == nil || !strings.Contains(*reconciliation.Note, "remains unknown") {
		t.Fatalf("missing-history reconciliation note = %v", reconciliation.Note)
	}
}

func TestTurnContainsPromptUsesStructuredExactText(t *testing.T) {
	turn := appServerTurn{Items: []byte(`[{"type":"userMessage","content":[{"type":"text","text":"run exactly"}]},{"type":"agentMessage","text":"please run exactly now"}]`)}
	if !turnContainsPrompt(turn, "run exactly") {
		t.Fatal("structured user prompt was not matched")
	}
	if turnContainsPrompt(turn, "exactly") {
		t.Fatal("substring from an unrelated message was matched")
	}
}

func TestMatchCommandTurnRechecksPromptForKnownRunID(t *testing.T) {
	command := testCommand("reconcile-prompt", `{"prompt":"expected prompt"}`)
	ack := protocol.CommandAck{RunID: stringPointer("turn-1")}
	turns := []appServerTurn{{ID: "turn-1", Status: "completed", Items: []byte(`[{"type":"userMessage","text":"different prompt"}]`)}}
	if matched, ambiguous := matchCommandTurn(command, ack, turns); matched != nil || ambiguous {
		t.Fatalf("mismatched known run = %+v, ambiguous = %v", matched, ambiguous)
	}
}

func TestMatchCommandTurnAcceptsKnownRunWithoutSummaryInput(t *testing.T) {
	command := testCommand("reconcile-summary", `{"prompt":"expected prompt"}`)
	ack := protocol.CommandAck{RunID: stringPointer("turn-summary")}
	turn := appServerTurn{ID: "turn-summary", Status: "completed"}
	if matched, ambiguous := matchCommandTurn(command, ack, []appServerTurn{turn}); matched == nil || ambiguous {
		t.Fatalf("summary-only known run = %+v, ambiguous = %v", matched, ambiguous)
	}
}

func TestMatchCommandTurnDoesNotInferSummaryRunWithoutRunID(t *testing.T) {
	command := testCommand("reconcile-summary-without-run", `{"prompt":"expected prompt"}`)
	command.IssuedAt = "2026-10-21T00:00:00Z"
	turn := appServerTurn{ID: "turn-summary", CreatedAt: "2026-10-21T00:00:01Z", Status: "completed"}
	if matched, ambiguous := matchCommandTurn(command, protocol.CommandAck{}, []appServerTurn{turn}); matched != nil || ambiguous {
		t.Fatalf("summary-only run without durable run ID was inferred: %+v, ambiguous = %v", matched, ambiguous)
	}
}

func TestMatchCommandTurnRejectsOlderSamePromptWithoutRunID(t *testing.T) {
	command := testCommand("reconcile-old-prompt", `{"prompt":"same prompt"}`)
	command.IssuedAt = "2026-10-21T00:00:02Z"
	turn := appServerTurn{
		ID:        "turn-old",
		Status:    "completed",
		CreatedAt: "2026-10-21T00:00:01Z",
		Items:     []byte(`[{"type":"userMessage","text":"same prompt"}]`),
	}
	if matched, ambiguous := matchCommandTurn(command, protocol.CommandAck{}, []appServerTurn{turn}); matched != nil || ambiguous {
		t.Fatalf("older same-prompt turn was matched: %+v, ambiguous = %v", matched, ambiguous)
	}
}

func TestMatchCommandTurnRechecksStructuredInput(t *testing.T) {
	command := testCommand("reconcile-input", `{"input":[{"type":"text","text":"expected input"}]}`)
	ack := protocol.CommandAck{RunID: stringPointer("turn-1")}
	matching := appServerTurn{ID: "turn-1", Status: "completed", Input: []byte(`[{"type":"text","text":"expected input"}]`)}
	if matched, _ := matchCommandTurn(command, ack, []appServerTurn{matching}); matched == nil {
		t.Fatal("matching structured input was rejected")
	}
	mismatched := matching
	mismatched.Input = []byte(`[{"type":"text","text":"different input"}]`)
	if matched, _ := matchCommandTurn(command, ack, []appServerTurn{mismatched}); matched != nil {
		t.Fatal("mismatched structured input was accepted")
	}
}

func TestParseTurnsPagePreservesTurnsAlias(t *testing.T) {
	page, ok := parseTurnsPage(json.RawMessage(`{"turns":[{"id":"turn-alias","status":"completed"}]}`))
	if !ok || page.Data != nil || page.Turns == nil || len(*page.Turns) != 1 || (*page.Turns)[0].ID != "turn-alias" {
		t.Fatalf("turns alias page = %+v, ok = %v", page, ok)
	}
}

func TestAdapterPreservesRawAppServerResponseEnvelope(t *testing.T) {
	journal := openTestJournal(t)
	transport := newFakeTransport()
	adapter, err := NewAdapter(fakeProvider{transport: transport}, journal, AdapterConfig{})
	if err != nil {
		t.Fatal(err)
	}
	state := &adapterSessionState{
		session:   protocol.AdapterSession{SessionID: "session-raw"},
		transport: transport,
	}
	raw := json.RawMessage(`{"jsonrpc":"2.0","id":7,"result":{"thread":{"id":"thread-raw"}}}`)
	event, err := adapter.appendObservedEventFromSource(state, protocol.EventTypeSessionCreated, protocol.EventSourceAppServer, "thread/start", raw, "")
	if err != nil {
		t.Fatal(err)
	}
	if string(event.Payload) != string(raw) {
		t.Fatalf("observed response payload = %s, want %s", event.Payload, raw)
	}
}

func TestCommandCanConfirmFromTurnRequiresCompletedRun(t *testing.T) {
	command := testCommand("reconcile-status", `{"prompt":"run"}`)
	if commandCanConfirmFromTurn(command, appServerTurn{ID: "turn-failed", Status: "failed"}) {
		t.Fatal("failed turn was treated as a successful run command")
	}
	if !commandCanConfirmFromTurn(command, appServerTurn{ID: "turn-completed", Status: "completed"}) {
		t.Fatal("completed turn was not accepted as a successful run command")
	}
	if outcome, established := commandOutcomeFromTurn(command, appServerTurn{ID: "turn-failed", Status: "failed"}); !established || outcome != protocol.CommandStateFailed {
		t.Fatalf("failed turn outcome = %q, established = %v", outcome, established)
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
