package connector

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
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
	artifactReadTimeout         = 10 * time.Second
	artifactIdentityVersion     = "loomhelm-artifact-v1"
)

var (
	ErrArtifactPublicationConflict = errors.New("artifact publication conflicts with an existing identity")
	ErrArtifactPublicationNotFound = errors.New("artifact publication is not present in the Connector outbox")
	ErrArtifactIdentityPending     = errors.New("artifact publication has no mapped platform run identity")
	ErrArtifactUploaderRequired    = errors.New("artifact uploader is required")
	ErrArtifactUnsupportedEvent    = errors.New("Codex event does not contain a supported artifact payload")
	ErrArtifactWorkspaceRequired   = errors.New("artifact publication has no verified Codex workspace")
	ErrArtifactPathUnauthorized    = errors.New("artifact path is outside the authorized Codex workspace")
	ErrArtifactSourceUnavailable   = errors.New("artifact source is not available")
)

// ArtifactPublicationState is local Connector state. The server remains the
// authority for artifact readiness; uploaded means only that the remote
// uploader acknowledged the immutable bytes for this artifact identity, while
// rejected records a durable non-retryable server rejection.
type ArtifactPublicationState string

const (
	ArtifactPublicationPending  ArtifactPublicationState = "pending"
	ArtifactPublicationUploaded ArtifactPublicationState = "uploaded"
	ArtifactPublicationRejected ArtifactPublicationState = "rejected"
)

// ArtifactCandidate is the host-side, native-identity form of one artifact.
// It deliberately contains no host path: file bytes come from the authorized
// app-server fs/readFile operation. Paths are used only transiently for
// validation and identity hashing.
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
	Provenance    string                `json:"provenance"`
	EventPayload  json.RawMessage       `json:"event_payload"`
	Content       []byte                `json:"content"`
}

// ArtifactCaptureGap is a durable, non-product-facing record that explains
// why a supported file-change event did not yield original file bytes. It
// carries no host path or error text, so a path cannot escape through the
// Connector journal or a later platform event.
type ArtifactCaptureGap struct {
	ID            string           `json:"id"`
	SourceEventID string           `json:"source_event_id"`
	ChangeKind    string           `json:"change_kind"`
	Reason        string           `json:"reason"`
	Observation   EventObservation `json:"observation"`
}

// ArtifactPublication is a durable outbox entry. The content is a bounded
// copy of the event-owned file bytes, so a reconnect can retry without
// reopening a path supplied by Codex or by an untrusted payload.
type ArtifactPublication struct {
	Candidate     ArtifactCandidate        `json:"candidate"`
	State         ArtifactPublicationState `json:"state"`
	RejectionCode string                   `json:"rejection_code,omitempty"`
}

type artifactOutboxRecord struct {
	FormatVersion int                      `json:"format_version"`
	Type          string                   `json:"type"`
	At            string                   `json:"at"`
	Publication   *ArtifactPublication     `json:"publication,omitempty"`
	Gap           *ArtifactCaptureGap      `json:"gap,omitempty"`
	ArtifactID    string                   `json:"artifact_id,omitempty"`
	State         ArtifactPublicationState `json:"state,omitempty"`
	RejectionCode string                   `json:"rejection_code,omitempty"`
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
	gaps     map[string]ArtifactCaptureGap
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
		gaps:    make(map[string]ArtifactCaptureGap),
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

// RecordGap durably records a source-recovery gap without retaining the
// untrusted host path. Repeating the same gap identity is idempotent; a
// changed reason for the same identity is a corruption/conflict signal.
func (o *ArtifactOutbox) RecordGap(gap ArtifactCaptureGap) error {
	if o == nil {
		return errors.New("artifact outbox is not open")
	}
	normalized, err := normalizeArtifactCaptureGap(gap)
	if err != nil {
		return err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.fatalErr != nil {
		return fmt.Errorf("artifact outbox is unusable: %w", o.fatalErr)
	}
	if existing, ok := o.gaps[normalized.ID]; ok {
		if existing.SourceEventID == normalized.SourceEventID && existing.ChangeKind == normalized.ChangeKind && existing.Reason == normalized.Reason && existing.Observation == normalized.Observation {
			return nil
		}
		return ErrArtifactPublicationConflict
	}
	if err := o.appendLocked(artifactOutboxRecord{
		FormatVersion: artifactOutboxFormatVersion,
		Type:          "gap",
		At:            now(),
		Gap:           &normalized,
	}); err != nil {
		return err
	}
	o.gaps[normalized.ID] = normalized
	return nil
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
	if publication.State == ArtifactPublicationRejected {
		return ErrArtifactPublicationConflict
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

// MarkRejected durably records a non-retryable server rejection. The
// immutable candidate remains available for diagnostics, but Pending excludes
// it so one bad publication cannot tear down or starve the gateway connection.
func (o *ArtifactOutbox) MarkRejected(id, code string) error {
	if o == nil {
		return errors.New("artifact outbox is not open")
	}
	code, err := normalizeArtifactRejectionCode(code)
	if err != nil {
		return err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.fatalErr != nil {
		return fmt.Errorf("artifact outbox is unusable: %w", o.fatalErr)
	}
	publication, ok := o.entries[strings.TrimSpace(id)]
	if !ok {
		return ErrArtifactPublicationNotFound
	}
	if publication.State == ArtifactPublicationRejected {
		if publication.RejectionCode == code {
			return nil
		}
		return ErrArtifactPublicationConflict
	}
	if publication.State == ArtifactPublicationUploaded {
		return ErrArtifactPublicationConflict
	}
	if err := o.appendLocked(artifactOutboxRecord{
		FormatVersion: artifactOutboxFormatVersion,
		Type:          "state",
		At:            now(),
		ArtifactID:    publication.Candidate.ID,
		State:         ArtifactPublicationRejected,
		RejectionCode: code,
	}); err != nil {
		return err
	}
	publication.State = ArtifactPublicationRejected
	publication.RejectionCode = code
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

// Gaps returns stable, non-sensitive source-recovery gaps for diagnostics and
// later reconciliation. It never returns raw file paths.
func (o *ArtifactOutbox) Gaps() []ArtifactCaptureGap {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	values := make([]ArtifactCaptureGap, 0, len(o.gaps))
	for _, gap := range o.gaps {
		values = append(values, gap)
	}
	sort.Slice(values, func(i, j int) bool { return values[i].ID < values[j].ID })
	return values
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
		if *seenHeader || record.Publication != nil || record.Gap != nil {
			return fmt.Errorf("%w: invalid artifact outbox header", ErrJournalCorrupt)
		}
		*seenHeader = true
	case "publication":
		if !*seenHeader || record.Publication == nil || record.Gap != nil {
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
	case "gap":
		if !*seenHeader || record.Gap == nil || record.Publication != nil {
			return fmt.Errorf("%w: invalid artifact capture gap", ErrJournalCorrupt)
		}
		gap, err := normalizeArtifactCaptureGap(*record.Gap)
		if err != nil {
			return fmt.Errorf("%w: invalid artifact capture gap: %v", ErrJournalCorrupt, err)
		}
		if existing, ok := o.gaps[gap.ID]; ok && (existing.SourceEventID != gap.SourceEventID || existing.ChangeKind != gap.ChangeKind || existing.Reason != gap.Reason || existing.Observation != gap.Observation) {
			return fmt.Errorf("%w: conflicting artifact capture gap %q", ErrJournalCorrupt, gap.ID)
		}
		o.gaps[gap.ID] = gap
	case "state":
		if !*seenHeader || record.ArtifactID == "" || record.Publication != nil || record.Gap != nil || (record.State != ArtifactPublicationUploaded && record.State != ArtifactPublicationRejected) {
			return fmt.Errorf("%w: invalid artifact publication state", ErrJournalCorrupt)
		}
		rejectionCode := ""
		if record.State == ArtifactPublicationRejected {
			normalizedCode, normalizeErr := normalizeArtifactRejectionCode(record.RejectionCode)
			if normalizeErr != nil {
				return fmt.Errorf("%w: invalid artifact rejection: %v", ErrJournalCorrupt, normalizeErr)
			}
			rejectionCode = normalizedCode
		} else if record.RejectionCode != "" {
			return fmt.Errorf("%w: uploaded artifact contains a rejection code", ErrJournalCorrupt)
		}
		publication, ok := o.entries[record.ArtifactID]
		if !ok {
			return fmt.Errorf("%w: artifact state has no publication %q", ErrJournalCorrupt, record.ArtifactID)
		}
		publication.State = record.State
		publication.RejectionCode = rejectionCode
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

type ArtifactPublicationUploadError struct {
	ArtifactID string
	Err        error
}

func (e *ArtifactPublicationUploadError) Error() string {
	if e == nil {
		return "artifact publication upload failed"
	}
	return fmt.Sprintf("upload artifact publication %q: %v", e.ArtifactID, e.Err)
}

func (e *ArtifactPublicationUploadError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
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
	candidate.Provenance = strings.TrimSpace(candidate.Provenance)
	candidate.Sha256 = strings.ToLower(strings.TrimSpace(candidate.Sha256))
	candidate.EventPayload = append(json.RawMessage(nil), candidate.EventPayload...)
	candidate.Content = append([]byte(nil), candidate.Content...)
	if err := requireIdentityParts("artifact candidate", candidate.ID, candidate.EventID, candidate.SourceEventID, candidate.Observation.AdapterSessionID, candidate.Observation.ExternalThreadRef, candidate.Observation.Generation, candidate.Observation.NativeTurnID); err != nil {
		return ArtifactPublication{}, err
	}
	if candidate.Name == "" || strings.ContainsAny(candidate.Name, "/\\") || strings.ContainsRune(candidate.Name, '\x00') {
		return ArtifactPublication{}, errors.New("artifact candidate name is invalid")
	}
	switch candidate.Kind {
	case protocol.ArtifactKindDiff:
		if candidate.ContentType != "text/x-diff" {
			return ArtifactPublication{}, errors.New("artifact diff content type is unsupported")
		}
		if candidate.Provenance == "" {
			candidate.Provenance = "legacy-diff"
		}
	case protocol.ArtifactKindFile:
		if candidate.ContentType != "application/octet-stream" {
			return ArtifactPublication{}, errors.New("artifact file content type is unsupported")
		}
		if candidate.Provenance == "" {
			return ArtifactPublication{}, errors.New("artifact file provenance is required")
		}
	default:
		return ArtifactPublication{}, fmt.Errorf("artifact candidate kind %q is unsupported", candidate.Kind)
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
	rejectionCode := strings.TrimSpace(publication.RejectionCode)
	if state != ArtifactPublicationPending && state != ArtifactPublicationUploaded && state != ArtifactPublicationRejected {
		return ArtifactPublication{}, fmt.Errorf("artifact publication state %q is invalid", state)
	}
	if state == ArtifactPublicationRejected {
		normalizedCode, normalizeErr := normalizeArtifactRejectionCode(rejectionCode)
		if normalizeErr != nil {
			return ArtifactPublication{}, normalizeErr
		}
		rejectionCode = normalizedCode
	} else if rejectionCode != "" {
		return ArtifactPublication{}, errors.New("artifact publication rejection code requires rejected state")
	}
	publication.Candidate = candidate
	publication.State = state
	publication.RejectionCode = rejectionCode
	return publication, nil
}

func normalizeArtifactRejectionCode(code string) (string, error) {
	code = strings.TrimSpace(code)
	if code == "" || len(code) > 128 || strings.ContainsAny(code, "\r\n") {
		return "", errors.New("artifact rejection code is invalid")
	}
	return code, nil
}

func normalizeArtifactCaptureGap(gap ArtifactCaptureGap) (ArtifactCaptureGap, error) {
	gap.ID = strings.TrimSpace(gap.ID)
	gap.SourceEventID = strings.TrimSpace(gap.SourceEventID)
	gap.ChangeKind = normalizeArtifactChangeKind(gap.ChangeKind)
	gap.Reason = strings.TrimSpace(gap.Reason)
	if err := requireIdentityParts("artifact capture gap", gap.ID, gap.SourceEventID, gap.ChangeKind, gap.Reason, gap.Observation.AdapterSessionID, gap.Observation.ExternalThreadRef, gap.Observation.Generation, gap.Observation.NativeTurnID); err != nil {
		return ArtifactCaptureGap{}, err
	}
	if strings.ContainsAny(gap.Reason, "\r\n") || len(gap.Reason) > 256 {
		return ArtifactCaptureGap{}, errors.New("artifact capture gap reason is invalid")
	}
	switch gap.Reason {
	case "content_too_large", "file_bytes_unavailable", "path_outside_authorized_workspace", "unsupported_change_kind", "workspace_unconfigured":
	default:
		return ArtifactCaptureGap{}, errors.New("artifact capture gap reason is unsupported")
	}
	return gap, nil
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
		left.Candidate.Provenance == right.Candidate.Provenance &&
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
				Path string          `json:"path"`
				Kind json.RawMessage `json:"kind"`
				Diff string          `json:"diff"`
			} `json:"changes"`
		} `json:"item"`
	} `json:"params"`
}

// ArtifactContentReader is the controlled source for original/final file
// bytes. Implementations must validate the event path against an authorized
// workspace before reading it.
type ArtifactContentReader interface {
	ValidatePath(string) error
	ReadFile(context.Context, string) ([]byte, error)
}

// CodexArtifactFileReader uses the existing host-owned app-server transport.
// It pins an authorized local workspace read with os.Root and confirms the
// same bytes through fs/readFile, so an event path cannot turn a check-then-use
// race into an artifact containing bytes outside the workspace.
type CodexArtifactFileReader struct {
	transport     RPCTransport
	workspace     string
	canonicalRoot string
}

// NewCodexArtifactFileReader admits one existing app-server transport and one
// explicit workspace root. The root must already exist as a directory; no
// environment, credential or alternate Codex configuration is introduced.
func NewCodexArtifactFileReader(transport RPCTransport, workspace string) (*CodexArtifactFileReader, error) {
	if transport == nil {
		return nil, errors.New("Codex artifact file transport must not be nil")
	}
	workspace = strings.TrimSpace(workspace)
	if workspace == "" {
		return nil, ErrArtifactWorkspaceRequired
	}
	absWorkspace, err := filepath.Abs(workspace)
	if err != nil {
		return nil, fmt.Errorf("resolve Codex artifact workspace: %w", err)
	}
	info, err := os.Stat(absWorkspace)
	if err != nil {
		return nil, fmt.Errorf("stat Codex artifact workspace: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("Codex artifact workspace must be a directory")
	}
	canonicalRoot, err := filepath.EvalSymlinks(absWorkspace)
	if err != nil {
		return nil, fmt.Errorf("canonicalize Codex artifact workspace: %w", err)
	}
	return &CodexArtifactFileReader{transport: transport, workspace: filepath.Clean(absWorkspace), canonicalRoot: filepath.Clean(canonicalRoot)}, nil
}

func (r *CodexArtifactFileReader) ValidatePath(eventPath string) error {
	_, err := r.resolvePath(eventPath, false)
	return err
}

func (r *CodexArtifactFileReader) ReadFile(ctx context.Context, eventPath string) ([]byte, error) {
	if ctx == nil {
		return nil, fmt.Errorf("read Codex artifact file: %w", ErrArtifactSourceUnavailable)
	}
	path, err := r.resolvePath(eventPath, true)
	if err != nil {
		return nil, err
	}
	localContent, err := r.readAuthorizedFile(path)
	if err != nil {
		return nil, err
	}
	response, err := r.transport.Call(ctx, "fs/readFile", mustRawJSON(map[string]string{"path": path}))
	if err != nil {
		return nil, fmt.Errorf("Codex fs/readFile: %w", err)
	}
	if response.Error != nil {
		return nil, fmt.Errorf("Codex fs/readFile: %w", rpcResponseError("fs/readFile", response))
	}
	var result struct {
		DataBase64 *string `json:"dataBase64"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil || result.DataBase64 == nil {
		return nil, fmt.Errorf("Codex fs/readFile returned invalid data: %w", ErrArtifactSourceUnavailable)
	}
	if len(*result.DataBase64) > base64.StdEncoding.EncodedLen(maxArtifactContentBytes) {
		return nil, fmt.Errorf("Codex fs/readFile returned oversized data: %w", ErrJournalTooLarge)
	}
	content, err := base64.StdEncoding.DecodeString(*result.DataBase64)
	if err != nil {
		return nil, fmt.Errorf("decode Codex fs/readFile data: %w", ErrArtifactSourceUnavailable)
	}
	if int64(len(content)) > maxArtifactContentBytes {
		return nil, fmt.Errorf("Codex fs/readFile returned oversized data: %w", ErrJournalTooLarge)
	}
	if !bytes.Equal(content, localContent) {
		return nil, fmt.Errorf("Codex fs/readFile content changed during authorized read: %w", ErrArtifactSourceUnavailable)
	}
	return localContent, nil
}

func (r *CodexArtifactFileReader) readAuthorizedFile(path string) ([]byte, error) {
	if r == nil || r.canonicalRoot == "" {
		return nil, ErrArtifactWorkspaceRequired
	}
	relative, err := filepath.Rel(r.canonicalRoot, path)
	if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, ErrArtifactPathUnauthorized
	}
	root, err := os.OpenRoot(r.canonicalRoot)
	if err != nil {
		return nil, fmt.Errorf("open Codex artifact workspace root: %w", ErrArtifactSourceUnavailable)
	}
	defer root.Close()
	file, err := root.Open(relative)
	if err != nil {
		return nil, fmt.Errorf("open Codex artifact file: %w", ErrArtifactSourceUnavailable)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat Codex artifact file: %w", ErrArtifactSourceUnavailable)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("Codex artifact path is not a regular file: %w", ErrArtifactSourceUnavailable)
	}
	if info.Size() > maxArtifactContentBytes {
		return nil, fmt.Errorf("Codex artifact path exceeds %d bytes: %w", maxArtifactContentBytes, ErrJournalTooLarge)
	}
	content, err := io.ReadAll(io.LimitReader(file, maxArtifactContentBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read Codex artifact file: %w", ErrArtifactSourceUnavailable)
	}
	if int64(len(content)) > maxArtifactContentBytes {
		return nil, fmt.Errorf("Codex artifact path exceeds %d bytes: %w", maxArtifactContentBytes, ErrJournalTooLarge)
	}
	return content, nil
}

func (r *CodexArtifactFileReader) resolvePath(eventPath string, requireFile bool) (string, error) {
	if r == nil || r.transport == nil || r.workspace == "" || r.canonicalRoot == "" {
		return "", ErrArtifactWorkspaceRequired
	}
	raw := strings.TrimSpace(eventPath)
	if raw == "" || strings.ContainsRune(raw, '\x00') || len(raw) > 4096 {
		return "", ErrArtifactPathUnauthorized
	}
	clean := filepath.Clean(filepath.FromSlash(raw))
	target := clean
	if !filepath.IsAbs(target) {
		target = filepath.Join(r.workspace, target)
	}
	target = filepath.Clean(target)
	if !pathWithinRoot(r.workspace, target) {
		return "", ErrArtifactPathUnauthorized
	}
	if err := rejectSymlinkComponents(r.workspace, target); err != nil {
		return "", err
	}
	canonical, err := filepath.EvalSymlinks(target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && !requireFile {
			return target, nil
		}
		return "", fmt.Errorf("resolve Codex artifact path: %w", ErrArtifactSourceUnavailable)
	}
	canonical = filepath.Clean(canonical)
	if !pathWithinRoot(r.canonicalRoot, canonical) {
		return "", ErrArtifactPathUnauthorized
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", fmt.Errorf("stat Codex artifact path: %w", ErrArtifactSourceUnavailable)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("Codex artifact path is not a regular file: %w", ErrArtifactSourceUnavailable)
	}
	if info.Size() > maxArtifactContentBytes {
		return "", fmt.Errorf("Codex artifact path exceeds %d bytes: %w", maxArtifactContentBytes, ErrJournalTooLarge)
	}
	// Pass the canonical in-workspace path to the app-server boundary. This
	// avoids reintroducing an event-supplied symlink or relative path after the
	// authorization checks above.
	return canonical, nil
}

func pathWithinRoot(root, target string) bool {
	relative, err := filepath.Rel(root, target)
	if err != nil || filepath.IsAbs(relative) || relative == ".." {
		return false
	}
	return !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func rejectSymlinkComponents(root, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return ErrArtifactPathUnauthorized
	}
	current := root
	if relative == "." {
		return nil
	}
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("inspect Codex artifact path: %w", ErrArtifactSourceUnavailable)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return ErrArtifactPathUnauthorized
		}
	}
	return nil
}

type fileChangeKind struct {
	Name     string
	MovePath string
}

func parseFileChangeKind(raw json.RawMessage) (fileChangeKind, bool) {
	var name string
	if json.Unmarshal(raw, &name) == nil {
		name = strings.TrimSpace(name)
		return fileChangeKind{Name: name}, name != ""
	}
	var object struct {
		Type     string  `json:"type"`
		MovePath *string `json:"movePath"`
	}
	if json.Unmarshal(raw, &object) != nil {
		return fileChangeKind{}, false
	}
	object.Type = strings.TrimSpace(object.Type)
	if object.Type == "" {
		return fileChangeKind{}, false
	}
	if object.MovePath != nil {
		object.MovePath = stringPointer(strings.TrimSpace(*object.MovePath))
	}
	kind := fileChangeKind{Name: object.Type}
	if object.MovePath != nil {
		kind.MovePath = *object.MovePath
	}
	return kind, true
}

// artifactCandidatesFromEvent keeps the compatibility helper intentionally
// conservative: without a verified workspace reader it creates no file
// artifact for Update, and it never publishes an Update diff as original bytes.
func artifactCandidatesFromEvent(event protocol.Event, observation EventObservation) ([]ArtifactCandidate, error) {
	candidates, _, err := artifactCandidatesFromEventWithReader(context.Background(), event, observation, nil)
	return candidates, err
}

func artifactCandidatesFromEventWithReader(ctx context.Context, event protocol.Event, observation EventObservation, reader ArtifactContentReader) ([]ArtifactCandidate, []ArtifactCaptureGap, error) {
	if event.Type != protocol.EventTypeItemCompleted || event.Source != protocol.EventSourceAppServer {
		return nil, nil, nil
	}
	var message fileChangeEvent
	if err := json.Unmarshal(event.Payload, &message); err != nil {
		return nil, nil, nil
	}
	if message.Method != "item/completed" || message.Params.Item.Type != "fileChange" || message.Params.Item.ID == "" || len(message.Params.Item.Changes) == 0 {
		return nil, nil, nil
	}
	if observation.NativeTurnID == "" {
		return nil, nil, nil
	}
	if ctx == nil {
		return nil, nil, errors.New("artifact capture context must not be nil")
	}
	sourceEventID := strings.TrimSpace(event.EventID)
	if sourceEventID == "" {
		sourceEventID = "source-event-" + digestString(string(event.Payload))
	}
	values := make([]ArtifactCandidate, 0, len(message.Params.Item.Changes))
	gaps := make([]ArtifactCaptureGap, 0)
	for index, change := range message.Params.Item.Changes {
		kind, ok := parseFileChangeKind(change.Kind)
		if !ok {
			gaps = append(gaps, artifactCaptureGap(sourceEventID, observation, message.Params.Item.ID, index, change.Path, "unknown", "unsupported_change_kind"))
			continue
		}
		path := strings.TrimSpace(change.Path)
		if !validArtifactEventPath(path) {
			gaps = append(gaps, artifactCaptureGap(sourceEventID, observation, message.Params.Item.ID, index, path, kind.Name, "path_outside_authorized_workspace"))
			continue
		}
		readPath := path
		if kind.MovePath != "" {
			readPath = kind.MovePath
		}
		if kind.Name == "update" && !validArtifactEventPath(readPath) {
			gaps = append(gaps, artifactCaptureGap(sourceEventID, observation, message.Params.Item.ID, index, readPath, kind.Name, "path_outside_authorized_workspace"))
			continue
		}
		var content []byte
		provenance := "codex.fs.readFile"
		switch kind.Name {
		case "add", "update":
			if reader == nil {
				gaps = append(gaps, artifactCaptureGap(sourceEventID, observation, message.Params.Item.ID, index, readPath, kind.Name, "workspace_unconfigured"))
				continue
			}
			var err error
			content, err = reader.ReadFile(ctx, readPath)
			if err != nil {
				gaps = append(gaps, artifactCaptureGap(sourceEventID, observation, message.Params.Item.ID, index, readPath, kind.Name, artifactGapReason(err)))
				continue
			}
		case "delete":
			if reader == nil {
				gaps = append(gaps, artifactCaptureGap(sourceEventID, observation, message.Params.Item.ID, index, readPath, kind.Name, "workspace_unconfigured"))
				continue
			}
			if err := reader.ValidatePath(readPath); err != nil {
				gaps = append(gaps, artifactCaptureGap(sourceEventID, observation, message.Params.Item.ID, index, readPath, kind.Name, artifactGapReason(err)))
				continue
			}
			gaps = append(gaps, artifactCaptureGap(sourceEventID, observation, message.Params.Item.ID, index, readPath, kind.Name, "file_bytes_unavailable"))
			continue
		default:
			gaps = append(gaps, artifactCaptureGap(sourceEventID, observation, message.Params.Item.ID, index, readPath, kind.Name, "unsupported_change_kind"))
			continue
		}
		if int64(len(content)) > maxArtifactContentBytes {
			gaps = append(gaps, artifactCaptureGap(sourceEventID, observation, message.Params.Item.ID, index, readPath, kind.Name, "content_too_large"))
			continue
		}
		identity := strings.Join([]string{
			artifactIdentityVersion,
			observation.AdapterSessionID,
			observation.ExternalThreadRef,
			observation.Generation,
			observation.NativeTurnID,
			message.Params.Item.ID,
			fmt.Sprintf("%d", index),
			kind.Name,
			normalizeArtifactPathForIdentity(path),
			normalizeArtifactPathForIdentity(kind.MovePath),
		}, "\x00")
		artifactID := "artifact-" + digestString(identity)
		eventID := "artifact-event-" + digestString(artifactID)
		sum := sha256.Sum256(content)
		candidate := ArtifactCandidate{
			ID:            artifactID,
			EventID:       eventID,
			SourceEventID: sourceEventID,
			Observation:   observation,
			Name:          "artifact-" + digestString(identity)[:32] + ".bin",
			Kind:          protocol.ArtifactKindFile,
			Size:          int64(len(content)),
			Sha256:        hex.EncodeToString(sum[:]),
			ContentType:   "application/octet-stream",
			CreatedAt:     event.OccurredAt,
			Provenance:    provenance,
			Content:       append([]byte(nil), content...),
		}
		candidate.EventPayload = artifactEventPayload(candidate)
		values = append(values, candidate)
	}
	return values, gaps, nil
}

func artifactCaptureGap(sourceEventID string, observation EventObservation, itemID string, index int, eventPath, changeKind, reason string) ArtifactCaptureGap {
	changeKind = normalizeArtifactChangeKind(changeKind)
	identity := strings.Join([]string{artifactIdentityVersion, sourceEventID, observation.AdapterSessionID, observation.ExternalThreadRef, observation.Generation, observation.NativeTurnID, itemID, fmt.Sprintf("%d", index), changeKind, normalizeArtifactPathForIdentity(eventPath)}, "\x00")
	return ArtifactCaptureGap{
		ID:            "artifact-gap-" + digestString(identity),
		SourceEventID: sourceEventID,
		ChangeKind:    changeKind,
		Reason:        reason,
		Observation:   observation,
	}
}

func normalizeArtifactChangeKind(value string) string {
	switch strings.TrimSpace(value) {
	case "add", "delete", "update":
		return strings.TrimSpace(value)
	default:
		return "unknown"
	}
}

func artifactGapReason(err error) string {
	switch {
	case errors.Is(err, ErrArtifactWorkspaceRequired):
		return "workspace_unconfigured"
	case errors.Is(err, ErrArtifactPathUnauthorized):
		return "path_outside_authorized_workspace"
	case errors.Is(err, ErrJournalTooLarge):
		return "content_too_large"
	case errors.Is(err, ErrArtifactSourceUnavailable):
		return "file_bytes_unavailable"
	default:
		return "file_bytes_unavailable"
	}
}

func normalizeArtifactPathForIdentity(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	return filepath.ToSlash(filepath.Clean(filepath.FromSlash(value)))
}

func validArtifactEventPath(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= 4096 && !strings.ContainsRune(value, '\x00')
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
			Provenance  string                `json:"provenance"`
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
	value.Artifact.Provenance = candidate.Provenance
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
