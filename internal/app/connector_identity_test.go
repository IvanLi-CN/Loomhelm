package app

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	connectorruntime "github.com/IvanLi-CN/Loomhelm/internal/connector"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestConnectorIdentityMapsPlatformCommandsToNativeIdentity(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()

	connector := &Connector{journal: journal}
	gatewaySession := protocol.GatewaySession{
		Handle:     "gateway-1",
		Generation: "generation-1",
	}
	adapterSession := protocol.AdapterSession{SessionID: "adapter-1", ExternalThreadRef: "thread-1"}
	if err := connector.BindSessionIdentity("platform-session-1", "create-1", gatewaySession, adapterSession); err != nil {
		t.Fatal(err)
	}

	platformRunID := "platform-run-1"
	command := protocol.Command{
		CommandID: "run-1",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"hello"}`),
		RunID:     &platformRunID,
		SessionID: "platform-session-1",
	}
	if binding, err := connector.BeginRunIdentity(command); err != nil || binding.State != connectorruntime.IdentityStateUnknown {
		t.Fatalf("begin run identity = %+v, error = %v", binding, err)
	}
	prepared, err := connector.PreparePlatformCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.SessionID != adapterSession.SessionID || prepared.RunID != nil {
		t.Fatalf("prepared initial command = %+v, want adapter session and no native run id", prepared)
	}

	nativeOperationID := "generation-1\x00rpc-1"
	if err := connector.ObserveCommandIdentity(command, protocol.CommandAck{OperationID: &nativeOperationID}); err != nil {
		t.Fatal(err)
	}
	pending, ok := journal.RunBinding(command.SessionID, platformRunID)
	if !ok || pending.State != connectorruntime.IdentityStatePending || pending.NativeOperationID != nativeOperationID {
		t.Fatalf("pending run identity = %+v, found = %v", pending, ok)
	}
	interrupt := command
	interrupt.CommandID = "interrupt-before-bound"
	interrupt.Kind = protocol.CommandKindRunInterrupt
	interrupt.Payload = json.RawMessage(`{"reason":"stop"}`)
	if _, err := connector.PreparePlatformCommand(interrupt); !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("pending control preparation error = %v, want unknown result", err)
	}

	nativeTurnID := "native-turn-1"
	if err := connector.ObserveCommandIdentity(command, protocol.CommandAck{RunID: &nativeTurnID, OperationID: &nativeOperationID}); err != nil {
		t.Fatal(err)
	}
	bound, ok := journal.RunBinding(command.SessionID, platformRunID)
	if !ok || bound.State != connectorruntime.IdentityStateBound || bound.NativeTurnID != nativeTurnID {
		t.Fatalf("bound run identity = %+v, found = %v", bound, ok)
	}

	interrupt = command
	interrupt.CommandID = "interrupt-1"
	interrupt.Kind = protocol.CommandKindRunInterrupt
	interrupt.Payload = json.RawMessage(`{"reason":"stop"}`)
	prepared, err = connector.PreparePlatformCommand(interrupt)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.SessionID != adapterSession.SessionID || prepared.RunID == nil || *prepared.RunID != nativeTurnID {
		t.Fatalf("prepared interrupt = %+v, want native turn identity", prepared)
	}
	controlOperationID := "generation-1\x00rpc-interrupt"
	if err := connector.ObserveCommandIdentity(interrupt, protocol.CommandAck{RunID: &nativeTurnID, OperationID: &controlOperationID}); err != nil {
		t.Fatal(err)
	}

	conflicting := interrupt
	conflicting.Payload = json.RawMessage(`{"turn_id":"another-native-turn"}`)
	if _, err := connector.PreparePlatformCommand(conflicting); !errors.Is(err, connectorruntime.ErrIdentityConflict) {
		t.Fatalf("conflicting native target error = %v, want identity conflict", err)
	}
}

func TestConnectorIdentityRejectsMismatchedRecoveryAndGatewayThread(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()

	connector := &Connector{journal: journal}
	alias := connectorruntime.SessionAlias{
		PlatformSessionID: "platform-session-recovery",
		AdapterSessionID:  "adapter-recovery",
		ExternalThreadRef: "thread-recovery",
		Generation:        "generation-old",
		CommandID:         "create-recovery",
	}
	if err := journal.RecordSessionAlias(alias); err != nil {
		t.Fatal(err)
	}
	if err := connector.BindSessionIdentity(alias.PlatformSessionID, alias.CommandID, protocol.GatewaySession{
		Generation:        alias.Generation,
		ExternalThreadRef: "different-thread",
	}, protocol.AdapterSession{SessionID: alias.AdapterSessionID, ExternalThreadRef: alias.ExternalThreadRef}); !errors.Is(err, connectorruntime.ErrIdentityConflict) {
		t.Fatalf("gateway thread mismatch error = %v, want identity conflict", err)
	}
	if err := validateRecoveredSessionIdentity(alias, protocol.GatewaySession{
		Generation:        "generation-new",
		ExternalThreadRef: alias.ExternalThreadRef,
	}, protocol.AdapterSession{SessionID: alias.AdapterSessionID, ExternalThreadRef: alias.ExternalThreadRef}); !errors.Is(err, connectorruntime.ErrIdentityConflict) {
		t.Fatalf("recovery generation mismatch error = %v, want identity conflict", err)
	}
}

func openConnectorIdentityJournal(t *testing.T) *connectorruntime.Journal {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "journal")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	journal, err := connectorruntime.OpenJournal(filepath.Join(directory, "connector.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return journal
}
