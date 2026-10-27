package app

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestConnectorGatewayCommandLogOmitsPrivateFailurePath(t *testing.T) {
	registry := newConnectorGatewayRegistry()
	server, err := gateway.NewServer(registry)
	if err != nil {
		t.Fatalf("gateway.NewServer() error = %v", err)
	}
	tlsServer := httptest.NewTLSServer(server)
	t.Cleanup(tlsServer.Close)

	privatePath := filepath.Join(t.TempDir(), "private-command-secret")
	var logOutput bytes.Buffer
	connector, err := NewConnector(platform.Config{
		Component:                 platform.ComponentConnector,
		Version:                   "test",
		ShutdownTimeout:           time.Second,
		ConnectorServerURL:        tlsServer.URL,
		ConnectorHostID:           registry.credential.HostID,
		ConnectorToken:            registry.token,
		ConnectorJournalPath:      connectorTestJournalPath(t),
		ConnectorAppServerCommand: privatePath,
	}, slog.New(slog.NewTextHandler(&logOutput, nil)))
	if err != nil {
		t.Fatalf("NewConnector() error = %v", err)
	}
	platformURL, err := connectorGatewayURL(tlsServer.URL)
	if err != nil {
		t.Fatalf("connectorGatewayURL() error = %v", err)
	}
	connector.platform, err = gateway.NewClient(gateway.ClientOptions{
		URL:        platformURL,
		HostID:     registry.credential.HostID,
		Token:      registry.token,
		HTTPClient: tlsServer.Client(),
	})
	if err != nil {
		t.Fatalf("gateway.NewClient() error = %v", err)
	}
	connection, err := connector.platform.Connect(context.Background())
	if err != nil {
		t.Fatalf("connect fixture gateway: %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })

	request := protocol.CreateSessionRequest{CommandID: "session-private-log", Path: protocol.SessionPathNew}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal session command: %v", err)
	}
	command := protocol.Command{
		CommandID: request.CommandID,
		Kind:      protocol.CommandKindSessionStart,
		Payload:   payload,
		SessionID: "platform-session-private-log",
	}
	if err := connector.handleGatewayCommand(context.Background(), connection, gateway.Message{
		RequestID: "request-private-log",
		Command:   &command,
	}); err != nil {
		t.Fatalf("handleGatewayCommand() error = %v", err)
	}
	output := logOutput.String()
	if strings.Contains(output, privatePath) {
		t.Fatalf("connector log exposed private command path: %s", output)
	}
	if !strings.Contains(output, command.CommandID) || !strings.Contains(output, string(command.Kind)) || !strings.Contains(output, "error=command_rejected") {
		t.Fatalf("connector log omitted safe command context: %s", output)
	}
}
