package connector

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
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
	retry := command
	retry.IssuedAt = "2026-10-21T00:01:00Z"
	if third, deduplicated, err := journal.BeginCommand(retry); err != nil || !deduplicated || !third.Deduplicated {
		t.Fatalf("retry with a new issued_at = %+v, deduplicated = %v, error = %v", third, deduplicated, err)
	}

	conflict := command
	conflict.Payload = []byte(`{"prompt":"different"}`)
	if _, _, err := journal.BeginCommand(conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("conflicting command error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}
}

func TestJournalRejectsMismatchedCommandAckIdentity(t *testing.T) {
	journal := openTestJournal(t)
	command := testCommand("ack-identity", `{"prompt":"identity"}`)
	if _, _, err := journal.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommand(command.CommandID, protocol.CommandAck{CommandID: "other-command", State: protocol.CommandStateSucceeded}); err == nil {
		t.Fatal("journal accepted an ACK for a different command")
	}
	ack, err := journal.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if ack.State != protocol.CommandStateAccepted {
		t.Fatalf("mismatched ACK changed command state to %q", ack.State)
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
	executing := testCommand("command-restart-executing", `{"prompt":"may also have run"}`)
	if _, _, err := first.BeginCommand(executing); err != nil {
		t.Fatal(err)
	}
	executingAck, err := first.LookupCommand(executing.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	executingAck.State = protocol.CommandStateExecuting
	if err := first.UpdateCommand(executing.CommandID, executingAck); err != nil {
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
	executingDuplicate, deduplicated, err := second.BeginCommand(executing)
	if !errors.Is(err, nil) || !deduplicated || executingDuplicate.State != protocol.CommandStateUnknown {
		t.Fatalf("replayed executing command = %+v, deduplicated = %v, error = %v", executingDuplicate, deduplicated, err)
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
	if _, err := second.BeginSessionStart(original, request); !errors.Is(err, ErrUnknownOutcome) {
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
	if intent, err := third.BeginSessionStart(original, request); err != nil || intent != intentID {
		t.Fatalf("resolved session start remained blocked: intent=%q error=%v", intent, err)
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
	if _, err := journal.BeginSessionStart(protocol.GatewaySession{Handle: "gateway-identity-1", Generation: "generation-identity-1"}, conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
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
	if intentID, err := journal.BeginSessionStart(protocol.GatewaySession{Handle: "gateway-identity-1", Generation: "generation-identity-1"}, request); err != nil || intentID != firstIntent {
		t.Fatalf("same identity did not remain idempotent: intent = %q, error = %v", intentID, err)
	}
}

func TestJournalAllowsSameCreationCommandIDAcrossGatewayNamespaces(t *testing.T) {
	j := openTestJournal(t)
	request := protocol.NewSessionRequest{CommandID: "shared-create", ProjectID: "project-shared", Prompt: "same payload"}
	firstGateway := protocol.GatewaySession{Handle: "gateway-shared-a", Generation: "generation-shared-a"}
	secondGateway := protocol.GatewaySession{Handle: "gateway-shared-b", Generation: "generation-shared-b"}
	firstIntent, err := j.BeginSessionStart(firstGateway, request)
	if err != nil {
		t.Fatal(err)
	}
	secondIntent, err := j.BeginSessionStart(secondGateway, request)
	if err != nil {
		t.Fatal(err)
	}
	if firstIntent == secondIntent {
		t.Fatalf("distinct gateway namespaces reused intent %q", firstIntent)
	}
	if err := j.ResolveSessionStart(firstIntent, "adapter-shared-a", "thread-shared-a", firstGateway.Generation); err != nil {
		t.Fatal(err)
	}
	if err := j.ResolveSessionStart(secondIntent, "adapter-shared-b", "thread-shared-b", secondGateway.Generation); err != nil {
		t.Fatal(err)
	}
	if _, found, err := j.ResolvedSessionStartForGateway(firstGateway.Handle, request); err != nil || !found {
		t.Fatalf("first gateway proof = found %v error %v", found, err)
	}
	if _, found, err := j.ResolvedSessionStartForGateway(secondGateway.Handle, request); err != nil || !found {
		t.Fatalf("second gateway proof = found %v error %v", found, err)
	}
	if _, _, err := j.ResolvedSessionStartProof(request); !errors.Is(err, ErrCommandScopeAmbiguous) {
		t.Fatalf("unscoped resolved proof error = %v, want %v", err, ErrCommandScopeAmbiguous)
	}
}

func TestJournalRetainsGatewayToPlatformSessionLinkIdempotently(t *testing.T) {
	j := openTestJournal(t)
	gateway := protocol.GatewaySession{Handle: "gateway-link", Generation: "generation-link"}
	request := protocol.NewSessionRequest{CommandID: "create-link", Prompt: "link"}
	intentID, err := j.BeginSessionStart(gateway, request)
	if err != nil {
		t.Fatal(err)
	}
	if err := j.ResolveSessionStart(intentID, "adapter-link", "thread-link", gateway.Generation); err != nil {
		t.Fatal(err)
	}
	if err := j.RecordSessionAlias(SessionAlias{
		PlatformSessionID: "platform-link",
		AdapterSessionID:  "adapter-link",
		ExternalThreadRef: "thread-link",
		Generation:        gateway.Generation,
		CommandID:         request.CommandID,
	}); err != nil {
		t.Fatal(err)
	}
	link := GatewaySessionLink{
		GatewayHandle:     gateway.Handle,
		PlatformSessionID: "platform-link",
		AdapterSessionID:  "adapter-link",
		ExternalThreadRef: "thread-link",
		Generation:        gateway.Generation,
		CommandID:         request.CommandID,
	}
	if err := j.RecordGatewaySessionLink(link); err != nil {
		t.Fatal(err)
	}
	proof, found, err := j.ResolvedSessionStartProofForPlatform(link.PlatformSessionID, request)
	if err != nil || !found || proof.GatewayHandle != gateway.Handle {
		t.Fatalf("linked platform proof = %+v found=%v error=%v", proof, found, err)
	}
	link.UpdatedAt = "2026-10-27T03:00:00Z"
	if err := j.RecordGatewaySessionLink(link); err != nil {
		t.Fatalf("repeated gateway link = %v", err)
	}
	got, found, err := j.GatewaySessionLinkForPlatform(link.PlatformSessionID)
	if err != nil || !found || got.GatewayHandle != gateway.Handle || got.AdapterSessionID != link.AdapterSessionID {
		t.Fatalf("gateway link = %+v found=%v error=%v", got, found, err)
	}
}

func TestJournalResolvesCreationProofByPlatformAliasWhenGatewayLinkIsMissing(t *testing.T) {
	j := openTestJournal(t)
	gateway := protocol.GatewaySession{Handle: "gateway-platform-proof", Generation: "generation-platform-proof"}
	request := protocol.NewSessionRequest{CommandID: "create-platform-proof", ProjectID: "project-platform-proof"}
	intentID, err := j.BeginSessionStart(gateway, request)
	if err != nil {
		t.Fatal(err)
	}
	if err := j.ResolveSessionStart(intentID, "adapter-platform-proof", "thread-platform-proof", gateway.Generation); err != nil {
		t.Fatal(err)
	}
	if err := j.RecordSessionAlias(SessionAlias{
		PlatformSessionID: "platform-proof",
		AdapterSessionID:  "adapter-platform-proof",
		ExternalThreadRef: "thread-platform-proof",
		Generation:        gateway.Generation,
		CommandID:         request.CommandID,
	}); err != nil {
		t.Fatal(err)
	}
	proof, found, err := j.ResolvedSessionStartProofForPlatform("platform-proof", request)
	if err != nil || !found || proof.GatewayHandle != gateway.Handle || proof.AdapterSession.SessionID != "adapter-platform-proof" {
		t.Fatalf("platform creation proof = %+v found=%v error=%v", proof, found, err)
	}
	if _, found, err := j.GatewaySessionLinkForPlatform("platform-proof"); err != nil || found {
		t.Fatalf("missing gateway link = found %v error %v", found, err)
	}
}

func TestJournalPlatformCreationProofDoesNotCrossSameCommandID(t *testing.T) {
	j := openTestJournal(t)
	requestA := protocol.NewSessionRequest{CommandID: "shared-platform-proof", ProjectID: "project-a", Prompt: "prompt-a"}
	requestB := protocol.NewSessionRequest{CommandID: "shared-platform-proof", ProjectID: "project-b", Prompt: "prompt-b"}
	gatewayA := protocol.GatewaySession{Handle: "gateway-platform-proof-a", Generation: "generation-platform-proof-a"}
	gatewayB := protocol.GatewaySession{Handle: "gateway-platform-proof-b", Generation: "generation-platform-proof-b"}
	intentA, err := j.BeginSessionStart(gatewayA, requestA)
	if err != nil {
		t.Fatal(err)
	}
	intentB, err := j.BeginSessionStart(gatewayB, requestB)
	if err != nil {
		t.Fatal(err)
	}
	if err := j.ResolveSessionStart(intentA, "adapter-proof-a", "thread-proof-a", gatewayA.Generation); err != nil {
		t.Fatal(err)
	}
	if err := j.ResolveSessionStart(intentB, "adapter-proof-b", "thread-proof-b", gatewayB.Generation); err != nil {
		t.Fatal(err)
	}
	for _, alias := range []SessionAlias{
		{PlatformSessionID: "platform-proof-a", AdapterSessionID: "adapter-proof-a", ExternalThreadRef: "thread-proof-a", Generation: gatewayA.Generation, CommandID: requestA.CommandID},
		{PlatformSessionID: "platform-proof-b", AdapterSessionID: "adapter-proof-b", ExternalThreadRef: "thread-proof-b", Generation: gatewayB.Generation, CommandID: requestB.CommandID},
	} {
		if err := j.RecordSessionAlias(alias); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []struct {
		platform string
		request  protocol.NewSessionRequest
		gateway  string
		thread   string
	}{
		{platform: "platform-proof-a", request: requestA, gateway: gatewayA.Handle, thread: "thread-proof-a"},
		{platform: "platform-proof-b", request: requestB, gateway: gatewayB.Handle, thread: "thread-proof-b"},
	} {
		proof, found, err := j.ResolvedSessionStartProofForPlatform(want.platform, want.request)
		if err != nil || !found || proof.GatewayHandle != want.gateway || proof.AdapterSession.ExternalThreadRef != want.thread {
			t.Fatalf("platform %s proof = %+v found=%v error=%v", want.platform, proof, found, err)
		}
	}
	if _, _, err := j.ResolvedSessionStartProofForPlatform("platform-proof-a", requestB); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("cross-payload proof error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}
	if _, _, err := j.ResolvedSessionStartProofForPlatform("platform-proof-missing", requestA); !errors.Is(err, ErrCommandScopeUnknown) {
		t.Fatalf("missing platform proof error = %v, want %v", err, ErrCommandScopeUnknown)
	}
}

func TestJournalScopesSameCommandIDAcrossAdapterNamespacesAfterRestart(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "scoped-command.jsonl")
	first, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	commandA := testCommand("shared-command", `{"prompt":"same command"}`)
	commandA.SessionID = "adapter-scoped-a"
	commandB := commandA
	commandB.SessionID = "adapter-scoped-b"
	for _, command := range []protocol.Command{commandA, commandB} {
		if _, deduplicated, err := first.BeginCommandInNamespace(AdapterSessionCommandNamespace(command.SessionID), command); err != nil || deduplicated {
			t.Fatalf("begin scoped command %+v: deduplicated=%v error=%v", command, deduplicated, err)
		}
	}
	ackA, err := first.LookupCommandInNamespace(AdapterSessionCommandNamespace(commandA.SessionID), commandA.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	ackA.State = protocol.CommandStateSucceeded
	ackA.Result = json.RawMessage(`{"adapter":"a"}`)
	if err := first.UpdateCommandInNamespace(AdapterSessionCommandNamespace(commandA.SessionID), commandA.CommandID, ackA); err != nil {
		t.Fatal(err)
	}
	ackB, err := first.LookupCommandInNamespace(AdapterSessionCommandNamespace(commandB.SessionID), commandB.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	ackB.State = protocol.CommandStateFailed
	ackB.Result = json.RawMessage(`{"adapter":"b"}`)
	if err := first.UpdateCommandInNamespace(AdapterSessionCommandNamespace(commandB.SessionID), commandB.CommandID, ackB); err != nil {
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
	gotA, err := second.LookupCommandInNamespace(AdapterSessionCommandNamespace(commandA.SessionID), commandA.CommandID)
	if err != nil || gotA.State != protocol.CommandStateSucceeded || string(gotA.Result) != `{"adapter":"a"}` {
		t.Fatalf("scoped command A = %+v error=%v", gotA, err)
	}
	gotB, err := second.LookupCommandInNamespace(AdapterSessionCommandNamespace(commandB.SessionID), commandB.CommandID)
	if err != nil || gotB.State != protocol.CommandStateFailed || string(gotB.Result) != `{"adapter":"b"}` {
		t.Fatalf("scoped command B = %+v error=%v", gotB, err)
	}
	if _, err := second.LookupCommand(commandA.CommandID); !errors.Is(err, ErrCommandScopeAmbiguous) {
		t.Fatalf("unscoped command lookup error = %v, want %v", err, ErrCommandScopeAmbiguous)
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

func TestJournalNormalizesLegacyCommandDigestForLargeJSONNumbers(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "legacy-command.jsonl")
	command := testCommand("legacy-large-number", `{"value":9007199254740993}`)
	ack := protocol.CommandAck{CommandID: command.CommandID, ReceivedAt: command.IssuedAt, State: protocol.CommandStateAccepted}
	record := journalRecord{
		FormatVersion: legacyJournalFormatVersion,
		Type:          "command",
		At:            command.IssuedAt,
		Command:       &command,
		CommandID:     command.CommandID,
		Digest:        legacyCommandDigestForTest(t, command),
		Ack:           &ack,
	}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	duplicate, deduplicated, err := journal.BeginCommand(command)
	if err != nil || !deduplicated || duplicate.State != protocol.CommandStateUnknown {
		t.Fatalf("legacy large-number command = %+v, deduplicated = %v, error = %v", duplicate, deduplicated, err)
	}
	conflict := command
	conflict.Payload = []byte(`{"value":9007199254740992}`)
	if _, _, err := journal.BeginCommand(conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("legacy large-number conflict error = %v, want %v", err, protocol.ErrIdempotencyConflict)
	}
}

func TestJournalRejectsMismatchedCommandRecordIdentity(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "mismatched-command.jsonl")
	command := testCommand("nested-command-id", `{"prompt":"must not be replayed"}`)
	ack := protocol.CommandAck{CommandID: command.CommandID, ReceivedAt: command.IssuedAt, State: protocol.CommandStateAccepted}
	digest, err := commandDigest(command)
	if err != nil {
		t.Fatal(err)
	}
	record := journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "command",
		At:            command.IssuedAt,
		Command:       &command,
		CommandID:     "outer-command-id",
		Digest:        digest,
		Ack:           &ack,
	}
	header, err := json.Marshal(journalRecord{FormatVersion: journalFormatVersion, Type: "journal_header", At: command.IssuedAt})
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	data = append(append(header, '\n'), data...)
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := OpenJournal(path); !errors.Is(err, ErrJournalCorrupt) {
		t.Fatalf("mismatched command identity error = %v, want %v", err, ErrJournalCorrupt)
	}
}

func TestJournalDuplicateCommandRecordDoesNotRollBackAck(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "duplicate-command.jsonl")
	command := testCommand("duplicate-command", `{"prompt":"preserve result"}`)
	digest, err := commandDigest(command)
	if err != nil {
		t.Fatal(err)
	}
	accepted := protocol.CommandAck{CommandID: command.CommandID, ReceivedAt: command.IssuedAt, State: protocol.CommandStateAccepted}
	succeeded := accepted
	succeeded.State = protocol.CommandStateSucceeded
	succeeded.Result = json.RawMessage(`{"ok":true}`)
	records := []journalRecord{
		{FormatVersion: journalFormatVersion, Type: "command", At: command.IssuedAt, Command: &command, CommandID: command.CommandID, Namespace: namespacePointer(AdapterSessionCommandNamespace(command.SessionID)), Digest: digest, Ack: &accepted},
		{FormatVersion: journalFormatVersion, Type: "command_update", At: command.IssuedAt, CommandID: command.CommandID, Namespace: namespacePointer(AdapterSessionCommandNamespace(command.SessionID)), Ack: &succeeded},
		{FormatVersion: journalFormatVersion, Type: "command", At: command.IssuedAt, Command: &command, CommandID: command.CommandID, Namespace: namespacePointer(AdapterSessionCommandNamespace(command.SessionID)), Digest: digest, Ack: &accepted},
	}
	header, err := json.Marshal(journalRecord{FormatVersion: journalFormatVersion, Type: "journal_header", At: command.IssuedAt})
	if err != nil {
		t.Fatal(err)
	}
	data := append(header, '\n')
	for _, record := range records {
		encoded, marshalErr := json.Marshal(record)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	ack, err := journal.LookupCommand(command.CommandID)
	if err != nil || ack.State != protocol.CommandStateSucceeded || string(ack.Result) != `{"ok":true}` {
		t.Fatalf("duplicate command replay = %+v, error = %v", ack, err)
	}
}

func TestJournalLookupCommandForRequestDoesNotRequireAdapterState(t *testing.T) {
	journal := openTestJournal(t)
	command := testCommand("lookup-command", `{"prompt":"durable"}`)
	if _, _, err := journal.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	ack, found, err := journal.LookupCommandForRequest(command)
	if err != nil || !found || !ack.Deduplicated || ack.State != protocol.CommandStateAccepted {
		t.Fatalf("durable lookup = %+v, found = %v, error = %v", ack, found, err)
	}
	missing := command
	missing.CommandID = "lookup-missing"
	if _, found, err := journal.LookupCommandForRequest(missing); err != nil || found {
		t.Fatalf("missing durable lookup = found %v, error %v", found, err)
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

func TestOpenJournalRejectsSymlinkAncestor(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires elevated privileges on some Windows configurations")
	}
	directory := privateTestDir(t)
	target := privateTestDir(t)
	link := filepath.Join(directory, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if _, err := OpenJournal(filepath.Join(link, "nested", "journal.jsonl")); err == nil {
		t.Fatal("journal accepted a symlink ancestor")
	}
}

func TestOpenJournalRejectsExistingSymlinkAncestor(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires elevated privileges on some Windows configurations")
	}
	directory := privateTestDir(t)
	target := privateTestDir(t)
	if err := os.Mkdir(filepath.Join(target, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if _, err := OpenJournal(filepath.Join(link, "nested", "journal.jsonl")); err == nil {
		t.Fatal("journal accepted an existing symlink ancestor")
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
	if !bytes.Contains(data, []byte("\"format_version\":4")) || !bytes.Contains(data, []byte("\"type\":\"journal_header\"")) || !bytes.Contains(data, []byte("\"namespace\":{\"kind\":\"gateway\"")) || !bytes.Contains(data, []byte("\"command_id\":\"current-format-id\"")) {
		t.Fatalf("current journal record did not include v4 identity marker: %s", data)
	}
}

func TestJournalRejectsResourceLimitBreaches(t *testing.T) {
	t.Run("record", func(t *testing.T) {
		path := filepath.Join(privateTestDir(t), "oversized-record.jsonl")
		data := append(bytes.Repeat([]byte{'x'}, maxJournalRecordBytes), '\n')
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenJournal(path); !errors.Is(err, ErrJournalTooLarge) {
			t.Fatalf("oversized record error = %v, want %v", err, ErrJournalTooLarge)
		}
	})

	t.Run("file", func(t *testing.T) {
		path := filepath.Join(privateTestDir(t), "oversized-file.jsonl")
		file, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Truncate(maxJournalBytes + 1); err != nil {
			_ = file.Close()
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenJournal(path); !errors.Is(err, ErrJournalTooLarge) {
			t.Fatalf("oversized file error = %v, want %v", err, ErrJournalTooLarge)
		}
	})

	t.Run("event-count", func(t *testing.T) {
		journal := openTestJournal(t)
		journal.mu.Lock()
		journal.events = make([]protocol.Event, maxJournalEvents)
		journal.mu.Unlock()
		_, err := journal.AppendEvent(protocol.Event{SessionID: "session-limit", Type: protocol.EventTypeUnknown, Payload: []byte(`{"ok":true}`)})
		if !errors.Is(err, ErrJournalTooLarge) {
			t.Fatalf("event-count error = %v, want %v", err, ErrJournalTooLarge)
		}
	})
}

func TestJournalRejectsOversizedAppendWithoutPoisoning(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "oversized-append.jsonl")
	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()

	payload := append([]byte(`{"prompt":"`), bytes.Repeat([]byte{'x'}, maxJournalRecordBytes)...)
	payload = append(payload, []byte(`"}`)...)
	oversized := testCommand("oversized-append", string(payload))
	if _, _, err := journal.BeginCommand(oversized); !errors.Is(err, ErrJournalTooLarge) {
		t.Fatalf("oversized append error = %v, want %v", err, ErrJournalTooLarge)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("oversized-append")) || !bytes.Contains(data, []byte(`"type":"journal_header"`)) {
		t.Fatalf("oversized append polluted journal: %s", data)
	}

	valid := testCommand("valid-after-oversized", `{"prompt":"accepted"}`)
	ack, deduplicated, err := journal.BeginCommand(valid)
	if err != nil {
		t.Fatalf("valid append after oversized record: %v", err)
	}
	if deduplicated || ack.State != protocol.CommandStateAccepted {
		t.Fatalf("valid append ACK = %+v, deduplicated = %v", ack, deduplicated)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restartedAck, err := reopened.LookupCommand(valid.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if restartedAck.CommandID != valid.CommandID || restartedAck.State != protocol.CommandStateUnknown {
		t.Fatalf("restarted valid command ACK = %+v, want command %q with state %q", restartedAck, valid.CommandID, protocol.CommandStateUnknown)
	}
}

func TestJournalRejectsUnsupportedFormatVersion(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "unsupported-format.jsonl")
	if err := os.WriteFile(path, []byte(`{"format_version":4,"type":"session"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenJournal(path); !errors.Is(err, ErrJournalCorrupt) {
		t.Fatalf("unsupported format error = %v, want %v", err, ErrJournalCorrupt)
	}
}

func TestJournalRejectsLegacyWriterAfterV4Marker(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "legacy-writer-after-v4.jsonl")
	j, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(`{"format_version":3,"type":"event","event":{"session_id":"adapter-old-writer","event_id":"old-writer-event","cursor":"adapter-old-writer:1","sequence":1,"type":"unknown","payload":"e30="}}` + "\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenJournal(path); !errors.Is(err, ErrJournalCorrupt) {
		t.Fatalf("legacy writer after v4 marker error = %v, want %v", err, ErrJournalCorrupt)
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
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() == 0 || !bytes.Contains(data, []byte(`"type":"journal_header"`)) {
		t.Fatalf("journal marker after incomplete record = %d bytes, want a valid v4 marker", info.Size())
	}
}

func TestJournalRepairsTornCommandUpdateIdempotentlyAfterRestart(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "journal-repair.jsonl")
	first, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	command := testCommand("command-repair", `{"prompt":"repair me"}`)
	if _, _, err := first.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(`{"format_version":2,"type":"command_update","command_id":"command-repair"`); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	ack, err := second.LookupCommand(command.CommandID)
	if err != nil {
		_ = second.Close()
		t.Fatal(err)
	}
	if ack.State != protocol.CommandStateUnknown {
		_ = second.Close()
		t.Fatalf("repaired command state = %q, want unknown", ack.State)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}

	third, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	ack, err = third.LookupCommand(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if ack.State != protocol.CommandStateUnknown {
		t.Fatalf("re-entered repaired command state = %q, want unknown", ack.State)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := bytes.Count(data, []byte(`"type":"command_update"`)); got != 1 {
		t.Fatalf("command update records after re-entry = %d, want 1", got)
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

func TestJournalUsesNativeApprovalParamsRequestIDWhenTopLevelIDIsAbsent(t *testing.T) {
	journal := openTestJournal(t)
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-native-approval-id",
		RunID:     stringPointer("turn-native-approval-id"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"item/commandExecution/requestApproval","params":{"requestId":43,"turnId":"turn-native-approval-id","itemId":"item-native-approval-id"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	pending, err := journal.FindPendingApproval("session-native-approval-id", "turn-native-approval-id", []byte("43"))
	if err != nil || string(pending.RequestID) != "43" {
		t.Fatalf("native approval pending = %+v, error = %v", pending, err)
	}
	pending, err = journal.FindPendingApproval("session-native-approval-id", "turn-native-approval-id", []byte(`"43"`))
	if err != nil || string(pending.RequestID) != "43" {
		t.Fatalf("stringified native approval pending = %+v, error = %v", pending, err)
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
	resolved, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-resolution",
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"requestId":11,"resolution":"unexpected"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.RunID == nil || *resolved.RunID != "turn-resolution" {
		t.Fatalf("resolved approval run ID = %v, want turn-resolution", resolved.RunID)
	}
	if got, ok := journal.ApprovalResult("command-resolution"); !ok || got != "unknown" {
		t.Fatalf("approval result = %q, found = %v, want unknown", got, ok)
	}
}

func TestJournalPreservesApprovalRequestIDTypeWhenFindingPendingApproval(t *testing.T) {
	journal := openTestJournal(t)
	for _, value := range []struct {
		id      string
		turnID  string
		itemID  string
		request string
	}{{"numeric", "turn-numeric", "item-numeric", `1`}, {"string", "turn-string", "item-string", `"1"`}} {
		if _, err := journal.AppendEvent(protocol.Event{
			SessionID: "session-approval-id-types",
			RunID:     stringPointer(value.turnID),
			Type:      protocol.EventTypeApprovalRequested,
			Source:    protocol.EventSourceAppServer,
			Payload:   []byte(`{"jsonrpc":"2.0","id":` + value.request + `,"method":"item/commandExecution/requestApproval","params":{"turnId":"` + value.turnID + `","itemId":"` + value.itemID + `"}}`),
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []struct {
		request string
		turnID  string
	}{{`1`, "turn-numeric"}, {`"1"`, "turn-string"}} {
		pending, err := journal.FindPendingApproval("session-approval-id-types", "", []byte(value.request))
		if err != nil || pending.TurnID != value.turnID {
			t.Fatalf("pending approval for %s = %+v, error = %v", value.request, pending, err)
		}
	}
}

func TestJournalNormalizesEscapedApprovalRequestID(t *testing.T) {
	journal := openTestJournal(t)
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-approval-id-escape",
		RunID:     stringPointer("turn-approval-id-escape"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":"\u0031","method":"item/commandExecution/requestApproval","params":{"turnId":"turn-approval-id-escape","itemId":"item-approval-id-escape"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	pending, err := journal.FindPendingApproval("session-approval-id-escape", "", []byte(`"1"`))
	if err != nil || string(pending.RequestID) != `"\u0031"` {
		t.Fatalf("escaped approval lookup = %+v, error = %v", pending, err)
	}
	if _, already, err := journal.ClaimApproval("session-approval-id-escape", []byte(`"1"`), 1, "command-approval-id-escape", "approve"); err != nil || already {
		t.Fatalf("escaped approval claim = already %v, error %v", already, err)
	}
}

func TestJournalDoesNotResolveApprovalAcrossTurnReuse(t *testing.T) {
	journal := openTestJournal(t)
	for _, value := range []struct {
		requestID string
		turnID    string
		commandID string
	}{{"21", "turn-reuse-a", "command-reuse-a"}, {"22", "turn-reuse-b", "command-reuse-b"}} {
		if _, err := journal.AppendEvent(protocol.Event{
			SessionID: "session-approval-turn-reuse",
			RunID:     stringPointer(value.turnID),
			Type:      protocol.EventTypeApprovalRequested,
			Source:    protocol.EventSourceAppServer,
			Payload:   []byte(`{"jsonrpc":"2.0","id":` + value.requestID + `,"method":"item/commandExecution/requestApproval","params":{"turnId":"` + value.turnID + `","revision":1,"itemId":"shared-item"}}`),
		}); err != nil {
			t.Fatal(err)
		}
		if _, already, err := journal.ClaimApproval("session-approval-turn-reuse", []byte(value.requestID), 1, value.commandID, "approve"); err != nil || already {
			t.Fatalf("approval claim %s = already %v, error %v", value.commandID, already, err)
		}
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-approval-turn-reuse",
		RunID:     stringPointer("turn-reuse-b"),
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"requestId":21,"turnId":"turn-reuse-b","resolution":"accept"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if result, ok := journal.ApprovalResult("command-reuse-a"); ok {
		t.Fatalf("wrong-turn resolution applied to command-reuse-a: %q", result)
	}
	if !journal.IsApprovalPending("session-approval-turn-reuse", []byte("21")) {
		t.Fatal("wrong-turn resolution removed command-reuse-a approval")
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-approval-turn-reuse",
		RunID:     stringPointer("turn-reuse-b"),
		Type:      protocol.EventTypeItemCompleted,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"item/completed","params":{"turnId":"turn-reuse-b","item":{"id":"shared-item","status":"completed"}}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if result, ok := journal.ApprovalResult("command-reuse-b"); !ok || result != "accept" {
		t.Fatalf("matching item completion result = %q, found = %v", result, ok)
	}
	if !journal.IsApprovalPending("session-approval-turn-reuse", []byte("21")) {
		t.Fatal("wrong-turn approval was removed by matching item completion")
	}
}

func TestJournalReplaysLegacyApprovalResolutionWithPendingRunIdentity(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "legacy-approval-resolution.jsonl")
	session := journalSession{
		SessionID:         "legacy-approval-session",
		ExternalThreadRef: "legacy-approval-thread",
		Generation:        "legacy-approval-generation",
		UpdatedAt:         "2026-10-21T00:00:00Z",
	}
	request := protocol.Event{
		SessionID: session.SessionID,
		RunID:     stringPointer("legacy-approval-turn"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":11,"method":"item/commandExecution/requestApproval","params":{"turnId":"legacy-approval-turn","revision":1,"itemId":"legacy-approval-item"}}`),
		Cursor:    session.SessionID + ":1",
		EventID:   "legacy-approval-request",
		Sequence:  1,
	}
	claim := approvalClaimRecord{
		SessionID: session.SessionID,
		RequestID: json.RawMessage(`11`),
		Revision:  1,
		CommandID: "legacy-approval-command",
		Decision:  "approve",
	}
	resolved := protocol.Event{
		SessionID: session.SessionID,
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"requestId":11,"resolution":"accept"}}`),
		Cursor:    session.SessionID + ":2",
		EventID:   "legacy-approval-resolution",
		Sequence:  2,
	}
	records := []journalRecord{
		{FormatVersion: legacyJournalFormatVersion, Type: "session", At: session.UpdatedAt, Session: &session},
		{FormatVersion: legacyJournalFormatVersion, Type: "event", At: session.UpdatedAt, Event: &request},
		{FormatVersion: legacyJournalFormatVersion, Type: "approval_claim", At: session.UpdatedAt, ApprovalClaim: &claim},
		{FormatVersion: legacyJournalFormatVersion, Type: "event", At: session.UpdatedAt, Event: &resolved},
	}
	var data []byte
	for _, record := range records {
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	page, err := journal.ReadEvents(protocol.EventQuery{SessionID: session.SessionID, RunID: "legacy-approval-turn", Limit: 10})
	if err != nil || len(page.Events) != 2 || page.Events[1].Type != protocol.EventTypeApprovalResolved {
		t.Fatalf("legacy approval events = %+v, error = %v", page.Events, err)
	}
	if result, ok := journal.ApprovalResult("legacy-approval-command"); !ok || result != "accept" {
		t.Fatalf("legacy approval result = %q, found = %v", result, ok)
	}
}

func TestJournalReplaysObservedApprovalAndClaimIdentity(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "observed-approval-replay.jsonl")
	session := journalSession{
		SessionID:         "observed-approval-session",
		ExternalThreadRef: "observed-approval-thread",
		Generation:        "observed-approval-generation",
		UpdatedAt:         "2026-10-21T00:00:00Z",
	}
	event := protocol.Event{
		SessionID: session.SessionID,
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":11,"method":"item/commandExecution/requestApproval","params":{"threadId":"observed-approval-thread","turnId":"observed-approval-turn","revision":2,"itemId":"observed-approval-item"}}`),
		Cursor:    session.SessionID + ":1",
		EventID:   "observed-approval-request",
		Sequence:  1,
	}
	claim := approvalClaimRecord{
		SessionID: session.SessionID,
		RequestID: json.RawMessage(`11`),
		Revision:  2,
		CommandID: "observed-approval-command",
		Decision:  "approve",
	}
	observed := journalObservedEvent{
		Event: event,
		Observation: EventObservation{
			AdapterSessionID:  session.SessionID,
			ExternalThreadRef: session.ExternalThreadRef,
			Generation:        session.Generation,
			NativeTurnID:      "observed-approval-turn",
		},
	}
	records := []journalRecord{
		{FormatVersion: journalFormatVersion, Type: "session", At: session.UpdatedAt, Session: &session},
		{FormatVersion: journalFormatVersion, Type: "approval_claim", At: session.UpdatedAt, ApprovalClaim: &claim},
		{FormatVersion: journalFormatVersion, Type: "observed_event", At: session.UpdatedAt, ObservedEvent: &observed},
	}
	header, err := json.Marshal(journalRecord{FormatVersion: journalFormatVersion, Type: "journal_header", At: session.UpdatedAt})
	if err != nil {
		t.Fatal(err)
	}
	data := append(header, '\n')
	for _, record := range records {
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	pending := journal.PendingApprovals(session.SessionID, "observed-approval-turn")
	if len(pending) != 1 || pending[0].Generation != session.Generation || pending[0].TurnID != "observed-approval-turn" || pending[0].Revision != 2 {
		t.Fatalf("replayed observed approval = %+v", pending)
	}
	if _, already, err := journal.ClaimApproval(session.SessionID, json.RawMessage(`11`), 2, claim.CommandID, claim.Decision); err != nil || !already {
		t.Fatalf("replayed approval claim = already %v, error %v", already, err)
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

func TestJournalDoesNotApplyApprovalClaimAcrossGenerations(t *testing.T) {
	journal := openTestJournal(t)
	if err := journal.RecordSession("session-approval-generation", "thread-approval-generation", "generation-old"); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-approval-generation",
		RunID:     stringPointer("turn-old"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":9,"method":"item/commandExecution/requestApproval","params":{"turnId":"turn-old","revision":1,"itemId":"item-old"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, already, err := journal.ClaimApproval("session-approval-generation", []byte("9"), 1, "command-old", "approve"); err != nil || already {
		t.Fatalf("old approval claim = already %v, error %v", already, err)
	}
	if err := journal.RecordSession("session-approval-generation", "thread-approval-generation", "generation-new"); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-approval-generation",
		RunID:     stringPointer("turn-new"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":9,"method":"item/commandExecution/requestApproval","params":{"turnId":"turn-new","revision":1,"itemId":"item-new"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-approval-generation",
		RunID:     stringPointer("turn-new"),
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"requestId":9,"turnId":"turn-new","resolution":"accept"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if result, ok := journal.ApprovalResult("command-old"); ok {
		t.Fatalf("old generation claim received new resolution %q", result)
	}
	if pending := journal.PendingApprovals("session-approval-generation", ""); len(pending) != 0 {
		t.Fatalf("resolved new-generation approval remains pending: %+v", pending)
	}
}

func TestJournalDoesNotApplyResolutionFromNewGenerationToOldApproval(t *testing.T) {
	journal := openTestJournal(t)
	if err := journal.RecordSession("session-approval-resolution-generation", "thread-approval-resolution-generation", "generation-old"); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-approval-resolution-generation",
		RunID:     stringPointer("turn-old"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":13,"method":"item/commandExecution/requestApproval","params":{"turnId":"turn-old","revision":1,"itemId":"item-old"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, already, err := journal.ClaimApproval("session-approval-resolution-generation", []byte("13"), 1, "command-old-resolution", "approve"); err != nil || already {
		t.Fatalf("old resolution claim = already %v, error %v", already, err)
	}
	if err := journal.RecordSession("session-approval-resolution-generation", "thread-approval-resolution-generation", "generation-new"); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-approval-resolution-generation",
		RunID:     stringPointer("turn-new"),
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"requestId":13,"turnId":"turn-new","resolution":"accept"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if result, ok := journal.ApprovalResult("command-old-resolution"); ok {
		t.Fatalf("new generation resolution applied to old claim: %q", result)
	}
}

func TestJournalSerializesCompetingApprovalClaims(t *testing.T) {
	journal := openTestJournal(t)
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: "session-approval-race",
		RunID:     stringPointer("turn-approval-race"),
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(`{"jsonrpc":"2.0","id":11,"method":"item/commandExecution/requestApproval","params":{"turnId":"turn-approval-race","revision":1,"itemId":"item-approval-race"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	type claimResult struct {
		already bool
		err     error
	}
	results := make(chan claimResult, 2)
	var group sync.WaitGroup
	for _, claim := range []struct {
		commandID string
		decision  string
	}{
		{commandID: "approval-race-approve", decision: "approve"},
		{commandID: "approval-race-deny", decision: "deny"},
	} {
		claim := claim
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			_, already, err := journal.ClaimApproval("session-approval-race", []byte("11"), 1, claim.commandID, claim.decision)
			results <- claimResult{already: already, err: err}
		}()
	}
	close(start)
	group.Wait()
	close(results)
	winners := 0
	losers := 0
	for result := range results {
		if result.err == nil && !result.already {
			winners++
		} else if errors.Is(result.err, ErrApprovalClaimed) {
			losers++
		} else {
			t.Fatalf("competing approval claim result = %+v", result)
		}
	}
	if winners != 1 || losers != 1 {
		t.Fatalf("competing approval claims = winners %d, losers %d, want one each", winners, losers)
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

func legacyCommandDigestForTest(t *testing.T, command protocol.Command) string {
	t.Helper()
	var value any
	if err := json.Unmarshal(command.Payload, &value); err != nil {
		t.Fatal(err)
	}
	legacyPayload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	digestValue := struct {
		CommandID string               `json:"command_id"`
		IssuedAt  string               `json:"issued_at"`
		Kind      protocol.CommandKind `json:"kind"`
		Payload   json.RawMessage      `json:"payload"`
		RunID     *string              `json:"run_id,omitempty"`
		SessionID string               `json:"session_id"`
	}{
		CommandID: command.CommandID,
		IssuedAt:  command.IssuedAt,
		Kind:      command.Kind,
		Payload:   legacyPayload,
		RunID:     command.RunID,
		SessionID: command.SessionID,
	}
	data, err := json.Marshal(digestValue)
	if err != nil {
		t.Fatal(err)
	}
	return digestString(string(data))
}
