package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
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

func TestConnectorArtifactPublicationThroughWSS(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	artifactRoot := t.TempDir()
	workspace := t.TempDir()
	journalDir := filepath.Join(workspace, "journal")
	if err := os.Mkdir(journalDir, 0o700); err != nil {
		t.Fatalf("create Connector journal directory: %v", err)
	}
	appServer := writeE01ArtifactAppServer(t, workspace)

	serverConfig := platform.Config{
		Component:        platform.ComponentServer,
		Version:          "e01-artifact-publication",
		DrainToken:       "e01-artifact-publication-drain",
		ShutdownTimeout:  10 * time.Second,
		StartupTimeout:   30 * time.Second,
		DatabaseURL:      databaseURL,
		DatabaseMaxConns: 8,
		ArtifactRoot:     artifactRoot,
		BrowserAuth: platform.BrowserAuthConfig{
			OIDCIssuerURL: issuer.URL,
			OIDCClientID:  "loomhelm-test",
			SecureCookies: false,
		},
	}
	baseURL, stopServer := startApplicationTLSTestServer(t, serverConfig)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	persistence, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 8})
	if err != nil {
		t.Fatalf("open integration persistence: %v", err)
	}
	defer persistence.Close()
	browser := applicationBrowser(t)
	browser.Transport = insecureTestHTTPClient().Transport
	loginApplicationBrowser(t, browser, baseURL, "e01-artifact-publication")
	var browserIdentity protocol.BrowserSessionResponse
	decodeApplicationResponse(t, applicationRequest(t, browser, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &browserIdentity)
	hostRegistration, err := hosts.NewService(persistence.Pool()).RegisterForUser(ctx, browserIdentity.UserID, hosts.RegisterRequest{
		Name:           "h01 E01 artifact publication",
		CredentialName: "e01-artifact-publication",
	})
	if err != nil {
		t.Fatalf("register integration host: %v", err)
	}

	connectorConfig := platform.Config{
		Component:                 platform.ComponentConnector,
		Version:                   "e01-artifact-publication",
		ShutdownTimeout:           10 * time.Second,
		ConnectorServerURL:        baseURL,
		ConnectorHostID:           hostRegistration.Host.ID,
		ConnectorToken:            hostRegistration.Token,
		ConnectorJournalPath:      filepath.Join(journalDir, "connector.jsonl"),
		ConnectorAppServerCommand: appServer,
		ConnectorWorkingDir:       workspace,
	}
	connector, err := NewConnector(connectorConfig, platform.NewLogger(io.Discard, connectorConfig.Component, connectorConfig.Version))
	if err != nil {
		t.Fatalf("create Connector: %v", err)
	}
	platformURL, err := connectorGatewayURL(baseURL)
	if err != nil {
		t.Fatalf("build Connector gateway URL: %v", err)
	}
	connector.platform, err = gateway.NewClient(gateway.ClientOptions{
		URL:        platformURL,
		HostID:     hostRegistration.Host.ID,
		Token:      hostRegistration.Token,
		HTTPClient: insecureTestHTTPClient(),
	})
	if err != nil {
		t.Fatalf("create Connector gateway client: %v", err)
	}
	connectorCtx, cancelConnector := context.WithCancel(ctx)
	connectorResult := make(chan error, 1)
	go func() { connectorResult <- connector.Run(connectorCtx) }()
	waitForConnectorConnectionWithin(t, connector, 15*time.Second)
	defer func() {
		cancelConnector()
		select {
		case connectorErr := <-connectorResult:
			if connectorErr != nil {
				t.Errorf("stop Connector: %v", connectorErr)
			}
		case <-time.After(20 * time.Second):
			t.Error("Connector did not stop")
		}
		stopServer()
	}()

	prompt := "publish the controlled artifact fixture"
	createResponse := applicationRequest(t, browser, http.MethodPost, baseURL+"/api/v1/sessions", protocol.CreateSessionRequest{
		CommandID: "e01-artifact-session",
		Path:      protocol.SessionPathNew,
		Prompt:    &prompt,
	}, map[string]string{"Origin": baseURL}, http.StatusCreated)
	var created protocol.SessionResponse
	decodeApplicationResponse(t, createResponse, &created)
	if created.Session.ID == "" || created.Session.State != protocol.SessionStateActive || created.InitialRunAck == nil {
		t.Fatalf("created session response = %+v", created)
	}
	if created.InitialRunAck.RunID == nil || strings.TrimSpace(*created.InitialRunAck.RunID) == "" {
		t.Fatalf("initial run ACK omitted platform run identity: %+v", created.InitialRunAck)
	}
	runID := *created.InitialRunAck.RunID

	var artifactID string
	deadline := time.NewTimer(45 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for artifactID == "" {
		var state string
		if err := persistence.Pool().QueryRow(ctx, `
			SELECT id, state
			FROM conversation_artifacts
			WHERE session_id = $1 AND run_id = $2
			ORDER BY created_at DESC
			LIMIT 1
		`, created.Session.ID, runID).Scan(&artifactID, &state); err == nil && state == "ready" {
			break
		}
		artifactID = ""
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatalf("artifact was not durably published for run %q", runID)
		case <-ctx.Done():
			t.Fatalf("artifact publication context ended: %v", ctx.Err())
		}
	}

	response := applicationRequest(t, browser, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/download", nil, nil, http.StatusOK)
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatalf("read published artifact: %v", err)
	}
	if want := []byte("E01 artifact publication bytes\n"); !bytes.Equal(body, want) {
		t.Fatalf("published artifact bytes = %q, want %q", body, want)
	}
}

func writeE01ArtifactAppServer(t *testing.T, workspace string) string {
	t.Helper()
	content := []byte("E01 artifact publication bytes\n")
	contentBase64 := base64.StdEncoding.EncodeToString(content)
	workspaceJSON, err := json.Marshal(workspace)
	if err != nil {
		t.Fatalf("encode fixture workspace: %v", err)
	}
	quote := func(value string) string {
		return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
	}
	script := fmt.Sprintf(`#!/bin/sh
set -eu
workspace_path=%s
workspace_json=%s
content_base64=%s
artifact_path="$workspace_path/artifact-e01.txt"
printf '%%s' "$content_base64" | base64 -d > "$artifact_path"
while IFS= read -r line; do
  id=$(printf '%%s\n' "$line" | sed 's/.*"id"://; s/[,}].*//')
  method=$(printf '%%s\n' "$line" | sed 's/.*"method":"//; s/".*//')
  case "$method" in
    initialize)
      printf '{"jsonrpc":"2.0","id":%%s,"result":{"userAgent":"loomhelm-e01-fixture"}}\n' "$id"
      ;;
    initialized)
      ;;
    thread/start)
      printf '{"jsonrpc":"2.0","id":%%s,"result":{"thread":{"id":"thread-e01-artifact","cwd":%%s}}}\n' "$id" "$workspace_json"
      printf '{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"thread-e01-artifact"}}}\n'
      ;;
    turn/start)
      printf '{"jsonrpc":"2.0","id":%%s,"result":{"turn":{"id":"turn-e01-artifact","status":"inProgress"}}}\n' "$id"
      printf '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-e01-artifact","turn":{"id":"turn-e01-artifact","status":"inProgress"}}}\n'
      printf '{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"thread-e01-artifact","turnId":"turn-e01-artifact","item":{"id":"item-e01-artifact","type":"fileChange","status":"completed","changes":[{"path":"artifact-e01.txt","kind":{"type":"add"},"diff":"new file"}]}}}\n'
      printf '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-e01-artifact","turn":{"id":"turn-e01-artifact","status":"completed"}}}\n'
      ;;
    fs/readFile)
      printf '{"jsonrpc":"2.0","id":%%s,"result":{"dataBase64":"%%s"}}\n' "$id" "$content_base64"
      ;;
    thread/close|turn/interrupt)
      printf '{"jsonrpc":"2.0","id":%%s,"result":{}}\n' "$id"
      ;;
    *)
      printf '{"jsonrpc":"2.0","id":%%s,"result":{}}\n' "$id"
      ;;
  esac
done
`, quote(workspace), quote(string(workspaceJSON)), quote(contentBase64))
	path := filepath.Join(workspace, "e01-app-server-fixture")
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatalf("write app-server fixture: %v", err)
	}
	return path
}
