package connector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestArtifactCandidatesFromCodexFileChange(t *testing.T) {
	event := protocol.Event{
		EventID:    "source-event-1",
		OccurredAt: "2026-10-30T01:02:03Z",
		Source:     protocol.EventSourceAppServer,
		Type:       protocol.EventTypeItemCompleted,
		Payload:    json.RawMessage(`{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"id":"item-1","type":"fileChange","changes":[{"path":"private.txt","kind":{"type":"update"},"diff":"--- a/private.txt\n+++ b/private.txt\n@@ -1 +1 @@\n-old\n+new\n"}]}}}`),
	}
	observation := EventObservation{
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
	}

	first, gaps, err := artifactCandidatesFromEventWithReader(context.Background(), event, observation, fixedArtifactReader{content: []byte("final bytes\n")})
	if err != nil {
		t.Fatal(err)
	}
	if len(gaps) != 0 {
		t.Fatalf("artifact capture gaps = %+v", gaps)
	}
	if len(first) != 1 {
		t.Fatalf("artifact candidates = %d, want 1", len(first))
	}
	candidate := first[0]
	if candidate.Kind != protocol.ArtifactKindFile || candidate.ContentType != "application/octet-stream" || candidate.Provenance != "codex.fs.readFile" {
		t.Fatalf("artifact metadata = %+v", candidate)
	}
	if candidate.Size != int64(len(candidate.Content)) || candidate.Size == 0 {
		t.Fatalf("artifact size = %d, content length = %d", candidate.Size, len(candidate.Content))
	}
	sum := sha256.Sum256(candidate.Content)
	if candidate.Sha256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("artifact hash = %q, want %q", candidate.Sha256, hex.EncodeToString(sum[:]))
	}
	if bytes.Contains(candidate.EventPayload, []byte(`"path"`)) {
		t.Fatalf("artifact payload leaked Codex path: %s", candidate.EventPayload)
	}
	if !json.Valid(candidate.EventPayload) {
		t.Fatalf("artifact event payload is invalid JSON: %s", candidate.EventPayload)
	}

	repeated, repeatedGaps, err := artifactCandidatesFromEventWithReader(context.Background(), event, observation, fixedArtifactReader{content: []byte("final bytes\n")})
	if err != nil {
		t.Fatal(err)
	}
	if len(repeatedGaps) != 0 {
		t.Fatalf("repeated artifact capture gaps = %+v", repeatedGaps)
	}
	if len(repeated) != 1 || repeated[0].ID != candidate.ID || repeated[0].EventID != candidate.EventID || repeated[0].Sha256 != candidate.Sha256 {
		t.Fatalf("artifact identity was not stable: first = %+v, repeated = %+v", candidate, repeated)
	}

	event.Type = protocol.EventTypeItemStarted
	ignored, err := artifactCandidatesFromEvent(event, observation)
	if err != nil {
		t.Fatal(err)
	}
	if len(ignored) != 0 {
		t.Fatalf("non-final item event produced artifacts: %+v", ignored)
	}
	event.Type = protocol.EventTypeItemCompleted
	withoutReader, captureGaps, err := artifactCandidatesFromEventWithReader(context.Background(), event, observation, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(withoutReader) != 0 || len(captureGaps) != 1 || captureGaps[0].Reason != "workspace_unconfigured" {
		t.Fatalf("unconfigured artifact capture = candidates %+v, gaps %+v", withoutReader, captureGaps)
	}
}

func TestArtifactCandidateRecoverySkipsExistingIdentityBeforeReading(t *testing.T) {
	event := testFileChangeEvent("source-event-recovery")
	observation := EventObservation{
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
	}
	initial, gaps, err := artifactCandidatesFromEventWithReader(context.Background(), event, observation, fixedArtifactReader{content: []byte("original bytes\n")})
	if err != nil || len(gaps) != 0 || len(initial) != 1 {
		t.Fatalf("initial artifact capture = candidates %+v, gaps %+v, error %v", initial, gaps, err)
	}
	readCalls := 0
	replayed, replayGaps, err := artifactCandidatesFromEventWithReaderSkipping(context.Background(), event, observation, fixedArtifactReader{
		content: []byte("later file bytes\n"),
		calls:   &readCalls,
	}, func(id string) bool {
		return id == initial[0].ID
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(replayed) != 0 || len(replayGaps) != 0 || readCalls != 0 {
		t.Fatalf("replayed existing artifact = candidates %+v, gaps %+v, read calls %d", replayed, replayGaps, readCalls)
	}
}

func TestReplayPendingArtifactCapturesDoesNotReReadExistingPublication(t *testing.T) {
	directory := privateTestDir(t)
	workspace := filepath.Join(directory, "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "private.txt"), []byte("later file bytes\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	journal, err := OpenJournal(filepath.Join(directory, "journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	outbox, err := OpenArtifactOutbox(filepath.Join(directory, "artifacts.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer outbox.Close()
	event := testFileChangeEvent("source-event-recovery-wiring")
	observation := EventObservation{
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
	}
	if _, _, err := journal.AppendObservedEventWithRecord(event, observation); err != nil {
		t.Fatal(err)
	}
	initial, _, err := artifactCandidatesFromEventWithReader(context.Background(), event, observation, fixedArtifactReader{content: []byte("original bytes\n")})
	if err != nil || len(initial) != 1 {
		t.Fatalf("initial artifact candidates = %+v, error = %v", initial, err)
	}
	if _, _, err := outbox.Ensure(initial[0]); err != nil {
		t.Fatal(err)
	}

	transport := newFakeTransport()
	state := &adapterSessionState{
		session:        protocol.AdapterSession{SessionID: observation.AdapterSessionID, ExternalThreadRef: observation.ExternalThreadRef},
		gatewaySession: protocol.GatewaySession{Handle: "gateway-1", Generation: observation.Generation},
		transport:      transport,
		workspace:      workspace,
		activeTurns:    make(map[string]string),
	}
	adapter := &Adapter{
		journal:   journal,
		artifacts: outbox,
		sessions:  map[string]*adapterSessionState{state.session.SessionID: state},
	}
	if err := adapter.ReplayPendingArtifactCaptures(); err != nil {
		t.Fatal(err)
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if len(transport.calls) != 0 {
		t.Fatalf("replayed existing publication contacted app-server = %+v", transport.calls)
	}
}

func TestArtifactCandidatesRequireReaderAuthorizationForAdd(t *testing.T) {
	event := testFileChangeEvent("source-event-unauthorized")
	event.Payload = json.RawMessage(`{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"id":"item-1","type":"fileChange","changes":[{"path":"other.txt","kind":{"type":"add"},"diff":"new file bytes\n"}]}}}`)
	candidates, gaps, err := artifactCandidatesFromEventWithReader(context.Background(), event, EventObservation{
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
	}, fixedArtifactReader{content: []byte("new file bytes\n")})
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 || len(gaps) != 1 || gaps[0].Reason != "path_outside_authorized_workspace" {
		t.Fatalf("unauthorized add capture = candidates %+v, gaps %+v", candidates, gaps)
	}
}

func TestArtifactCandidatesDoNotPublishDeleteDiffAsFile(t *testing.T) {
	event := testFileChangeEvent("source-event-delete")
	event.Payload = json.RawMessage(`{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"id":"item-1","type":"fileChange","changes":[{"path":"private.txt","kind":{"type":"delete"},"diff":"@@ -1 +0,0 @@\n-old bytes\n"}]}}}`)
	candidates, gaps, err := artifactCandidatesFromEventWithReader(context.Background(), event, EventObservation{
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
	}, fixedArtifactReader{content: []byte("new file bytes\n")})
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 || len(gaps) != 1 || gaps[0].Reason != "file_bytes_unavailable" {
		t.Fatalf("delete diff capture = candidates %+v, gaps %+v", candidates, gaps)
	}
}

func TestArtifactOutboxPersistsDeduplicatesAndMarksUploaded(t *testing.T) {
	candidate := testArtifactCandidate(t)
	directory := privateTestDir(t)
	path := filepath.Join(directory, "artifacts.jsonl")

	outbox, err := OpenArtifactOutbox(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, deduplicated, err := outbox.Ensure(candidate); err != nil || deduplicated {
		t.Fatalf("first artifact ensure = deduplicated %v, error %v", deduplicated, err)
	}
	if _, deduplicated, err := outbox.Ensure(candidate); err != nil || !deduplicated {
		t.Fatalf("retry artifact ensure = deduplicated %v, error %v", deduplicated, err)
	}
	gap := ArtifactCaptureGap{
		ID:            "artifact-gap-1",
		SourceEventID: candidate.SourceEventID,
		ChangeKind:    "update",
		Reason:        "workspace_unconfigured",
		Observation:   candidate.Observation,
	}
	if err := outbox.RecordGap(gap); err != nil {
		t.Fatal(err)
	}
	updatedReason := gap
	updatedReason.Reason = "file_bytes_unavailable"
	if err := outbox.RecordGap(updatedReason); err != nil {
		t.Fatalf("repeated artifact gap with changed transient reason = %v", err)
	}
	if err := outbox.Close(); err != nil {
		t.Fatal(err)
	}

	partial, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := partial.WriteString(`{"format_version":1,"type":"publication"`); err != nil {
		_ = partial.Close()
		t.Fatal(err)
	}
	if err := partial.Close(); err != nil {
		t.Fatal(err)
	}

	outbox, err = OpenArtifactOutbox(path)
	if err != nil {
		t.Fatal(err)
	}
	publication, found := outbox.Publication(candidate.ID)
	if !found || publication.State != ArtifactPublicationPending {
		t.Fatalf("recovered publication = %+v, found = %v", publication, found)
	}
	gaps := outbox.Gaps()
	if len(gaps) != 1 || gaps[0].ID != gap.ID || gaps[0].Reason != gap.Reason {
		t.Fatalf("recovered artifact gaps = %+v", gaps)
	}
	if err := outbox.MarkUploaded(candidate.ID); err != nil {
		t.Fatal(err)
	}
	if err := outbox.Close(); err != nil {
		t.Fatal(err)
	}

	outbox, err = OpenArtifactOutbox(path)
	if err != nil {
		t.Fatal(err)
	}
	publication, found = outbox.Publication(candidate.ID)
	if !found || publication.State != ArtifactPublicationUploaded {
		t.Fatalf("uploaded publication = %+v, found = %v", publication, found)
	}
	conflict := candidate
	conflict.Content = []byte("different diff")
	conflict.Size = int64(len(conflict.Content))
	conflictHash := sha256.Sum256(conflict.Content)
	conflict.Sha256 = hex.EncodeToString(conflictHash[:])
	if _, _, err := outbox.Ensure(conflict); !errors.Is(err, ErrArtifactPublicationConflict) {
		t.Fatalf("conflicting artifact ensure error = %v", err)
	}
	if err := outbox.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestArtifactOutboxPersistsRejectedPublication(t *testing.T) {
	directory := privateTestDir(t)
	path := filepath.Join(directory, "artifacts.jsonl")
	outbox, err := OpenArtifactOutbox(path)
	if err != nil {
		t.Fatal(err)
	}
	candidate := testArtifactCandidate(t)
	candidate.ID = "artifact-rejected"
	candidate.EventID = "artifact-event-rejected"
	if _, _, err := outbox.Ensure(candidate); err != nil {
		t.Fatal(err)
	}
	if err := outbox.MarkRejected(candidate.ID, "artifact_conflict"); err != nil {
		t.Fatal(err)
	}
	if pending := outbox.Pending(); len(pending) != 0 {
		t.Fatalf("rejected publication remained pending: %+v", pending)
	}
	if err := outbox.Close(); err != nil {
		t.Fatal(err)
	}

	outbox, err = OpenArtifactOutbox(path)
	if err != nil {
		t.Fatal(err)
	}
	defer outbox.Close()
	publication, found := outbox.Publication(candidate.ID)
	if !found || publication.State != ArtifactPublicationRejected || publication.RejectionCode != "artifact_conflict" {
		t.Fatalf("recovered rejected publication = %+v, found = %v", publication, found)
	}
}

func TestArtifactOutboxCompactsCompletedPublication(t *testing.T) {
	directory := privateTestDir(t)
	path := filepath.Join(directory, "artifacts.jsonl")
	outbox, err := OpenArtifactOutbox(path)
	if err != nil {
		t.Fatal(err)
	}
	candidate := testArtifactCandidate(t)
	candidate.Content = bytes.Repeat([]byte("x"), 64*1024)
	candidate.Size = int64(len(candidate.Content))
	sum := sha256.Sum256(candidate.Content)
	candidate.Sha256 = hex.EncodeToString(sum[:])
	if _, _, err := outbox.Ensure(candidate); err != nil {
		t.Fatal(err)
	}
	if err := outbox.MarkUploaded(candidate.ID); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := outbox.compactCompleted(); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() >= before.Size() {
		t.Fatalf("compacted artifact outbox size = %d, before = %d", after.Size(), before.Size())
	}
	publication, found := outbox.Publication(candidate.ID)
	if !found || publication.State != ArtifactPublicationUploaded || len(publication.Candidate.Content) != 0 {
		t.Fatalf("compacted uploaded publication = %+v, found = %v", publication, found)
	}
	if _, deduplicated, err := outbox.Ensure(candidate); err != nil || !deduplicated {
		t.Fatalf("compacted publication retry = deduplicated %v, error %v", deduplicated, err)
	}

	newCandidate := candidate
	newCandidate.ID = "artifact-compacted-new"
	newCandidate.EventID = "artifact-event-compacted-new"
	newCandidate.SourceEventID = "source-event-compacted-new"
	if _, deduplicated, err := outbox.Ensure(newCandidate); err != nil || deduplicated {
		t.Fatalf("new publication after compaction = deduplicated %v, error %v", deduplicated, err)
	}
	if err := outbox.Close(); err != nil {
		t.Fatal(err)
	}
	outbox, err = OpenArtifactOutbox(path)
	if err != nil {
		t.Fatal(err)
	}
	defer outbox.Close()
	publication, found = outbox.Publication(candidate.ID)
	if !found || publication.State != ArtifactPublicationUploaded || len(publication.Candidate.Content) != 0 {
		t.Fatalf("recovered compacted publication = %+v, found = %v", publication, found)
	}
}

func TestArtifactOutboxCompactsPendingStateTransition(t *testing.T) {
	directory := privateTestDir(t)
	path := filepath.Join(directory, "artifacts.jsonl")
	outbox, err := OpenArtifactOutbox(path)
	if err != nil {
		t.Fatal(err)
	}
	candidate := testArtifactCandidate(t)
	if _, _, err := outbox.Ensure(candidate); err != nil {
		t.Fatal(err)
	}
	if err := outbox.compactPublicationState(candidate.ID, ArtifactPublicationUploaded, ""); err != nil {
		t.Fatal(err)
	}
	publication, found := outbox.Publication(candidate.ID)
	if !found || publication.State != ArtifactPublicationUploaded || len(publication.Candidate.Content) != 0 {
		t.Fatalf("state-transition compacted publication = %+v, found = %v", publication, found)
	}
	if err := outbox.Close(); err != nil {
		t.Fatal(err)
	}
	outbox, err = OpenArtifactOutbox(path)
	if err != nil {
		t.Fatal(err)
	}
	defer outbox.Close()
	publication, found = outbox.Publication(candidate.ID)
	if !found || publication.State != ArtifactPublicationUploaded || len(publication.Candidate.Content) != 0 {
		t.Fatalf("recovered state-transition publication = %+v, found = %v", publication, found)
	}
}

func TestUploadArtifactForEventUsesMappedIdentityAndRetries(t *testing.T) {
	directory := privateTestDir(t)
	journal, err := OpenJournal(filepath.Join(directory, "journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	outbox, err := OpenArtifactOutbox(filepath.Join(directory, "artifacts.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer outbox.Close()

	alias := SessionAlias{
		PlatformSessionID: "platform-session-1",
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		CommandID:         "session-command-1",
	}
	if err := journal.RecordSessionAlias(alias); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordRunBinding(RunBinding{
		PlatformSessionID: alias.PlatformSessionID,
		PlatformRunID:     "platform-run-1",
		CommandID:         "run-command-1",
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		NativeTurnID:      "turn-1",
		State:             IdentityStateBound,
	}); err != nil {
		t.Fatal(err)
	}

	source := testFileChangeEvent("source-event-1")
	observation := EventObservation{
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		NativeTurnID:      "turn-1",
	}
	if _, delivered, err := journal.AppendObservedEventWithRecord(source, observation); err != nil || !delivered {
		t.Fatalf("source event delivered = %v, error = %v", delivered, err)
	}
	candidates, _, err := artifactCandidatesFromEventWithReader(context.Background(), source, observation, fixedArtifactReader{content: []byte("new file bytes\n")})
	if err != nil || len(candidates) != 1 {
		t.Fatalf("artifact candidates = %+v, error = %v", candidates, err)
	}
	candidate := candidates[0]
	if _, _, err := outbox.Ensure(candidate); err != nil {
		t.Fatal(err)
	}
	if _, delivered, err := journal.AppendObservedEventWithRecord(artifactEvent(candidate), observation); err != nil || !delivered {
		t.Fatalf("artifact event delivered = %v, error = %v", delivered, err)
	}
	mapped, ok := journal.MappedEvent(candidate.EventID)
	if !ok || mapped.SessionID != alias.PlatformSessionID || mapped.RunID == nil || *mapped.RunID != "platform-run-1" {
		t.Fatalf("mapped artifact event = %+v, found = %v", mapped, ok)
	}

	adapter := &Adapter{journal: journal, artifacts: outbox}
	uploader := &artifactUploadProbe{fail: true}
	if err := adapter.UploadArtifactForEvent(context.Background(), mapped, uploader); err == nil {
		t.Fatal("first artifact upload unexpectedly succeeded")
	}
	if uploader.calls != 1 {
		t.Fatalf("first upload calls = %d, want 1", uploader.calls)
	}
	if publication, _ := outbox.Publication(candidate.ID); publication.State != ArtifactPublicationPending {
		t.Fatalf("failed upload changed publication state: %+v", publication)
	}

	uploader.fail = false
	if err := adapter.UploadArtifactForEvent(context.Background(), mapped, uploader); err != nil {
		t.Fatal(err)
	}
	if uploader.calls != 2 {
		t.Fatalf("retry upload calls = %d, want 2", uploader.calls)
	}
	request := uploader.requests[1]
	if request.Artifact.SessionID != alias.PlatformSessionID || request.Artifact.RunID == nil || *request.Artifact.RunID != "platform-run-1" {
		t.Fatalf("uploaded artifact identity = %+v", request.Artifact)
	}
	if request.IdempotencyKey != candidate.ID || request.EventID != candidate.EventID || request.SourceEventID != candidate.SourceEventID {
		t.Fatalf("upload identity = %+v", request)
	}
	if !bytes.Equal(uploader.contents[1], candidate.Content) {
		t.Fatalf("uploaded content = %q, want %q", uploader.contents[1], candidate.Content)
	}

	if err := adapter.UploadArtifactForEvent(context.Background(), mapped, uploader); err != nil {
		t.Fatal(err)
	}
	if uploader.calls != 2 {
		t.Fatalf("uploaded artifact was sent again: %d calls", uploader.calls)
	}
}

func TestUploadPendingArtifactsPublishesSuccessOnlyAfterDurableUpload(t *testing.T) {
	directory := privateTestDir(t)
	journal, err := OpenJournal(filepath.Join(directory, "journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	outboxPath := filepath.Join(directory, "artifacts.jsonl")
	outbox, err := OpenArtifactOutbox(outboxPath)
	if err != nil {
		t.Fatal(err)
	}
	observation := EventObservation{
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
	}
	alias := SessionAlias{PlatformSessionID: "platform-session-1", AdapterSessionID: observation.AdapterSessionID, ExternalThreadRef: observation.ExternalThreadRef, Generation: observation.Generation, CommandID: "session-command-1"}
	if err := journal.RecordSessionAlias(alias); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordRunBinding(RunBinding{PlatformSessionID: alias.PlatformSessionID, PlatformRunID: "platform-run-1", CommandID: "run-command-1", AdapterSessionID: alias.AdapterSessionID, ExternalThreadRef: alias.ExternalThreadRef, Generation: alias.Generation, NativeTurnID: observation.NativeTurnID, State: IdentityStateBound}); err != nil {
		t.Fatal(err)
	}
	source := testFileChangeEvent("source-event-pending")
	if _, _, err := journal.AppendObservedEventWithRecord(source, observation); err != nil {
		t.Fatal(err)
	}
	candidates, _, err := artifactCandidatesFromEventWithReader(context.Background(), source, observation, fixedArtifactReader{content: []byte("new file bytes\n")})
	if err != nil || len(candidates) != 1 {
		t.Fatalf("artifact candidates = %+v, error = %v", candidates, err)
	}
	candidate := candidates[0]
	if _, _, err := outbox.Ensure(candidate); err != nil {
		t.Fatal(err)
	}
	adapter := &Adapter{journal: journal, artifacts: outbox}
	uploader := &artifactUploadProbe{fail: true}
	if err := adapter.UploadPendingArtifacts(context.Background(), uploader); err == nil {
		t.Fatal("failed artifact upload unexpectedly succeeded")
	}
	if publication, _ := outbox.Publication(candidate.ID); publication.State != ArtifactPublicationPending {
		t.Fatalf("failed upload changed publication state: %+v", publication)
	}
	if _, mapped := journal.MappedEvent(candidate.EventID); mapped {
		t.Fatal("failed artifact upload published artifact.created")
	}

	if err := outbox.Close(); err != nil {
		t.Fatal(err)
	}
	outbox, err = OpenArtifactOutbox(outboxPath)
	if err != nil {
		t.Fatal(err)
	}
	defer outbox.Close()
	adapter.artifacts = outbox
	uploader.fail = false
	if err := adapter.UploadPendingArtifacts(context.Background(), uploader); err != nil {
		t.Fatal(err)
	}
	publication, found := outbox.Publication(candidate.ID)
	if !found || publication.State != ArtifactPublicationUploaded {
		t.Fatalf("successful publication = %+v, found = %v", publication, found)
	}
	mapped, mappedOK := journal.MappedEvent(candidate.EventID)
	if !mappedOK || mapped.SessionID != "platform-session-1" || valueOrEmpty(mapped.RunID) != "platform-run-1" {
		t.Fatalf("published artifact event = %+v, found = %v", mapped, mappedOK)
	}
	if uploader.calls != 2 {
		t.Fatalf("upload calls after restart = %d, want 2", uploader.calls)
	}
	request := uploader.requests[1]
	if request.Artifact.SessionID != "platform-session-1" || valueOrEmpty(request.Artifact.RunID) != "platform-run-1" {
		t.Fatalf("uploaded artifact identity = %+v", request.Artifact)
	}
	if !bytes.Equal(uploader.contents[1], candidate.Content) {
		t.Fatalf("uploaded artifact content = %q, want %q", uploader.contents[1], candidate.Content)
	}
	if err := adapter.UploadPendingArtifacts(context.Background(), uploader); err != nil {
		t.Fatal(err)
	}
	if uploader.calls != 2 {
		t.Fatalf("uploaded artifact was sent again after durable success: %d calls", uploader.calls)
	}
}

func TestUploadPendingArtifactsRequiresExactSourceMapping(t *testing.T) {
	directory := privateTestDir(t)
	journal, err := OpenJournal(filepath.Join(directory, "journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	outbox, err := OpenArtifactOutbox(filepath.Join(directory, "artifacts.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer outbox.Close()
	candidate := testArtifactCandidate(t)
	if _, _, err := journal.AppendObservedEventWithRecord(testFileChangeEvent(candidate.SourceEventID), candidate.Observation); err != nil {
		t.Fatal(err)
	}
	if _, _, err := outbox.Ensure(candidate); err != nil {
		t.Fatal(err)
	}
	uploader := &artifactUploadProbe{}
	adapter := &Adapter{journal: journal, artifacts: outbox}
	if err := adapter.UploadPendingArtifacts(context.Background(), uploader); !errors.Is(err, ErrArtifactIdentityPending) {
		t.Fatalf("unmapped source upload error = %v", err)
	}
	if uploader.calls != 0 {
		t.Fatalf("unmapped source invoked uploader %d times", uploader.calls)
	}
}

func TestUploadPendingArtifactsSerializesDuplicateCallers(t *testing.T) {
	directory := privateTestDir(t)
	journal, err := OpenJournal(filepath.Join(directory, "journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	outbox, err := OpenArtifactOutbox(filepath.Join(directory, "artifacts.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer outbox.Close()
	alias := SessionAlias{PlatformSessionID: "platform-session-1", AdapterSessionID: "adapter-session-1", ExternalThreadRef: "thread-1", Generation: "generation-1", CommandID: "session-command-1"}
	if err := journal.RecordSessionAlias(alias); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordRunBinding(RunBinding{PlatformSessionID: alias.PlatformSessionID, PlatformRunID: "platform-run-1", CommandID: "run-command-1", AdapterSessionID: alias.AdapterSessionID, ExternalThreadRef: alias.ExternalThreadRef, Generation: alias.Generation, NativeTurnID: "turn-1", State: IdentityStateBound}); err != nil {
		t.Fatal(err)
	}
	observation := EventObservation{AdapterSessionID: alias.AdapterSessionID, ExternalThreadRef: alias.ExternalThreadRef, Generation: alias.Generation, NativeTurnID: "turn-1"}
	source := testFileChangeEvent("source-event-serial")
	if _, _, err := journal.AppendObservedEventWithRecord(source, observation); err != nil {
		t.Fatal(err)
	}
	candidates, _, err := artifactCandidatesFromEventWithReader(context.Background(), source, observation, fixedArtifactReader{content: []byte("new file bytes\n")})
	if err != nil || len(candidates) != 1 {
		t.Fatalf("artifact candidates = %+v, error = %v", candidates, err)
	}
	if _, _, err := outbox.Ensure(candidates[0]); err != nil {
		t.Fatal(err)
	}
	adapter := &Adapter{journal: journal, artifacts: outbox}
	uploader := &blockingArtifactUploader{entered: make(chan struct{}), secondCall: make(chan struct{}, 1), release: make(chan struct{})}
	firstDone := make(chan error, 1)
	go func() { firstDone <- adapter.UploadPendingArtifacts(context.Background(), uploader) }()
	select {
	case <-uploader.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("first artifact upload did not start")
	}
	secondDone := make(chan error, 1)
	go func() { secondDone <- adapter.UploadPendingArtifacts(context.Background(), uploader) }()
	select {
	case <-uploader.secondCall:
		t.Fatal("duplicate artifact upload entered uploader concurrently")
	case <-time.After(50 * time.Millisecond):
	}
	close(uploader.release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if err := <-secondDone; err != nil {
		t.Fatal(err)
	}
	if uploader.calls != 1 {
		t.Fatalf("serialized uploader calls = %d, want 1", uploader.calls)
	}
}

func TestGatewayArtifactUploaderUsesTheAuthenticatedLink(t *testing.T) {
	link := &artifactLinkProbe{}
	uploader, err := NewGatewayArtifactUploader(link)
	if err != nil {
		t.Fatal(err)
	}
	runID := "platform-run-1"
	request := ArtifactUploadRequest{
		Artifact: protocol.Artifact{
			ID:          "artifact-link-1",
			SessionID:   "platform-session-1",
			RunID:       &runID,
			Name:        "source.bin",
			Kind:        protocol.ArtifactKindFile,
			Size:        5,
			Sha256:      "",
			ContentType: "application/octet-stream",
			CreatedAt:   "2026-10-30T01:02:03Z",
		},
		EventID:        "artifact-event-link-1",
		SourceEventID:  "source-event-link-1",
		IdempotencyKey: "artifact-link-1",
		Content:        io.NopCloser(bytes.NewReader([]byte("bytes"))),
	}
	if err := uploader.UploadArtifact(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if link.request.IdempotencyKey != request.IdempotencyKey || link.request.EventID != request.EventID || !bytes.Equal(link.content, []byte("bytes")) {
		t.Fatalf("forwarded gateway request = %+v, content = %q", link.request, link.content)
	}
}

type artifactUploadProbe struct {
	fail     bool
	calls    int
	requests []ArtifactUploadRequest
	contents [][]byte
}

type blockingArtifactUploader struct {
	mu         sync.Mutex
	calls      int
	entered    chan struct{}
	secondCall chan struct{}
	release    chan struct{}
}

type artifactLinkProbe struct {
	request gateway.ArtifactUploadRequest
	content []byte
}

func (p *artifactLinkProbe) SendArtifact(_ context.Context, request gateway.ArtifactUploadRequest) error {
	p.request = request
	var err error
	p.content, err = io.ReadAll(request.Content)
	return err
}

func (u *blockingArtifactUploader) UploadArtifact(_ context.Context, request ArtifactUploadRequest) error {
	if _, err := io.ReadAll(request.Content); err != nil {
		return err
	}
	u.mu.Lock()
	u.calls++
	call := u.calls
	u.mu.Unlock()
	if call == 1 {
		close(u.entered)
		<-u.release
	} else {
		select {
		case u.secondCall <- struct{}{}:
		default:
		}
	}
	return nil
}

func (p *artifactUploadProbe) UploadArtifact(_ context.Context, request ArtifactUploadRequest) error {
	p.calls++
	content, err := io.ReadAll(request.Content)
	if err != nil {
		return err
	}
	p.requests = append(p.requests, request)
	p.contents = append(p.contents, content)
	if p.fail {
		return errors.New("temporary uploader failure")
	}
	return nil
}

func testArtifactCandidate(t *testing.T) ArtifactCandidate {
	t.Helper()
	candidates, _, err := artifactCandidatesFromEventWithReader(context.Background(), testFileChangeEvent("source-event-1"), EventObservation{
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
	}, fixedArtifactReader{content: []byte("new file bytes\n")})
	if err != nil || len(candidates) != 1 {
		t.Fatalf("test artifact candidates = %+v, error = %v", candidates, err)
	}
	return candidates[0]
}

func testFileChangeEvent(eventID string) protocol.Event {
	return protocol.Event{
		EventID:    eventID,
		OccurredAt: "2026-10-30T01:02:03Z",
		Source:     protocol.EventSourceAppServer,
		Type:       protocol.EventTypeItemCompleted,
		SessionID:  "adapter-session-1",
		Payload:    json.RawMessage(`{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"id":"item-1","type":"fileChange","changes":[{"path":"private.txt","kind":{"type":"add"},"diff":"new file bytes\n"}]}}}`),
	}
}

type fixedArtifactReader struct {
	content []byte
	calls   *int
}

func (r fixedArtifactReader) ValidatePath(path string) error {
	if path != "private.txt" {
		return ErrArtifactPathUnauthorized
	}
	return nil
}

func (r fixedArtifactReader) ReadFile(_ context.Context, path string) ([]byte, error) {
	if path != "private.txt" {
		return nil, ErrArtifactPathUnauthorized
	}
	if r.calls != nil {
		(*r.calls)++
	}
	return append([]byte(nil), r.content...), nil
}

func TestCodexArtifactFileReaderUsesBoundedAppServerRead(t *testing.T) {
	workspace := privateTestDir(t)
	filePath := filepath.Join(workspace, "private.txt")
	if err := os.WriteFile(filePath, []byte("final bytes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	transport := newFakeTransport()
	transport.responses["fs/readFile"] = []fakeResult{{message: RPCMessage{Result: mustRawJSON(map[string]string{
		"dataBase64": base64.StdEncoding.EncodeToString([]byte("final bytes\n")),
	})}}}
	reader, err := NewCodexArtifactFileReader(transport, workspace)
	if err != nil {
		t.Fatal(err)
	}
	content, err := reader.ReadFile(context.Background(), "private.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content, []byte("final bytes\n")) {
		t.Fatalf("read artifact content = %q", content)
	}
	if err := reader.ValidatePath("../outside.txt"); !errors.Is(err, ErrArtifactPathUnauthorized) {
		t.Fatalf("path escape validation error = %v", err)
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if len(transport.calls) != 1 || transport.calls[0].method != "fs/readFile" {
		t.Fatalf("app-server calls = %+v", transport.calls)
	}
	var params struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(transport.calls[0].params, &params); err != nil {
		t.Fatal(err)
	}
	canonicalPath, err := filepath.EvalSymlinks(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if params.Path != canonicalPath {
		t.Fatalf("fs/readFile path = %q, want %q", params.Path, canonicalPath)
	}
}
