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
	"testing"

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
	candidates, err := artifactCandidatesFromEvent(source, observation)
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

type artifactUploadProbe struct {
	fail     bool
	calls    int
	requests []ArtifactUploadRequest
	contents [][]byte
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
	candidates, err := artifactCandidatesFromEvent(testFileChangeEvent("source-event-1"), EventObservation{
		AdapterSessionID:  "adapter-session-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
	})
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
}

func (r fixedArtifactReader) ValidatePath(path string) error {
	if path != "private.txt" {
		return ErrArtifactPathUnauthorized
	}
	return nil
}

func (r fixedArtifactReader) ReadFile(context.Context, string) ([]byte, error) {
	return append([]byte(nil), r.content...), nil
}

func TestCodexArtifactFileReaderUsesBoundedAppServerRead(t *testing.T) {
	workspace := privateTestDir(t)
	filePath := filepath.Join(workspace, "private.txt")
	if err := os.WriteFile(filePath, []byte("host placeholder\n"), 0o600); err != nil {
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
	if params.Path != filePath {
		t.Fatalf("fs/readFile path = %q, want %q", params.Path, filePath)
	}
}
