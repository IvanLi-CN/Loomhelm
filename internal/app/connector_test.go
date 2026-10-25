package app

import (
	"strings"
	"testing"
	"time"
)

func TestConnectorGatewayURL(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  string
		want string
		err  string
	}{
		{name: "root", raw: "https://platform.example.test", want: "wss://platform.example.test/gateway"},
		{name: "base path", raw: "https://platform.example.test/loomhelm", want: "wss://platform.example.test/loomhelm/gateway"},
		{name: "existing gateway path", raw: "https://platform.example.test/gateway", want: "wss://platform.example.test/gateway"},
		{name: "credentials", raw: "https://user:secret@platform.example.test", err: "credential-free"},
		{name: "query", raw: "https://platform.example.test?token=secret", err: "credential-free"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := connectorGatewayURL(test.raw)
			if test.err != "" {
				if err == nil || !strings.Contains(err.Error(), test.err) {
					t.Fatalf("connectorGatewayURL() error = %v, want %q", err, test.err)
				}
				return
			}
			if err != nil {
				t.Fatalf("connectorGatewayURL() error = %v", err)
			}
			if got != test.want {
				t.Fatalf("connectorGatewayURL() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestConnectorReconnectBounds(t *testing.T) {
	if got := nextConnectorRetry(connectorInitialReconnectDelay); got != 500*time.Millisecond {
		t.Fatalf("nextConnectorRetry(initial) = %s, want 500ms", got)
	}
	if got := nextConnectorRetry(4 * time.Second); got != connectorMaxReconnectDelay {
		t.Fatalf("nextConnectorRetry(4s) = %s, want %s", got, connectorMaxReconnectDelay)
	}
	if got := nextConnectorRetry(connectorMaxReconnectDelay); got != connectorMaxReconnectDelay {
		t.Fatalf("nextConnectorRetry(max) = %s, want %s", got, connectorMaxReconnectDelay)
	}
	if got := connectorDialTimeoutFor(2 * time.Second); got != 2*time.Second {
		t.Fatalf("connectorDialTimeoutFor(2s) = %s, want 2s", got)
	}
	if got := connectorDialTimeoutFor(30 * time.Second); got != connectorDialTimeout {
		t.Fatalf("connectorDialTimeoutFor(30s) = %s, want %s", got, connectorDialTimeout)
	}
}
