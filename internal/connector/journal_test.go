package connector

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
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
	path := filepath.Join(privateTestDir(t), "journal.jsonl")
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

func TestJournalPersistsSessionStartIntentAndBlocksDuplicate(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "journal.jsonl")
	first, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	request := protocol.NewSessionRequest{CommandID: "create-1", ProjectID: "project-1", TaskID: "task-1", Prompt: "hello"}
	original := protocol.GatewaySession{Handle: "gateway-1", Generation: "generation-1"}
	intentID, err := first.BeginSessionStart(original, request)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := second.BeginSessionStart(protocol.GatewaySession{Handle: "gateway-2", Generation: "generation-2"}, request); !errors.Is(err, ErrUnknownOutcome) {
		t.Fatalf("duplicate session start error = %v, want %v", err, ErrUnknownOutcome)
	}
	if err := second.ResolveSessionStart(intentID, "session-1", "thread-1", original.Generation); err != nil {
		t.Fatal(err)
	}
	if session, ok := second.Session("session-1"); !ok || session.ExternalThreadRef != "thread-1" {
		t.Fatalf("resolved session = %+v, found = %v", session, ok)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}

	third, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	if _, err := third.BeginSessionStart(protocol.GatewaySession{Handle: "gateway-3", Generation: "generation-3"}, request); err != nil {
		t.Fatalf("resolved session start remained blocked: %v", err)
	}
}

func TestJournalResolvedSessionStartReturnsSessionUntilInitialPromptSucceeds(t *testing.T) {
	journal := openTestJournal(t)
	request := protocol.NewSessionRequest{CommandID: "create-resolved", ProjectID: "project-resolved", Prompt: "resume once"}
	gatewaySession := protocol.GatewaySession{Handle: "gateway-resolved", Generation: "generation-resolved"}
	intentID, err := journal.BeginSessionStart(gatewaySession, request)
	if err != nil {
		t.Fatal(err)
	}
	threadID := "thread-resolved"
	sessionID := stableSessionID(threadID)
	if err := journal.ResolveSessionStart(intentID, sessionID, threadID, gatewaySession.Generation); err != nil {
		t.Fatal(err)
	}
	if session, ok, err := journal.ResolvedSessionStart(request); err != nil || !ok || session.ExternalThreadRef != threadID {
		t.Fatalf("resolved session without an initial command = %+v, found = %v", session, ok)
	}
	command := protocol.Command{
		CommandID: sessionID + ":initial",
		IssuedAt:  "2026-10-21T00:00:00Z",
		Kind:      protocol.CommandKindRunSend,
		Payload:   []byte(`{"prompt":"resume once"}`),
		SessionID: sessionID,
	}
	if _, _, err := journal.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	if session, ok, err := journal.ResolvedSessionStart(request); err != nil || !ok || session.ExternalThreadRef != threadID {
		t.Fatalf("unfinished initial prompt session = %+v, found = %v", session, ok)
	}
	ack, err := journal.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	ack.State = protocol.CommandStateSucceeded
	if err := journal.UpdateCommand(command.CommandID, ack); err != nil {
		t.Fatal(err)
	}
	if session, ok, err := journal.ResolvedSessionStart(request); err != nil || !ok || session.ExternalThreadRef != threadID {
		t.Fatalf("successful initial prompt did not remain eligible for session reuse: %+v, found = %v", session, ok)
	}
}

func TestJournalSessionStartUsesExplicitCommandIdentity(t *testing.T) {
	journal := openTestJournal(t)
	request := protocol.NewSessionRequest{CommandID: "create-explicit-1", ProjectID: "project-identity", Prompt: "same prompt"}
	firstIntent, err := journal.BeginSessionStart(protocol.GatewaySession{Handle: "gateway-identity-1", Generation: "generation-identity-1"}, request)
	if err != nil {
		t.Fatal(err)
	}

	conflict := request
	conflict.Prompt = "different prompt"
	if _, err := journal.BeginSessionStart(protocol.GatewaySession{Handle: "gateway-identity-2", Generation: "generation-identity-2"}, conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("same identity with changed payload error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}

	distinct := request
	distinct.CommandID = "create-explicit-2"
	secondIntent, err := journal.BeginSessionStart(protocol.GatewaySession{Handle: "gateway-identity-3", Generation: "generation-identity-3"}, distinct)
	if err != nil {
		t.Fatal(err)
	}
	if secondIntent == firstIntent {
		t.Fatalf("distinct creation identities reused intent %q", secondIntent)
	}
	if err := journal.ResolveSessionStart(firstIntent, stableSessionID("thread-identity-1"), "thread-identity-1", "generation-identity-1"); err != nil {
		t.Fatal(err)
	}
	if session, ok, err := journal.ResolvedSessionStart(request); err != nil || !ok || session.ExternalThreadRef != "thread-identity-1" {
		t.Fatalf("resolved explicit session = %+v, found = %v, error = %v", session, ok, err)
	}
	if intentID, err := journal.BeginSessionStart(protocol.GatewaySession{Handle: "gateway-identity-4", Generation: "generation-identity-4"}, request); err != nil || intentID != firstIntent {
		t.Fatalf("same identity did not remain idempotent: intent = %q, error = %v", intentID, err)
	}
}

func TestJournalReadsLegacySessionStartsWithoutInferringNewIdentity(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "legacy-journal.jsonl")
	legacy := []byte("{\"format_version\":1,\"type\":\"session\",\"at\":\"2026-10-21T00:00:00Z\",\"session\":{\"session_id\":\"legacy-session\",\"external_thread_ref\":\"legacy-thread\",\"generation\":\"legacy-generation\",\"updated_at\":\"2026-10-21T00:00:00Z\"},\"session_start\":{\"intent_id\":\"legacy-generation\",\"gateway_handle\":\"legacy-gateway\",\"generation\":\"legacy-generation\",\"request_digest\":\"legacy-digest\",\"state\":\"resolved\",\"external_thread_ref\":\"legacy-thread\",\"updated_at\":\"2026-10-21T00:00:00Z\"}}\n")
	if err := os.WriteFile(path, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	if session, ok := journal.Session("legacy-session"); !ok || session.ExternalThreadRef != "legacy-thread" {
		t.Fatalf("legacy session = %+v, found = %v", session, ok)
	}
	request := protocol.NewSessionRequest{CommandID: "new-explicit-id", Prompt: "same prompt"}
	if _, ok, err := journal.ResolvedSessionStart(request); err != nil || ok {
		t.Fatalf("legacy session was reused for a new identity: found = %v, error = %v", ok, err)
	}
	if _, err := journal.BeginSessionStart(protocol.GatewaySession{Handle: "new-gateway", Generation: "new-generation"}, request); err != nil {
		t.Fatalf("legacy intent blocked a new explicit identity: %v", err)
	}
}

func TestJournalPreservesLargeJSONNumbersInCommandDigests(t *testing.T) {
	journal := openTestJournal(t)
	first := testCommand("large-number", "{\"value\":9007199254740992}")
	if _, _, err := journal.BeginCommand(first); err != nil {
		t.Fatal(err)
	}
	conflict := first
	conflict.Payload = []byte("{\"value\":9007199254740993}")
	if _, _, err := journal.BeginCommand(conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("large-number conflict error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}
}

func TestOpenJournalRejectsSymlinkPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires elevated privileges on some Windows configurations")
	}
	directory := privateTestDir(t)
	target := filepath.Join(directory, "target.jsonl")
	link := filepath.Join(directory, "journal.jsonl")
	if err := os.WriteFile(target, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if _, err := OpenJournal(link); err == nil {
		t.Fatal("journal symlink was accepted")
	}
}

func TestJournalWritesCurrentFormatAndCommandIdentity(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "journal.jsonl")
	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	request := protocol.NewSessionRequest{CommandID: "current-format-id", Prompt: "format"}
	if _, err := journal.BeginSessionStart(protocol.GatewaySession{Handle: "format-gateway", Generation: "format-generation"}, request); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte("\"format_version\":2")) || !bytes.Contains(data, []byte("\"command_id\":\"current-format-id\"")) {
		t.Fatalf("current journal record did not include v2 identity: %s", data)
	}
}

func TestJournalDiscardsInterruptedFinalRecord(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "journal.jsonl")
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
		Payload:   []byte(`{"jsonrpc":"2.0","id":42,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","command":"/usr/bin/printf APPROVED","item":{"id":"item-1","type":"commandExecution"}}}`),
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
	if len(pending) != 1 || string(pending[0].RequestID) != "42" || pending[0].Command != "/usr/bin/printf APPROVED" {
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

func TestJournalKeepsUnknownApprovalResolutionUnknown(t *testing.T) {
	journal := openTestJournal(t)
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-resolution",
		RunID:     stringPointer("turn-resolution"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":11,"method":"item/commandExecution/requestApproval","params":{"turnId":"turn-resolution","revision":1,"itemId":"item-resolution"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := journal.ClaimApproval("session-resolution", []byte("11"), 1, "command-resolution", "approve"); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-resolution",
		RunID:     stringPointer("turn-resolution"),
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"requestId":11,"resolution":"unexpected"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if got, ok := journal.ApprovalResult("command-resolution"); !ok || got != "unknown" {
		t.Fatalf("approval result = %q, found = %v, want unknown", got, ok)
	}
}

func TestJournalWaitsForItemStatusWhenApprovalResolutionIsEmpty(t *testing.T) {
	journal := openTestJournal(t)
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-empty-resolution",
		RunID:     stringPointer("turn-empty-resolution"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":12,"method":"item/commandExecution/requestApproval","params":{"turnId":"turn-empty-resolution","revision":1,"itemId":"item-empty-resolution"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := journal.ClaimApproval("session-empty-resolution", []byte("12"), 1, "command-empty-resolution", "approve"); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-empty-resolution",
		RunID:     stringPointer("turn-empty-resolution"),
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"requestId":12}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if len(journal.PendingApprovals("session-empty-resolution", "turn-empty-resolution")) != 1 {
		t.Fatal("empty approval resolution removed the pending claim before item status")
	}
	if result, ok := journal.ApprovalResult("command-empty-resolution"); !ok || result != approvalResolutionCleared {
		t.Fatalf("empty approval resolution marker = %q, found = %v", result, ok)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-empty-resolution",
		RunID:     stringPointer("turn-empty-resolution"),
		Type:      protocol.EventTypeItemCompleted,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"id":"item-empty-resolution","status":"completed"}}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if result, ok := journal.ApprovalResult("command-empty-resolution"); !ok || result != "accept" {
		t.Fatalf("item completion approval result = %q, found = %v", result, ok)
	}
}

func TestJournalPersistsApprovalClaimAcrossRestart(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "journal.jsonl")
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

func TestJournalDoesNotAttributeLaterCommandRunToEarlierUnknownCommand(t *testing.T) {
	journal := openTestJournal(t)
	first := testCommand("command-first", `{"prompt":"same"}`)
	if _, _, err := journal.BeginCommand(first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.CommandID = "command-second"
	second.IssuedAt = "2026-10-21T00:00:01Z"
	if _, _, err := journal.BeginCommand(second); err != nil {
		t.Fatal(err)
	}
	secondAck, err := journal.LookupCommand(second.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	secondAck.State = protocol.CommandStateSucceeded
	if err := journal.UpdateCommand(second.CommandID, secondAck); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID:  first.SessionID,
		RunID:      stringPointer("turn-second"),
		OccurredAt: "2026-10-21T00:00:02Z",
		Type:       protocol.EventTypeRunStarted,
		Source:     protocol.EventSourceAppServer,
		Payload:    []byte(`{"method":"turn/started"}`),
	}); err != nil {
		t.Fatal(err)
	}
	if runID, ok := journal.UniqueRunIDForCommand(first.SessionID, first.CommandID, first.IssuedAt); ok || runID != "" {
		t.Fatalf("later command run was attributed to earlier unknown command: %q, %v", runID, ok)
	}
}

func TestJournalEnforcesPrivatePermissions(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "nested", "deeper", "journal.jsonl")
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
	parentInfo, err := os.Stat(filepath.Dir(filepath.Dir(path)))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && (fileInfo.Mode().Perm() != 0o600 || directoryInfo.Mode().Perm() != 0o700 || parentInfo.Mode().Perm() != 0o700) {
		t.Fatalf("journal permissions = file %o, directory %o, parent %o", fileInfo.Mode().Perm(), directoryInfo.Mode().Perm(), parentInfo.Mode().Perm())
	}
}

func openTestJournal(t *testing.T) *Journal {
	t.Helper()
	journal, err := OpenJournal(filepath.Join(privateTestDir(t), "journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	return journal
}

func privateTestDir(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	return directory
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
