package app

import (
	"context"
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

// TestRealPlatformC01InterruptOnly isolates the interrupt and restart path so
// approval accept/deny scenarios cannot consume the evidence window first.
func TestRealPlatformC01InterruptOnly(t *testing.T) {
	if os.Getenv("LOOMHELM_REAL_PLATFORM_C01_INTERRUPT_ONLY") != "1" {
		t.Skip("set LOOMHELM_REAL_PLATFORM_C01_INTERRUPT_ONLY=1 to run the focused real interrupt acceptance")
	}
	cli := strings.TrimSpace(os.Getenv("LOOMHELM_REAL_CODEX_CLI"))
	if cli == "" {
		t.Fatal("LOOMHELM_REAL_CODEX_CLI is required for the focused real interrupt acceptance")
	}
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Fatal("LOOMHELM_DATABASE_URL is required for the focused real interrupt acceptance")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	serverConfig := platform.Config{
		Component:        platform.ComponentServer,
		Version:          "real-platform-c01-interrupt-only",
		DrainToken:       "real-platform-c01-interrupt-only-drain",
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
	t.Cleanup(stopServer)

	persistence, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 8})
	if err != nil {
		t.Fatalf("open focused interrupt persistence: %v", err)
	}
	t.Cleanup(persistence.Close)
	hostRegistration, err := hosts.NewService(persistence.Pool()).Register(ctx, hosts.RegisterRequest{
		Name:           "h01 focused real interrupt",
		CredentialName: "real-platform-c01-interrupt-only",
	})
	if err != nil {
		t.Fatalf("register focused interrupt host: %v", err)
	}

	journalPath := filepath.Join(t.TempDir(), "journal", "connector.jsonl")
	connectorConfig := platform.Config{
		Component:                 platform.ComponentConnector,
		Version:                   "real-platform-c01-interrupt-only",
		ShutdownTimeout:           10 * time.Second,
		ConnectorServerURL:        baseURL,
		ConnectorHostID:           hostRegistration.Host.ID,
		ConnectorToken:            hostRegistration.Token,
		ConnectorJournalPath:      journalPath,
		ConnectorAppServerCommand: cli,
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
		connector.platform, connectorErr = gatewayClientForTest(platformURL, hostRegistration.Host.ID, hostRegistration.Token)
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
				t.Fatalf("stop focused interrupt Connector: %v", connectorErr)
			}
		case <-time.After(20 * time.Second):
			t.Fatal("focused interrupt Connector did not stop")
		}
	}

	connector, connectorCancel, connectorResult := startConnector()
	connectorStopped := false
	t.Cleanup(func() {
		if !connectorStopped {
			stopConnector(connectorCancel, connectorResult)
		}
	})

	browser := applicationBrowser(t)
	browser.Timeout = 3 * time.Minute
	browser.Transport = insecureTestHTTPClient().Transport
	loginApplicationBrowser(t, browser, baseURL, "real-platform-c01-interrupt-only")
	createResponse := applicationRequest(t, browser, http.MethodPost, baseURL+"/api/v1/sessions", protocol.CreateSessionRequest{
		CommandID: "real-platform-c01-interrupt-only-session",
		Path:      protocol.SessionPathNew,
	}, map[string]string{"Origin": baseURL}, http.StatusCreated)
	var created protocol.SessionResponse
	decodeApplicationResponse(t, createResponse, &created)
	if created.Session.ID == "" || created.Session.ExternalThreadRef == "" || created.Session.State != protocol.SessionStateActive {
		t.Fatalf("focused interrupt session creation result = %+v", created.Session)
	}

	interruptRun := submitRealPlatformRun(t, browser, baseURL, created.Session.ID, "real-platform-c01-interrupt-only-run", "Run exactly this harmless command in the test workspace: /bin/sleep 30. Do not use any other tool. After it completes, reply exactly LOOMHELM_PLATFORM_C01_INTERRUPT_ONLY_OK.")
	interruptApproval := waitForRealPlatformApproval(t, ctx, browser, baseURL, interruptRun)
	resolveRealPlatformApproval(t, browser, baseURL, interruptRun, interruptApproval, protocol.ApprovalDecisionApprove, "real-platform-c01-interrupt-only-approval")
	waitForRealPlatformEvent(t, ctx, browser, baseURL, interruptRun, protocol.EventTypeItemStarted)

	interruptResponse := applicationRequest(t, browser, http.MethodPost, baseURL+"/api/v1/runs/"+interruptRun+"/interrupt", protocol.InterruptRunRequest{
		CommandID: "real-platform-c01-interrupt-only-command",
	}, map[string]string{"Origin": baseURL}, http.StatusOK, http.StatusConflict)
	if interruptResponse.StatusCode == http.StatusConflict {
		var failure protocol.ApiError
		decodeApplicationResponse(t, interruptResponse, &failure)
		if failure.Code != protocol.ErrorCodeUnknownResult || failure.RequestID == "" {
			t.Fatalf("focused platform interrupt conflict error = %+v", failure)
		}
		t.Logf("focused platform interrupt outcome is explicitly unknown; continuing to observe run %s", interruptRun)
	} else {
		var interruptAck protocol.CommandAckResponse
		decodeApplicationResponse(t, interruptResponse, &interruptAck)
		if interruptAck.Ack.State != protocol.CommandStateSucceeded {
			t.Fatalf("focused platform interrupt ACK = %+v", interruptAck.Ack)
		}
	}
	waitForRealPlatformEvent(t, ctx, browser, baseURL, interruptRun, protocol.EventTypeRunInterrupted)

	stopConnector(connectorCancel, connectorResult)
	connectorStopped = true
	connector, connectorCancel, connectorResult = startConnector()
	connectorStopped = false
	_ = connector
	assertRealPlatformApprovalReadable(t, browser, baseURL, interruptRun, interruptApproval)
	recoveredRun := submitRealPlatformRun(t, browser, baseURL, created.Session.ID, "real-platform-c01-interrupt-only-recovered", "Reply exactly LOOMHELM_PLATFORM_C01_INTERRUPT_ONLY_RECOVERED_OK and do not use tools.")
	waitForRealPlatformEvent(t, ctx, browser, baseURL, recoveredRun, protocol.EventTypeRunCompleted)
}

func gatewayClientForTest(baseURL, hostID, token string) (*gateway.Client, error) {
	return gateway.NewClient(gateway.ClientOptions{
		URL:        baseURL,
		HostID:     hostID,
		Token:      token,
		HTTPClient: insecureTestHTTPClient(),
	})
}
