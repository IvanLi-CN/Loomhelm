package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestRealPlatformC01ConnectorClosure(t *testing.T) {
	if os.Getenv("LOOMHELM_REAL_PLATFORM_C01") != "1" {
		t.Skip("set LOOMHELM_REAL_PLATFORM_C01=1 to run the real platform Connector acceptance")
	}
	cli := strings.TrimSpace(os.Getenv("LOOMHELM_REAL_CODEX_CLI"))
	if cli == "" {
		t.Fatal("LOOMHELM_REAL_CODEX_CLI is required for the real platform Connector acceptance")
	}
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Fatal("LOOMHELM_DATABASE_URL is required for the real platform Connector acceptance")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	serverConfig := platform.Config{
		Component:        platform.ComponentServer,
		Version:          "real-platform-c01",
		DrainToken:       "real-platform-c01-drain",
		ShutdownTimeout:  10 * time.Second,
		StartupTimeout:   30 * time.Second,
		DatabaseURL:      databaseURL,
		DatabaseMaxConns: 8,
		BrowserAuth: platform.BrowserAuthConfig{
			OIDCIssuerURL: issuer.URL,
			OIDCClientID:  "loomhelm-test",
			SecureCookies: false,
		},
	}
	baseURL, stopServer := startApplicationTLSTestServer(t, serverConfig)

	persistence, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 8})
	if err != nil {
		t.Fatalf("open acceptance persistence: %v", err)
	}
	t.Cleanup(persistence.Close)
	hostRegistration, err := hosts.NewService(persistence.Pool()).Register(ctx, hosts.RegisterRequest{
		Name:           "h01 real platform C01",
		CredentialName: "real-platform-c01",
	})
	if err != nil {
		t.Fatalf("register acceptance host: %v", err)
	}

	workspace := t.TempDir()
	journalDir := filepath.Join(workspace, "journal")
	if err := os.Mkdir(journalDir, 0o700); err != nil {
		t.Fatalf("create secure connector journal directory: %v", err)
	}
	journalPath := filepath.Join(journalDir, "connector.jsonl")
	appServerArgs, appServerEnv := realC01AppServerOptions(t)
	connectorConfig := platform.Config{
		Component:                 platform.ComponentConnector,
		Version:                   "real-platform-c01",
		ShutdownTimeout:           10 * time.Second,
		ConnectorServerURL:        baseURL,
		ConnectorHostID:           hostRegistration.Host.ID,
		ConnectorToken:            hostRegistration.Token,
		ConnectorJournalPath:      journalPath,
		ConnectorAppServerCommand: cli,
		ConnectorAppServerArgs:    appServerArgs,
		ConnectorAppServerEnv:     appServerEnv,
		ConnectorWorkingDir:       workspace,
	}
	newConnector := func() (*Connector, error) {
		connector, connectorErr := NewConnector(connectorConfig, platform.NewLogger(os.Stderr, connectorConfig.Component, connectorConfig.Version))
		if connectorErr != nil {
			return nil, connectorErr
		}
		platformURL, urlErr := connectorGatewayURL(baseURL)
		if urlErr != nil {
			return nil, urlErr
		}
		connector.platform, connectorErr = gateway.NewClient(gateway.ClientOptions{
			URL:        platformURL,
			HostID:     hostRegistration.Host.ID,
			Token:      hostRegistration.Token,
			HTTPClient: insecureTestHTTPClient(),
		})
		if connectorErr != nil {
			return nil, connectorErr
		}
		return connector, nil
	}
	startConnector := func() (*Connector, context.CancelFunc, <-chan error) {
		connector, connectorErr := newConnector()
		if connectorErr != nil {
			t.Fatal(connectorErr)
		}
		connectorCtx, connectorCancel := context.WithCancel(ctx)
		result := make(chan error, 1)
		go func() { result <- connector.Run(connectorCtx) }()
		waitForConnectorConnectionWithin(t, connector, 15*time.Second)
		return connector, connectorCancel, result
	}
	stopConnector := func(connectorCancel context.CancelFunc, result <-chan error) {
		connectorCancel()
		select {
		case connectorErr := <-result:
			if connectorErr != nil {
				t.Fatalf("stop real Connector: %v", connectorErr)
			}
		case <-time.After(20 * time.Second):
			t.Fatal("real Connector did not stop")
		}
	}

	_, connectorCancel, connectorResult := startConnector()
	connectorStopped := false
	t.Cleanup(func() {
		if !connectorStopped {
			stopConnector(connectorCancel, connectorResult)
		}
		stopServer()
	})

	browser := applicationBrowser(t)
	browser.Timeout = 3 * time.Minute
	browser.Transport = insecureTestHTTPClient().Transport
	loginApplicationBrowser(t, browser, baseURL, "real-platform-c01")
	createResponse := applicationRequest(t, browser, http.MethodPost, baseURL+"/api/v1/sessions", protocol.CreateSessionRequest{
		CommandID: "real-platform-c01-session",
		Path:      protocol.SessionPathNew,
	}, map[string]string{"Origin": baseURL}, http.StatusCreated)
	var created protocol.SessionResponse
	decodeApplicationResponse(t, createResponse, &created)
	if created.Session.ID == "" || created.Session.ExternalThreadRef == "" || created.Session.State != protocol.SessionStateActive {
		t.Fatalf("real session creation result = %+v", created.Session)
	}

	approveRun := submitRealPlatformRun(t, browser, baseURL, created.Session.ID, "real-platform-c01-approve", "Run exactly this harmless command in the test workspace: /usr/bin/printf LOOMHELM_PLATFORM_C01_APPROVED. Do not use any other tool. After it completes, reply exactly LOOMHELM_PLATFORM_C01_APPROVE_OK.")
	approveApproval := waitForRealPlatformApproval(t, ctx, browser, baseURL, approveRun)
	resolveRealPlatformApproval(t, ctx, browser, baseURL, approveRun, approveApproval, protocol.ApprovalDecisionApprove, "real-platform-c01-approve-decision")
	waitForRealPlatformEvent(t, ctx, browser, baseURL, approveRun, protocol.EventTypeRunCompleted)

	denyRun := submitRealPlatformRun(t, browser, baseURL, created.Session.ID, "real-platform-c01-deny", "Run exactly this harmless command in the test workspace: /usr/bin/printf LOOMHELM_PLATFORM_C01_DENIED. Do not use any other tool. After it completes, reply exactly LOOMHELM_PLATFORM_C01_DENY_OK.")
	denyApproval := waitForRealPlatformApproval(t, ctx, browser, baseURL, denyRun)
	resolveRealPlatformApproval(t, ctx, browser, baseURL, denyRun, denyApproval, protocol.ApprovalDecisionDeny, "real-platform-c01-deny-decision")
	waitForRealPlatformEvent(t, ctx, browser, baseURL, denyRun, protocol.EventTypeRunCompleted)

	interruptRun := submitRealPlatformRun(t, browser, baseURL, created.Session.ID, "real-platform-c01-interrupt", "Run exactly this harmless command in the test workspace: /bin/sleep 30. Do not use any other tool. After it completes, reply exactly LOOMHELM_PLATFORM_C01_INTERRUPT_OK.")
	interruptApproval := waitForRealPlatformApproval(t, ctx, browser, baseURL, interruptRun)
	resolveRealPlatformApproval(t, ctx, browser, baseURL, interruptRun, interruptApproval, protocol.ApprovalDecisionApprove, "real-platform-c01-interrupt-approval")
	waitForRealPlatformEvent(t, ctx, browser, baseURL, interruptRun, protocol.EventTypeItemStarted)
	interruptResponse := applicationRequest(t, browser, http.MethodPost, baseURL+"/api/v1/runs/"+interruptRun+"/interrupt", protocol.InterruptRunRequest{
		CommandID: "real-platform-c01-interrupt-command",
	}, map[string]string{"Origin": baseURL}, http.StatusOK, http.StatusConflict)
	if interruptResponse.StatusCode == http.StatusConflict {
		var failure protocol.ApiError
		decodeApplicationResponse(t, interruptResponse, &failure)
		if failure.Code != protocol.ErrorCodeUnknownResult || failure.RequestID == "" {
			t.Fatalf("platform interrupt conflict error = %+v", failure)
		}
		t.Logf("platform interrupt outcome is explicitly unknown; continuing to observe run %s", interruptRun)
	} else {
		var interruptAck protocol.CommandAckResponse
		decodeApplicationResponse(t, interruptResponse, &interruptAck)
		if interruptAck.Ack.State != protocol.CommandStateSucceeded {
			t.Fatalf("platform interrupt ACK = %+v", interruptAck.Ack)
		}
	}
	waitForRealPlatformEvent(t, ctx, browser, baseURL, interruptRun, protocol.EventTypeRunInterrupted)

	stopConnector(connectorCancel, connectorResult)
	connectorStopped = true
	stopServer()
	baseURL, stopServer = startApplicationTLSTestServer(t, serverConfig)
	connectorConfig.ConnectorServerURL = baseURL
	_, connectorCancel, connectorResult = startConnector()
	connectorStopped = false
	loginApplicationBrowser(t, browser, baseURL, "real-platform-c01")
	assertRealPlatformApprovalReadable(t, browser, baseURL, approveRun, approveApproval, protocol.ApprovalStatusApproved)
	assertRealPlatformApprovalReadable(t, browser, baseURL, denyRun, denyApproval, protocol.ApprovalStatusDenied)
	assertRealPlatformApprovalReadable(t, browser, baseURL, interruptRun, interruptApproval, protocol.ApprovalStatusApproved)
	recoveredRun := submitRealPlatformRun(t, browser, baseURL, created.Session.ID, "real-platform-c01-recovered", "Reply exactly LOOMHELM_PLATFORM_C01_RECOVERED_OK and do not use tools.")
	waitForRealPlatformEvent(t, ctx, browser, baseURL, recoveredRun, protocol.EventTypeRunCompleted)
	t.Logf("real platform Connector closure passed: session=%s approve=%s deny=%s interrupt=%s recovered=%s", created.Session.ID, approveRun, denyRun, interruptRun, recoveredRun)
}

func realC01AppServerOptions(t *testing.T) ([]string, []string) {
	t.Helper()
	switch strings.TrimSpace(os.Getenv("LOOMHELM_REAL_CODEX_PROVIDER")) {
	case "":
		return nil, nil
	case "dzw":
		apiKey, ok := os.LookupEnv("DZW_API_KEY")
		if !ok || strings.TrimSpace(apiKey) == "" {
			t.Fatal("DZW_API_KEY is required when LOOMHELM_REAL_CODEX_PROVIDER=dzw")
		}
		return []string{
			"app-server",
			"-c", "model_provider=dzw",
			"-c", "model_providers.dzw.name=OpenAI",
			"-c", "model_providers.dzw.base_url=https://ai.dzw.io/v1",
			"-c", "model_providers.dzw.wire_api=responses",
			"-c", "model_providers.dzw.env_key=DZW_API_KEY",
			"-c", "model_providers.dzw.requires_openai_auth=true",
			"-c", "model_providers.dzw.supports_websockets=false",
			"--listen", "stdio://",
		}, []string{"DZW_API_KEY=" + apiKey}
	default:
		t.Fatalf("unsupported LOOMHELM_REAL_CODEX_PROVIDER")
		return nil, nil
	}
}

func submitRealPlatformRun(t *testing.T, browser *http.Client, baseURL, sessionID, commandID, prompt string) string {
	t.Helper()
	body, err := json.Marshal(protocol.SubmitRunRequest{
		CommandID: commandID,
		Prompt:    prompt,
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, baseURL+"/api/v1/sessions/"+sessionID+"/runs", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", baseURL)
	response, err := browser.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	responseBody, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		var failure protocol.ApiError
		_ = json.Unmarshal(responseBody, &failure)
		t.Fatalf("submit platform run returned %d: code=%q message=%q", response.StatusCode, failure.Code, failure.Message)
	}
	var result protocol.CommandAckResponse
	if err := json.Unmarshal(responseBody, &result); err != nil {
		t.Fatal(err)
	}
	if result.Ack.State != protocol.CommandStateSucceeded || result.Ack.RunID == nil || strings.TrimSpace(*result.Ack.RunID) == "" {
		t.Fatalf("platform run ACK = %+v", result.Ack)
	}
	return *result.Ack.RunID
}

func waitForRealPlatformApproval(t *testing.T, ctx context.Context, browser *http.Client, baseURL, runID string) protocol.Approval {
	t.Helper()
	event := waitForRealPlatformEvent(t, ctx, browser, baseURL, runID, protocol.EventTypeApprovalRequested)
	var native struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(event.Payload, &native); err != nil {
		t.Fatalf("decode raw platform approval event: %v; payload=%s", err, event.Payload)
	}
	if native.Method != "item/commandExecution/requestApproval" && native.Method != "item/fileChange/requestApproval" {
		t.Fatalf("raw platform approval event method = %q; payload=%s", native.Method, event.Payload)
	}
	if len(native.Params) == 0 || !json.Valid(native.Params) {
		t.Fatalf("raw platform approval event params are not valid JSON: %s", event.Payload)
	}
	return waitForRealPlatformApprovalRecord(t, ctx, browser, baseURL, runID, event)
}

func waitForRealPlatformApprovalRecord(t *testing.T, ctx context.Context, browser *http.Client, baseURL, runID string, event protocol.Event) protocol.Approval {
	t.Helper()
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		response := applicationRequest(t, browser, http.MethodGet, baseURL+"/api/v1/runs/"+runID+"/approvals?limit=200", nil, nil, http.StatusOK)
		var page protocol.ApprovalListResponse
		decodeApplicationResponse(t, response, &page)
		for _, approval := range page.Items {
			if approval.RunID != runID || approval.RequestedEventID == nil || *approval.RequestedEventID != event.EventID {
				continue
			}
			if approval.ID == "" || approval.Revision <= 0 || len(approval.Context) == 0 || !json.Valid(approval.Context) {
				t.Fatalf("platform approval public record is incomplete: %+v", approval)
			}
			return approval
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-deadline.C:
			t.Fatalf("run %q approval list did not link event %q", runID, event.EventID)
		case <-ticker.C:
		}
	}
}

func assertRealPlatformApprovalReadable(t *testing.T, browser *http.Client, baseURL, runID string, want protocol.Approval, wantStatus protocol.ApprovalStatus) {
	t.Helper()
	response := applicationRequest(t, browser, http.MethodGet, baseURL+"/api/v1/runs/"+runID+"/approvals?limit=200", nil, nil, http.StatusOK)
	var page protocol.ApprovalListResponse
	decodeApplicationResponse(t, response, &page)
	for _, approval := range page.Items {
		if approval.ID == want.ID {
			if approval.Status != wantStatus {
				t.Fatalf("reconnected approval %q status = %q, want %q", approval.ID, approval.Status, wantStatus)
			}
			if approval.Revision != want.Revision || approval.RunID != want.RunID || string(approval.Context) != string(want.Context) || approval.RequestedEventID == nil || want.RequestedEventID == nil || *approval.RequestedEventID != *want.RequestedEventID {
				t.Fatalf("reconnected approval changed: got %+v want %+v", approval, want)
			}
			return
		}
	}
	t.Fatalf("reconnected approval %q was not returned", want.ID)
}

func resolveRealPlatformApproval(t *testing.T, ctx context.Context, browser *http.Client, baseURL, runID string, approval protocol.Approval, decision protocol.ApprovalDecision, commandID string) {
	t.Helper()
	wantStatus := protocol.ApprovalStatusApproved
	if decision == protocol.ApprovalDecisionDeny {
		wantStatus = protocol.ApprovalStatusDenied
	}
	response := applicationRequest(t, browser, http.MethodPost, baseURL+"/api/v1/runs/"+runID+"/approvals/"+approval.ID, protocol.ResolveApprovalRequest{
		CommandID: commandID,
		Decision:  decision,
		Revision:  approval.Revision,
	}, map[string]string{"Origin": baseURL}, http.StatusOK, http.StatusConflict)
	if response.StatusCode == http.StatusConflict {
		var failure protocol.ApiError
		decodeApplicationResponse(t, response, &failure)
		if failure.Code != protocol.ErrorCodeUnknownResult || failure.RequestID == "" {
			t.Fatalf("platform approval %q conflict error = %+v", decision, failure)
		}
		t.Logf("platform approval %q outcome is explicitly unknown; continuing to observe run %s", decision, runID)
	} else {
		var result protocol.CommandAckResponse
		decodeApplicationResponse(t, response, &result)
		if result.Ack.State != protocol.CommandStateSucceeded {
			t.Fatalf("platform approval %q ACK = %+v", decision, result.Ack)
		}
	}
	waitForRealPlatformApprovalStatus(t, ctx, browser, baseURL, runID, approval.ID, wantStatus)
}

func waitForRealPlatformApprovalStatus(t *testing.T, ctx context.Context, browser *http.Client, baseURL, runID, approvalID string, want protocol.ApprovalStatus) {
	t.Helper()
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		response := applicationRequest(t, browser, http.MethodGet, baseURL+"/api/v1/runs/"+runID+"/approvals?limit=200", nil, nil, http.StatusOK)
		var page protocol.ApprovalListResponse
		decodeApplicationResponse(t, response, &page)
		for _, approval := range page.Items {
			if approval.ID != approvalID {
				continue
			}
			if approval.Status == want {
				return
			}
			if approval.Status != protocol.ApprovalStatusPending {
				t.Fatalf("platform approval %q status = %q, want %q", approvalID, approval.Status, want)
			}
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-deadline.C:
			t.Fatalf("platform approval %q did not reach status %q", approvalID, want)
		case <-ticker.C:
		}
	}
}

func waitForRealPlatformEvent(t *testing.T, ctx context.Context, browser *http.Client, baseURL, runID string, want protocol.EventType) protocol.Event {
	t.Helper()
	deadline := time.NewTimer(3 * time.Minute)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		response := applicationRequest(t, browser, http.MethodGet, baseURL+"/api/v1/runs/"+runID+"/events?limit=1000", nil, nil, http.StatusOK)
		var page protocol.EventPage
		decodeApplicationResponse(t, response, &page)
		for _, event := range page.Events {
			if event.Type == want {
				return event
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-deadline.C:
			t.Fatalf("run %q did not produce platform event %q", runID, want)
		case <-ticker.C:
		}
	}
}
