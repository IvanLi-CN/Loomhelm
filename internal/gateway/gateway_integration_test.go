package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
)

func TestGatewayWithPostgresTLSWSS(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	db := openGatewayDatabase(t, ctx)

	registration, err := hosts.NewService(db.Pool()).Register(ctx, hosts.RegisterRequest{
		Name:           "h01 gateway integration " + time.Now().UTC().Format("20060102T150405.000000000"),
		CredentialName: "gateway-test",
	})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	var handlerMu sync.Mutex
	handlerCalls := make(map[string]int)
	handledEventIDs := make(map[string]struct{})
	sideEffects := 0
	observed := make(chan protocol.Event, 4)
	server, err := NewServer(hosts.NewService(db.Pool()), ServerOptions{
		EventHandler: func(_ context.Context, _ hosts.Connection, event protocol.Event) error {
			handlerMu.Lock()
			handlerCalls[event.EventID]++
			if _, handled := handledEventIDs[event.EventID]; !handled {
				handledEventIDs[event.EventID] = struct{}{}
				sideEffects++
			}
			handlerMu.Unlock()
			observed <- event
			return nil
		},
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)

	wssURL := strings.Replace(httpServer.URL, "https://", "wss://", 1)
	client, err := NewClient(ClientOptions{
		URL:        wssURL,
		HostID:     registration.Host.ID,
		Token:      registration.Token,
		HTTPClient: httpServer.Client(),
	})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	invalidClient, err := NewClient(ClientOptions{
		URL:        wssURL,
		HostID:     registration.Host.ID,
		Token:      "invalid-token",
		HTTPClient: httpServer.Client(),
	})
	if err != nil {
		t.Fatalf("NewClient(invalid) error = %v", err)
	}
	if _, err := invalidClient.Connect(ctx); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("invalid credential connection error = %v, want HTTP 401", err)
	}

	connection := connectTestClient(t, client)
	if connection.Generation() != 1 {
		t.Fatalf("first gateway generation = %d, want 1", connection.Generation())
	}

	command := protocol.Command{
		CommandID: "cmd_pg_gateway_1",
		IssuedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"text":"hello from postgres"}`),
		SessionID: "session_pg_gateway_1",
	}
	commandResult := make(chan struct {
		ack protocol.CommandAck
		err error
	}, 1)
	go func() {
		ack, sendErr := server.SendCommand(ctx, registration.Host.ID, command)
		commandResult <- struct {
			ack protocol.CommandAck
			err error
		}{ack: ack, err: sendErr}
	}()
	commandMessage := readGatewayMessage(t, connection)
	if commandMessage.Type != MessageCommand || commandMessage.Command == nil || commandMessage.Command.CommandID != command.CommandID {
		t.Fatalf("gateway command message = %+v", commandMessage)
	}
	if err := connection.Acknowledge(ctx, commandMessage.RequestID, protocol.CommandAck{
		CommandID:  command.CommandID,
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateAccepted,
	}); err != nil {
		t.Fatalf("Acknowledge() error = %v", err)
	}
	select {
	case result := <-commandResult:
		if result.err != nil || result.ack.CommandID != command.CommandID || result.ack.State != protocol.CommandStateAccepted {
			t.Fatalf("SendCommand() result = %+v", result)
		}
	case <-ctx.Done():
		t.Fatalf("SendCommand() did not receive an acknowledgement: %v", ctx.Err())
	}

	runID := "run_pg_gateway_1"
	event := protocol.Event{
		Cursor:     "event_cursor_1",
		EventID:    "event_pg_gateway_1",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:    json.RawMessage(`{"delta":"persisted"}`),
		RunID:      &runID,
		Sequence:   1,
		SessionID:  command.SessionID,
		Source:     protocol.EventSourceHostObservation,
		Type:       protocol.EventTypeMessageDelta,
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := connection.SendEvent(ctx, event); err != nil {
			t.Fatalf("SendEvent(attempt=%d) error = %v", attempt, err)
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		select {
		case observedEvent := <-observed:
			if observedEvent.EventID != event.EventID || observedEvent.Cursor != event.Cursor {
				t.Fatalf("observed event = %+v", observedEvent)
			}
		case <-ctx.Done():
			t.Fatalf("event handler did not observe duplicate %d: %v", attempt+1, ctx.Err())
		}
	}
	handlerMu.Lock()
	gotCalls := handlerCalls[event.EventID]
	gotSideEffects := sideEffects
	handlerMu.Unlock()
	if gotCalls != 2 || gotSideEffects != 1 {
		t.Fatalf("event receiver calls=%d side_effects=%d, want calls=2 side_effects=1", gotCalls, gotSideEffects)
	}

	if err := connection.SendHeartbeatForStream(ctx, command.SessionID, runID, "event_cursor_2"); err != nil {
		t.Fatalf("SendHeartbeatForStream() error = %v", err)
	}
	heartbeat := readGatewayMessage(t, connection)
	if heartbeat.Type != MessageHeartbeatAck || heartbeat.Generation != connection.Generation() {
		t.Fatalf("heartbeat acknowledgement = %+v", heartbeat)
	}
	if err := connection.Close(); err != nil {
		t.Fatalf("close first connection: %v", err)
	}

	resumed := connectTestClient(t, client)
	if resumed.Generation() != 2 {
		t.Fatalf("replacement gateway generation = %d, want 2", resumed.Generation())
	}
	resumeCursors := resumed.ResumeCursors()
	if len(resumeCursors) != 1 || resumeCursors[0].SessionID != command.SessionID || resumeCursors[0].RunID != runID || resumeCursors[0].Value != "event_cursor_2" {
		t.Fatalf("replacement resume cursors = %+v", resumeCursors)
	}

	if err := hosts.NewService(db.Pool()).RevokeCredential(ctx, registration.Credential.ID); err != nil {
		t.Fatalf("RevokeCredential() error = %v", err)
	}
	if _, err := server.SendCommand(ctx, registration.Host.ID, command); !errors.Is(err, hosts.ErrConnectionStale) {
		t.Fatalf("SendCommand() after revoke error = %v, want ErrConnectionStale", err)
	}
	if err := resumed.SendHeartbeatForStream(ctx, command.SessionID, runID, "event_cursor_3"); err != nil {
		t.Fatalf("heartbeat after revoke write error = %v", err)
	}
	staleMessage := readGatewayMessage(t, resumed)
	if staleMessage.Type != MessageError || staleMessage.Error == nil || staleMessage.Error.Code != "stale_generation" {
		t.Fatalf("revoked connection error message = %+v", staleMessage)
	}
	_ = resumed.Close()
	if _, err := client.Connect(ctx); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("revoked reconnect error = %v, want HTTP 401", err)
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	if _, err := client.Connect(shutdownCtx); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("connection during drain error = %v, want HTTP 503", err)
	}
}

func TestGatewayWithPostgresTLSWSSRejectsNonPositiveEventSequence(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openGatewayDatabase(t, ctx)
	service := hosts.NewService(db.Pool())
	registration, err := service.Register(ctx, hosts.RegisterRequest{
		Name: "h01 gateway event sequence " + time.Now().UTC().Format("20060102T150405.000000000"),
	})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	handlerCalls := 0
	server, err := NewServer(service, ServerOptions{
		EventHandler: func(context.Context, hosts.Connection, protocol.Event) error {
			handlerCalls++
			return nil
		},
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client, err := NewClient(ClientOptions{
		URL:        strings.Replace(httpServer.URL, "https://", "wss://", 1),
		HostID:     registration.Host.ID,
		Token:      registration.Token,
		HTTPClient: httpServer.Client(),
	})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	positiveConnection := connectTestClient(t, client)
	positiveRunID := "run_positive_sequence"
	positiveEvent := protocol.Event{
		Cursor:     "cursor_positive_sequence",
		EventID:    "event_positive_sequence",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:    json.RawMessage(`{"delta":"positive"}`),
		RunID:      &positiveRunID,
		Sequence:   1,
		SessionID:  "session_positive_sequence",
		Source:     protocol.EventSourceHostObservation,
		Type:       protocol.EventTypeMessageDelta,
	}
	if err := positiveConnection.SendEvent(ctx, positiveEvent); err != nil {
		t.Fatalf("SendEvent(positive) error = %v", err)
	}
	if err := positiveConnection.SendHeartbeat(ctx, ""); err != nil {
		t.Fatalf("SendHeartbeat(after positive event) error = %v", err)
	}
	positiveAck := readGatewayMessage(t, positiveConnection)
	if positiveAck.Type != MessageHeartbeatAck {
		t.Fatalf("positive event heartbeat acknowledgement = %+v, want heartbeat_ack", positiveAck)
	}
	if err := positiveConnection.Close(); err != nil {
		t.Fatalf("close positive sequence connection: %v", err)
	}

	for _, sequence := range []int64{0, -1} {
		connection := connectTestClient(t, client)
		event := protocol.Event{
			Cursor:     fmt.Sprintf("cursor_invalid_sequence_%d", sequence),
			EventID:    fmt.Sprintf("event_invalid_sequence_%d", sequence),
			OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
			Payload:    json.RawMessage(`{"delta":"invalid"}`),
			Sequence:   sequence,
			SessionID:  fmt.Sprintf("session_invalid_sequence_%d", sequence),
			Source:     protocol.EventSourceHostObservation,
			Type:       protocol.EventTypeMessageDelta,
		}
		data, err := json.Marshal(Message{Type: MessageEvent, Event: &event})
		if err != nil {
			t.Fatalf("marshal event(sequence=%d) error = %v", sequence, err)
		}
		if err := connection.ws.Write(ctx, websocket.MessageText, data); err != nil {
			t.Fatalf("write event(sequence=%d) error = %v", sequence, err)
		}
		readCtx, readCancel := context.WithTimeout(ctx, 2*time.Second)
		_, readErr := connection.Read(readCtx)
		readCancel()
		if readErr == nil {
			t.Fatalf("sequence=%d was accepted, want gateway connection rejection", sequence)
		}
		_ = connection.Close()

		var cursorCount int
		if err := db.Pool().QueryRow(ctx, `
			SELECT COUNT(*) FROM host_cursors
			WHERE host_id = $1 AND session_id = $2
		`, registration.Host.ID, event.SessionID).Scan(&cursorCount); err != nil {
			t.Fatalf("count rejected sequence=%d cursor rows: %v", sequence, err)
		}
		if cursorCount != 0 {
			t.Fatalf("sequence=%d persisted %d cursor rows, want 0", sequence, cursorCount)
		}
	}
	if handlerCalls != 1 {
		t.Fatalf("event handler calls = %d, want only the positive event", handlerCalls)
	}

	var positiveCursorCount int
	if err := db.Pool().QueryRow(ctx, `
		SELECT COUNT(*) FROM host_cursors
		WHERE host_id = $1 AND session_id = $2 AND run_id = $3 AND cursor = $4
	`, registration.Host.ID, positiveEvent.SessionID, positiveRunID, positiveEvent.Cursor).Scan(&positiveCursorCount); err != nil {
		t.Fatalf("count positive event cursor rows: %v", err)
	}
	if positiveCursorCount != 1 {
		t.Fatalf("positive event cursor rows = %d, want 1", positiveCursorCount)
	}
}

func TestGatewayWithPostgresTLSWSSDrain(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openGatewayDatabase(t, ctx)
	registration, err := hosts.NewService(db.Pool()).Register(ctx, hosts.RegisterRequest{
		Name: "h01 gateway drain " + time.Now().UTC().Format("20060102T150405.000000000"),
	})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	server, err := NewServer(hosts.NewService(db.Pool()), ServerOptions{
		EventHandler: func(context.Context, hosts.Connection, protocol.Event) error { return nil },
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client, err := NewClient(ClientOptions{
		URL:        strings.Replace(httpServer.URL, "https://", "wss://", 1),
		HostID:     registration.Host.ID,
		Token:      registration.Token,
		HTTPClient: httpServer.Client(),
	})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	connection := connectTestClient(t, client)

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	if _, err := client.Connect(shutdownCtx); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("connection during drain error = %v, want HTTP 503", err)
	}
	_ = connection.Close()
}

func TestGatewayWithPostgresTLSWSSRejectsRecoveryFrameOverflow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openGatewayDatabase(t, ctx)
	service := hosts.NewService(db.Pool())
	registration, err := service.Register(ctx, hosts.RegisterRequest{
		Name: "h01 gateway frame limit " + time.Now().UTC().Format("20060102T150405.000000000"),
	})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	const maxFrameBytes = 512
	server, err := NewServer(service, ServerOptions{MaxFrameBytes: maxFrameBytes})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client, err := NewClient(ClientOptions{
		URL:           strings.Replace(httpServer.URL, "https://", "wss://", 1),
		HostID:        registration.Host.ID,
		Token:         registration.Token,
		HTTPClient:    httpServer.Client(),
		MaxFrameBytes: maxFrameBytes * 8,
	})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	connection, err := client.Connect(ctx)
	if err != nil {
		t.Fatalf("initial Client.Connect() error = %v", err)
	}
	defer connection.Close()
	now := time.Now().UTC()
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO host_cursors (host_id, session_id, run_id, cursor, observed_at, cursor_retained_until)
		VALUES ($1, 'frame_session', '', $2, $3, $4)
	`, registration.Host.ID, strings.Repeat("v", 700), now, now.Add(time.Hour)); err != nil {
		t.Fatalf("seed frame-overflow cursor: %v", err)
	}
	if _, err := client.Connect(ctx); err == nil {
		t.Fatal("Client.Connect() accepted a hello acknowledgement above the configured frame limit")
	}
	if err := connection.SendHeartbeat(ctx, ""); err != nil {
		t.Fatalf("active connection heartbeat error = %v", err)
	}
	heartbeat := readGatewayMessage(t, connection)
	if heartbeat.Type != MessageHeartbeatAck || heartbeat.Generation != connection.Generation() {
		t.Fatalf("active connection heartbeat acknowledgement = %+v, want generation %d", heartbeat, connection.Generation())
	}
	var active bool
	if err := db.Pool().QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM host_connections WHERE host_id = $1)`, registration.Host.ID).Scan(&active); err != nil {
		t.Fatalf("check active gateway connection: %v", err)
	}
	if !active {
		t.Fatal("frame-overflow handshake removed the existing active host connection")
	}
	var generation int64
	if err := db.Pool().QueryRow(ctx, `SELECT connection_generation FROM host_registrations WHERE id = $1`, registration.Host.ID).Scan(&generation); err != nil {
		t.Fatalf("read active gateway generation: %v", err)
	}
	if generation != connection.Generation() {
		t.Fatalf("generation after rejected frame-overflow handshake = %d, want %d", generation, connection.Generation())
	}
}

func openGatewayDatabase(t *testing.T, ctx context.Context) *database.DB {
	t.Helper()
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
			t.Skip("LOOMHELM_DATABASE_URL is not set")
		}
		t.Fatalf("load database config: %v", err)
	}
	admin, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 1})
	if err != nil {
		t.Fatalf("open database admin connection: %v", err)
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		admin.Close()
		t.Fatalf("generate test schema name: %v", err)
	}
	schema := "gateway_test_" + hex.EncodeToString(suffix)
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Pool().Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		admin.Close()
		t.Fatalf("create owned gateway test schema: %v", err)
	}
	var db *database.DB
	t.Cleanup(func() {
		if db != nil {
			db.Close()
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Pool().Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop owned gateway test schema: %v", err)
		}
		admin.Close()
	})
	databaseURL, err := databaseURLWithSearchPath(config.URL, schema)
	if err != nil {
		t.Fatalf("build isolated database URL: %v", err)
	}
	db, err = database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("open isolated database: %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		t.Fatalf("migrate isolated database: %v", err)
	}
	var currentSchema string
	if err := db.Pool().QueryRow(ctx, "SELECT current_schema()").Scan(&currentSchema); err != nil {
		db.Close()
		t.Fatalf("read isolated database schema: %v", err)
	}
	if currentSchema != schema {
		db.Close()
		t.Fatalf("database schema = %q, want %q", currentSchema, schema)
	}
	return db
}

func databaseURLWithSearchPath(rawURL, schema string) (string, error) {
	if strings.Contains(rawURL, "://") {
		parsed, err := url.Parse(rawURL)
		if err != nil {
			return "", err
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		return parsed.String(), nil
	}
	return strings.TrimSpace(rawURL) + " search_path=" + schema, nil
}
