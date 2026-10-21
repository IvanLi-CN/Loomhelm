package connector

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestJournalDeduplicatesCommandsAndRejectsConflictingPayloads(t *testing.T) {
	journal := openTestJournal(t)
	command := testCommand("command-1", `{"prompt":"hello"}`)

	first, deduplicated, err := journal.BeginCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	if deduplicated || first.State != protocol.CommandStateAccepted {
		t.Fatalf("first command = %+v, deduplicated = %v", first, deduplicated)
	}

	second, deduplicated, err := journal.BeginCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	if !deduplicated || !second.Deduplicated || second.CommandID != command.CommandID {
		t.Fatalf("duplicate command = %+v, deduplicated = %v", second, deduplicated)
	}

	conflict := command
	conflict.Payload = []byte(`{"prompt":"different"}`)
	if _, _, err := journal.BeginCommand(conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("conflicting command error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}
}

func TestJournalTurnsInflightCommandUnknownAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	first, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	command := testCommand("command-restart", `{"prompt":"may have run"}`)
	if _, _, err := first.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	ack, err := second.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if ack.State != protocol.CommandStateUnknown {
		t.Fatalf("restarted command state = %q, want unknown", ack.State)
	}
	duplicate, deduplicated, err := second.BeginCommand(command)
	if !errors.Is(err, nil) || !deduplicated || duplicate.State != protocol.CommandStateUnknown {
		t.Fatalf("replayed command = %+v, deduplicated = %v, error = %v", duplicate, deduplicated, err)
	}
}

func TestJournalDiscardsInterruptedFinalRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(`{"format_version":1,"type":"command"`); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != 0 {
		t.Fatalf("journal size after incomplete record = %d, want 0", info.Size())
	}
}

func TestJournalReadsOrderedEventsAndRebuildsPendingApproval(t *testing.T) {
	journal := openTestJournal(t)
	event, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-1",
		RunID:     stringPointer("turn-1"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":42,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"item-1","type":"commandExecution"}}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	page, err := journal.ReadEvents(protocol.EventQuery{SessionID: "session-1", RunID: "turn-1", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 1 || page.Events[0].Cursor != event.Cursor {
		t.Fatalf("event page = %+v, want cursor %q", page, event.Cursor)
	}
	pending := journal.PendingApprovals("session-1", "turn-1")
	if len(pending) != 1 || string(pending[0].RequestID) != "42" {
		t.Fatalf("pending approvals = %+v", pending)
	}

	resolved, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-1",
		RunID:     stringPointer("turn-1"),
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":42,"result":{"decision":"accept"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(journal.PendingApprovals("session-1", "turn-1")) != 0 {
		t.Fatalf("approval remained pending after event %s", resolved.EventID)
	}
}

func TestJournalFindsUniqueRunAfterCommandIssuance(t *testing.T) {
	journal := openTestJournal(t)
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID:  "session-1",
		RunID:      stringPointer("turn-1"),
		OccurredAt: "2026-10-21T00:00:01Z",
		Type:       protocol.EventTypeRunStarted,
		Source:     protocol.EventSourceAppServer,
		Payload:    []byte(`{"method":"turn/started"}`),
	}); err != nil {
		t.Fatal(err)
	}
	if runID, ok := journal.UniqueRunIDAfter("session-1", "2026-10-21T00:00:00Z"); !ok || runID != "turn-1" {
		t.Fatalf("unique run after issuance = %q, %v", runID, ok)
	}
}

func TestJournalEnforcesPrivatePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "journal.jsonl")
	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	directoryInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if fileInfo.Mode().Perm() != 0o600 || directoryInfo.Mode().Perm() != 0o700 {
		t.Fatalf("journal permissions = file %o, directory %o", fileInfo.Mode().Perm(), directoryInfo.Mode().Perm())
	}
}

func openTestJournal(t *testing.T) *Journal {
	t.Helper()
	journal, err := OpenJournal(filepath.Join(t.TempDir(), "journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	return journal
}

func testCommand(id, payload string) protocol.Command {
	return protocol.Command{
		CommandID: id,
		IssuedAt:  "2026-10-21T00:00:00Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   []byte(payload),
		SessionID: "session-1",
	}
}
