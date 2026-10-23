package connector

import (
	"context"
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
	if _, _, err := journal.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	ack, err := journal.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	ack.State = protocol.CommandStateSucceeded
	if err := journal.UpdateCommand(command.CommandID, ack); err != nil {
		t.Fatal(err)
	}

	reconciliation, err := controller.ReconcileCommand(context.Background(), command.CommandID)
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
