package app

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

func TestConnectorAuthenticatedGatewayLifecycle(t *testing.T) {
	registry := newConnectorGatewayRegistry()
	server, err := gateway.NewServer(registry)
	if err != nil {
		t.Fatalf("gateway.NewServer() error = %v", err)
	}
	tlsServer := httptest.NewTLSServer(server)
	t.Cleanup(tlsServer.Close)

	journalDir := t.TempDir()
	if err := os.Chmod(journalDir, 0o700); err != nil {
		t.Fatalf("secure connector journal directory: %v", err)
	}
	cfg := platform.Config{
		Component:                 platform.ComponentConnector,
		Version:                   "test",
		ShutdownTimeout:           time.Second,
		ConnectorServerURL:        tlsServer.URL,
		ConnectorHostID:           registry.credential.HostID,
		ConnectorToken:            registry.token,
		ConnectorJournalPath:      filepath.Join(journalDir, "connector.jsonl"),
		ConnectorAppServerCommand: "/bin/true",
	}
	connector, err := NewConnector(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("NewConnector() error = %v", err)
	}
	platformURL, err := connectorGatewayURL(cfg.ConnectorServerURL)
	if err != nil {
		t.Fatalf("connectorGatewayURL() error = %v", err)
	}
	connector.platform, err = gateway.NewClient(gateway.ClientOptions{
		URL:        platformURL,
		HostID:     cfg.ConnectorHostID,
		Token:      cfg.ConnectorToken,
		HTTPClient: tlsServer.Client(),
	})
	if err != nil {
		t.Fatalf("gateway.NewClient() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- connector.Run(ctx) }()
	select {
	case <-registry.authenticated:
	case <-time.After(2 * time.Second):
		t.Fatal("Connector did not authenticate with the platform gateway")
	}
	waitForConnectorConnection(t, connector)
	cancel()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("Connector.Run() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Connector did not stop after context cancellation")
	}
	select {
	case <-registry.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("platform gateway did not observe Connector close")
	}
	if snapshot := connector.Lifecycle(); snapshot.State != platform.StateStopped {
		t.Fatalf("Connector lifecycle = %+v, want stopped", snapshot)
	}
}

type connectorGatewayRegistry struct {
	mu            sync.Mutex
	credential    hosts.Credential
	token         string
	generation    int64
	current       *hosts.Connection
	authenticated chan struct{}
	closed        chan struct{}
	authOnce      sync.Once
	closeOnce     sync.Once
}

func newConnectorGatewayRegistry() *connectorGatewayRegistry {
	return &connectorGatewayRegistry{
		credential:    hosts.Credential{ID: "credential-test", HostID: "host-test", Name: "connector"},
		token:         "token-test",
		authenticated: make(chan struct{}),
		closed:        make(chan struct{}),
	}
}

func (r *connectorGatewayRegistry) Authenticate(_ context.Context, token string) (hosts.Credential, error) {
	if token != r.token {
		return hosts.Credential{}, hosts.ErrUnauthenticated
	}
	r.authOnce.Do(func() { close(r.authenticated) })
	return r.credential, nil
}

func (r *connectorGatewayRegistry) OpenConnection(ctx context.Context, credential hosts.Credential) (hosts.Connection, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if credential.ID != r.credential.ID || credential.HostID != r.credential.HostID {
		return hosts.Connection{}, hosts.ErrCredentialRevoked
	}
	r.generation++
	connection := hosts.Connection{HostID: credential.HostID, CredentialID: credential.ID, Generation: r.generation}
	r.current = &connection
	return connection, nil
}

func (r *connectorGatewayRegistry) OpenConnectionWithPreflight(ctx context.Context, credential hosts.Credential, preflight hosts.ConnectionPreflight) (hosts.Connection, error) {
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

func (r *connectorGatewayRegistry) Touch(_ context.Context, connection hosts.Connection) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.matchesLocked(connection) {
		return hosts.ErrConnectionStale
	}
	return nil
}

func (r *connectorGatewayRegistry) Checkpoint(_ context.Context, connection hosts.Connection, _ hosts.Cursor) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.matchesLocked(connection) {
		return hosts.ErrConnectionStale
	}
	return nil
}

func (r *connectorGatewayRegistry) AuthorizeCommand(_ context.Context, connection hosts.Connection, deliver func() error) error {
	r.mu.Lock()
	valid := r.matchesLocked(connection)
	r.mu.Unlock()
	if !valid {
		return hosts.ErrConnectionStale
	}
	return deliver()
}

func (r *connectorGatewayRegistry) ProcessEvent(ctx context.Context, connection hosts.Connection, _ hosts.Cursor, handler func(context.Context) error) error {
	r.mu.Lock()
	valid := r.matchesLocked(connection)
	r.mu.Unlock()
	if !valid {
		return hosts.ErrConnectionStale
	}
	if handler != nil {
		return handler(ctx)
	}
	return nil
}

func (r *connectorGatewayRegistry) CloseConnection(_ context.Context, connection hosts.Connection) error {
	r.mu.Lock()
	if r.current != nil && sameConnectorConnection(*r.current, connection) {
		r.current = nil
	}
	r.mu.Unlock()
	r.closeOnce.Do(func() { close(r.closed) })
	return nil
}

func (r *connectorGatewayRegistry) matchesLocked(connection hosts.Connection) bool {
	return r.current != nil && sameConnectorConnection(*r.current, connection)
}

func sameConnectorConnection(left, right hosts.Connection) bool {
	return left.HostID == right.HostID && left.CredentialID == right.CredentialID && left.Generation == right.Generation
}

func waitForConnectorConnection(t *testing.T, connector *Connector) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		connector.connectionMu.Lock()
		connected := connector.connection != nil
		connector.connectionMu.Unlock()
		if connected {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("Connector did not retain the authenticated gateway connection")
}

var _ gateway.Registry = (*connectorGatewayRegistry)(nil)
