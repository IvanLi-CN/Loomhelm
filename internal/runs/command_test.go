package runs

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestLedgerDeduplicatesCanonicalPayloadAndRejectsConflict(t *testing.T) {
	ledger := NewLedger()
	first := testIntent("cmd-1", "generation-1", `{"prompt":"hello","metadata":{"b":2,"a":1}}`)
	first.ReceivedAt = "2026-10-24T00:00:01Z"
	accepted, err := ledger.Accept(first)
	if err != nil {
		t.Fatalf("first Accept() error = %v", err)
	}
	if accepted.Deduplicated || accepted.Record.State != protocol.CommandStateAccepted {
		t.Fatalf("first accept = %+v, want a non-deduplicated accepted record", accepted)
	}
	if accepted.Record.ReceivedAt != first.ReceivedAt {
		t.Fatalf("received_at = %q, want %q", accepted.Record.ReceivedAt, first.ReceivedAt)
	}

	retry := first
	retry.Command.IssuedAt = "2026-10-24T01:02:03Z"
	retry.Command.Payload = json.RawMessage(`{"metadata":{"a":1,"b":2},"prompt":"hello"}`)
	deduplicated, err := ledger.Accept(retry)
	if err != nil {
		t.Fatalf("canonical retry error = %v", err)
	}
	if !deduplicated.Deduplicated || deduplicated.Record.Digest != accepted.Record.Digest {
		t.Fatalf("canonical retry = %+v, want the original identity", deduplicated)
	}

	conflict := first
	conflict.Command.Payload = json.RawMessage(`{"prompt":"different"}`)
	if _, err := ledger.Accept(conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("payload conflict error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}

	oldGeneration := first
	oldGeneration.Generation = "generation-2"
	if _, err := ledger.Accept(oldGeneration); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("generation reuse error = %v, want %v", err, ErrStaleGeneration)
	}
}

func TestLedgerUnknownRequiresReconciliationBeforeRetry(t *testing.T) {
	ledger := NewLedger()
	intent := testIntent("cmd-unknown", "generation-1", `{"prompt":"uncertain"}`)
	if _, err := ledger.Accept(intent); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.MarkUnknown(intent.Command.CommandID, intent.Generation); err != nil {
		t.Fatalf("MarkUnknown() error = %v", err)
	}
	unknown, err := ledger.Lookup(intent.Command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if unknown.State != protocol.CommandStateUnknown {
		t.Fatalf("unknown state = %q, want unknown", unknown.State)
	}

	if _, err := ledger.Accept(intent); err != nil {
		t.Fatalf("same unknown command should be a lookup/dedup, got %v", err)
	}
	if _, err := ledger.Transition(intent.Command.CommandID, intent.Generation, protocol.CommandStateSucceeded, "operation-1", nil, nil); !errors.Is(err, ErrCommandNotUnknown) {
		t.Fatalf("direct transition from unknown error = %v, want %v", err, ErrCommandNotUnknown)
	}
	// The direct transition is deliberately rejected; the command remains unknown.
	current, _ := ledger.Lookup(intent.Command.CommandID)
	if current.State != protocol.CommandStateUnknown {
		t.Fatalf("state after rejected direct transition = %q, want unknown", current.State)
	}

	if _, err := ledger.Reconcile(intent.Command.CommandID, "generation-old", CommandObservation{
		Reconciliation: protocol.ReconciliationStateConfirmed,
		State:          protocol.CommandStateSucceeded,
	}); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old-generation reconciliation error = %v, want %v", err, ErrStaleGeneration)
	}
	if _, err := ledger.Reconcile(intent.Command.CommandID, intent.Generation, CommandObservation{
		Reconciliation: protocol.ReconciliationStateUnknown,
	}); !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("still-unknown reconciliation error = %v, want %v", err, protocol.ErrUnknownCommandResult)
	}
	resolved, err := ledger.Reconcile(intent.Command.CommandID, intent.Generation, CommandObservation{
		Reconciliation: protocol.ReconciliationStateConfirmed,
		State:          protocol.CommandStateSucceeded,
		OperationID:    "operation-1",
		Result:         json.RawMessage(`{"ok":true}`),
	})
	if err != nil {
		t.Fatalf("confirmed reconciliation error = %v", err)
	}
	if resolved.State != protocol.CommandStateSucceeded || resolved.OperationID != "operation-1" {
		t.Fatalf("resolved record = %+v", resolved)
	}
	repeated, err := ledger.Reconcile(intent.Command.CommandID, intent.Generation, CommandObservation{Reconciliation: protocol.ReconciliationStateConfirmed, State: protocol.CommandStateSucceeded})
	if err != nil || repeated.State != protocol.CommandStateSucceeded {
		t.Fatalf("repeated reconciliation = %+v, error %v", repeated, err)
	}
}

func TestLedgerAcceptForGenerationRejectsOldNewCommand(t *testing.T) {
	intent := testIntent("cmd-old", "generation-old", `{"prompt":"old"}`)
	if _, err := NewLedger().AcceptForGeneration("generation-current", intent); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old new-command error = %v, want %v", err, ErrStaleGeneration)
	}
}

func TestLedgerConcurrentAcceptsKeepOneCommandIdentity(t *testing.T) {
	ledger := NewLedger()
	intent := testIntent("cmd-race", "generation-1", `{"prompt":"same"}`)
	const callers = 64
	results := make(chan AcceptResult, callers)
	errorsSeen := make(chan error, callers)
	var group sync.WaitGroup
	for i := 0; i < callers; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			result, err := ledger.Accept(intent)
			if err != nil {
				errorsSeen <- err
				return
			}
			results <- result
		}()
	}
	group.Wait()
	close(results)
	close(errorsSeen)
	for err := range errorsSeen {
		t.Fatalf("concurrent Accept() error = %v", err)
	}
	var first, duplicates int
	for result := range results {
		if result.Deduplicated {
			duplicates++
		} else {
			first++
		}
	}
	if first != 1 || duplicates != callers-1 {
		t.Fatalf("concurrent acceptance = first %d, duplicates %d; want 1/%d", first, duplicates, callers-1)
	}
}

func testIntent(commandID, generation, payload string) CommandIntent {
	return CommandIntent{
		Generation: generation,
		Command: protocol.Command{
			CommandID: commandID,
			IssuedAt:  "2026-10-24T00:00:00Z",
			Kind:      protocol.CommandKindRunSend,
			Payload:   json.RawMessage(payload),
			SessionID: "session-1",
		},
	}
}

func TestCommandFingerprintRejectsMultiplePayloadValues(t *testing.T) {
	intent := testIntent("cmd-invalid", "generation-1", `{"ok":true} {"again":true}`)
	if _, err := Fingerprint(intent); err == nil {
		t.Fatal("Fingerprint() accepted multiple JSON payload values")
	}
	if _, err := NewLedger().Accept(intent); !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("Accept() error = %v, want %v", err, ErrInvalidCommand)
	}
}

func TestCommandObservationNotFoundBecomesRejected(t *testing.T) {
	ledger := NewLedger()
	intent := testIntent("cmd-not-found", "generation-1", `{"prompt":"missing"}`)
	if _, err := ledger.Accept(intent); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.MarkUnknown(intent.Command.CommandID, intent.Generation); err != nil {
		t.Fatal(err)
	}
	record, err := ledger.Reconcile(intent.Command.CommandID, intent.Generation, CommandObservation{Reconciliation: protocol.ReconciliationStateNotFound})
	if err != nil {
		t.Fatal(err)
	}
	if record.State != protocol.CommandStateRejected {
		t.Fatalf("not-found record state = %q, want rejected", record.State)
	}
	if _, err := ledger.Transition(intent.Command.CommandID, intent.Generation, protocol.CommandStateExecuting, "", nil, nil); !errors.Is(err, ErrCommandTerminal) {
		t.Fatalf("rejected command transition error = %v, want terminal error", err)
	}
}

func TestCommandAckClonesMutablePayloads(t *testing.T) {
	ledger := NewLedger()
	intent := testIntent("cmd-clone", "generation-1", `{"prompt":"clone"}`)
	if _, err := ledger.Accept(intent); err != nil {
		t.Fatal(err)
	}
	result := json.RawMessage(`{"result":"ok"}`)
	if _, err := ledger.Transition(intent.Command.CommandID, intent.Generation, protocol.CommandStateSucceeded, "op", result, &protocol.ApiError{Code: protocol.ErrorCodeConflict, Details: json.RawMessage(`{"x":1}`)}); err != nil {
		t.Fatal(err)
	}
	result[2] = 'X'
	record, err := ledger.Lookup(intent.Command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if string(record.Result) != `{"result":"ok"}` {
		t.Fatalf("record result = %s, input mutation leaked", record.Result)
	}
	if record.Ack().Error == nil || string(record.Ack().Error.Details) != `{"x":1}` {
		t.Fatalf("ACK error clone = %+v", record.Ack().Error)
	}
}
