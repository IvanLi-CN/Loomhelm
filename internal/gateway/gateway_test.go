package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/coder/websocket"
)

type fakeRegistry struct {
	mu              sync.Mutex
	credential      hosts.Credential
	token           string
	revoked         bool
	authenticateErr error
	generation      int64
	current         *hosts.Connection
	closed          []hosts.Connection
	cursor          *hosts.Cursor
	touches         int
	authorizeErr    error
	touchErr        error
	processEventErr error
	deliverCalls    int
}

func newFakeRegistry() *fakeRegistry {
	now := time.Now().UTC()
	return &fakeRegistry{
		credential: hosts.Credential{
			ID:        "hcred_test",
			HostID:    "host_test",
			Name:      "connector",
			CreatedAt: now,
		},
		token: "token_test",
	}
}

func (r *fakeRegistry) Authenticate(_ context.Context, token string) (hosts.Credential, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if token != r.token {
		return hosts.Credential{}, hosts.ErrUnauthenticated
	}
	if r.revoked {
		return hosts.Credential{}, hosts.ErrCredentialRevoked
	}
	if r.authenticateErr != nil {
		return hosts.Credential{}, r.authenticateErr
	}
	return r.credential, nil
}

func (r *fakeRegistry) OpenConnection(_ context.Context, credential hosts.Credential) (hosts.Connection, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.revoked || credential.ID != r.credential.ID || credential.HostID != r.credential.HostID {
		return hosts.Connection{}, hosts.ErrCredentialRevoked
	}
	r.generation++
	now := time.Now().UTC()
	connection := hosts.Connection{
		HostID:        credential.HostID,
		CredentialID:  credential.ID,
		Generation:    r.generation,
		ConnectedAt:   now,
		ResumeCursors: cloneCursors(r.cursor),
	}
	r.current = &connection
	return connection, nil
}

func (r *fakeRegistry) OpenConnectionWithPreflight(ctx context.Context, credential hosts.Credential, preflight hosts.ConnectionPreflight) (hosts.Connection, error) {
	connection, err := r.OpenConnection(ctx, credential)
	if err != nil {
		return hosts.Connection{}, err
	}
	if preflight != nil {
		if err := preflight(connection); err != nil {
			_ = r.CloseConnection(ctx, connection)
			return hosts.Connection{}, err
		}
	}
	return connection, nil
}

func (r *fakeRegistry) Touch(_ context.Context, connection hosts.Connection) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.matchesLocked(connection) {
		return hosts.ErrConnectionStale
	}
	if r.touchErr != nil {
		return r.touchErr
	}
	r.touches++
	return nil
}

func (r *fakeRegistry) Checkpoint(_ context.Context, connection hosts.Connection, cursor hosts.Cursor) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.matchesLocked(connection) {
		return hosts.ErrConnectionStale
	}
	r.cursor = cloneCursor(&cursor)
	if r.cursor.ObservedAt.IsZero() {
		r.cursor.ObservedAt = time.Now().UTC()
	}
	if r.cursor.RetainedUntil.IsZero() {
		r.cursor.RetainedUntil = time.Now().UTC().Add(time.Hour)
	}
	return nil
}

func (r *fakeRegistry) AuthorizeCommand(_ context.Context, connection hosts.Connection, deliver func() error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.matchesLocked(connection) {
		return hosts.ErrConnectionStale
	}
	if r.authorizeErr != nil {
		return r.authorizeErr
	}
	r.deliverCalls++
	return deliver()
}

func (r *fakeRegistry) ProcessEvent(ctx context.Context, connection hosts.Connection, cursor hosts.Cursor, handler func(context.Context) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.matchesLocked(connection) {
		return hosts.ErrConnectionStale
	}
	if r.processEventErr != nil {
		return r.processEventErr
	}
	if handler != nil {
		if err := handler(ctx); err != nil {
			return err
		}
	}
	r.cursor = cloneCursor(&cursor)
	if r.cursor.ObservedAt.IsZero() {
		r.cursor.ObservedAt = time.Now().UTC()
	}
	if r.cursor.RetainedUntil.IsZero() {
		r.cursor.RetainedUntil = time.Now().UTC().Add(time.Hour)
	}
	return nil
}

func (r *fakeRegistry) CloseConnection(_ context.Context, connection hosts.Connection) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = append(r.closed, connection)
	if r.current != nil && sameConnection(*r.current, connection) {
		r.current = nil
	}
	return nil
}

type orderedOpenRegistry struct {
	*fakeRegistry
	firstOpened  chan struct{}
	releaseFirst chan struct{}
}

type helloAckGateRegistry struct {
	*fakeRegistry
	opened           chan struct{}
	releaseOpen      chan struct{}
	authorizeStarted chan struct{}
	openOnce         sync.Once
	authorizeOnce    sync.Once
	authorizeMu      sync.Mutex
	authorizeCalls   int
}

func newHelloAckGateRegistry() *helloAckGateRegistry {
	return &helloAckGateRegistry{
		fakeRegistry:     newFakeRegistry(),
		opened:           make(chan struct{}),
		releaseOpen:      make(chan struct{}),
		authorizeStarted: make(chan struct{}),
	}
}

func (r *helloAckGateRegistry) OpenConnectionWithPreflight(ctx context.Context, credential hosts.Credential, preflight hosts.ConnectionPreflight) (hosts.Connection, error) {
	connection, err := r.fakeRegistry.OpenConnection(ctx, credential)
	if err != nil {
		return hosts.Connection{}, err
	}
	if preflight != nil {
		if err := preflight(connection); err != nil {
			_ = r.fakeRegistry.CloseConnection(ctx, connection)
			return hosts.Connection{}, err
		}
	}
	r.openOnce.Do(func() { close(r.opened) })
	<-r.releaseOpen
	return connection, nil
}

func (r *helloAckGateRegistry) AuthorizeCommand(ctx context.Context, connection hosts.Connection, deliver func() error) error {
	r.authorizeMu.Lock()
	r.authorizeCalls++
	commandAuthorization := r.authorizeCalls > 1
	r.authorizeMu.Unlock()
	if commandAuthorization {
		r.authorizeOnce.Do(func() { close(r.authorizeStarted) })
	}
	return r.fakeRegistry.AuthorizeCommand(ctx, connection, deliver)
}

type helloAckGateListener struct {
	net.Listener
	accepted chan *helloAckGateConn
}

func newHelloAckGateListener() *helloAckGateListener {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	return &helloAckGateListener{Listener: listener, accepted: make(chan *helloAckGateConn, 1)}
}

func (l *helloAckGateListener) Accept() (net.Conn, error) {
	connection, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	wrapped := newHelloAckGateConn(connection)
	l.accepted <- wrapped
	return wrapped, nil
}

type helloAckGateConn struct {
	net.Conn
	mu           sync.Mutex
	blocked      bool
	release      chan struct{}
	releaseOnce  sync.Once
	blockedWrite chan struct{}
	blockedOnce  sync.Once
}

type observableContext struct {
	context.Context
	entered chan struct{}
	once    sync.Once
}

func (c *observableContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	return c.Context.Done()
}

func newHelloAckGateConn(connection net.Conn) *helloAckGateConn {
	return &helloAckGateConn{
		Conn:         connection,
		release:      make(chan struct{}),
		blockedWrite: make(chan struct{}),
	}
}

func (c *helloAckGateConn) blockWrites() {
	c.mu.Lock()
	c.blocked = true
	c.mu.Unlock()
}

func (c *helloAckGateConn) releaseWrites() {
	c.releaseOnce.Do(func() { close(c.release) })
}

func (c *helloAckGateConn) Write(data []byte) (int, error) {
	c.mu.Lock()
	blocked := c.blocked
	c.mu.Unlock()
	if blocked {
		c.blockedOnce.Do(func() { close(c.blockedWrite) })
		<-c.release
	}
	return c.Conn.Write(data)
}

func newOrderedOpenRegistry() *orderedOpenRegistry {
	return &orderedOpenRegistry{
		fakeRegistry: newFakeRegistry(),
		firstOpened:  make(chan struct{}),
		releaseFirst: make(chan struct{}),
	}
}

type crossInstanceOpenRegistry struct {
	*fakeRegistry
	firstReturned     chan struct{}
	releaseFirst      chan struct{}
	firstReturnedOnce sync.Once
}

func newCrossInstanceOpenRegistry() *crossInstanceOpenRegistry {
	return &crossInstanceOpenRegistry{
		fakeRegistry:  newFakeRegistry(),
		firstReturned: make(chan struct{}),
		releaseFirst:  make(chan struct{}),
	}
}

func (r *crossInstanceOpenRegistry) OpenConnectionWithPreflight(ctx context.Context, credential hosts.Credential, preflight hosts.ConnectionPreflight) (hosts.Connection, error) {
	connection, err := r.fakeRegistry.OpenConnection(ctx, credential)
	if err != nil {
		return hosts.Connection{}, err
	}
	if preflight != nil {
		if err := preflight(connection); err != nil {
			_ = r.fakeRegistry.CloseConnection(ctx, connection)
			return hosts.Connection{}, err
		}
	}
	if connection.Generation == 1 {
		r.firstReturnedOnce.Do(func() { close(r.firstReturned) })
		<-r.releaseFirst
	}
	return connection, nil
}

func (r *orderedOpenRegistry) OpenConnection(_ context.Context, credential hosts.Credential) (hosts.Connection, error) {
	r.fakeRegistry.mu.Lock()
	if r.fakeRegistry.revoked || credential.ID != r.fakeRegistry.credential.ID || credential.HostID != r.fakeRegistry.credential.HostID {
		r.fakeRegistry.mu.Unlock()
		return hosts.Connection{}, hosts.ErrCredentialRevoked
	}
	r.fakeRegistry.generation++
	connection := hosts.Connection{
		HostID:        credential.HostID,
		CredentialID:  credential.ID,
		Generation:    r.fakeRegistry.generation,
		ConnectedAt:   time.Now().UTC(),
		ResumeCursors: cloneCursors(r.fakeRegistry.cursor),
	}
	r.fakeRegistry.current = &connection
	generation := connection.Generation
	r.fakeRegistry.mu.Unlock()
	if generation == 1 {
		close(r.firstOpened)
		<-r.releaseFirst
	}
	return connection, nil
}

func (r *orderedOpenRegistry) OpenConnectionWithPreflight(ctx context.Context, credential hosts.Credential, preflight hosts.ConnectionPreflight) (hosts.Connection, error) {
	connection, err := r.OpenConnection(ctx, credential)
	if err != nil {
		return hosts.Connection{}, err
	}
	if preflight != nil {
		if err := preflight(connection); err != nil {
			_ = r.CloseConnection(ctx, connection)
			return hosts.Connection{}, err
		}
	}
	return connection, nil
}

func (r *fakeRegistry) revoke() {
	r.mu.Lock()
	r.revoked = true
	r.mu.Unlock()
}

func (r *fakeRegistry) matchesLocked(connection hosts.Connection) bool {
	return !r.revoked && r.current != nil && sameConnection(*r.current, connection)
}

type unlockedEventRegistry struct {
	*fakeRegistry
}

func (r *unlockedEventRegistry) ProcessEvent(ctx context.Context, connection hosts.Connection, cursor hosts.Cursor, handler func(context.Context) error) error {
	r.mu.Lock()
	if !r.matchesLocked(connection) {
		r.mu.Unlock()
		return hosts.ErrConnectionStale
	}
	r.mu.Unlock()
	if handler != nil {
		if err := handler(ctx); err != nil {
			return err
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.matchesLocked(connection) {
		return hosts.ErrConnectionStale
	}
	r.cursor = cloneCursor(&cursor)
	if r.cursor.ObservedAt.IsZero() {
		r.cursor.ObservedAt = time.Now().UTC()
	}
	if r.cursor.RetainedUntil.IsZero() {
		r.cursor.RetainedUntil = time.Now().UTC().Add(time.Hour)
	}
	return nil
}

func sameConnection(left, right hosts.Connection) bool {
	return left.HostID == right.HostID && left.CredentialID == right.CredentialID && left.Generation == right.Generation
}

func cloneCursor(cursor *hosts.Cursor) *hosts.Cursor {
	if cursor == nil {
		return nil
	}
	copy := *cursor
	return &copy
}

func cloneCursors(cursor *hosts.Cursor) []hosts.Cursor {
	if cursor == nil {
		return nil
	}
	return []hosts.Cursor{*cloneCursor(cursor)}
}

func TestGatewayDoesNotAuthorizeCommandBeforeHelloAck(t *testing.T) {
	registry := newHelloAckGateRegistry()
	server, err := NewServer(registry)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	listener := newHelloAckGateListener()
	httpServer := httptest.NewUnstartedServer(server)
	httpServer.Listener = listener
	httpServer.StartTLS()
	t.Cleanup(func() {
		listener.Close()
		httpServer.Close()
	})

	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)
	connectResult := make(chan struct {
		connection *ClientConnection
		err        error
	}, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		connection, connectErr := client.Connect(ctx)
		connectResult <- struct {
			connection *ClientConnection
			err        error
		}{connection: connection, err: connectErr}
	}()

	var gate *helloAckGateConn
	select {
	case gate = <-listener.accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("gateway connection was not accepted")
	}
	select {
	case <-registry.opened:
	case <-time.After(2 * time.Second):
		t.Fatal("gateway connection did not reach the registry preflight")
	}
	gate.blockWrites()
	close(registry.releaseOpen)
	select {
	case <-gate.blockedWrite:
	case <-time.After(2 * time.Second):
		t.Fatal("gateway did not attempt the hello acknowledgement write")
	}

	command := protocol.Command{
		CommandID: "cmd_hello_ack_gate",
		IssuedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"text":"hello ack gate"}`),
		SessionID: "session_hello_ack_gate",
	}
	baseCommandCtx, cancelCommand := context.WithTimeout(context.Background(), 3*time.Second)
	commandCtx := &observableContext{Context: baseCommandCtx, entered: make(chan struct{})}
	defer cancelCommand()
	commandResult := make(chan error, 1)
	go func() {
		_, sendErr := server.SendCommand(commandCtx, registry.credential.HostID, command)
		commandResult <- sendErr
	}()

	select {
	case <-commandCtx.entered:
	case <-registry.authorizeStarted:
		gate.releaseWrites()
		t.Fatal("SendCommand() authorized delivery before entering the HelloAck readiness wait")
	case err := <-commandResult:
		gate.releaseWrites()
		t.Fatalf("SendCommand() returned before entering the HelloAck readiness wait: %v", err)
	}
	select {
	case <-registry.authorizeStarted:
		gate.releaseWrites()
		t.Fatal("SendCommand() authorized delivery before hello acknowledgement write completed")
	case err := <-commandResult:
		gate.releaseWrites()
		t.Fatalf("SendCommand() returned before hello acknowledgement write completed: %v", err)
	default:
	}

	gate.releaseWrites()
	select {
	case result := <-connectResult:
		if result.err != nil {
			t.Fatalf("Client.Connect() error = %v", result.err)
		}
		defer result.connection.Close()
	case <-time.After(2 * time.Second):
		t.Fatal("Client.Connect() did not complete after hello acknowledgement release")
	}
	select {
	case <-registry.authorizeStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("SendCommand() did not become deliverable after hello acknowledgement write completed")
	}
	cancelCommand()
	select {
	case <-commandResult:
	case <-time.After(2 * time.Second):
		t.Fatal("SendCommand() did not finish after its context was cancelled")
	}
}

type gatewayRoundTripFunc struct {
	roundTrip func(*http.Request) (*http.Response, error)
}

func (f *gatewayRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f.roundTrip(request)
}

func TestGatewayClientRejectsRedirectWithoutMutatingHTTPClient(t *testing.T) {
	const token = "disposable-gateway-token"
	callerRedirectErr := errors.New("caller redirect policy")
	callerRedirectCalled := false
	requests := make([]*http.Request, 0, 2)
	transport := &gatewayRoundTripFunc{roundTrip: func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request)
		if len(requests) > 1 {
			return nil, errors.New("gateway redirect was followed")
		}
		return &http.Response{
			StatusCode: http.StatusFound,
			Status:     "302 Found",
			Header:     http.Header{"Location": []string{"ws://gateway.test/redirect"}},
			Body:       io.NopCloser(strings.NewReader("redirect")),
			Request:    request,
		}, nil
	}}
	caller := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			callerRedirectCalled = true
			return callerRedirectErr
		},
	}
	client, err := NewClient(ClientOptions{
		URL:        "wss://gateway.test/gateway",
		HostID:     "host_test",
		Token:      token,
		HTTPClient: caller,
	})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	if _, err := client.Connect(context.Background()); !errors.Is(err, errGatewayRedirect) {
		t.Fatalf("Client.Connect() error = %v, want redirect rejection", err)
	}
	if callerRedirectCalled {
		t.Fatal("Client.Connect() invoked the caller redirect policy")
	}
	if caller.Transport != transport {
		t.Fatal("Client.Connect() mutated the caller HTTP transport")
	}
	if got := caller.CheckRedirect(nil, nil); !errors.Is(got, callerRedirectErr) {
		t.Fatalf("caller CheckRedirect() = %v, want unchanged caller policy", got)
	}
	if len(requests) != 1 {
		t.Fatalf("redirect round trips = %d, want 1", len(requests))
	}
	if got := requests[0].Header.Get("Authorization"); got != "Bearer "+token {
		t.Fatalf("initial Authorization header = %q, want disposable token", got)
	}
}

func TestGatewayQueuedCommandAcknowledgementWinsOverCloseAndCancellation(t *testing.T) {
	ack := &protocol.CommandAck{
		CommandID:  "command_ack_race",
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateAccepted,
	}
	for _, test := range []struct {
		name    string
		trigger func(context.CancelFunc, chan struct{})
	}{
		{name: "close", trigger: func(_ context.CancelFunc, done chan struct{}) { close(done) }},
		{name: "cancel", trigger: func(cancel context.CancelFunc, _ chan struct{}) { cancel() }},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			response := make(chan commandResponse, 1)
			response <- commandResponse{ack: ack}
			test.trigger(cancel, done)
			got, err := waitCommandResponse(ctx, done, response, ack.CommandID)
			if err != nil || got.CommandID != ack.CommandID || got.ReceivedAt != ack.ReceivedAt || got.State != ack.State || got.Deduplicated != ack.Deduplicated {
				t.Fatalf("waitCommandResponse() = %+v, %v; want queued acknowledgement", got, err)
			}
		})
	}

	t.Run("without acknowledgement remains unknown", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		done := make(chan struct{})
		close(done)
		_, err := waitCommandResponse(ctx, done, make(chan commandResponse, 1), ack.CommandID)
		if !errors.Is(err, protocol.ErrUnknownCommandResult) {
			t.Fatalf("waitCommandResponse() error = %v, want unknown result", err)
		}
	})
}

func TestGatewayWSSCommandEventAndResume(t *testing.T) {
	registry := newFakeRegistry()
	events := make(chan protocol.Event, 1)
	server, err := NewServer(registry, ServerOptions{EventHandler: func(_ context.Context, _ hosts.Connection, event protocol.Event) error {
		events <- event
		return nil
	}})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)

	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)
	connection := connectTestClient(t, client)
	if got := connection.Generation(); got != 1 {
		t.Fatalf("first gateway generation = %d, want 1", got)
	}

	command := protocol.Command{
		CommandID: "cmd_gateway_1",
		IssuedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"text":"hello"}`),
		SessionID: "session_gateway_1",
	}
	commandResult := make(chan struct {
		ack protocol.CommandAck
		err error
	}, 1)
	go func() {
		ack, sendErr := server.SendCommand(context.Background(), registry.credential.HostID, command)
		commandResult <- struct {
			ack protocol.CommandAck
			err error
		}{ack: ack, err: sendErr}
	}()
	commandMessage := readGatewayMessage(t, connection)
	if commandMessage.Type != MessageCommand || commandMessage.Command == nil || commandMessage.Command.CommandID != command.CommandID {
		t.Fatalf("gateway command message = %+v", commandMessage)
	}
	ack := protocol.CommandAck{
		CommandID:  command.CommandID,
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateAccepted,
	}
	if err := connection.Acknowledge(context.Background(), commandMessage.RequestID, ack); err != nil {
		t.Fatalf("Acknowledge() error = %v", err)
	}
	select {
	case result := <-commandResult:
		if result.err != nil || result.ack.CommandID != command.CommandID || result.ack.State != protocol.CommandStateAccepted {
			t.Fatalf("SendCommand() result = %+v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SendCommand() did not receive an acknowledgement")
	}

	event := protocol.Event{
		Cursor:     "cursor_1",
		EventID:    "event_1",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:    json.RawMessage(`{"delta":"hello"}`),
		Sequence:   1,
		SessionID:  command.SessionID,
		Source:     protocol.EventSourceHostObservation,
		Type:       protocol.EventTypeMessageDelta,
	}
	if err := connection.SendEvent(context.Background(), event); err != nil {
		t.Fatalf("SendEvent() error = %v", err)
	}
	select {
	case got := <-events:
		if got.Cursor != event.Cursor || got.EventID != event.EventID {
			t.Fatalf("event = %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("event handler did not receive the event")
	}

	if err := connection.SendHeartbeatForStream(context.Background(), command.SessionID, "", "cursor_2"); err != nil {
		t.Fatalf("SendHeartbeat() error = %v", err)
	}
	heartbeat := readGatewayMessage(t, connection)
	if heartbeat.Type != MessageHeartbeatAck || heartbeat.RequestID == "" || heartbeat.Generation != connection.Generation() {
		t.Fatalf("heartbeat acknowledgement = %+v", heartbeat)
	}
	if err := connection.Close(); err != nil {
		t.Fatalf("close first connection: %v", err)
	}

	resumed := connectTestClient(t, client)
	if resumed.Generation() != 2 {
		t.Fatalf("replacement gateway generation = %d, want 2", resumed.Generation())
	}
	cursor := resumed.ResumeCursor()
	if cursor == nil || cursor.Value != "cursor_2" {
		t.Fatalf("replacement resume cursor = %+v, want cursor_2", cursor)
	}
	if err := resumed.Close(); err != nil {
		t.Fatalf("close replacement connection: %v", err)
	}
}

func TestGatewayRejectsLateOlderHandshake(t *testing.T) {
	registry := newOrderedOpenRegistry()
	server, err := NewServer(registry)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)

	var releaseOnce sync.Once
	releaseFirst := func() { releaseOnce.Do(func() { close(registry.releaseFirst) }) }
	t.Cleanup(releaseFirst)
	firstResult := make(chan struct {
		connection *ClientConnection
		err        error
	}, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		connection, connectErr := client.Connect(ctx)
		firstResult <- struct {
			connection *ClientConnection
			err        error
		}{connection: connection, err: connectErr}
	}()
	select {
	case <-registry.firstOpened:
	case <-time.After(2 * time.Second):
		t.Fatal("first handshake did not reach OpenConnection")
	}

	second := connectTestClient(t, client)
	defer second.Close()
	if got := second.Generation(); got != 2 {
		t.Fatalf("newer gateway generation = %d, want 2", got)
	}
	releaseFirst()

	select {
	case result := <-firstResult:
		if result.connection != nil {
			_ = result.connection.Close()
		}
		if result.err == nil {
			t.Fatal("older handshake succeeded after newer connection replaced it")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("older handshake did not finish after release")
	}

	registry.mu.Lock()
	current := registry.current
	closed := append([]hosts.Connection(nil), registry.closed...)
	registry.mu.Unlock()
	if current == nil || current.Generation != 2 {
		t.Fatalf("registry current connection = %+v, want generation 2", current)
	}
	var closedOlder bool
	for _, connection := range closed {
		if connection.HostID == registry.credential.HostID && connection.Generation == 1 {
			closedOlder = true
			break
		}
	}
	if !closedOlder {
		t.Fatalf("closed connections = %+v, want rejected generation 1", closed)
	}
	if err := second.SendHeartbeat(context.Background(), ""); err != nil {
		t.Fatalf("newer connection heartbeat error = %v", err)
	}
	heartbeat := readGatewayMessage(t, second)
	if heartbeat.Type != MessageHeartbeatAck || heartbeat.Generation != 2 {
		t.Fatalf("newer connection heartbeat acknowledgement = %+v", heartbeat)
	}
}

func TestGatewayRejectsLateOlderHandshakeAfterNewerRemoved(t *testing.T) {
	registry := newOrderedOpenRegistry()
	server, err := NewServer(registry)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)

	var releaseOnce sync.Once
	releaseFirst := func() { releaseOnce.Do(func() { close(registry.releaseFirst) }) }
	t.Cleanup(releaseFirst)
	firstResult := make(chan struct {
		connection *ClientConnection
		err        error
	}, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		connection, connectErr := client.Connect(ctx)
		firstResult <- struct {
			connection *ClientConnection
			err        error
		}{connection: connection, err: connectErr}
	}()
	select {
	case <-registry.firstOpened:
	case <-time.After(2 * time.Second):
		t.Fatal("first handshake did not reach OpenConnection")
	}

	second := connectTestClient(t, client)
	if got := second.Generation(); got != 2 {
		t.Fatalf("newer gateway generation = %d, want 2", got)
	}
	if err := second.Close(); err != nil {
		t.Fatalf("close newer gateway connection: %v", err)
	}
	waitForGatewayConnectionRemoval(t, server, registry.credential.HostID)
	releaseFirst()

	select {
	case result := <-firstResult:
		if result.connection != nil {
			_ = result.connection.Close()
		}
		if result.err == nil {
			t.Fatal("older handshake succeeded after newer connection was removed")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("older handshake did not finish after release")
	}

	registry.mu.Lock()
	current := registry.current
	closed := append([]hosts.Connection(nil), registry.closed...)
	registry.mu.Unlock()
	if current != nil {
		t.Fatalf("registry current connection = %+v, want none after newer removal", current)
	}
	var closedOlder bool
	for _, connection := range closed {
		if connection.HostID == registry.credential.HostID && connection.Generation == 1 {
			closedOlder = true
			break
		}
	}
	if !closedOlder {
		t.Fatalf("closed connections = %+v, want rejected generation 1", closed)
	}
}

func TestGatewayRejectsCrossInstanceLateOlderHandshakeAfterNewerRemoved(t *testing.T) {
	registry := newCrossInstanceOpenRegistry()
	serverA, err := NewServer(registry)
	if err != nil {
		t.Fatalf("NewServer(A) error = %v", err)
	}
	serverB, err := NewServer(registry)
	if err != nil {
		t.Fatalf("NewServer(B) error = %v", err)
	}
	httpServerA := httptest.NewTLSServer(serverA)
	t.Cleanup(httpServerA.Close)
	httpServerB := httptest.NewTLSServer(serverB)
	t.Cleanup(httpServerB.Close)
	clientA := newTestClient(t, httpServerA, registry.credential.HostID, registry.token)
	clientB := newTestClient(t, httpServerB, registry.credential.HostID, registry.token)

	var releaseOnce sync.Once
	releaseFirst := func() { releaseOnce.Do(func() { close(registry.releaseFirst) }) }
	t.Cleanup(releaseFirst)
	firstResult := make(chan struct {
		connection *ClientConnection
		err        error
	}, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		connection, connectErr := clientA.Connect(ctx)
		firstResult <- struct {
			connection *ClientConnection
			err        error
		}{connection: connection, err: connectErr}
	}()
	select {
	case <-registry.firstReturned:
	case <-time.After(2 * time.Second):
		t.Fatal("older cross-instance handshake did not reach the post-open barrier")
	}

	newer := connectTestClient(t, clientB)
	if got := newer.Generation(); got != 2 {
		t.Fatalf("newer cross-instance generation = %d, want 2", got)
	}
	if err := newer.Close(); err != nil {
		t.Fatalf("close newer cross-instance connection: %v", err)
	}
	waitForFakeRegistryRemoval(t, registry.fakeRegistry, registry.credential.HostID)
	releaseFirst()

	select {
	case result := <-firstResult:
		if result.connection != nil {
			_ = result.connection.Close()
		}
		if result.err == nil {
			t.Fatal("older cross-instance handshake succeeded after newer connection was removed")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("older cross-instance handshake did not finish after release")
	}

	registry.mu.Lock()
	current := registry.current
	closed := append([]hosts.Connection(nil), registry.closed...)
	registry.mu.Unlock()
	if current != nil {
		t.Fatalf("shared registry current connection = %+v, want none after newer removal", current)
	}
	var closedOlder bool
	for _, connection := range closed {
		if connection.HostID == registry.credential.HostID && connection.Generation == 1 {
			closedOlder = true
			break
		}
	}
	if !closedOlder {
		t.Fatalf("closed shared-registry connections = %+v, want rejected generation 1 cleanup", closed)
	}
}

func TestGatewayRevocationFencesConnection(t *testing.T) {
	registry := newFakeRegistry()
	server, err := NewServer(registry)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)
	connection := connectTestClient(t, client)
	registry.revoke()
	command := protocol.Command{
		CommandID: "cmd_revoked",
		IssuedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"text":"blocked"}`),
		SessionID: "session_gateway_1",
	}
	if _, err := server.SendCommand(context.Background(), registry.credential.HostID, command); !errors.Is(err, hosts.ErrConnectionStale) {
		t.Fatalf("SendCommand() after revoke error = %v, want ErrConnectionStale", err)
	}

	if _, err := client.Connect(context.Background()); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("revoked reconnect error = %v, want HTTP 401", err)
	}
	if err := connection.SendHeartbeat(context.Background(), ""); err != nil {
		t.Fatalf("heartbeat on revoked connection: %v", err)
	}
	errorMessage := readGatewayMessage(t, connection)
	if errorMessage.Type != MessageError || errorMessage.Error == nil || errorMessage.Error.Code != "stale_generation" {
		t.Fatalf("revoked connection error message = %+v", errorMessage)
	}
	_ = connection.Close()
}

func TestGatewayRejectsStaleCommandAcknowledgements(t *testing.T) {
	ack := &protocol.CommandAck{
		CommandID:  "command_ack_fence",
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateAccepted,
	}

	t.Run("generation mismatch", func(t *testing.T) {
		registry := newFakeRegistry()
		connection, err := registry.OpenConnection(context.Background(), registry.credential)
		if err != nil {
			t.Fatalf("OpenConnection() error = %v", err)
		}
		assertCommandAckRejected(t, registry, connection, connection.Generation+1, ack)
		registry.mu.Lock()
		deliverCalls := registry.deliverCalls
		registry.mu.Unlock()
		if deliverCalls != 0 {
			t.Fatalf("generation mismatch invoked delivery %d times", deliverCalls)
		}
	})

	t.Run("revoked connection", func(t *testing.T) {
		registry := newFakeRegistry()
		connection, err := registry.OpenConnection(context.Background(), registry.credential)
		if err != nil {
			t.Fatalf("OpenConnection() error = %v", err)
		}
		registry.revoke()
		assertCommandAckRejected(t, registry, connection, connection.Generation, ack)
	})

	t.Run("replaced connection", func(t *testing.T) {
		registry := newFakeRegistry()
		connection, err := registry.OpenConnection(context.Background(), registry.credential)
		if err != nil {
			t.Fatalf("OpenConnection(first) error = %v", err)
		}
		if _, err := registry.OpenConnection(context.Background(), registry.credential); err != nil {
			t.Fatalf("OpenConnection(replacement) error = %v", err)
		}
		assertCommandAckRejected(t, registry, connection, connection.Generation, ack)
	})

	t.Run("current connection", func(t *testing.T) {
		registry := newFakeRegistry()
		connection, err := registry.OpenConnection(context.Background(), registry.credential)
		if err != nil {
			t.Fatalf("OpenConnection() error = %v", err)
		}
		response := make(chan commandResponse, 1)
		serverConnection := &serverConnection{
			registry:   registry,
			connection: connection,
			pending:    map[string]chan commandResponse{"request_ack_fence": response},
		}
		if err := serverConnection.resolve(context.Background(), Message{
			Type:       MessageCommandAck,
			RequestID:  "request_ack_fence",
			Generation: connection.Generation,
			Ack:        ack,
		}); err != nil {
			t.Fatalf("resolve(current) error = %v", err)
		}
		select {
		case result := <-response:
			if result.ack != ack || result.err != nil {
				t.Fatalf("current acknowledgement result = %+v, want ack", result)
			}
		default:
			t.Fatal("current acknowledgement did not resolve the pending command")
		}
	})
}

func assertCommandAckRejected(t *testing.T, registry *fakeRegistry, connection hosts.Connection, generation int64, ack *protocol.CommandAck) {
	t.Helper()
	response := make(chan commandResponse, 1)
	serverConnection := &serverConnection{
		registry:   registry,
		connection: connection,
		pending:    map[string]chan commandResponse{"request_ack_fence": response},
	}
	err := serverConnection.resolve(context.Background(), Message{
		Type:       MessageCommandAck,
		RequestID:  "request_ack_fence",
		Generation: generation,
		Ack:        ack,
	})
	if !errors.Is(err, hosts.ErrConnectionStale) {
		t.Fatalf("resolve() error = %v, want ErrConnectionStale", err)
	}
	select {
	case result := <-response:
		t.Fatalf("stale acknowledgement resolved command: %+v", result)
	default:
	}
}

func TestGatewayRejectsEventsWithoutHandler(t *testing.T) {
	registry := newFakeRegistry()
	server, err := NewServer(registry)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)
	connection := connectTestClient(t, client)
	if err := connection.SendEvent(context.Background(), protocol.Event{
		Cursor:     "cursor_unhandled",
		EventID:    "event_unhandled",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:    json.RawMessage(`{"delta":"unhandled"}`),
		Sequence:   1,
		SessionID:  "session_unhandled",
		Source:     protocol.EventSourceHostObservation,
		Type:       protocol.EventTypeMessageDelta,
	}); err != nil {
		t.Fatalf("SendEvent() error = %v", err)
	}
	errorMessage := readGatewayMessage(t, connection)
	if errorMessage.Type != MessageError || errorMessage.Error == nil || errorMessage.Error.Code != "event_rejected" {
		t.Fatalf("unhandled event error message = %+v", errorMessage)
	}
	_ = connection.Close()

	resumed := connectTestClient(t, client)
	defer resumed.Close()
	if got := resumed.ResumeCursors(); len(got) != 0 {
		t.Fatalf("unhandled event resume cursors = %+v, want none", got)
	}
}

func TestGatewayWSSRejectsInternalErrorDetails(t *testing.T) {
	const marker = "private path=/srv/loomhelm/secrets credential=credential-secret raw-envelope={\"token\":\"raw-secret\"}"
	for _, test := range []struct {
		name        string
		configure   func(*fakeRegistry) error
		invoke      func(*serverConnection) error
		options     ServerOptions
		wantCode    string
		wantMessage string
	}{
		{
			name: "heartbeat",
			configure: func(registry *fakeRegistry) error {
				internalErr := errors.New(marker)
				registry.touchErr = internalErr
				return internalErr
			},
			invoke: func(connection *serverConnection) error {
				return connection.handleHeartbeat(context.Background(), Message{
					Type:       MessageHeartbeat,
					RequestID:  "request_error_details",
					Generation: connection.connection.Generation,
				})
			},
			wantCode:    "heartbeat_rejected",
			wantMessage: "gateway heartbeat rejected",
		},
		{
			name: "event",
			configure: func(registry *fakeRegistry) error {
				internalErr := errors.New(marker)
				registry.processEventErr = internalErr
				return internalErr
			},
			invoke: func(connection *serverConnection) error {
				runID := "run_error_details"
				return connection.handleEvent(context.Background(), Message{
					Type: MessageEvent,
					Event: &protocol.Event{
						Cursor:     "cursor_error_details",
						EventID:    "event_error_details",
						OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
						Payload:    json.RawMessage("{\"raw\":\"error details\"}"),
						Sequence:   1,
						SessionID:  "session_error_details",
						RunID:      &runID,
						Source:     protocol.EventSourceHostObservation,
						Type:       protocol.EventTypeMessageDelta,
					},
				})
			},
			options:     ServerOptions{EventHandler: func(context.Context, hosts.Connection, protocol.Event) error { return nil }},
			wantCode:    "event_rejected",
			wantMessage: "gateway event rejected",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			registry := newFakeRegistry()
			internalErr := test.configure(registry)
			server, err := NewServer(registry, test.options)
			if err != nil {
				t.Fatalf("NewServer() error = %v", err)
			}
			httpServer := httptest.NewTLSServer(server)
			t.Cleanup(httpServer.Close)
			connection := connectTestClient(t, newTestClient(t, httpServer, registry.credential.HostID, registry.token))
			t.Cleanup(func() { _ = connection.Close() })

			serverConnection := gatewayServerConnection(t, server, registry.credential.HostID)
			if err := test.invoke(serverConnection); !errors.Is(err, internalErr) {
				t.Fatalf("invoke %s error = %v, want original internal error", test.name, err)
			}
			rawFrame, errorMessage := readGatewayFrame(t, connection)
			if errorMessage.Type != MessageError || errorMessage.Error == nil {
				t.Fatalf("error frame = %+v, want MessageError", errorMessage)
			}
			if errorMessage.Error.Code != test.wantCode {
				t.Fatalf("error frame code = %q, want %q", errorMessage.Error.Code, test.wantCode)
			}
			if errorMessage.Error.Message != test.wantMessage {
				t.Fatalf("error frame message = %q, want fixed safe message %q", errorMessage.Error.Message, test.wantMessage)
			}
			for _, fragment := range []string{"/srv/loomhelm/secrets", "credential-secret", "raw-envelope", "raw-secret"} {
				if strings.Contains(string(rawFrame), fragment) {
					t.Fatalf("raw error frame leaked internal detail %q: %q", fragment, rawFrame)
				}
			}
		})
	}
}

func TestGatewayShutdownDrainsAndRejectsNewConnections(t *testing.T) {
	registry := newFakeRegistry()
	server, err := NewServer(registry)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)
	connection := connectTestClient(t, client)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	if _, err := client.Connect(ctx); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("connection after shutdown error = %v, want HTTP 503", err)
	}
	_ = connection.Close()
}

func TestGatewayAuthenticationErrorsUseSafeStatus(t *testing.T) {
	for _, test := range []struct {
		name             string
		token            string
		revoked          bool
		authenticateErr  error
		wantStatus       int
		wantBodyContains string
		wantBodyExcludes string
	}{
		{name: "invalid credential", token: "invalid", wantStatus: 401},
		{name: "revoked credential", token: "token_test", revoked: true, wantStatus: 401},
		{
			name:             "dependency failure",
			token:            "token_test",
			authenticateErr:  errors.New("database connection failed: internal credential details"),
			wantStatus:       503,
			wantBodyContains: "Service Unavailable",
			wantBodyExcludes: "internal credential details",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			registry := newFakeRegistry()
			registry.revoked = test.revoked
			registry.authenticateErr = test.authenticateErr
			server, err := NewServer(registry)
			if err != nil {
				t.Fatalf("NewServer() error = %v", err)
			}
			request := httptest.NewRequest("GET", "https://gateway.test/gateway", nil)
			request.Header.Set("Authorization", "Bearer "+test.token)
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("ServeHTTP() status = %d, want %d; body = %q", response.Code, test.wantStatus, response.Body.String())
			}
			if test.wantBodyContains != "" && !strings.Contains(response.Body.String(), test.wantBodyContains) {
				t.Fatalf("ServeHTTP() body = %q, want %q", response.Body.String(), test.wantBodyContains)
			}
			if test.wantBodyExcludes != "" && strings.Contains(response.Body.String(), test.wantBodyExcludes) {
				t.Fatalf("ServeHTTP() leaked authentication error details in body %q", response.Body.String())
			}
		})
	}
}

func TestGatewayShutdownWaitsForInFlightEventHandler(t *testing.T) {
	registry := &unlockedEventRegistry{fakeRegistry: newFakeRegistry()}
	handlerStarted := make(chan struct{})
	releaseHandler := make(chan struct{})
	var startOnce sync.Once
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseHandler) }) }
	t.Cleanup(release)
	server, err := NewServer(registry, ServerOptions{
		EventHandler: func(ctx context.Context, _ hosts.Connection, _ protocol.Event) error {
			startOnce.Do(func() { close(handlerStarted) })
			select {
			case <-releaseHandler:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)
	connection := connectTestClient(t, client)
	t.Cleanup(func() { _ = connection.Close() })
	event := protocol.Event{
		Cursor:     "cursor_shutdown_inflight",
		EventID:    "event_shutdown_inflight",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:    json.RawMessage(`{"delta":"blocking"}`),
		Sequence:   1,
		SessionID:  "session_shutdown_inflight",
		Source:     protocol.EventSourceHostObservation,
		Type:       protocol.EventTypeMessageDelta,
	}
	if err := connection.SendEvent(context.Background(), event); err != nil {
		t.Fatalf("SendEvent() error = %v", err)
	}
	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("event handler did not enter its controlled in-flight state")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	shutdown := make(chan error, 1)
	go func() { shutdown <- server.Shutdown(shutdownCtx) }()
	select {
	case err := <-shutdown:
		t.Fatalf("Shutdown() returned before in-flight event handler completed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	release()
	select {
	case err := <-shutdown:
		if err != nil {
			t.Fatalf("Shutdown() after event handler completion error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown() did not complete after in-flight event handler was released")
	}
}

func TestGatewayShutdownReportsDeadlineWhileEventHandlerRemainsInFlight(t *testing.T) {
	registry := &unlockedEventRegistry{fakeRegistry: newFakeRegistry()}
	handlerStarted := make(chan struct{})
	handlerFinished := make(chan struct{})
	releaseHandler := make(chan struct{})
	var startOnce sync.Once
	var finishOnce sync.Once
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseHandler) }) }
	t.Cleanup(release)
	server, err := NewServer(registry, ServerOptions{
		EventHandler: func(ctx context.Context, _ hosts.Connection, _ protocol.Event) error {
			startOnce.Do(func() { close(handlerStarted) })
			defer finishOnce.Do(func() { close(handlerFinished) })
			select {
			case <-releaseHandler:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)
	connection := connectTestClient(t, client)
	t.Cleanup(func() { _ = connection.Close() })
	event := protocol.Event{
		Cursor:     "cursor_shutdown_deadline",
		EventID:    "event_shutdown_deadline",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:    json.RawMessage(`{"delta":"deadline"}`),
		Sequence:   1,
		SessionID:  "session_shutdown_deadline",
		Source:     protocol.EventSourceHostObservation,
		Type:       protocol.EventTypeMessageDelta,
	}
	if err := connection.SendEvent(context.Background(), event); err != nil {
		t.Fatalf("SendEvent() error = %v", err)
	}
	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("event handler did not enter its controlled in-flight state")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	shutdown := make(chan error, 1)
	shutdownStarted := time.Now()
	go func() { shutdown <- server.Shutdown(shutdownCtx) }()
	var shutdownErr error
	select {
	case shutdownErr = <-shutdown:
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown() did not return within the bounded deadline test window")
	}
	if shutdownErr == nil || !errors.Is(shutdownErr, context.DeadlineExceeded) {
		t.Fatalf("Shutdown() error = %v, want context deadline exceeded", shutdownErr)
	}
	if elapsed := time.Since(shutdownStarted); elapsed > time.Second {
		t.Fatalf("Shutdown() elapsed %s, want bounded return", elapsed)
	}
	select {
	case <-handlerFinished:
		t.Fatal("Shutdown() cancelled the in-flight event handler before release")
	default:
	}

	release()
	select {
	case <-handlerFinished:
	case <-time.After(2 * time.Second):
		t.Fatal("event handler did not finish after release")
	}
	deadline := time.After(2 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		registry.mu.Lock()
		closedConnections := len(registry.closed)
		registry.mu.Unlock()
		if closedConnections >= 2 {
			return
		}
		select {
		case <-ticker.C:
		case <-deadline:
			t.Fatalf("registry cleanup calls = %d, want ServeHTTP cleanup after release", closedConnections)
		}
	}
}

func TestGatewayShutdownWaitsForHandshake(t *testing.T) {
	server, err := NewServer(newFakeRegistry())
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	if !server.beginHandshake() {
		t.Fatal("beginHandshake() rejected an active server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	shutdown := make(chan error, 1)
	go func() { shutdown <- server.Shutdown(ctx) }()
	select {
	case err := <-shutdown:
		t.Fatalf("Shutdown() returned before handshake ended: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	server.endHandshake()
	if err := <-shutdown; err != nil {
		t.Fatalf("Shutdown() after handshake error = %v", err)
	}
}

func TestGatewayValidatesCommandAcknowledgements(t *testing.T) {
	valid := `{"type":"command_ack","request_id":"request_1","ack":{"command_id":"command_1","state":"accepted","received_at":"2026-10-22T12:00:00Z","deduplicated":false}}`
	if _, err := decodeMessage([]byte(valid), DefaultMaxFrame); err != nil {
		t.Fatalf("valid command acknowledgement error = %v", err)
	}
	for name, payload := range map[string]string{
		"missing deduplicated":  `{"type":"command_ack","request_id":"request_1","ack":{"command_id":"command_1","state":"accepted","received_at":"2026-10-22T12:00:00Z"}}`,
		"invalid state":         `{"type":"command_ack","request_id":"request_1","ack":{"command_id":"command_1","state":"not-a-state","received_at":"2026-10-22T12:00:00Z","deduplicated":false}}`,
		"invalid received time": `{"type":"command_ack","request_id":"request_1","ack":{"command_id":"command_1","state":"accepted","received_at":"not-a-time","deduplicated":false}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeMessage([]byte(payload), DefaultMaxFrame); err == nil {
				t.Fatal("decodeMessage() accepted malformed command acknowledgement")
			}
		})
	}
}

func TestGatewayValidatesCommandFrames(t *testing.T) {
	validCommand := protocol.Command{
		CommandID: "command_1",
		IssuedAt:  "2026-10-22T12:00:00Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"hello"}`),
		SessionID: "session_1",
	}
	validMessage := Message{Type: MessageCommand, RequestID: "request_1", Command: &validCommand}
	data, err := encodeMessage(validMessage, DefaultMaxFrame)
	if err != nil {
		t.Fatalf("encodeMessage(valid command) error = %v", err)
	}
	if _, err := decodeMessage(data, DefaultMaxFrame); err != nil {
		t.Fatalf("decodeMessage(valid command) error = %v", err)
	}

	for _, test := range []struct {
		name    string
		command protocol.Command
	}{
		{name: "missing command id", command: func() protocol.Command { command := validCommand; command.CommandID = ""; return command }()},
		{name: "missing kind", command: func() protocol.Command { command := validCommand; command.Kind = ""; return command }()},
		{name: "unsupported kind", command: func() protocol.Command { command := validCommand; command.Kind = "run.unknown"; return command }()},
		{name: "missing session id", command: func() protocol.Command { command := validCommand; command.SessionID = ""; return command }()},
		{name: "missing issued time", command: func() protocol.Command { command := validCommand; command.IssuedAt = ""; return command }()},
		{name: "malformed issued time", command: func() protocol.Command { command := validCommand; command.IssuedAt = "not-a-time"; return command }()},
		{name: "missing payload", command: func() protocol.Command { command := validCommand; command.Payload = nil; return command }()},
	} {
		t.Run(test.name, func(t *testing.T) {
			message := Message{Type: MessageCommand, RequestID: "request_1", Command: &test.command}
			if _, err := encodeMessage(message, DefaultMaxFrame); err == nil {
				t.Fatal("encodeMessage() accepted malformed command")
			}
			data, err := json.Marshal(message)
			if err != nil {
				t.Fatalf("json.Marshal() error = %v", err)
			}
			if _, err := decodeMessage(data, DefaultMaxFrame); err == nil {
				t.Fatal("decodeMessage() accepted malformed command")
			}
		})
	}

	server, err := NewServer(newFakeRegistry())
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	invalidSend := validCommand
	invalidSend.IssuedAt = "not-a-time"
	if _, err := server.SendCommand(context.Background(), "host_test", invalidSend); err == nil || errors.Is(err, ErrNoActiveConnection) {
		t.Fatalf("SendCommand() error = %v, want command validation before connection lookup", err)
	}
}

func TestGatewayValidatesEvents(t *testing.T) {
	valid := `{"type":"event","event":{"event_id":"event_1","cursor":"cursor_1","sequence":1,"session_id":"session_1","type":"message.delta","occurred_at":"2026-10-22T12:00:00Z","source":"host-observation","payload":{"text":"hello"}}}`
	if _, err := decodeMessage([]byte(valid), DefaultMaxFrame); err != nil {
		t.Fatalf("valid event error = %v", err)
	}
	for name, sequence := range map[string]int64{
		"zero":     0,
		"negative": -1,
		"positive": 1,
	} {
		t.Run("direct sequence "+name, func(t *testing.T) {
			event := protocol.Event{
				Cursor:     "cursor_direct",
				EventID:    "event_direct",
				OccurredAt: "2026-10-22T12:00:00Z",
				Payload:    json.RawMessage(`{"text":"hello"}`),
				Sequence:   sequence,
				SessionID:  "session_direct",
				Source:     protocol.EventSourceHostObservation,
				Type:       protocol.EventTypeMessageDelta,
			}
			err := (Message{Type: MessageEvent, Event: &event}).Validate()
			if sequence > 0 {
				if err != nil {
					t.Fatalf("Message.Validate() error = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "sequence must be positive") {
				t.Fatalf("Message.Validate() error = %v, want positive sequence rejection", err)
			}
		})
	}
	for name, payload := range map[string]string{
		"missing payload":   `{"type":"event","event":{"event_id":"event_1","cursor":"cursor_1","sequence":1,"session_id":"session_1","type":"message.delta","occurred_at":"2026-10-22T12:00:00Z","source":"host-observation"}}`,
		"missing sequence":  `{"type":"event","event":{"event_id":"event_1","cursor":"cursor_1","session_id":"session_1","type":"message.delta","occurred_at":"2026-10-22T12:00:00Z","source":"host-observation","payload":{}}}`,
		"zero sequence":     `{"type":"event","event":{"event_id":"event_1","cursor":"cursor_1","sequence":0,"session_id":"session_1","type":"message.delta","occurred_at":"2026-10-22T12:00:00Z","source":"host-observation","payload":{}}}`,
		"negative sequence": `{"type":"event","event":{"event_id":"event_1","cursor":"cursor_1","sequence":-1,"session_id":"session_1","type":"message.delta","occurred_at":"2026-10-22T12:00:00Z","source":"host-observation","payload":{}}}`,
		"invalid sequence":  `{"type":"event","event":{"event_id":"event_1","cursor":"cursor_1","sequence":"one","session_id":"session_1","type":"message.delta","occurred_at":"2026-10-22T12:00:00Z","source":"host-observation","payload":{}}}`,
		"invalid source":    `{"type":"event","event":{"event_id":"event_1","cursor":"cursor_1","sequence":1,"session_id":"session_1","type":"message.delta","occurred_at":"2026-10-22T12:00:00Z","source":"unknown","payload":{}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeMessage([]byte(payload), DefaultMaxFrame); err == nil {
				t.Fatal("decodeMessage() accepted malformed event")
			}
		})
	}
	unknown := `{"type":"event","event":{"event_id":"event_unknown","cursor":"cursor_unknown","sequence":2,"session_id":"session_1","type":"unknown","occurred_at":"2026-10-22T12:00:00Z","source":"host-observation","payload":["opaque",null]}}`
	if _, err := decodeMessage([]byte(unknown), DefaultMaxFrame); err != nil {
		t.Fatalf("EventTypeUnknown or raw payload rejected: %v", err)
	}
}

func TestGatewayDoesNotClassifyPreDeliveryFailureAsUnknown(t *testing.T) {
	registry := newFakeRegistry()
	server, err := NewServer(registry)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)
	connection := connectTestClient(t, client)
	defer connection.Close()
	registry.mu.Lock()
	registry.authorizeErr = hosts.ErrCommandNotDelivered
	registry.deliverCalls = 0
	registry.mu.Unlock()
	_, err = server.SendCommand(context.Background(), registry.credential.HostID, protocol.Command{
		CommandID: "command_not_delivered",
		IssuedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"text":"not sent"}`),
		SessionID: "session_not_delivered",
	})
	if !errors.Is(err, hosts.ErrCommandNotDelivered) || errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("pre-delivery command error = %v, want non-unknown ErrCommandNotDelivered", err)
	}
	registry.mu.Lock()
	deliverCalls := registry.deliverCalls
	registry.mu.Unlock()
	if deliverCalls != 0 {
		t.Fatalf("pre-delivery command invoked deliver %d times", deliverCalls)
	}
}

func waitForFakeRegistryRemoval(t *testing.T, registry *fakeRegistry, hostID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		registry.mu.Lock()
		current := registry.current
		registry.mu.Unlock()
		if current == nil || current.HostID != hostID {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("shared registry connection for host %q was not removed: %v", hostID, ctx.Err())
		case <-ticker.C:
		}
	}
}

func TestGatewayWireRejectsOversizedMessages(t *testing.T) {
	message := Message{Type: MessageHello, Protocol: ProtocolVersion, HostID: "host_test"}
	if _, err := encodeMessage(message, 1); err == nil {
		t.Fatal("encodeMessage() accepted an oversized frame")
	}
}

func TestGatewayWireRejectsOversizedRecoveryPayload(t *testing.T) {
	cursors := make([]WireCursor, hosts.MaxResumeCursorCount)
	for i := range cursors {
		cursors[i] = WireCursor{
			SessionID:     "session",
			Value:         strings.Repeat(`\`, 1024),
			ObservedAt:    "2026-10-24T00:00:00Z",
			RetainedUntil: "2026-10-25T00:00:00Z",
		}
	}
	message := Message{
		Type:       MessageHelloAck,
		HostID:     "host_test",
		Generation: 1,
		Cursors:    cursors,
	}
	if _, err := encodeMessage(message, DefaultMaxFrame); err == nil || !strings.Contains(err.Error(), "recovery payload") {
		t.Fatalf("encodeMessage() error = %v, want recovery payload rejection", err)
	}
}

func TestGatewayWireRejectsOversizedCursorIDs(t *testing.T) {
	cursor := WireCursor{
		SessionID:     strings.Repeat("s", hosts.MaxCursorIDBytes+1),
		Value:         "cursor",
		ObservedAt:    "2026-10-24T00:00:00Z",
		RetainedUntil: "2026-10-25T00:00:00Z",
	}
	message := Message{Type: MessageHelloAck, HostID: "host_test", Generation: 1, Cursors: []WireCursor{cursor}}
	if _, err := encodeMessage(message, DefaultMaxFrame); err == nil || !strings.Contains(err.Error(), "session id") {
		t.Fatalf("encodeMessage() error = %v, want cursor session id rejection", err)
	}
}

func newTestClient(t *testing.T, server *httptest.Server, hostID, token string) *Client {
	t.Helper()
	url := strings.Replace(server.URL, "https://", "wss://", 1)
	client, err := NewClient(ClientOptions{URL: url, HostID: hostID, Token: token, HTTPClient: server.Client()})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	return client
}

func connectTestClient(t *testing.T, client *Client) *ClientConnection {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	connection, err := client.Connect(ctx)
	if err != nil {
		t.Fatalf("Client.Connect() error = %v", err)
	}
	return connection
}

func readGatewayMessage(t *testing.T, connection *ClientConnection) Message {
	t.Helper()
	_, message := readGatewayFrame(t, connection)
	return message
}

func readGatewayFrame(t *testing.T, connection *ClientConnection) ([]byte, Message) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	messageType, data, err := connection.ws.Read(ctx)
	if err != nil {
		t.Fatalf("ClientConnection.ws.Read() error = %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("gateway frame type = %v, want text", messageType)
	}
	message, err := decodeMessage(data, connection.maxFrame)
	if err != nil {
		t.Fatalf("decode gateway frame: %v", err)
	}
	return data, message
}

func gatewayServerConnection(t *testing.T, server *Server, hostID string) *serverConnection {
	t.Helper()
	server.mu.RLock()
	connection := server.connections[hostID]
	server.mu.RUnlock()
	if connection == nil {
		t.Fatalf("server connection for host %q is missing", hostID)
	}
	return connection
}

func waitForGatewayConnectionRemoval(t *testing.T, server *Server, hostID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		server.mu.RLock()
		_, present := server.connections[hostID]
		server.mu.RUnlock()
		if !present {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("gateway connection for host %q was not removed: %v", hostID, ctx.Err())
		case <-ticker.C:
		}
	}
}
