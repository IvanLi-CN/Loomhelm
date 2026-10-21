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

func TestJournalScopesApprovalRequestsBySessionAndRevision(t *testing.T) {
	journal := openTestJournal(t)
	for _, sessionID := range []string{"session-a", "session-b"} {
		if _, err := journal.AppendEvent(protocol.Event{
			SessionID: sessionID,
			RunID:     stringPointer("turn-" + sessionID),
			Type:      protocol.EventTypeApprovalRequested,
			Source:    protocol.EventSourceAppServer,
			Payload:   []byte(`{"jsonrpc":"2.0","id":7,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-` + sessionID + `","turnId":"turn-` + sessionID + `","revision":2,"itemId":"item-` + sessionID + `"}}`),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if got := journal.PendingApprovals("session-a", ""); len(got) != 1 || got[0].Revision != 2 {
		t.Fatalf("session-a pending approvals = %+v", got)
	}
	if got := journal.PendingApprovals("session-b", ""); len(got) != 1 || got[0].Revision != 2 {
		t.Fatalf("session-b pending approvals = %+v", got)
	}
	if _, _, err := journal.ClaimApproval("session-a", []byte("7"), 2, "approve-a", "approve"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := journal.ClaimApproval("session-b", []byte("7"), 1, "approve-b", "approve"); err == nil {
		t.Fatal("stale session-b approval revision unexpectedly claimed")
	}
	if _, _, err := journal.ClaimApproval("session-b", []byte("7"), 2, "approve-b", "approve"); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-a",
		RunID:     stringPointer("turn-session-a"),
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"requestId":7,"resolution":"accept"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if journal.IsApprovalPending("session-a", []byte("7")) {
		t.Fatal("session-a approval remained pending")
	}
	if !journal.IsApprovalPending("session-b", []byte("7")) {
		t.Fatal("session-b approval was removed by another session")
	}
}

func TestJournalPersistsApprovalClaimAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	first, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.AppendEvent(protocol.Event{
		SessionID: "session-claim",
		RunID:     stringPointer("turn-claim"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":9,"method":"item/commandExecution/requestApproval","params":{"turnId":"turn-claim","revision":1,"itemId":"item-claim"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, already, err := first.ClaimApproval("session-claim", []byte("9"), 1, "command-claim", "approve"); err != nil || already {
		t.Fatalf("first approval claim = already %v, error %v", already, err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if _, _, err := second.ClaimApproval("session-claim", []byte("9"), 1, "retry-command", "approve"); !errors.Is(err, ErrApprovalClaimed) {
		t.Fatalf("replayed approval claim error = %v, want %v", err, ErrApprovalClaimed)
	}
	if _, already, err := second.ClaimApproval("session-claim", []byte("9"), 1, "command-claim", "approve"); err != nil || !already {
		t.Fatalf("same approval claim = already %v, error %v", already, err)
	}
}

func TestJournalDoesNotDeduplicateIdenticalObservedPayloads(t *testing.T) {
	journal := openTestJournal(t)
	value := protocol.Event{SessionID: "session-events", Type: protocol.EventTypeMessageDelta, Source: protocol.EventSourceAppServer, Payload: []byte(`{"method":"item/agentMessage/delta","params":{"delta":"same"}}`)}
	first, err := journal.AppendEvent(value)
	if err != nil {
		t.Fatal(err)
	}
	second, err := journal.AppendEvent(value)
	if err != nil {
		t.Fatal(err)
	}
	if first.EventID == second.EventID || first.Cursor == second.Cursor {
		t.Fatalf("identical observed events collapsed: first=%+v second=%+v", first, second)
	}
	page, err := journal.ReadEvents(protocol.EventQuery{SessionID: "session-events", Limit: 10})
	if err != nil || len(page.Events) != 2 {
		t.Fatalf("observed event page = %+v, error = %v", page, err)
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
