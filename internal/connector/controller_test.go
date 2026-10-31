package connector

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestControllerReturnsDurableCommandAckBeforeRequiringLiveAdapter(t *testing.T) {
	journal := openTestJournal(t)
	transport := newFakeTransport()
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	controller, err := NewController(journal, adapter)
	if err != nil {
		t.Fatal(err)
	}
	command := testCommand("controller-duplicate", `{"prompt":"already durable"}`)
	if _, _, err := journal.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	ack, err := controller.AcceptCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !ack.Deduplicated || ack.State != protocol.CommandStateAccepted {
		t.Fatalf("durable command ACK = %+v", ack)
	}
	if len(transport.calls) != 0 {
		t.Fatalf("durable duplicate reacquired the adapter: calls = %+v", transport.calls)
	}

	ack.State = protocol.CommandStateUnknown
	if err := journal.UpdateCommand(command.CommandID, ack); err != nil {
		t.Fatal(err)
	}
	unknown, err := controller.AcceptCommand(context.Background(), command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) || unknown.State != protocol.CommandStateUnknown {
		t.Fatalf("durable unknown ACK = %+v, error = %v", unknown, err)
	}
	if len(transport.calls) != 0 {
		t.Fatalf("durable unknown command reacquired the adapter: calls = %+v", transport.calls)
	}
}

func TestControllerReconcilesTerminalCommandWithoutAppServer(t *testing.T) {
	journal := openTestJournal(t)
	transport := newFakeTransport()
	adapter, err := NewCodexAdapter(fakeProvider{transport: transport}, journal)
	if err != nil {
		t.Fatal(err)
	}
	controller, err := NewController(journal, adapter)
	if err != nil {
		t.Fatal(err)
	}
	command := testCommand("controller-terminal", `{"prompt":"terminal"}`)
	if _, _, err := journal.BeginCommandInNamespace(PlatformSessionCommandNamespace(command.SessionID), command); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordSessionAlias(SessionAlias{
		PlatformSessionID: command.SessionID,
		AdapterSessionID:  command.SessionID,
		ExternalThreadRef: "thread-controller-terminal",
		Generation:        "generation-controller-terminal",
		CommandID:         command.CommandID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := journal.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	ack, err := journal.LookupCommandInNamespace(PlatformSessionCommandNamespace(command.SessionID), command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	ack.State = protocol.CommandStateSucceeded
	if err := journal.UpdateCommandInNamespace(PlatformSessionCommandNamespace(command.SessionID), command.CommandID, ack); err != nil {
		t.Fatal(err)
	}
	adapterAck, err := journal.LookupCommandInNamespace(AdapterSessionCommandNamespace(command.SessionID), command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	adapterAck.State = protocol.CommandStateSucceeded
	if err := journal.UpdateCommandInNamespace(AdapterSessionCommandNamespace(command.SessionID), command.CommandID, adapterAck); err != nil {
		t.Fatal(err)
	}

	reconciliation, err := controller.ReconcileCommand(context.Background(), command.SessionID, command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if reconciliation.State != protocol.ReconciliationStateConfirmed {
		t.Fatalf("terminal reconciliation = %+v", reconciliation)
	}
	if len(transport.calls) != 0 {
		t.Fatalf("terminal reconciliation contacted app-server: calls = %+v", transport.calls)
	}
}

func TestControllerScopesSameCommandIDByPlatformAlias(t *testing.T) {
	journal := openTestJournal(t)
	adapter, err := NewCodexAdapter(fakeProvider{transport: newFakeTransport()}, journal)
	if err != nil {
		t.Fatal(err)
	}
	controller, err := NewController(journal, adapter)
	if err != nil {
		t.Fatal(err)
	}
	aliases := []SessionAlias{
		{PlatformSessionID: "platform-a", AdapterSessionID: "adapter-a", ExternalThreadRef: "thread-a", Generation: "generation-a", CommandID: "create-a"},
		{PlatformSessionID: "platform-b", AdapterSessionID: "adapter-b", ExternalThreadRef: "thread-b", Generation: "generation-b", CommandID: "create-b"},
	}
	for _, alias := range aliases {
		if err := journal.RecordSessionAlias(alias); err != nil {
			t.Fatal(err)
		}
	}
	commandA := testCommand("shared-command", `{"prompt":"same command id"}`)
	commandA.SessionID = "adapter-a"
	commandB := commandA
	commandB.SessionID = "adapter-b"
	for _, command := range []protocol.Command{commandA, commandB} {
		ack, _, err := journal.BeginCommandInNamespace(AdapterSessionCommandNamespace(command.SessionID), command)
		if err != nil {
			t.Fatal(err)
		}
		ack.State = protocol.CommandStateSucceeded
		ack.Result = json.RawMessage(`{"session":"` + command.SessionID + `"}`)
		if err := journal.UpdateCommandInNamespace(AdapterSessionCommandNamespace(command.SessionID), command.CommandID, ack); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []struct {
		platform string
		result   string
	}{
		{platform: "platform-a", result: `{"session":"adapter-a"}`},
		{platform: "platform-b", result: `{"session":"adapter-b"}`},
	} {
		ack, err := controller.LookupCommand(context.Background(), want.platform, "shared-command")
		if err != nil {
			t.Fatal(err)
		}
		if string(ack.Result) != want.result {
			t.Fatalf("platform %s resolved ACK %s, want %s", want.platform, ack.Result, want.result)
		}
		reconciliation, err := controller.ReconcileCommand(context.Background(), want.platform, "shared-command")
		if err != nil {
			t.Fatal(err)
		}
		if reconciliation.State != protocol.ReconciliationStateConfirmed {
			t.Fatalf("platform %s reconciliation = %+v", want.platform, reconciliation)
		}
	}
}
