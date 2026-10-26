package connector

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestJournalPersistsExactSessionAndRunIdentityBeforeMaterializingEvents(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "identity.jsonl")
	first, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	alias := SessionAlias{
		PlatformSessionID: "platform-session-1",
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		CommandID:         "create-command-1",
	}
	if err := first.RecordSessionAlias(alias); err != nil {
		t.Fatal(err)
	}

	event := protocol.Event{
		EventID:   "event-before-binding",
		Cursor:    "adapter-session-1:1",
		Sequence:  1,
		SessionID: "adapter-session-1",
		Source:    protocol.EventSourceAppServer,
		Type:      protocol.EventTypeMessageDelta,
		Payload:   []byte(`{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"raw"}}`),
	}
	observation := EventObservation{
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "native-turn-1",
		NativeOperationID: "native-operation-1",
	}
	if mapped, delivered, err := first.AppendObservedEvent(event, observation); err != nil || delivered || mapped.EventID != "" {
		t.Fatalf("unbound event = %+v, delivered = %v, error = %v", mapped, delivered, err)
	}
	if page, err := first.ReadMappedEvents(protocol.EventQuery{SessionID: alias.PlatformSessionID}); err != nil || len(page.Events) != 0 {
		t.Fatalf("unbound mapped events = %+v, error = %v", page.Events, err)
	}
	if raw, err := first.ReadEvents(protocol.EventQuery{SessionID: alias.AdapterSessionID}); err != nil || len(raw.Events) != 1 || string(raw.Events[0].Payload) != string(event.Payload) || raw.Events[0].RunID != nil {
		t.Fatalf("raw observed event = %+v, error = %v", raw.Events, err)
	}

	pending := RunBinding{
		PlatformSessionID: alias.PlatformSessionID,
		PlatformRunID:     "platform-run-1",
		CommandID:         "run-command-1",
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		NativeOperationID: observation.NativeOperationID,
		State:             IdentityStatePending,
	}
	if err := first.RecordRunBinding(pending); err != nil {
		t.Fatal(err)
	}
	if mapped, delivered := first.MappedEvent(event.EventID); delivered || mapped.EventID != "" {
		t.Fatalf("pending run unexpectedly materialized event = %+v, delivered = %v", mapped, delivered)
	}

	bound := pending
	bound.NativeTurnID = observation.NativeTurnID
	bound.State = IdentityStateBound
	if err := first.RecordRunBinding(bound); err != nil {
		t.Fatal(err)
	}
	page, err := first.ReadMappedEvents(protocol.EventQuery{SessionID: alias.PlatformSessionID, RunID: bound.PlatformRunID})
	if err != nil || len(page.Events) != 1 {
		t.Fatalf("bound mapped events = %+v, error = %v", page.Events, err)
	}
	if page.Events[0].SessionID != alias.PlatformSessionID || page.Events[0].RunID == nil || *page.Events[0].RunID != bound.PlatformRunID || string(page.Events[0].Payload) != string(event.Payload) {
		t.Fatalf("materialized event = %+v", page.Events[0])
	}
	if mapped, delivered := first.MappedEvent(event.EventID); !delivered || mapped.RunID == nil || *mapped.RunID != bound.PlatformRunID {
		t.Fatalf("direct materialization = %+v, delivered = %v", mapped, delivered)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	recoveredAlias, found := second.SessionAlias(alias.PlatformSessionID)
	if !found || !sameSessionAlias(recoveredAlias, alias) {
		t.Fatalf("recovered session alias = %+v, found = %v", recoveredAlias, found)
	}
	recoveredBinding, found := second.RunBinding(bound.PlatformSessionID, bound.PlatformRunID)
	if !found || recoveredBinding.NativeTurnID != bound.NativeTurnID || recoveredBinding.State != IdentityStateBound {
		t.Fatalf("recovered run binding = %+v, found = %v", recoveredBinding, found)
	}
	page, err = second.ReadMappedEvents(protocol.EventQuery{SessionID: alias.PlatformSessionID})
	if err != nil || len(page.Events) != 1 || page.Events[0].RunID == nil || *page.Events[0].RunID != bound.PlatformRunID {
		t.Fatalf("recovered mapped events = %+v, error = %v", page.Events, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte(`"type":"session_alias"`)) || !bytes.Contains(data, []byte(`"type":"run_binding"`)) || !bytes.Contains(data, []byte(`"type":"observed_event"`)) {
		t.Fatalf("identity records missing from journal: %s", data)
	}
}

func TestJournalIdentityBindingsAreIdempotentAndRejectConflicts(t *testing.T) {
	journal := openTestJournal(t)
	alias := SessionAlias{
		PlatformSessionID: "platform-session-idempotent",
		AdapterSessionID:  "adapter-session-idempotent",
		ExternalThreadRef: "thread-idempotent",
		Generation:        "generation-idempotent",
		CommandID:         "create-idempotent",
	}
	if err := journal.RecordSessionAlias(alias); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordSessionAlias(alias); err != nil {
		t.Fatalf("same session alias was not idempotent: %v", err)
	}
	conflictingAlias := alias
	conflictingAlias.CommandID = "create-other"
	if !errors.Is(journal.RecordSessionAlias(conflictingAlias), ErrIdentityConflict) {
		t.Fatal("changed session alias was accepted")
	}
	conflictingAdapter := alias
	conflictingAdapter.PlatformSessionID = "platform-session-other"
	if !errors.Is(journal.RecordSessionAlias(conflictingAdapter), ErrIdentityConflict) {
		t.Fatal("adapter session was mapped to two platform sessions")
	}

	binding := RunBinding{
		PlatformSessionID: alias.PlatformSessionID,
		PlatformRunID:     "platform-run-idempotent",
		CommandID:         "run-idempotent",
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		NativeTurnID:      "native-turn-idempotent",
		NativeOperationID: "native-operation-idempotent",
		State:             IdentityStateBound,
	}
	if err := journal.RecordRunBinding(binding); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordRunBinding(binding); err != nil {
		t.Fatalf("same run binding was not idempotent: %v", err)
	}
	conflictingTurn := binding
	conflictingTurn.NativeTurnID = "native-turn-other"
	if !errors.Is(journal.RecordRunBinding(conflictingTurn), ErrIdentityConflict) {
		t.Fatal("changed native turn was accepted")
	}
	conflictingCommand := binding
	conflictingCommand.PlatformRunID = "platform-run-other"
	if !errors.Is(journal.RecordRunBinding(conflictingCommand), ErrIdentityConflict) {
		t.Fatal("command identity was mapped to two platform runs")
	}
	if got, found := journal.RunBindingForCommand(binding.CommandID); !found || got.PlatformRunID != binding.PlatformRunID {
		t.Fatalf("command reverse index = %+v, found = %v", got, found)
	}
	if got, found := journal.RunBindingForNativeTurn(alias.AdapterSessionID, alias.ExternalThreadRef, alias.Generation, binding.NativeTurnID); !found || got.PlatformRunID != binding.PlatformRunID {
		t.Fatalf("native turn reverse index = %+v, found = %v", got, found)
	}
	if got, found := journal.RunBindingForNativeOperation(alias.AdapterSessionID, alias.ExternalThreadRef, alias.Generation, binding.NativeOperationID); !found || got.PlatformRunID != binding.PlatformRunID {
		t.Fatalf("native operation reverse index = %+v, found = %v", got, found)
	}
}

func TestJournalUnknownBindingDoesNotMaterializeUntilExactEvidence(t *testing.T) {
	journal := openTestJournal(t)
	alias := SessionAlias{
		PlatformSessionID: "platform-session-unknown",
		AdapterSessionID:  "adapter-session-unknown",
		ExternalThreadRef: "thread-unknown",
		Generation:        "generation-unknown",
		CommandID:         "create-unknown",
	}
	if err := journal.RecordSessionAlias(alias); err != nil {
		t.Fatal(err)
	}
	binding := RunBinding{
		PlatformSessionID: alias.PlatformSessionID,
		PlatformRunID:     "platform-run-unknown",
		CommandID:         "run-unknown",
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		State:             IdentityStateUnknown,
	}
	if err := journal.RecordRunBinding(binding); err != nil {
		t.Fatal(err)
	}
	if _, delivered, err := journal.AppendObservedEvent(protocol.Event{
		EventID:   "event-without-native-identity",
		Cursor:    "adapter-session-unknown:1",
		Sequence:  1,
		SessionID: alias.AdapterSessionID,
		Source:    protocol.EventSourceAppServer,
		Type:      protocol.EventTypeRunStarted,
		Payload:   []byte(`{"turn":"missing"}`),
	}, EventObservation{
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
	}); err != nil || delivered {
		t.Fatalf("run event without native identity delivered = %v, error = %v", delivered, err)
	}
	event := protocol.Event{
		EventID:   "event-unknown",
		Cursor:    "adapter-session-unknown:2",
		Sequence:  2,
		SessionID: alias.AdapterSessionID,
		Source:    protocol.EventSourceAppServer,
		Type:      protocol.EventTypeRunStarted,
		Payload:   []byte(`{"turn":"unknown"}`),
	}
	if _, delivered, err := journal.AppendObservedEvent(event, EventObservation{
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		NativeTurnID:      "native-turn-unknown",
	}); err != nil || delivered {
		t.Fatalf("unknown event delivered = %v, error = %v", delivered, err)
	}
	page, err := journal.ReadMappedEvents(protocol.EventQuery{SessionID: alias.PlatformSessionID})
	if err != nil || len(page.Events) != 0 {
		t.Fatalf("unknown mapped events = %+v, error = %v", page.Events, err)
	}
	bound := binding
	bound.NativeTurnID = "native-turn-unknown"
	bound.State = IdentityStateBound
	if err := journal.RecordRunBinding(bound); err != nil {
		t.Fatal(err)
	}
	page, err = journal.ReadMappedEvents(protocol.EventQuery{SessionID: alias.PlatformSessionID, RunID: bound.PlatformRunID})
	if err != nil || len(page.Events) != 1 {
		t.Fatalf("exactly bound mapped events = %+v, error = %v", page.Events, err)
	}
}

func TestJournalSessionReplayDoesNotSkipPendingObservation(t *testing.T) {
	journal := openTestJournal(t)
	alias := SessionAlias{
		PlatformSessionID: "platform-session-order",
		AdapterSessionID:  "adapter-session-order",
		ExternalThreadRef: "thread-order",
		Generation:        "generation-order",
		CommandID:         "create-order",
	}
	if err := journal.RecordSessionAlias(alias); err != nil {
		t.Fatal(err)
	}
	binding := RunBinding{
		PlatformSessionID: alias.PlatformSessionID,
		PlatformRunID:     "platform-run-order",
		CommandID:         "run-order",
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		State:             IdentityStateUnknown,
	}
	if err := journal.RecordRunBinding(binding); err != nil {
		t.Fatal(err)
	}
	for _, event := range []struct {
		id       string
		cursor   string
		turnID   string
		sequence int64
	}{
		{id: "pending-order", cursor: "adapter-session-order:1", sequence: 1},
		{id: "mapped-order", cursor: "adapter-session-order:2", turnID: "native-order", sequence: 2},
	} {
		if _, delivered, err := journal.AppendObservedEvent(protocol.Event{
			EventID:   event.id,
			Cursor:    event.cursor,
			Sequence:  event.sequence,
			SessionID: alias.AdapterSessionID,
			Source:    protocol.EventSourceAppServer,
			Type:      protocol.EventTypeMessageDelta,
			Payload:   []byte(`{"event":"order"}`),
		}, EventObservation{
			AdapterSessionID:  alias.AdapterSessionID,
			ExternalThreadRef: alias.ExternalThreadRef,
			Generation:        alias.Generation,
			NativeTurnID:      event.turnID,
		}); err != nil || delivered {
			t.Fatalf("append event %q delivered = %v, error = %v", event.id, delivered, err)
		}
	}
	bound := binding
	bound.NativeTurnID = "native-order"
	bound.State = IdentityStateBound
	if err := journal.RecordRunBinding(bound); err != nil {
		t.Fatal(err)
	}
	page, err := journal.ReadMappedEvents(protocol.EventQuery{SessionID: alias.PlatformSessionID})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 0 || page.HasMore || page.NextCursor != nil {
		t.Fatalf("session replay skipped pending observation: %+v", page)
	}
	page, err = journal.ReadMappedEvents(protocol.EventQuery{SessionID: alias.PlatformSessionID, RunID: bound.PlatformRunID})
	if err != nil || len(page.Events) != 1 || page.Events[0].EventID != "mapped-order" {
		t.Fatalf("run replay = %+v, error = %v", page.Events, err)
	}
}

func TestJournalReadsV2AndAppendsV3WithoutRewritingHistory(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "v2-journal.jsonl")
	legacy := journalSession{
		SessionID:         "adapter-v2",
		ExternalThreadRef: "thread-v2",
		Generation:        "generation-v2",
		UpdatedAt:         "2026-10-21T00:00:00Z",
	}
	record := journalRecord{FormatVersion: previousJournalFormatVersion, Type: "session", At: legacy.UpdatedAt, Session: &legacy}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	if facts := journal.LegacySessionFacts(); len(facts) != 1 || facts[0].PlatformSessionID != "" || facts[0].CommandID != "" || facts[0].AdapterSessionID != legacy.SessionID {
		t.Fatalf("legacy session facts = %+v", facts)
	}
	if err := journal.RecordSessionAlias(SessionAlias{
		PlatformSessionID: "platform-v3",
		AdapterSessionID:  "adapter-v2",
		ExternalThreadRef: "thread-v2",
		Generation:        "generation-v2",
		CommandID:         "create-v3",
	}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data, []byte(`{"format_version":2`)) || !bytes.Contains(data, []byte(`{"format_version":3`)) {
		t.Fatalf("v2 history was rewritten or v3 record missing: %s", data)
	}
}

func TestJournalRejectsRunBindingWithoutExactSessionAliasOnRecovery(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "orphan-binding.jsonl")
	binding := RunBinding{
		PlatformSessionID: "missing-platform-session",
		PlatformRunID:     "orphan-run",
		CommandID:         "orphan-command",
		AdapterSessionID:  "adapter-orphan",
		ExternalThreadRef: "thread-orphan",
		Generation:        "generation-orphan",
		NativeTurnID:      "native-orphan",
		State:             IdentityStateBound,
	}
	record := journalRecord{FormatVersion: journalFormatVersion, Type: "run_binding", At: "2026-10-21T00:00:00Z", RunBinding: &binding}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenJournal(path); !errors.Is(err, ErrJournalCorrupt) {
		t.Fatalf("orphan run binding recovery error = %v, want %v", err, ErrJournalCorrupt)
	}
}

func TestJournalReplaysEqualIdentityRecordsAndRejectsConflictingReplay(t *testing.T) {
	alias := SessionAlias{
		PlatformSessionID: "platform-replay",
		AdapterSessionID:  "adapter-replay",
		ExternalThreadRef: "thread-replay",
		Generation:        "generation-replay",
		CommandID:         "create-replay",
		UpdatedAt:         "2026-10-21T00:00:00Z",
	}
	binding := RunBinding{
		PlatformSessionID: alias.PlatformSessionID,
		PlatformRunID:     "run-replay",
		CommandID:         "run-replay-command",
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		NativeTurnID:      "turn-replay",
		State:             IdentityStateBound,
		UpdatedAt:         "2026-10-21T00:00:01Z",
	}
	path := filepath.Join(privateTestDir(t), "duplicate-identities.jsonl")
	records := []journalRecord{
		{FormatVersion: journalFormatVersion, Type: "session_alias", At: alias.UpdatedAt, SessionAlias: &alias},
		{FormatVersion: journalFormatVersion, Type: "session_alias", At: alias.UpdatedAt, SessionAlias: &alias},
		{FormatVersion: journalFormatVersion, Type: "run_binding", At: binding.UpdatedAt, RunBinding: &binding},
		{FormatVersion: journalFormatVersion, Type: "run_binding", At: binding.UpdatedAt, RunBinding: &binding},
	}
	writeJournalRecords(t, path, records)
	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	if aliases := journal.SessionAliases(); len(aliases) != 1 {
		_ = journal.Close()
		t.Fatalf("replayed session aliases = %+v", aliases)
	}
	if bindings := journal.RunBindings(); len(bindings) != 1 {
		_ = journal.Close()
		t.Fatalf("replayed run bindings = %+v", bindings)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}

	conflictPath := filepath.Join(privateTestDir(t), "conflicting-identities.jsonl")
	conflictingAlias := alias
	conflictingAlias.CommandID = "create-conflict"
	writeJournalRecords(t, conflictPath, []journalRecord{
		{FormatVersion: journalFormatVersion, Type: "session_alias", At: alias.UpdatedAt, SessionAlias: &alias},
		{FormatVersion: journalFormatVersion, Type: "session_alias", At: conflictingAlias.UpdatedAt, SessionAlias: &conflictingAlias},
	})
	if _, err := OpenJournal(conflictPath); !errors.Is(err, ErrJournalCorrupt) {
		t.Fatalf("conflicting identity replay error = %v, want %v", err, ErrJournalCorrupt)
	}
}

func TestJournalSessionAliasRotationPreservesHistoricalBindings(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "rotation.jsonl")
	first, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	oldAlias := SessionAlias{
		PlatformSessionID: "platform-rotation",
		AdapterSessionID:  "adapter-rotation",
		ExternalThreadRef: "thread-rotation",
		Generation:        "generation-old",
		CommandID:         "create-rotation",
	}
	if err := first.RecordSessionAlias(oldAlias); err != nil {
		t.Fatal(err)
	}
	oldBinding := RunBinding{
		PlatformSessionID: oldAlias.PlatformSessionID,
		PlatformRunID:     "platform-run-old",
		CommandID:         "run-old",
		AdapterSessionID:  oldAlias.AdapterSessionID,
		ExternalThreadRef: oldAlias.ExternalThreadRef,
		Generation:        oldAlias.Generation,
		NativeTurnID:      "native-turn-old",
		State:             IdentityStateBound,
	}
	if err := first.RecordRunBinding(oldBinding); err != nil {
		t.Fatal(err)
	}
	oldEvent := protocol.Event{EventID: "rotation-old-event", Cursor: "adapter-rotation:1", Sequence: 1, SessionID: oldAlias.AdapterSessionID, Type: protocol.EventTypeMessageDelta, Source: protocol.EventSourceAppServer, Payload: json.RawMessage(`{"delta":"old"}`)}
	if mapped, delivered, err := first.AppendObservedEvent(oldEvent, EventObservation{AdapterSessionID: oldAlias.AdapterSessionID, ExternalThreadRef: oldAlias.ExternalThreadRef, Generation: oldAlias.Generation, NativeTurnID: oldBinding.NativeTurnID}); err != nil || !delivered || mapped.SessionID != oldAlias.PlatformSessionID || valueOrEmpty(mapped.RunID) != oldBinding.PlatformRunID {
		t.Fatalf("old generation mapping = %+v, delivered = %v, error = %v", mapped, delivered, err)
	}

	if err := first.RotateSessionAlias(SessionAlias{PlatformSessionID: oldAlias.PlatformSessionID, AdapterSessionID: oldAlias.AdapterSessionID, ExternalThreadRef: oldAlias.ExternalThreadRef, Generation: "generation-new", CommandID: oldAlias.CommandID}); err != nil {
		t.Fatal(err)
	}
	if err := first.RotateSessionAlias(SessionAlias{PlatformSessionID: oldAlias.PlatformSessionID, AdapterSessionID: oldAlias.AdapterSessionID, ExternalThreadRef: oldAlias.ExternalThreadRef, Generation: "generation-new", CommandID: oldAlias.CommandID}); err != nil {
		t.Fatalf("repeated generation rotation was not idempotent: %v", err)
	}
	rotated, ok := first.SessionAlias(oldAlias.PlatformSessionID)
	if !ok || rotated.Generation != "generation-new" || rotated.Revision != 2 {
		t.Fatalf("current rotated alias = %+v, found = %v", rotated, ok)
	}
	newBinding := RunBinding{
		PlatformSessionID: oldAlias.PlatformSessionID,
		PlatformRunID:     "platform-run-new",
		CommandID:         "run-new",
		AdapterSessionID:  oldAlias.AdapterSessionID,
		ExternalThreadRef: oldAlias.ExternalThreadRef,
		Generation:        "generation-new",
		NativeTurnID:      "native-turn-new",
		State:             IdentityStateBound,
	}
	if err := first.RecordRunBinding(newBinding); err != nil {
		t.Fatal(err)
	}
	newEvent := protocol.Event{EventID: "rotation-new-event", Cursor: "adapter-rotation:2", Sequence: 2, SessionID: oldAlias.AdapterSessionID, Type: protocol.EventTypeMessageDelta, Source: protocol.EventSourceAppServer, Payload: json.RawMessage(`{"delta":"new"}`)}
	if mapped, delivered, err := first.AppendObservedEvent(newEvent, EventObservation{AdapterSessionID: oldAlias.AdapterSessionID, ExternalThreadRef: oldAlias.ExternalThreadRef, Generation: "generation-new", NativeTurnID: newBinding.NativeTurnID}); err != nil || !delivered || mapped.SessionID != oldAlias.PlatformSessionID || valueOrEmpty(mapped.RunID) != newBinding.PlatformRunID {
		t.Fatalf("new generation mapping = %+v, delivered = %v, error = %v", mapped, delivered, err)
	}

	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	oldRecovered, ok := second.SessionAliasForAdapter(oldAlias.AdapterSessionID, oldAlias.ExternalThreadRef, oldAlias.Generation)
	if !ok || oldRecovered.Generation != oldAlias.Generation || oldRecovered.Revision != 1 {
		t.Fatalf("historical alias = %+v, found = %v", oldRecovered, ok)
	}
	newRecovered, ok := second.SessionAliasForAdapter(oldAlias.AdapterSessionID, oldAlias.ExternalThreadRef, "generation-new")
	if !ok || newRecovered.Generation != "generation-new" || newRecovered.Revision != 2 {
		t.Fatalf("current alias tuple = %+v, found = %v", newRecovered, ok)
	}
	if binding, ok := second.RunBinding(oldAlias.PlatformSessionID, oldBinding.PlatformRunID); !ok || binding.Generation != oldAlias.Generation {
		t.Fatalf("historical run binding = %+v, found = %v", binding, ok)
	}
	page, err := second.ReadMappedEvents(protocol.EventQuery{SessionID: oldAlias.PlatformSessionID})
	if err != nil || len(page.Events) != 2 || valueOrEmpty(page.Events[0].RunID) != oldBinding.PlatformRunID || valueOrEmpty(page.Events[1].RunID) != newBinding.PlatformRunID {
		t.Fatalf("rotated mapped events = %+v, error = %v", page.Events, err)
	}
}

func writeJournalRecords(t *testing.T, path string, records []journalRecord) {
	t.Helper()
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
}
