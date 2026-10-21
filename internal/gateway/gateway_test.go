package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

type fakeRegistry struct {
	mu         sync.Mutex
	credential hosts.Credential
	token      string
	revoked    bool
	generation int64
	current    *hosts.Connection
	cursor     *hosts.Cursor
	touches    int
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

func (r *fakeRegistry) Touch(_ context.Context, connection hosts.Connection) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.matchesLocked(connection) {
		return hosts.ErrConnectionStale
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
	return deliver()
}

func (r *fakeRegistry) ProcessEvent(ctx context.Context, connection hosts.Connection, cursor hosts.Cursor, handler func(context.Context) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.matchesLocked(connection) {
		return hosts.ErrConnectionStale
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
	if r.current != nil && sameConnection(*r.current, connection) {
		r.current = nil
	}
	return nil
}

func (r *fakeRegistry) revoke() {
	r.mu.Lock()
	r.revoked = true
	r.mu.Unlock()
}

func (r *fakeRegistry) matchesLocked(connection hosts.Connection) bool {
	return !r.revoked && r.current != nil && sameConnection(*r.current, connection)
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

	event := protocol.Event{Cursor: "cursor_1", EventID: "event_1", SessionID: command.SessionID, Sequence: 1}
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
	if err := connection.SendEvent(context.Background(), protocol.Event{Cursor: "cursor_unhandled", EventID: "event_unhandled", SessionID: "session_unhandled"}); err != nil {
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

func TestGatewayWireRejectsOversizedMessages(t *testing.T) {
	message := Message{Type: MessageHello, Protocol: ProtocolVersion, HostID: "host_test"}
	if _, err := encodeMessage(message, 1); err == nil {
		t.Fatal("encodeMessage() accepted an oversized frame")
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
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	message, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("ClientConnection.Read() error = %v", err)
	}
	return message
}
