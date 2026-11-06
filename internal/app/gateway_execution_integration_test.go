package app

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/drafts"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestServerGatewayRunControlTLSWSSRoundTrip(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	cfg := platform.Config{
		Component:        platform.ComponentServer,
		Version:          "gateway-integration",
		DrainToken:       "test-drain",
		ShutdownTimeout:  5 * time.Second,
		StartupTimeout:   30 * time.Second,
		DatabaseURL:      databaseURL,
		DatabaseMaxConns: 8,
		BrowserAuth: platform.BrowserAuthConfig{
			OIDCIssuerURL: issuer.URL,
			OIDCClientID:  "loomhelm-test",
			SecureCookies: false,
		},
	}
	baseURL, stop := startApplicationTLSTestServer(t, cfg)
	defer stop()

	alice := applicationBrowser(t)
	alice.Transport = insecureTestHTTPClient().Transport
	loginApplicationBrowser(t, alice, baseURL, "gateway-alice")
	var identity struct {
		UserID string `json:"user_id"`
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &identity)
	if identity.UserID == "" {
		t.Fatal("authenticated fixture omitted user id")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	persistence, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 8})
	if err != nil {
		t.Fatalf("open fixture persistence: %v", err)
	}
	t.Cleanup(persistence.Close)
	hostRegistration, err := hosts.NewService(persistence.Pool()).RegisterForUser(ctx, identity.UserID, hosts.RegisterRequest{
		Name:           "h01 app gateway integration",
		CredentialName: "connector-fixture",
	})
	if err != nil {
		t.Fatalf("register fixture host: %v", err)
	}
	sessionStore := sessions.NewStore(persistence.Pool())
	const sessionID = "session_gateway_round_trip"
	if _, err := sessionStore.CreateIntent(ctx, sessions.CreationIntentInput{
		SessionID:     sessionID,
		CommandID:     "create_gateway_round_trip",
		CreatorUserID: identity.UserID,
		HostID:        hostRegistration.Host.ID,
		Path:          protocol.SessionPathNew,
		Parameters:    []byte(`{"prompt":"fixture"}`),
		Summary:       "gateway round trip fixture",
	}); err != nil {
		t.Fatalf("create confirmed-session intent: %v", err)
	}
	if _, err := sessionStore.ActivateIntent(ctx, sessions.ActivationInput{
		SessionID:           sessionID,
		ExternalThreadRef:   "thread_gateway_round_trip",
		ExecutionGeneration: "execution-generation-1",
	}); err != nil {
		t.Fatalf("activate confirmed session: %v", err)
	}

	client, err := gateway.NewClient(gateway.ClientOptions{
		URL:        strings.Replace(baseURL, "https://", "wss://", 1) + connectorGatewayPath,
		HostID:     hostRegistration.Host.ID,
		Token:      hostRegistration.Token,
		HTTPClient: insecureTestHTTPClient(),
	})
	if err != nil {
		t.Fatalf("create gateway client: %v", err)
	}
	connection, err := client.Connect(ctx)
	if err != nil {
		t.Fatalf("connect fixture gateway: %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })

	commandResponse := make(chan struct {
		response *http.Response
		err      error
	}, 1)
	go func() {
		body, marshalErr := json.Marshal(protocol.SubmitRunRequest{CommandID: "run_gateway_round_trip", Prompt: "fixture run"})
		if marshalErr != nil {
			commandResponse <- struct {
				response *http.Response
				err      error
			}{err: marshalErr}
			return
		}
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/v1/sessions/"+sessionID+"/runs", strings.NewReader(string(body)))
		if requestErr != nil {
			commandResponse <- struct {
				response *http.Response
				err      error
			}{err: requestErr}
			return
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", baseURL)
		response, requestErr := alice.Do(request)
		commandResponse <- struct {
			response *http.Response
			err      error
		}{response: response, err: requestErr}
	}()

	commandMessage, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read REST-submitted command over WSS: %v", err)
	}
	if commandMessage.Type != gateway.MessageCommand || commandMessage.Command == nil {
		t.Fatalf("gateway command message = %+v", commandMessage)
	}
	command := *commandMessage.Command
	if command.CommandID != "run_gateway_round_trip" || command.RunID == nil || *command.RunID == "turn-external-1" {
		t.Fatalf("gateway command identity = %+v", command)
	}
	if err := connection.AcknowledgeForSession(ctx, command.SessionID, commandMessage.RequestID, protocol.CommandAck{
		CommandID:  command.CommandID,
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateAccepted,
	}); err != nil {
		t.Fatalf("acknowledge gateway command: %v", err)
	}
	result := <-commandResponse
	if result.err != nil {
		t.Fatalf("submit run request: %v", result.err)
	}
	defer result.response.Body.Close()
	if result.response.StatusCode != http.StatusOK {
		t.Fatalf("submit run status = %d, want %d", result.response.StatusCode, http.StatusOK)
	}
	var ackResponse protocol.CommandAckResponse
	if err := json.NewDecoder(result.response.Body).Decode(&ackResponse); err != nil {
		t.Fatalf("decode submit run response: %v", err)
	}
	if ackResponse.Ack.CommandID != command.CommandID || ackResponse.Ack.RunID == nil || *ackResponse.Ack.RunID != *command.RunID {
		t.Fatalf("submit run ack = %+v, command = %+v", ackResponse.Ack, command)
	}

	firstEvent := protocol.Event{
		Cursor:     "gateway-cursor-1",
		EventID:    "gateway-event-1",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:    json.RawMessage(`{"turn_id":"turn-external-1","unknown":{"preserve":true}}`),
		RunID:      command.RunID,
		Sequence:   1,
		SessionID:  sessionID,
		Source:     protocol.EventSourceHostObservation,
		Type:       protocol.EventTypeRunStarted,
	}
	if err := connection.SendEvent(ctx, firstEvent); err != nil {
		t.Fatalf("send run event: %v", err)
	}
	waitForGatewayRun(t, ctx, persistence.Pool(), *command.RunID, protocol.RunStatusRunning)

	approvalID := "approval_gateway_round_trip"
	approvalEvent := protocol.Event{
		Cursor:     "gateway-cursor-2",
		EventID:    "gateway-event-2",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:    json.RawMessage(`{"approval_id":"approval_gateway_round_trip","kind":"command","summary":"Approve fixture","revision":1,"context":{"unknown":true},"future_field":"preserve"}`),
		RunID:      command.RunID,
		Sequence:   2,
		SessionID:  sessionID,
		Source:     protocol.EventSourceHostObservation,
		Type:       protocol.EventTypeApprovalRequested,
	}
	if err := connection.SendEvent(ctx, approvalEvent); err != nil {
		t.Fatalf("send approval event: %v", err)
	}
	waitForGatewayRun(t, ctx, persistence.Pool(), *command.RunID, protocol.RunStatusWaitingApproval)
	waitForGatewayApproval(t, ctx, persistence.Pool(), approvalID)

	pageResponse := applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/runs/"+*command.RunID+"/events", nil, nil, http.StatusOK)
	var page protocol.EventPage
	decodeApplicationResponse(t, pageResponse, &page)
	if len(page.Events) != 2 || string(page.Events[0].Payload) != string(firstEvent.Payload) || string(page.Events[1].Payload) != string(approvalEvent.Payload) {
		t.Fatalf("persisted event page = %+v", page)
	}
	if page.Events[0].RunID == nil || *page.Events[0].RunID != *command.RunID {
		t.Fatalf("persisted event run identity = %+v", page.Events[0])
	}
}

func TestServerSessionCreationTLSWSSRoundTrip(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	cfg := platform.Config{
		Component:        platform.ComponentServer,
		Version:          "session-creation-integration",
		DrainToken:       "session-creation-test-drain",
		ShutdownTimeout:  5 * time.Second,
		StartupTimeout:   30 * time.Second,
		DatabaseURL:      databaseURL,
		DatabaseMaxConns: 8,
		BrowserAuth: platform.BrowserAuthConfig{
			OIDCIssuerURL: issuer.URL,
			OIDCClientID:  "loomhelm-test",
			SecureCookies: false,
		},
	}
	baseURL, stop := startApplicationTLSTestServer(t, cfg)
	defer stop()
	alice := applicationBrowser(t)
	alice.Transport = insecureTestHTTPClient().Transport
	loginApplicationBrowser(t, alice, baseURL, "session-creation-alice")
	var identity protocol.BrowserSessionResponse
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &identity)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	persistence, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 8})
	if err != nil {
		t.Fatalf("open fixture persistence: %v", err)
	}
	t.Cleanup(persistence.Close)
	hostRegistration, err := hosts.NewService(persistence.Pool()).RegisterForUser(ctx, identity.UserID, hosts.RegisterRequest{
		Name:           "h01 session creation integration",
		CredentialName: "session-creation-fixture",
	})
	if err != nil {
		t.Fatalf("register fixture host: %v", err)
	}
	client, err := gateway.NewClient(gateway.ClientOptions{
		URL:        strings.Replace(baseURL, "https://", "wss://", 1) + connectorGatewayPath,
		HostID:     hostRegistration.Host.ID,
		Token:      hostRegistration.Token,
		HTTPClient: insecureTestHTTPClient(),
	})
	if err != nil {
		t.Fatalf("create gateway client: %v", err)
	}
	connection, err := client.Connect(ctx)
	if err != nil {
		t.Fatalf("connect fixture gateway: %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })

	prompt := "run through the normal durable path"
	createRequest := protocol.CreateSessionRequest{CommandID: "create-session-round-trip", Path: protocol.SessionPathNew, Prompt: &prompt}
	responseCh := make(chan struct {
		response *http.Response
		err      error
	}, 1)
	go func() {
		body, marshalErr := json.Marshal(createRequest)
		if marshalErr != nil {
			responseCh <- struct {
				response *http.Response
				err      error
			}{err: marshalErr}
			return
		}
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/v1/sessions", strings.NewReader(string(body)))
		if requestErr != nil {
			responseCh <- struct {
				response *http.Response
				err      error
			}{err: requestErr}
			return
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", baseURL)
		response, requestErr := alice.Do(request)
		responseCh <- struct {
			response *http.Response
			err      error
		}{response: response, err: requestErr}
	}()

	startMessage, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read session creation command: %v", err)
	}
	if startMessage.Type != gateway.MessageCommand || startMessage.Command == nil {
		t.Fatalf("session creation gateway message = %+v", startMessage)
	}
	startCommand := *startMessage.Command
	if startCommand.Kind != protocol.CommandKindSessionStart || startCommand.CommandID != createRequest.CommandID || startCommand.SessionID == "" {
		t.Fatalf("session creation command = %+v", startCommand)
	}
	var forwardedRequest protocol.CreateSessionRequest
	if err := json.Unmarshal(startCommand.Payload, &forwardedRequest); err != nil {
		t.Fatalf("decode forwarded session request: %v", err)
	}
	if forwardedRequest.Prompt == nil || *forwardedRequest.Prompt != prompt {
		t.Fatalf("forwarded session prompt = %+v", forwardedRequest.Prompt)
	}
	ack := protocol.CommandAck{
		CommandID:  startCommand.CommandID,
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateSucceeded,
		Result:     json.RawMessage(`{"external_thread_ref":"thread-session-round-trip","generation":"execution-session-round-trip"}`),
	}
	executionTransport := &gatewayExecutionTransport{sessions: sessions.NewStore(persistence.Pool()), runs: runs.NewStore(persistence.Pool())}
	if err := executionTransport.HandleCommandAck(ctx, hosts.Connection{HostID: hostRegistration.Host.ID}, "", "", ack); err == nil {
		t.Fatal("session creation ACK without a platform session scope was accepted")
	}
	if err := executionTransport.HandleCommandAck(ctx, hosts.Connection{HostID: hostRegistration.Host.ID}, "", startCommand.SessionID, ack); err != nil {
		t.Fatalf("exactly scoped session creation ACK rejected: %v", err)
	}
	if err := connection.AcknowledgeForSession(ctx, startCommand.SessionID, startMessage.RequestID, ack); err != nil {
		t.Fatalf("acknowledge session creation command: %v", err)
	}

	runMessage, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read durable initial run command: %v", err)
	}
	if runMessage.Command == nil || runMessage.Command.Kind != protocol.CommandKindRunSend || runMessage.Command.CommandID != initialRunCommandID(startCommand.SessionID) || runMessage.Command.RunID == nil {
		t.Fatalf("initial run command = %+v", runMessage.Command)
	}
	if err := connection.AcknowledgeForSession(ctx, runMessage.Command.SessionID, runMessage.RequestID, protocol.CommandAck{
		CommandID:  runMessage.Command.CommandID,
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateAccepted,
	}); err != nil {
		t.Fatalf("acknowledge initial run command: %v", err)
	}
	result := <-responseCh
	if result.err != nil {
		t.Fatalf("create session request: %v", result.err)
	}
	defer result.response.Body.Close()
	if result.response.StatusCode != http.StatusCreated {
		t.Fatalf("create session status = %d, want %d", result.response.StatusCode, http.StatusCreated)
	}
	var created protocol.SessionResponse
	if err := json.NewDecoder(result.response.Body).Decode(&created); err != nil {
		t.Fatalf("decode created session response: %v", err)
	}
	if created.Session.ID != startCommand.SessionID || created.Session.ExternalThreadRef != "thread-session-round-trip" || created.Session.State != protocol.SessionStateActive {
		t.Fatalf("created session = %+v", created.Session)
	}
	store := sessions.NewStore(persistence.Pool())
	access, err := store.GetAccess(ctx, created.Session.ID)
	if err != nil {
		t.Fatalf("read activated session access: %v", err)
	}
	if !access.Confirmed || access.CreatorUserID != identity.UserID || access.HostID != hostRegistration.Host.ID {
		t.Fatalf("activated session access = %+v", access)
	}

	var retry protocol.SessionResponse
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/sessions", createRequest, map[string]string{"Origin": baseURL}, http.StatusCreated), &retry)
	if retry.Session != created.Session {
		t.Fatalf("idempotent session retry = %+v, first = %+v", retry.Session, created.Session)
	}
	conflict := createRequest
	otherPrompt := "changed payload"
	conflict.Prompt = &otherPrompt
	conflictResponse := applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/sessions", conflict, map[string]string{"Origin": baseURL}, http.StatusConflict)
	var conflictError protocol.ApiError
	decodeApplicationResponse(t, conflictResponse, &conflictError)
	if conflictError.Code != protocol.ErrorCodeIdempotencyConflict {
		t.Fatalf("creation conflict code = %q", conflictError.Code)
	}

	postSession := func(request protocol.CreateSessionRequest) <-chan struct {
		response *http.Response
		err      error
	} {
		resultCh := make(chan struct {
			response *http.Response
			err      error
		}, 1)
		go func() {
			body, marshalErr := json.Marshal(request)
			if marshalErr != nil {
				resultCh <- struct {
					response *http.Response
					err      error
				}{err: marshalErr}
				return
			}
			httpRequest, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/v1/sessions", strings.NewReader(string(body)))
			if requestErr != nil {
				resultCh <- struct {
					response *http.Response
					err      error
				}{err: requestErr}
				return
			}
			httpRequest.Header.Set("Content-Type", "application/json")
			httpRequest.Header.Set("Origin", baseURL)
			response, requestErr := alice.Do(httpRequest)
			resultCh <- struct {
				response *http.Response
				err      error
			}{response: response, err: requestErr}
		}()
		return resultCh
	}
	unknownRequest := protocol.CreateSessionRequest{CommandID: "create-session-unknown", Path: protocol.SessionPathNew}
	unknownResultCh := postSession(unknownRequest)
	unknownMessage, err := connection.Read(ctx)
	if err != nil || unknownMessage.Command == nil || unknownMessage.Command.CommandID != unknownRequest.CommandID {
		t.Fatalf("read unknown session command: message=%+v error=%v", unknownMessage, err)
	}
	if err := connection.AcknowledgeForSession(ctx, unknownMessage.Command.SessionID, unknownMessage.RequestID, protocol.CommandAck{
		CommandID:  unknownRequest.CommandID,
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateUnknown,
	}); err != nil {
		t.Fatalf("acknowledge unknown session command: %v", err)
	}
	unknownResult := <-unknownResultCh
	if unknownResult.err != nil {
		t.Fatalf("unknown session request: %v", unknownResult.err)
	}
	if unknownResult.response.StatusCode != http.StatusConflict {
		t.Fatalf("unknown session status = %d, want %d", unknownResult.response.StatusCode, http.StatusConflict)
	}
	unknownResult.response.Body.Close()
	var unknownSessionID string
	if err := persistence.Pool().QueryRow(ctx, `SELECT id FROM execution_sessions WHERE creation_command_id = $1`, unknownRequest.CommandID).Scan(&unknownSessionID); err != nil {
		t.Fatalf("find unknown creation intent: %v", err)
	}
	unknownAccess, err := store.GetAccess(ctx, unknownSessionID)
	if err != nil || unknownAccess.IntentState != sessions.IntentStateUnknown || unknownAccess.Confirmed {
		t.Fatalf("unknown creation access = %+v, error = %v", unknownAccess, err)
	}

	lostRequest := protocol.CreateSessionRequest{CommandID: "create-session-ack-loss", Path: protocol.SessionPathNew}
	lostResultCh := postSession(lostRequest)
	lostMessage, err := connection.Read(ctx)
	if err != nil || lostMessage.Command == nil || lostMessage.Command.CommandID != lostRequest.CommandID {
		t.Fatalf("read ACK-loss session command: message=%+v error=%v", lostMessage, err)
	}
	if err := connection.Close(); err != nil {
		t.Fatalf("close gateway during ACK-loss simulation: %v", err)
	}
	lostResult := <-lostResultCh
	if lostResult.err != nil {
		t.Fatalf("ACK-loss session request: %v", lostResult.err)
	}
	if lostResult.response.StatusCode != http.StatusConflict {
		t.Fatalf("ACK-loss session status = %d, want %d", lostResult.response.StatusCode, http.StatusConflict)
	}
	lostResult.response.Body.Close()
	var lostSessionID string
	if err := persistence.Pool().QueryRow(ctx, `SELECT id FROM execution_sessions WHERE creation_command_id = $1`, lostRequest.CommandID).Scan(&lostSessionID); err != nil {
		t.Fatalf("find ACK-loss creation intent: %v", err)
	}
	lostAccess, err := store.GetAccess(ctx, lostSessionID)
	if err != nil || lostAccess.IntentState != sessions.IntentStateUnknown || lostAccess.Confirmed {
		t.Fatalf("ACK-loss creation access = %+v, error = %v", lostAccess, err)
	}

	retryClient, err := gateway.NewClient(gateway.ClientOptions{
		URL:        strings.Replace(baseURL, "https://", "wss://", 1) + connectorGatewayPath,
		HostID:     hostRegistration.Host.ID,
		Token:      hostRegistration.Token,
		HTTPClient: insecureTestHTTPClient(),
	})
	if err != nil {
		t.Fatalf("create retry gateway client: %v", err)
	}
	retryConnection, err := retryClient.Connect(ctx)
	if err != nil {
		t.Fatalf("reconnect fixture gateway: %v", err)
	}
	t.Cleanup(func() { _ = retryConnection.Close() })
	retryResultCh := postSession(lostRequest)
	retryMessage, err := retryConnection.Read(ctx)
	if err != nil || retryMessage.Command == nil || retryMessage.Command.CommandID != lostRequest.CommandID {
		t.Fatalf("read retried session command: message=%+v error=%v", retryMessage, err)
	}
	if retryMessage.Command.SessionID != lostSessionID {
		t.Fatalf("retried session id = %q, want original %q", retryMessage.Command.SessionID, lostSessionID)
	}
	if err := retryConnection.AcknowledgeForSession(ctx, retryMessage.Command.SessionID, retryMessage.RequestID, protocol.CommandAck{
		CommandID:  retryMessage.Command.CommandID,
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateSucceeded,
		Result:     json.RawMessage(`{"external_thread_ref":"thread-session-recovered","generation":"execution-session-recovered"}`),
	}); err != nil {
		t.Fatalf("acknowledge retried session command: %v", err)
	}
	retryResult := <-retryResultCh
	if retryResult.err != nil {
		t.Fatalf("retried session request: %v", retryResult.err)
	}
	defer retryResult.response.Body.Close()
	if retryResult.response.StatusCode != http.StatusCreated {
		t.Fatalf("retried session status = %d, want %d", retryResult.response.StatusCode, http.StatusCreated)
	}
	var recovered protocol.SessionResponse
	if err := json.NewDecoder(retryResult.response.Body).Decode(&recovered); err != nil {
		t.Fatalf("decode recovered session response: %v", err)
	}
	if recovered.Session.ID != lostSessionID || recovered.Session.ExternalThreadRef != "thread-session-recovered" || recovered.Session.State != protocol.SessionStateActive {
		t.Fatalf("recovered session = %+v", recovered.Session)
	}
	var sessionCount int
	if err := persistence.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM execution_sessions WHERE creation_command_id = $1`, lostRequest.CommandID).Scan(&sessionCount); err != nil {
		t.Fatalf("count retried session intents: %v", err)
	}
	if sessionCount != 1 {
		t.Fatalf("retried session intent count = %d, want 1", sessionCount)
	}
}

func TestGatewayLateSessionCreationFailurePersistsDefiniteMarker(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	persistence, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("open fixture persistence: %v", err)
	}
	t.Cleanup(persistence.Close)
	hostRegistration, err := hosts.NewService(persistence.Pool()).Register(ctx, hosts.RegisterRequest{
		Name:           "h01 late session failure ACK",
		CredentialName: "late-session-failure-ack-fixture",
	})
	if err != nil {
		t.Fatalf("register fixture host: %v", err)
	}
	store := sessions.NewStore(persistence.Pool())
	transport := &gatewayExecutionTransport{sessions: store, runs: runs.NewStore(persistence.Pool())}
	if _, err := persistence.Pool().Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject)
		VALUES ('user-late-session-failure', 'https://issuer.example.test', 'subject-late-session-failure')
	`); err != nil {
		t.Fatalf("create late failure ACK user: %v", err)
	}

	for _, state := range []protocol.CommandState{protocol.CommandStateFailed, protocol.CommandStateRejected} {
		t.Run(string(state), func(t *testing.T) {
			suffix := string(state)
			sessionID := "session_late_failure_" + suffix
			commandID := "create_late_failure_" + suffix
			if _, err := store.CreateIntent(ctx, sessions.CreationIntentInput{
				SessionID:     sessionID,
				CommandID:     commandID,
				CreatorUserID: "user-late-session-failure",
				HostID:        hostRegistration.Host.ID,
				Path:          protocol.SessionPathNew,
				Parameters:    []byte(`{"prompt":"late failure"}`),
				Summary:       "late failure ACK fixture",
			}); err != nil {
				t.Fatalf("create session intent: %v", err)
			}
			if err := transport.HandleCommandAck(ctx, hosts.Connection{HostID: hostRegistration.Host.ID}, "", sessionID, protocol.CommandAck{
				CommandID:  commandID,
				ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
				State:      state,
			}); err != nil {
				t.Fatalf("handle late %s ACK: %v", state, err)
			}
			intent, err := store.GetIntent(ctx, sessionID)
			if err != nil {
				t.Fatalf("read late %s ACK intent: %v", state, err)
			}
			wantReason := "definite_failure:" + string(state)
			if intent.State != sessions.IntentStatePending || intent.UnknownReason != wantReason {
				t.Fatalf("late %s ACK intent = %+v, want pending marker %q", state, intent, wantReason)
			}
		})
	}
}

func TestGatewayCommandAckFinalizesDraftAndFencesUnknown(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	persistence, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("open fixture persistence: %v", err)
	}
	t.Cleanup(persistence.Close)
	hostRegistration, err := hosts.NewService(persistence.Pool()).Register(ctx, hosts.RegisterRequest{
		Name:           "h01 draft ACK finalization",
		CredentialName: "draft-ack-finalization-fixture",
	})
	if err != nil {
		t.Fatalf("register fixture host: %v", err)
	}
	const (
		userID    = "user-draft-ack-finalization"
		sessionID = "session-draft-ack-finalization"
		commandID = "command-draft-ack-finalization"
		runID     = "run-draft-ack-finalization"
	)
	if _, err := persistence.Pool().Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject)
		VALUES ($1, 'https://issuer.example.test', $1)
	`, userID); err != nil {
		t.Fatalf("create draft ACK user: %v", err)
	}
	sessionStore := sessions.NewStore(persistence.Pool())
	if _, err := sessionStore.CreateIntent(ctx, sessions.CreationIntentInput{
		SessionID:     sessionID,
		CommandID:     "create-" + sessionID,
		CreatorUserID: userID,
		HostID:        hostRegistration.Host.ID,
		Path:          protocol.SessionPathNew,
		Parameters:    []byte(`{"prompt":"draft ACK"}`),
		Summary:       "draft ACK finalization fixture",
	}); err != nil {
		t.Fatalf("create draft ACK session intent: %v", err)
	}
	if _, err := sessionStore.ActivateIntent(ctx, sessions.ActivationInput{
		SessionID:           sessionID,
		ExternalThreadRef:   "thread-" + sessionID,
		ExecutionGeneration: "generation-" + sessionID,
	}); err != nil {
		t.Fatalf("activate draft ACK session: %v", err)
	}
	draftStore := drafts.NewStore(persistence.Pool())
	draft, err := draftStore.Apply(ctx, drafts.UpdateInput{
		SessionID:      sessionID,
		OwnerUserID:    userID,
		MutationID:     "mutation-" + sessionID,
		ClientID:       "desktop",
		ClientSequence: 1,
		Content:        "draft ACK content",
	})
	if err != nil {
		t.Fatalf("create draft ACK draft: %v", err)
	}
	runStore := runs.NewStore(persistence.Pool())
	command := protocol.Command{
		CommandID: commandID,
		IssuedAt:  "2026-10-30T00:00:04Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"draft ACK content"}`),
		RunID:     stringPointer(runID),
		SessionID: sessionID,
	}
	_, _, err = runStore.AcceptRunWithMutation(ctx, runs.CommandIntent{Command: command, Generation: "generation-" + sessionID}, runs.NewRunInput{
		ID:         runID,
		SessionID:  sessionID,
		CommandID:  commandID,
		Generation: "generation-" + sessionID,
	}, func(mutationCtx context.Context, tx pgx.Tx, _ runs.AcceptResult) error {
		return draftStore.PrepareCommandTx(mutationCtx, tx, drafts.CommandDraftInput{
			CommandID:        commandID,
			SessionID:        sessionID,
			OwnerUserID:      userID,
			ExpectedRevision: draft.Revision,
			Content:          draft.Content,
		})
	})
	if err != nil {
		t.Fatalf("accept draft ACK command: %v", err)
	}
	transport := &gatewayExecutionTransport{
		sessions:      sessionStore,
		runs:          runStore,
		draftCommands: &flakyDraftCommandLifecycle{store: draftStore, failures: 1},
	}
	ack := protocol.CommandAck{
		CommandID:  commandID,
		RunID:      stringPointer(runID),
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateExecuting,
	}
	if err := transport.HandleCommandAck(ctx, hosts.Connection{HostID: hostRegistration.Host.ID}, "", sessionID, ack); !errors.Is(err, runs.ErrDraftRecoveryRequired) {
		t.Fatalf("first draft ACK error = %v, want draft recovery error", err)
	}
	if err := transport.HandleCommandAck(ctx, hosts.Connection{HostID: hostRegistration.Host.ID}, "", sessionID, protocol.CommandAck{
		CommandID:  commandID,
		RunID:      stringPointer(runID),
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateFailed,
	}); err != nil {
		t.Fatalf("failed ACK after executing delivery = %v", err)
	}
	failedRecord, err := runStore.Lookup(ctx, sessionID, commandID)
	if err != nil {
		t.Fatalf("read failed ACK command: %v", err)
	}
	if failedRecord.State != protocol.CommandStateFailed || failedRecord.ExactAckState != protocol.CommandStateExecuting {
		t.Fatalf("failed ACK command = %+v, want failed state with executing delivery marker", failedRecord)
	}
	failedDraft, err := draftStore.Get(ctx, sessionID, userID)
	if err != nil {
		t.Fatalf("read draft after failed ACK: %v", err)
	}
	if failedDraft.Content != "" || failedDraft.Revision != draft.Revision+1 {
		t.Fatalf("draft after failed ACK = %+v, want consumed revision %d", failedDraft, draft.Revision+1)
	}
	controller, err := runs.NewController(runStore, noCallCommandTransport{}, runs.ControllerConfig{
		Generation:    "generation-" + sessionID,
		DraftCommands: transport.draftCommands,
	})
	if err != nil {
		t.Fatalf("create draft ACK recovery controller: %v", err)
	}
	if _, err := persistence.Pool().Exec(ctx, `
		UPDATE execution_commands
		SET state = 'executing', operation_id = '', result = NULL, error = NULL,
		    event_cursor = '', reconciliation_state = ''
		WHERE command_id = $1
	`, commandID); err != nil {
		t.Fatalf("simulate legacy ACK writer: %v", err)
	}
	if _, err := controller.ReconcileCommand(ctx, sessionID, commandID); err != nil {
		t.Fatalf("recover draft finalization from confirmed ACK: %v", err)
	}
	if err := transport.HandleCommandAck(ctx, hosts.Connection{HostID: hostRegistration.Host.ID}, "", sessionID, ack); err != nil {
		t.Fatalf("retry draft ACK finalization: %v", err)
	}
	current, err := draftStore.Get(ctx, sessionID, userID)
	if err != nil {
		t.Fatalf("read finalized draft: %v", err)
	}
	if current.Content != "" || current.Revision != draft.Revision+1 {
		t.Fatalf("finalized draft = %+v, want empty revision %d", current, draft.Revision+1)
	}
	record, err := runStore.Lookup(ctx, sessionID, commandID)
	if err != nil {
		t.Fatalf("read ACK command: %v", err)
	}
	if record.State != protocol.CommandStateExecuting || record.ReconciliationState != protocol.ReconciliationStateConfirmed || record.ExactAckState != protocol.CommandStateExecuting {
		t.Fatalf("ACK command = %+v, want executing confirmed", record)
	}
	if _, err := runStore.Reconcile(ctx, commandID, "generation-"+sessionID, runs.CommandObservation{
		Reconciliation: protocol.ReconciliationStateNotFound,
	}); !errors.Is(err, runs.ErrCommandFactConflict) {
		t.Fatalf("stale not-found reconciliation error = %v, want command fact conflict", err)
	}
	if _, err := runStore.MarkCommandAndRunUnknown(ctx, commandID, "generation-"+sessionID, "late send timeout"); err != nil {
		t.Fatalf("fence unknown transition after executing ACK: %v", err)
	}
	record, err = runStore.Lookup(ctx, sessionID, commandID)
	if err != nil {
		t.Fatalf("read executing fenced command: %v", err)
	}
	if record.State != protocol.CommandStateExecuting || record.ReconciliationState != protocol.ReconciliationStateConfirmed {
		t.Fatalf("executing fenced command = %+v, want executing confirmed", record)
	}
	if err := transport.HandleCommandAck(ctx, hosts.Connection{HostID: hostRegistration.Host.ID}, "", sessionID, protocol.CommandAck{
		CommandID:  commandID,
		RunID:      stringPointer(runID),
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateSucceeded,
		Result:     json.RawMessage(`{"status":"done"}`),
	}); err != nil {
		t.Fatalf("handle terminal draft ACK: %v", err)
	}
	record, err = runStore.Lookup(ctx, sessionID, commandID)
	if err != nil {
		t.Fatalf("read terminal ACK command: %v", err)
	}
	if record.State != protocol.CommandStateSucceeded || record.ReconciliationState != protocol.ReconciliationStateConfirmed {
		t.Fatalf("terminal ACK command = %+v, want succeeded confirmed", record)
	}
}

type flakyDraftCommandLifecycle struct {
	store    *drafts.Store
	failures int
}

type noCallCommandTransport struct{}

func (noCallCommandTransport) SendCommand(context.Context, protocol.Command) (protocol.CommandAck, error) {
	return protocol.CommandAck{}, errors.New("unexpected command send during confirmed ACK recovery")
}

func (noCallCommandTransport) ReconcileCommand(context.Context, protocol.Command) (protocol.Reconciliation, error) {
	return protocol.Reconciliation{}, errors.New("unexpected command reconciliation during confirmed ACK recovery")
}

func (f *flakyDraftCommandLifecycle) PrepareCommandTx(ctx context.Context, tx pgx.Tx, input drafts.CommandDraftInput) error {
	return f.store.PrepareCommandTx(ctx, tx, input)
}

func (f *flakyDraftCommandLifecycle) FinalizeCommand(ctx context.Context, commandID string, delivered bool) (drafts.CommandDraftResult, error) {
	if f.failures > 0 {
		f.failures--
		return drafts.CommandDraftResult{}, errors.New("injected draft finalization failure")
	}
	return f.store.FinalizeCommand(ctx, commandID, delivered)
}

func TestGatewayUnknownSessionCreationAckGuardsAndActivates(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	persistence, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("open fixture persistence: %v", err)
	}
	t.Cleanup(persistence.Close)
	hostRegistration, err := hosts.NewService(persistence.Pool()).Register(ctx, hosts.RegisterRequest{
		Name:           "h01 unknown session ACK guards",
		CredentialName: "unknown-session-ack-fixture",
	})
	if err != nil {
		t.Fatalf("register fixture host: %v", err)
	}
	store := sessions.NewStore(persistence.Pool())
	const sessionID = "session_unknown_ack_guards"
	const commandID = "create_unknown_ack_guards"
	if _, err := persistence.Pool().Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject)
		VALUES ('user-unknown-ack', 'https://issuer.example.test', 'subject-unknown-ack')
	`); err != nil {
		t.Fatalf("create unknown ACK user: %v", err)
	}
	if _, err := store.CreateIntent(ctx, sessions.CreationIntentInput{
		SessionID:     sessionID,
		CommandID:     commandID,
		CreatorUserID: "user-unknown-ack",
		HostID:        hostRegistration.Host.ID,
		Path:          protocol.SessionPathNew,
		Parameters:    []byte(`{}`),
		Summary:       "unknown ACK guard fixture",
	}); err != nil {
		t.Fatalf("create unknown ACK intent: %v", err)
	}
	if _, err := store.MarkIntentUnknown(ctx, sessions.UnknownIntentInput{SessionID: sessionID, Reason: "simulated lost ACK"}); err != nil {
		t.Fatalf("mark unknown ACK intent: %v", err)
	}
	transport := &gatewayExecutionTransport{sessions: store, runs: runs.NewStore(persistence.Pool())}
	ack := protocol.CommandAck{
		CommandID:  commandID,
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateSucceeded,
		Result:     json.RawMessage(`{"external_thread_ref":"thread-unknown-ack","generation":"generation-unknown-ack"}`),
	}
	connection := hosts.Connection{HostID: hostRegistration.Host.ID}
	if err := transport.HandleCommandAck(ctx, connection, "", sessionID, ack); err != nil {
		t.Fatalf("unknown session ACK rejected: %v", err)
	}
	access, err := store.GetAccess(ctx, sessionID)
	if err != nil {
		t.Fatalf("read activated unknown intent: %v", err)
	}
	if !access.Confirmed || access.IntentState != sessions.IntentStateConfirmed {
		t.Fatalf("activated unknown intent access = %+v", access)
	}
	active, err := store.Get(ctx, sessionID)
	if err != nil {
		t.Fatalf("read activated session: %v", err)
	}
	if active.ExternalThreadRef != "thread-unknown-ack" || active.Generation != "generation-unknown-ack" {
		t.Fatalf("activated session identity = %+v", active)
	}
	if err := transport.HandleCommandAck(ctx, connection, "", sessionID, ack); err != nil {
		t.Fatalf("idempotent duplicate session ACK rejected: %v", err)
	}

	if err := transport.HandleCommandAck(ctx, hosts.Connection{HostID: "wrong-host"}, "", sessionID, ack); err == nil {
		t.Fatal("wrong-host session ACK accepted")
	}
	wrongCommand := ack
	wrongCommand.CommandID = "wrong-command"
	if err := transport.HandleCommandAck(ctx, connection, "", sessionID, wrongCommand); err == nil {
		t.Fatal("wrong-command session ACK accepted")
	}
	if err := transport.HandleCommandAck(ctx, connection, "", "wrong-session", ack); err == nil {
		t.Fatal("wrong-session session ACK accepted")
	}
	wrongRun := ack
	runID := "run-must-not-be-present"
	wrongRun.RunID = &runID
	if err := transport.HandleCommandAck(ctx, connection, "", sessionID, wrongRun); err == nil {
		t.Fatal("session creation ACK with run identity accepted")
	}
}

func startApplicationTLSTestServer(t *testing.T, cfg platform.Config) (string, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	certificateServer := httptest.NewTLSServer(http.NotFoundHandler())
	certificates := append([]tls.Certificate(nil), certificateServer.TLS.Certificates...)
	certificateServer.Close()
	tlsListener := tls.NewListener(listener, &tls.Config{Certificates: certificates, MinVersion: tls.VersionTLS12})
	baseURL := "https://" + listener.Addr().String()
	cfg.HTTPAddr = listener.Addr().String()
	if cfg.BrowserAuth.OIDCEnabled() {
		cfg.BrowserAuth.OIDCRedirectURL = baseURL + "/api/v1/auth/oidc/callback"
	}
	server, err := NewServer(cfg, nil)
	if err != nil {
		_ = tlsListener.Close()
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, tlsListener) }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("stop TLS application Server: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Error("TLS application Server did not stop")
			}
		})
	}
	t.Cleanup(stop)
	deadline := time.Now().Add(35 * time.Second)
	for !server.Lifecycle().Ready {
		select {
		case err := <-done:
			cancel()
			t.Fatalf("start TLS application Server: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("TLS application Server readiness deadline exceeded")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return baseURL, stop
}

func insecureTestHTTPClient() *http.Client {
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}} // test certificate only
}

func waitForGatewayRun(t *testing.T, ctx context.Context, pool *pgxpool.Pool, runID string, want protocol.RunStatus) {
	t.Helper()
	store := runs.NewStore(pool)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		run, err := store.GetRun(ctx, runID)
		if err == nil && run.Status == want {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("run %q did not reach %q: run=%+v err=%v", runID, want, run, err)
		case <-ticker.C:
		}
	}
}

func waitForGatewayApproval(t *testing.T, ctx context.Context, pool *pgxpool.Pool, approvalID string) {
	t.Helper()
	store := approvals.NewStore(pool)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		approval, err := store.Get(ctx, approvalID)
		if err == nil && approval.Status == protocol.ApprovalStatusPending {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("approval %q was not persisted: approval=%+v err=%v", approvalID, approval, err)
		case <-ticker.C:
		}
	}
}
