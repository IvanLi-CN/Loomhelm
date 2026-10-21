package connector

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestRealCodexAdapterHostOwnedNewSession(t *testing.T) {
	cli := os.Getenv("LOOMHELM_REAL_CODEX_CLI")
	if cli == "" {
		t.Skip("set LOOMHELM_REAL_CODEX_CLI to run the disposable host-owned app-server check")
	}
	workspace := t.TempDir()
	journal, err := OpenJournal(workspace + "/connector.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	gateway, err := NewGateway(GatewayConfig{Process: ProcessTransportConfig{CommandPath: cli, WorkingDir: workspace}})
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := NewCodexAdapter(gateway, journal)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	gatewaySession, err := gateway.StartNewSession(ctx, protocol.NewSessionRequest{})
	if err != nil {
		t.Fatal(err)
	}
	session, err := adapter.StartSession(ctx, gatewaySession, protocol.NewSessionRequest{Prompt: "Reply with exactly LOOMHELM_C01_REAL_OK and do not use tools."})
	if err != nil {
		_ = gateway.CloseSession(context.Background(), gatewaySession)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = adapter.CloseSession(context.Background(), session)
		_ = gateway.CloseSession(context.Background(), gatewaySession)
	})
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		page, readErr := journal.ReadEvents(protocol.EventQuery{SessionID: session.SessionID, Limit: 1000})
		if readErr != nil {
			t.Fatal(readErr)
		}
		for _, event := range page.Events {
			if event.Type == protocol.EventTypeRunCompleted {
				return
			}
			if event.Type == protocol.EventTypeRunFailed {
				t.Fatalf("real adapter observed terminal failure event: %+v", event)
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("timed out waiting for real adapter run completion")
}
