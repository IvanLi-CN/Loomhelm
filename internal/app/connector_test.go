package app

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
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

func TestConnectorRecoveryErrorClassOmitsPrivateDetails(t *testing.T) {
	privatePath := "/private/connector/app-server-secret"
	err := fmt.Errorf("recover journal session: %w", &os.PathError{Op: "start", Path: privatePath, Err: os.ErrPermission})
	if got := connectorRecoveryErrorClass(err); got != "recovery_failed" {
		t.Fatalf("connectorRecoveryErrorClass() = %q, want recovery_failed", got)
	}
	if strings.Contains(connectorRecoveryErrorClass(err), privatePath) {
		t.Fatalf("recovery error class exposed private path: %q", connectorRecoveryErrorClass(err))
	}
	if connectorRecoveryErrorClass(errors.Join(context.Canceled, err)) != "canceled" {
		t.Fatalf("canceled recovery error class = %q, want canceled", connectorRecoveryErrorClass(errors.Join(context.Canceled, err)))
	}
}

func TestPlatformOperationIDEncodesInternalNULSeparator(t *testing.T) {
	raw := "generation-1\x00rpc-41"
	value := platformOperationID(&raw)
	if value == nil || strings.ContainsRune(*value, '\x00') || !strings.HasPrefix(*value, "loomhelm-op-") {
		t.Fatalf("platformOperationID(%q) = %v", raw, value)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(*value, "loomhelm-op-"))
	if err != nil || string(decoded) != raw {
		t.Fatalf("encoded operation id = %q, decoded = %q, error = %v", *value, decoded, err)
	}
}

func TestPlatformOperationIDKeepsSafeValue(t *testing.T) {
	raw := "rpc-41"
	value := platformOperationID(&raw)
	if value == nil || *value != raw {
		t.Fatalf("platformOperationID(%q) = %v, want original value", raw, value)
	}
}
