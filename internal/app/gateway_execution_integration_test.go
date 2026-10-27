package app

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
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
	hostRegistration, err := hosts.NewService(persistence.Pool()).Register(ctx, hosts.RegisterRequest{
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
	hostRegistration, err := hosts.NewService(persistence.Pool()).Register(ctx, hosts.RegisterRequest{
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
	if err := connection.AcknowledgeForSession(ctx, startCommand.SessionID, startMessage.RequestID, protocol.CommandAck{
		CommandID:  startCommand.CommandID,
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State:      protocol.CommandStateSucceeded,
		Result:     json.RawMessage(`{"external_thread_ref":"thread-session-round-trip","generation":"execution-session-round-trip"}`),
	}); err != nil {
		t.Fatalf("acknowledge session creation command: %v", err)
	}

	runMessage, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read durable initial run command: %v", err)
	}
	if runMessage.Command == nil || runMessage.Command.Kind != protocol.CommandKindRunSend || runMessage.Command.CommandID != createRequest.CommandID+":initial" || runMessage.Command.RunID == nil {
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
