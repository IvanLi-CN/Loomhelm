package connector

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

const (
	artifactOutboxFormatVersion = 1
	maxArtifactOutboxBytes      = int64(256 << 20)
	maxArtifactRecordBytes      = 8 << 20
	maxArtifactContentBytes     = 4 << 20
	artifactIdentityVersion     = "loomhelm-artifact-v1"
)

var (
	ErrArtifactPublicationConflict = errors.New("artifact publication conflicts with an existing identity")
	ErrArtifactPublicationNotFound = errors.New("artifact publication is not present in the Connector outbox")
	ErrArtifactIdentityPending     = errors.New("artifact publication has no mapped platform run identity")
	ErrArtifactUploaderRequired    = errors.New("artifact uploader is required")
	ErrArtifactUnsupportedEvent    = errors.New("Codex event does not contain a supported artifact payload")
)

// ArtifactPublicationState is local Connector state. The server remains the
// authority for artifact readiness; uploaded means only that the remote
// uploader acknowledged the immutable bytes for this artifact identity.
type ArtifactPublicationState string

const (
	ArtifactPublicationPending  ArtifactPublicationState = "pending"
	ArtifactPublicationUploaded ArtifactPublicationState = "uploaded"
)

// ArtifactCandidate is the host-side, native-identity form of one artifact.
// It deliberately contains no host path: the first supported source is the
// final file-change diff already present in the app-server event payload.
// Platform SessionID and RunID are resolved only after Journal mapping.
type ArtifactCandidate struct {
	ID            string                `json:"id"`
	EventID       string                `json:"event_id"`
	SourceEventID string                `json:"source_event_id"`
	Observation   EventObservation      `json:"observation"`
	Name          string                `json:"name"`
	Kind          protocol.ArtifactKind `json:"kind"`
	Size          int64                 `json:"size"`
	Sha256        string                `json:"sha256"`
	ContentType   string                `json:"content_type"`
	CreatedAt     string                `json:"created_at"`
	EventPayload  json.RawMessage       `json:"event_payload"`
	Content       []byte                `json:"content"`
}

// ArtifactPublication is a durable outbox entry. The content is a bounded
// copy of the event-owned diff, so a reconnect can retry without reopening a
// path supplied by Codex or by an untrusted payload.
type ArtifactPublication struct {
	Candidate ArtifactCandidate        `json:"candidate"`
	State     ArtifactPublicationState `json:"state"`
}

type artifactOutboxRecord struct {
	FormatVersion int                      `json:"format_version"`
	Type          string                   `json:"type"`
	At            string                   `json:"at"`
	Publication   *ArtifactPublication     `json:"publication,omitempty"`
	ArtifactID    string                   `json:"artifact_id,omitempty"`
	State         ArtifactPublicationState `json:"state,omitempty"`
}

// ArtifactOutbox is a Connector-local durable publication ledger. It is
// intentionally separate from Journal's v4 format so older Connector journal
// readers never encounter a new record type. The server-side store is reached
// only through ArtifactUploader; this type never imports or calls artifacts.Store.
type ArtifactOutbox struct {
	mu       sync.Mutex
	path     string
	file     *os.File
	entries  map[string]ArtifactPublication
	fatalErr error
}

// OpenArtifactOutbox opens or creates a mode-0600 Connector artifact ledger.
// The caller owns the returned file and must close it with Close.
func OpenArtifactOutbox(path string) (*ArtifactOutbox, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("artifact outbox path must not be empty")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve artifact outbox path: %w", err)
	}
	if info, statErr := os.Lstat(absPath); statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return nil, errors.New("artifact outbox path must be a regular file")
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return nil, fmt.Errorf("stat artifact outbox: %w", statErr)
	}
	file, err := openJournalFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("open artifact outbox: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("secure artifact outbox: %w", err)
	}
	if err := lockJournalFile(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("lock artifact outbox: %w", err)
	}
	outbox := &ArtifactOutbox{
		path:    absPath,
		file:    file,
		entries: make(map[string]ArtifactPublication),
	}
	if err := outbox.load(); err != nil {
		_ = outbox.Close()
		return nil, err
	}
	return outbox, nil
}

func (o *ArtifactOutbox) Path() string {
	if o == nil {
		return ""
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.path
}

func (o *ArtifactOutbox) Close() error {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.file == nil {
		return nil
	}
	unlockErr := unlockJournalFile(o.file)
	closeErr := o.file.Close()
	o.file = nil
	return errors.Join(unlockErr, closeErr)
}

// Ensure records one immutable publication exactly once. A matching retry is
// deduplicated; different bytes or identity metadata for the same ID fail.
func (o *ArtifactOutbox) Ensure(candidate ArtifactCandidate) (ArtifactPublication, bool, error) {
	publication, err := normalizeArtifactPublication(ArtifactPublication{Candidate: candidate, State: ArtifactPublicationPending})
	if err != nil {
		return ArtifactPublication{}, false, err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.fatalErr != nil {
		return ArtifactPublication{}, false, fmt.Errorf("artifact outbox is unusable: %w", o.fatalErr)
	}
	existing, ok := o.entries[publication.Candidate.ID]
	if ok {
		if !sameArtifactPublication(existing, publication) {
			return ArtifactPublication{}, true, ErrArtifactPublicationConflict
		}
		return cloneArtifactPublication(existing), true, nil
	}
	record := artifactOutboxRecord{
		FormatVersion: artifactOutboxFormatVersion,
		Type:          "publication",
		At:            now(),
		Publication:   &publication,
	}
	if err := o.appendLocked(record); err != nil {
		return ArtifactPublication{}, false, err
	}
	o.entries[publication.Candidate.ID] = publication
	return cloneArtifactPublication(publication), false, nil
}

// MarkUploaded durably records the remote acknowledgement. Repeating the
// acknowledgement is idempotent; a later event send may still fail and will
// be retried independently from the uploaded state.
func (o *ArtifactOutbox) MarkUploaded(id string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.fatalErr != nil {
		return fmt.Errorf("artifact outbox is unusable: %w", o.fatalErr)
	}
	publication, ok := o.entries[strings.TrimSpace(id)]
	if !ok {
		return ErrArtifactPublicationNotFound
	}
	if publication.State == ArtifactPublicationUploaded {
		return nil
	}
	if err := o.appendLocked(artifactOutboxRecord{
		FormatVersion: artifactOutboxFormatVersion,
		Type:          "state",
		At:            now(),
		ArtifactID:    publication.Candidate.ID,
		State:         ArtifactPublicationUploaded,
	}); err != nil {
		return err
	}
	publication.State = ArtifactPublicationUploaded
	o.entries[publication.Candidate.ID] = publication
	return nil
}

func (o *ArtifactOutbox) Publication(id string) (ArtifactPublication, bool) {
	if o == nil {
		return ArtifactPublication{}, false
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	publication, ok := o.entries[strings.TrimSpace(id)]
	return cloneArtifactPublication(publication), ok
}

func (o *ArtifactOutbox) PublicationForEvent(eventID string) (ArtifactPublication, bool) {
	if o == nil {
		return ArtifactPublication{}, false
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, publication := range o.entries {
		if publication.Candidate.EventID == strings.TrimSpace(eventID) {
			return cloneArtifactPublication(publication), true
		}
	}
	return ArtifactPublication{}, false
}

func (o *ArtifactOutbox) Publications() []ArtifactPublication {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	values := make([]ArtifactPublication, 0, len(o.entries))
	for _, publication := range o.entries {
		values = append(values, cloneArtifactPublication(publication))
	}
	sort.Slice(values, func(i, j int) bool { return values[i].Candidate.ID < values[j].Candidate.ID })
	return values
}

func (o *ArtifactOutbox) Pending() []ArtifactPublication {
	values := o.Publications()
	filtered := values[:0]
	for _, publication := range values {
		if publication.State == ArtifactPublicationPending {
			filtered = append(filtered, publication)
		}
	}
	return filtered
}

func (o *ArtifactOutbox) load() error {
	if o == nil || o.file == nil {
		return errors.New("artifact outbox is not open")
	}
	info, err := o.file.Stat()
	if err != nil {
		return fmt.Errorf("stat artifact outbox: %w", err)
	}
	if info.Size() > maxArtifactOutboxBytes {
		return fmt.Errorf("artifact outbox file size %d exceeds %d bytes: %w", info.Size(), maxArtifactOutboxBytes, ErrJournalTooLarge)
	}
	if _, err := o.file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind artifact outbox: %w", err)
	}
	reader := bufio.NewReader(o.file)
	var seenHeader bool
	var validBytes int64
	var needsNewline bool
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > maxArtifactRecordBytes {
			return fmt.Errorf("artifact outbox record exceeds %d bytes: %w", maxArtifactRecordBytes, ErrJournalTooLarge)
		}
		if len(bytes.TrimSpace(line)) == 0 && err == io.EOF {
			break
		}
		if err == io.EOF {
			trimmed := bytes.TrimSpace(line)
			if len(trimmed) != 0 {
				var record artifactOutboxRecord
				if decodeErr := json.Unmarshal(trimmed, &record); decodeErr == nil {
					if applyErr := o.applyRecord(record, &seenHeader); applyErr != nil {
						return applyErr
					}
					validBytes += int64(len(line))
					needsNewline = true
				} else if truncateErr := o.file.Truncate(validBytes); truncateErr != nil {
					return fmt.Errorf("truncate incomplete artifact outbox record: %w", truncateErr)
				} else if syncErr := o.file.Sync(); syncErr != nil {
					return fmt.Errorf("sync artifact outbox truncation: %w", syncErr)
				}
			}
			break
		}
		if err != nil {
			return fmt.Errorf("read artifact outbox: %w", err)
		}
		var record artifactOutboxRecord
		if err := json.Unmarshal(bytes.TrimSpace(line), &record); err != nil {
			return fmt.Errorf("decode artifact outbox: %w", ErrJournalCorrupt)
		}
		if err := o.applyRecord(record, &seenHeader); err != nil {
			return err
		}
		validBytes += int64(len(line))
	}
	if !seenHeader {
		if err := o.appendLocked(artifactOutboxRecord{FormatVersion: artifactOutboxFormatVersion, Type: "header", At: now()}); err != nil {
			return err
		}
	} else if needsNewline {
		if _, err := o.file.Write([]byte{'\n'}); err != nil {
			return fmt.Errorf("terminate artifact outbox record: %w", err)
		}
		if err := o.file.Sync(); err != nil {
			return fmt.Errorf("sync artifact outbox record terminator: %w", err)
		}
	}
	if _, err := o.file.Seek(0, io.SeekEnd); err != nil {
		return fmt.Errorf("seek artifact outbox end: %w", err)
	}
	return nil
}

func (o *ArtifactOutbox) applyRecord(record artifactOutboxRecord, seenHeader *bool) error {
	if record.FormatVersion != artifactOutboxFormatVersion {
		return fmt.Errorf("%w: unsupported artifact outbox format version %d", ErrJournalCorrupt, record.FormatVersion)
	}
	switch record.Type {
	case "header":
		if *seenHeader || record.Publication != nil {
			return fmt.Errorf("%w: invalid artifact outbox header", ErrJournalCorrupt)
		}
		*seenHeader = true
	case "publication":
		if !*seenHeader || record.Publication == nil {
			return fmt.Errorf("%w: artifact publication appears before header", ErrJournalCorrupt)
		}
		publication, err := normalizeArtifactPublication(*record.Publication)
		if err != nil {
			return fmt.Errorf("%w: invalid artifact publication: %v", ErrJournalCorrupt, err)
		}
		if existing, ok := o.entries[publication.Candidate.ID]; ok && !sameArtifactPublication(existing, publication) {
			return fmt.Errorf("%w: conflicting artifact publication %q", ErrJournalCorrupt, publication.Candidate.ID)
		}
		if existing, ok := o.entries[publication.Candidate.ID]; ok && existing.State == ArtifactPublicationUploaded {
			publication.State = ArtifactPublicationUploaded
		}
		o.entries[publication.Candidate.ID] = publication
	case "state":
		if !*seenHeader || record.ArtifactID == "" || record.State != ArtifactPublicationUploaded {
			return fmt.Errorf("%w: invalid artifact publication state", ErrJournalCorrupt)
		}
		publication, ok := o.entries[record.ArtifactID]
		if !ok {
			return fmt.Errorf("%w: artifact state has no publication %q", ErrJournalCorrupt, record.ArtifactID)
		}
		publication.State = ArtifactPublicationUploaded
		o.entries[record.ArtifactID] = publication
	default:
		return fmt.Errorf("%w: unknown artifact outbox record %q", ErrJournalCorrupt, record.Type)
	}
	return nil
}

func (o *ArtifactOutbox) appendLocked(record artifactOutboxRecord) error {
	if o.fatalErr != nil {
		return fmt.Errorf("artifact outbox is unusable: %w", o.fatalErr)
	}
	data, err := json.Marshal(record)
	if err != nil {
		return o.poison(fmt.Errorf("encode artifact outbox: %w", err))
	}
	data = append(data, '\n')
	if len(data) > maxArtifactRecordBytes {
		return fmt.Errorf("artifact outbox record exceeds %d bytes: %w", maxArtifactRecordBytes, ErrJournalTooLarge)
	}
	if info, err := o.file.Stat(); err != nil {
		return o.poison(fmt.Errorf("stat artifact outbox: %w", err))
	} else if info.Size() > maxArtifactOutboxBytes-int64(len(data)) {
		return o.poison(fmt.Errorf("artifact outbox exceeds %d bytes: %w", maxArtifactOutboxBytes, ErrJournalTooLarge))
	}
	if _, err := o.file.Seek(0, io.SeekEnd); err != nil {
		return o.poison(fmt.Errorf("seek artifact outbox: %w", err))
	}
	if _, err := writeAll(o.file, data); err != nil {
		return o.poison(fmt.Errorf("write artifact outbox: %w", err))
	}
	if err := o.file.Sync(); err != nil {
		return o.poison(fmt.Errorf("sync artifact outbox: %w", err))
	}
	return nil
}

func (o *ArtifactOutbox) poison(err error) error {
	if o.fatalErr == nil {
		o.fatalErr = err
	}
	return fmt.Errorf("artifact outbox write path is unusable: %w", o.fatalErr)
}

// ArtifactUploadRequest is the only Connector-to-server publication seam.
// Implementations must send the request over the already authenticated
// platform link, preserve IdempotencyKey, and close Content exactly once.
// ArtifactStore is intentionally not part of this interface.
type ArtifactUploadRequest struct {
	Artifact       protocol.Artifact
	EventID        string
	SourceEventID  string
	IdempotencyKey string
	Content        io.ReadCloser
}

type ArtifactUploader interface {
	UploadArtifact(context.Context, ArtifactUploadRequest) error
}

func (p ArtifactPublication) ContentReader() io.ReadCloser {
	return io.NopCloser(bytes.NewReader(append([]byte(nil), p.Candidate.Content...)))
}

func normalizeArtifactPublication(publication ArtifactPublication) (ArtifactPublication, error) {
	candidate := publication.Candidate
	candidate.ID = strings.TrimSpace(candidate.ID)
	candidate.EventID = strings.TrimSpace(candidate.EventID)
	candidate.SourceEventID = strings.TrimSpace(candidate.SourceEventID)
	candidate.Name = strings.TrimSpace(candidate.Name)
	candidate.ContentType = strings.TrimSpace(candidate.ContentType)
	candidate.CreatedAt = strings.TrimSpace(candidate.CreatedAt)
	candidate.Sha256 = strings.ToLower(strings.TrimSpace(candidate.Sha256))
	candidate.EventPayload = append(json.RawMessage(nil), candidate.EventPayload...)
	candidate.Content = append([]byte(nil), candidate.Content...)
	if err := requireIdentityParts("artifact candidate", candidate.ID, candidate.EventID, candidate.SourceEventID, candidate.Observation.AdapterSessionID, candidate.Observation.ExternalThreadRef, candidate.Observation.Generation, candidate.Observation.NativeTurnID); err != nil {
		return ArtifactPublication{}, err
	}
	if candidate.Name == "" || strings.ContainsAny(candidate.Name, "/\\") || strings.ContainsRune(candidate.Name, '\x00') {
		return ArtifactPublication{}, errors.New("artifact candidate name is invalid")
	}
	if candidate.Kind != protocol.ArtifactKindDiff {
		return ArtifactPublication{}, fmt.Errorf("artifact candidate kind %q is unsupported", candidate.Kind)
	}
	if candidate.ContentType != "text/x-diff" {
		return ArtifactPublication{}, errors.New("artifact candidate content type is unsupported")
	}
	if candidate.Size < 0 || candidate.Size > maxArtifactContentBytes || int64(len(candidate.Content)) != candidate.Size {
		return ArtifactPublication{}, errors.New("artifact candidate content size is invalid")
	}
	sum := sha256.Sum256(candidate.Content)
	if candidate.Sha256 == "" {
		candidate.Sha256 = hex.EncodeToString(sum[:])
	} else if candidate.Sha256 != hex.EncodeToString(sum[:]) {
		return ArtifactPublication{}, errors.New("artifact candidate content hash is invalid")
	}
	if candidate.CreatedAt == "" {
		candidate.CreatedAt = now()
	} else if _, err := time.Parse(time.RFC3339Nano, candidate.CreatedAt); err != nil {
		return ArtifactPublication{}, errors.New("artifact candidate created_at is invalid")
	}
	if !json.Valid(candidate.EventPayload) {
		return ArtifactPublication{}, errors.New("artifact candidate event payload must be valid JSON")
	}
	state := publication.State
	if state == "" {
		state = ArtifactPublicationPending
	}
	if state != ArtifactPublicationPending && state != ArtifactPublicationUploaded {
		return ArtifactPublication{}, fmt.Errorf("artifact publication state %q is invalid", state)
	}
	publication.Candidate = candidate
	publication.State = state
	return publication, nil
}

func sameArtifactPublication(left, right ArtifactPublication) bool {
	return left.Candidate.ID == right.Candidate.ID &&
		left.Candidate.EventID == right.Candidate.EventID &&
		left.Candidate.SourceEventID == right.Candidate.SourceEventID &&
		left.Candidate.Observation == right.Candidate.Observation &&
		left.Candidate.Name == right.Candidate.Name &&
		left.Candidate.Kind == right.Candidate.Kind &&
		left.Candidate.Size == right.Candidate.Size &&
		left.Candidate.Sha256 == right.Candidate.Sha256 &&
		left.Candidate.ContentType == right.Candidate.ContentType &&
		left.Candidate.CreatedAt == right.Candidate.CreatedAt &&
		bytes.Equal(left.Candidate.EventPayload, right.Candidate.EventPayload) &&
		bytes.Equal(left.Candidate.Content, right.Candidate.Content)
}

func cloneArtifactPublication(value ArtifactPublication) ArtifactPublication {
	value.Candidate.EventPayload = append(json.RawMessage(nil), value.Candidate.EventPayload...)
	value.Candidate.Content = append([]byte(nil), value.Candidate.Content...)
	return value
}

type fileChangeEvent struct {
	Method string `json:"method"`
	Params struct {
		Item struct {
			ID      string `json:"id"`
			Type    string `json:"type"`
			Changes []struct {
				Diff string `json:"diff"`
			} `json:"changes"`
		} `json:"item"`
	} `json:"params"`
}

// artifactCandidatesFromEvent accepts only the documented final item shape
// already preserved by Adapter.observe. It never follows the event's path;
// only the final diff bytes are eligible for remote publication.
func artifactCandidatesFromEvent(event protocol.Event, observation EventObservation) ([]ArtifactCandidate, error) {
	if event.Type != protocol.EventTypeItemCompleted || event.Source != protocol.EventSourceAppServer {
		return nil, nil
	}
	var message fileChangeEvent
	if err := json.Unmarshal(event.Payload, &message); err != nil {
		return nil, nil
	}
	if message.Method != "item/completed" || message.Params.Item.Type != "fileChange" || message.Params.Item.ID == "" || len(message.Params.Item.Changes) == 0 {
		return nil, nil
	}
	if observation.NativeTurnID == "" {
		return nil, nil
	}
	values := make([]ArtifactCandidate, 0, len(message.Params.Item.Changes))
	for index, change := range message.Params.Item.Changes {
		content := []byte(change.Diff)
		if len(content) == 0 {
			continue
		}
		if int64(len(content)) > maxArtifactContentBytes {
			return nil, fmt.Errorf("file-change diff %d exceeds %d bytes: %w", index, maxArtifactContentBytes, ErrJournalTooLarge)
		}
		identity := strings.Join([]string{
			artifactIdentityVersion,
			observation.AdapterSessionID,
			observation.ExternalThreadRef,
			observation.Generation,
			observation.NativeTurnID,
			message.Params.Item.ID,
			fmt.Sprintf("%d", index),
		}, "\x00")
		artifactID := "artifact-" + digestString(identity)
		eventID := "artifact-event-" + digestString(artifactID)
		sum := sha256.Sum256(content)
		candidate := ArtifactCandidate{
			ID:            artifactID,
			EventID:       eventID,
			SourceEventID: event.EventID,
			Observation:   observation,
			Name:          "artifact-" + digestString(identity)[:32] + ".diff",
			Kind:          protocol.ArtifactKindDiff,
			Size:          int64(len(content)),
			Sha256:        hex.EncodeToString(sum[:]),
			ContentType:   "text/x-diff",
			CreatedAt:     event.OccurredAt,
			Content:       content,
		}
		candidate.EventPayload = artifactEventPayload(candidate)
		values = append(values, candidate)
	}
	return values, nil
}

func artifactEventPayload(candidate ArtifactCandidate) json.RawMessage {
	value := struct {
		Artifact struct {
			ID          string                `json:"id"`
			Name        string                `json:"name"`
			Kind        protocol.ArtifactKind `json:"kind"`
			Size        int64                 `json:"size"`
			Sha256      string                `json:"sha256"`
			ContentType string                `json:"content_type"`
			CreatedAt   string                `json:"created_at"`
		} `json:"artifact"`
		SourceEventID string `json:"source_event_id"`
	}{SourceEventID: candidate.SourceEventID}
	value.Artifact.ID = candidate.ID
	value.Artifact.Name = candidate.Name
	value.Artifact.Kind = candidate.Kind
	value.Artifact.Size = candidate.Size
	value.Artifact.Sha256 = candidate.Sha256
	value.Artifact.ContentType = candidate.ContentType
	value.Artifact.CreatedAt = candidate.CreatedAt
	encoded, _ := json.Marshal(value)
	return encoded
}

func artifactEvent(candidate ArtifactCandidate) protocol.Event {
	return protocol.Event{
		EventID:   candidate.EventID,
		SessionID: candidate.Observation.AdapterSessionID,
		Type:      protocol.EventTypeArtifactCreated,
		Source:    protocol.EventSourceArtifact,
		Payload:   append(json.RawMessage(nil), candidate.EventPayload...),
	}
}
