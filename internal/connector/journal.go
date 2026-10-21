package connector

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

const journalFormatVersion = 1

var (
	ErrCommandNotFound  = errors.New("command is not present in the journal")
	ErrJournalCorrupt   = errors.New("journal contains a corrupt record")
	ErrApprovalNotFound = errors.New("approval is not pending in the journal")
	ErrApprovalClaimed  = errors.New("approval is already claimed")
)

type journalRecord struct {
	FormatVersion  int                      `json:"format_version"`
	Type           string                   `json:"type"`
	At             string                   `json:"at"`
	Command        *protocol.Command        `json:"command,omitempty"`
	CommandID      string                   `json:"command_id,omitempty"`
	Digest         string                   `json:"digest,omitempty"`
	Ack            *protocol.CommandAck     `json:"ack,omitempty"`
	Event          *protocol.Event          `json:"event,omitempty"`
	Session        *journalSession          `json:"session,omitempty"`
	Reconciliation *protocol.Reconciliation `json:"reconciliation,omitempty"`
	ApprovalClaim  *approvalClaimRecord     `json:"approval_claim,omitempty"`
}

type journalSession struct {
	SessionID         string `json:"session_id"`
	ExternalThreadRef string `json:"external_thread_ref"`
	Generation        string `json:"generation"`
	UpdatedAt         string `json:"updated_at"`
}

type commandEntry struct {
	command protocol.Command
	digest  string
	ack     protocol.CommandAck
}

type Journal struct {
	mu sync.Mutex

	path string
	file *os.File

	commands map[string]commandEntry
	events   []protocol.Event
	eventIDs map[string]struct{}
	sessions map[string]journalSession

	sequenceBySession map[string]int64
	pendingApprovals  map[string]PendingApproval
	approvalClaims    map[string]approvalClaimRecord
}

// PendingApproval is the durable identity needed to answer one app-server
// approval request after a Connector restart or transport reconnect.
type PendingApproval struct {
	RequestID json.RawMessage
	SessionID string
	RunID     string
	ThreadID  string
	TurnID    string
	ItemID    string
	Revision  int64
}

type approvalClaimRecord struct {
	SessionID string          `json:"session_id"`
	RequestID json.RawMessage `json:"request_id"`
	Revision  int64           `json:"revision"`
	CommandID string          `json:"command_id"`
	Decision  string          `json:"decision"`
	Released  bool            `json:"released,omitempty"`
}

// OpenJournal opens or creates a mode-0600 append-only journal. A final
// incomplete JSONL record is discarded because a process may have crashed
// after writing only part of a record.
func OpenJournal(path string) (*Journal, error) {
	if path == "" {
		return nil, fmt.Errorf("journal path must not be empty")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve journal path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0o700); err != nil {
		return nil, fmt.Errorf("create journal directory: %w", err)
	}
	file, err := os.OpenFile(absPath, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open journal: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, fmt.Errorf("secure journal permissions: %w", err)
	}
	if err := lockJournalFile(file); err != nil {
		file.Close()
		return nil, fmt.Errorf("lock journal ownership: %w", err)
	}

	journal := &Journal{
		path:              absPath,
		file:              file,
		commands:          make(map[string]commandEntry),
		eventIDs:          make(map[string]struct{}),
		sessions:          make(map[string]journalSession),
		sequenceBySession: make(map[string]int64),
		pendingApprovals:  make(map[string]PendingApproval),
		approvalClaims:    make(map[string]approvalClaimRecord),
	}
	if err := journal.load(); err != nil {
		file.Close()
		return nil, err
	}
	if err := journal.markInFlightUnknown(); err != nil {
		file.Close()
		return nil, err
	}
	return journal, nil
}

func (j *Journal) Path() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.path
}

func (j *Journal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.file == nil {
		return nil
	}
	unlockErr := unlockJournalFile(j.file)
	err := j.file.Close()
	j.file = nil
	if unlockErr != nil {
		return unlockErr
	}
	return err
}

func (j *Journal) BeginCommand(command protocol.Command) (protocol.CommandAck, bool, error) {
	if err := protocol.ValidateCommand(command); err != nil {
		return protocol.CommandAck{}, false, err
	}
	digest, err := commandDigest(command)
	if err != nil {
		return protocol.CommandAck{}, false, err
	}

	j.mu.Lock()
	defer j.mu.Unlock()
	if entry, ok := j.commands[command.CommandID]; ok {
		if entry.digest != digest {
			return protocol.CommandAck{}, true, protocol.ErrIdempotencyConflict
		}
		ack := cloneAck(entry.ack)
		ack.Deduplicated = true
		return ack, true, nil
	}

	ack := protocol.CommandAck{
		CommandID:    command.CommandID,
		Deduplicated: false,
		ReceivedAt:   now(),
		State:        protocol.CommandStateAccepted,
	}
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "command",
		At:            ack.ReceivedAt,
		Command:       &command,
		CommandID:     command.CommandID,
		Digest:        digest,
		Ack:           &ack,
	}); err != nil {
		return protocol.CommandAck{}, false, err
	}
	j.commands[command.CommandID] = commandEntry{command: cloneCommand(command), digest: digest, ack: cloneAck(ack)}
	return ack, false, nil
}

func (j *Journal) UpdateCommand(commandID string, ack protocol.CommandAck) error {
	if commandID == "" {
		return fmt.Errorf("command id must not be empty")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	entry, ok := j.commands[commandID]
	if !ok {
		return ErrCommandNotFound
	}
	ack.CommandID = commandID
	if ack.ReceivedAt == "" {
		ack.ReceivedAt = entry.ack.ReceivedAt
	}
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "command_update",
		At:            now(),
		CommandID:     commandID,
		Ack:           &ack,
	}); err != nil {
		return err
	}
	entry.ack = cloneAck(ack)
	j.commands[commandID] = entry
	return nil
}

func (j *Journal) LookupCommand(commandID string) (protocol.CommandAck, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	entry, ok := j.commands[commandID]
	if !ok {
		return protocol.CommandAck{}, ErrCommandNotFound
	}
	return cloneAck(entry.ack), nil
}

func (j *Journal) Command(commandID string) (protocol.Command, protocol.CommandAck, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	entry, ok := j.commands[commandID]
	if !ok {
		return protocol.Command{}, protocol.CommandAck{}, ErrCommandNotFound
	}
	return cloneCommand(entry.command), cloneAck(entry.ack), nil
}

func (j *Journal) AppendEvent(event protocol.Event) (protocol.Event, error) {
	if event.SessionID == "" {
		return protocol.Event{}, fmt.Errorf("event session id must not be empty")
	}

	j.mu.Lock()
	defer j.mu.Unlock()
	if event.EventID != "" {
		if _, ok := j.eventIDs[event.EventID]; ok {
			for _, existing := range j.events {
				if existing.EventID == event.EventID {
					return cloneEvent(existing), nil
				}
			}
		}
	}
	if event.OccurredAt == "" {
		event.OccurredAt = now()
	}
	if event.Sequence <= 0 {
		event.Sequence = j.sequenceBySession[event.SessionID] + 1
	}
	if event.Cursor == "" {
		event.Cursor = fmt.Sprintf("%s:%d", event.SessionID, event.Sequence)
	}
	if event.EventID == "" {
		event.EventID = digestString(event.SessionID + "\x00" + event.Cursor + "\x00" + string(event.Payload))
	}
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "event",
		At:            event.OccurredAt,
		Event:         &event,
	}); err != nil {
		return protocol.Event{}, err
	}
	j.events = append(j.events, cloneEvent(event))
	j.eventIDs[event.EventID] = struct{}{}
	if event.Sequence > j.sequenceBySession[event.SessionID] {
		j.sequenceBySession[event.SessionID] = event.Sequence
	}
	j.updatePendingApprovalLocked(event)
	return cloneEvent(event), nil
}

func (j *Journal) ReadEvents(query protocol.EventQuery) (protocol.EventPage, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if query.SessionID == "" {
		return protocol.EventPage{}, fmt.Errorf("event session id must not be empty")
	}
	start := 0
	if query.AfterCursor != "" {
		found := false
		for index, event := range j.events {
			if event.Cursor == query.AfterCursor {
				if event.SessionID != query.SessionID || (query.RunID != "" && valueOrEmpty(event.RunID) != query.RunID) {
					return protocol.EventPage{}, protocol.ErrCursorExpired
				}
				start = index + 1
				found = true
				break
			}
		}
		if !found {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		}
	}

	limit := query.Limit
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	page := protocol.EventPage{Events: make([]protocol.Event, 0)}
	for _, event := range j.events[start:] {
		if event.SessionID != query.SessionID {
			continue
		}
		if query.RunID != "" && valueOrEmpty(event.RunID) != query.RunID {
			continue
		}
		if int64(len(page.Events)) >= limit {
			page.HasMore = true
			break
		}
		page.Events = append(page.Events, cloneEvent(event))
	}
	if len(page.Events) > 0 {
		last := page.Events[len(page.Events)-1].Cursor
		if page.HasMore {
			page.NextCursor = &last
		}
	}
	return page, nil
}

// UniqueRunIDAfter returns a run identity only when exactly one run-start
// observation for the session follows the command issuance time. It is used
// during unknown-result reconciliation when app-server history may not yet
// contain the submitted user message.
func (j *Journal) UniqueRunIDAfter(sessionID, issuedAt string) (string, bool) {
	after, err := time.Parse(time.RFC3339Nano, issuedAt)
	if err != nil {
		return "", false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	ids := make(map[string]struct{})
	for _, event := range j.events {
		if event.SessionID != sessionID || event.Type != protocol.EventTypeRunStarted || event.RunID == nil {
			continue
		}
		occurredAt, parseErr := time.Parse(time.RFC3339Nano, event.OccurredAt)
		if parseErr != nil || occurredAt.Before(after) {
			continue
		}
		ids[*event.RunID] = struct{}{}
	}
	if len(ids) != 1 {
		return "", false
	}
	for id := range ids {
		return id, true
	}
	return "", false
}

func (j *Journal) RecordSession(sessionID, externalThreadRef, generation string) error {
	if sessionID == "" || externalThreadRef == "" {
		return fmt.Errorf("session id and external thread reference are required")
	}
	record := journalSession{
		SessionID:         sessionID,
		ExternalThreadRef: externalThreadRef,
		Generation:        generation,
		UpdatedAt:         now(),
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "session",
		At:            record.UpdatedAt,
		Session:       &record,
	}); err != nil {
		return err
	}
	j.sessions[sessionID] = record
	return nil
}

func (j *Journal) RecordReconciliation(value protocol.Reconciliation) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.appendLocked(journalRecord{
		FormatVersion:  journalFormatVersion,
		Type:           "reconciliation",
		At:             value.ObservedAt,
		Reconciliation: &value,
	})
}

func (j *Journal) Session(sessionID string) (protocol.AdapterSession, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	session, ok := j.sessions[sessionID]
	if !ok {
		return protocol.AdapterSession{}, false
	}
	return protocol.AdapterSession{SessionID: session.SessionID, ExternalThreadRef: session.ExternalThreadRef}, true
}

func (j *Journal) PendingApprovals(sessionID, runID string) []PendingApproval {
	j.mu.Lock()
	defer j.mu.Unlock()
	values := make([]PendingApproval, 0)
	for _, approval := range j.pendingApprovals {
		if approval.SessionID != sessionID || (runID != "" && approval.RunID != runID) {
			continue
		}
		values = append(values, cloneApproval(approval))
	}
	sort.Slice(values, func(i, k int) bool {
		return string(values[i].RequestID) < string(values[k].RequestID)
	})
	return values
}

// ClaimApproval durably arbitrates the first response to one pending approval.
// The claim is written before the transport response so a restart never
// silently replays an approval whose delivery outcome is unknown.
func (j *Journal) ClaimApproval(sessionID string, requestID json.RawMessage, revision int64, commandID, decision string) (PendingApproval, bool, error) {
	if sessionID == "" || len(bytes.TrimSpace(requestID)) == 0 || commandID == "" || decision == "" {
		return PendingApproval{}, false, errors.New("approval claim identity is incomplete")
	}
	key := approvalKey(sessionID, requestID)
	j.mu.Lock()
	defer j.mu.Unlock()
	pending, ok := j.pendingApprovals[key]
	if !ok {
		return PendingApproval{}, false, ErrApprovalNotFound
	}
	if pending.Revision != revision {
		return PendingApproval{}, false, fmt.Errorf("approval revision %d is stale; current revision is %d", revision, pending.Revision)
	}
	if existing, ok := j.approvalClaims[key]; ok {
		if existing.CommandID != commandID || existing.Decision != decision || existing.Revision != revision {
			return PendingApproval{}, false, ErrApprovalClaimed
		}
		return cloneApproval(pending), true, nil
	}
	claim := approvalClaimRecord{
		SessionID: sessionID,
		RequestID: append(json.RawMessage(nil), requestID...),
		Revision:  revision,
		CommandID: commandID,
		Decision:  decision,
	}
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "approval_claim",
		At:            now(),
		ApprovalClaim: &claim,
	}); err != nil {
		return PendingApproval{}, false, err
	}
	j.approvalClaims[key] = claim
	return cloneApproval(pending), false, nil
}

func (j *Journal) ReleaseApprovalClaim(sessionID string, requestID json.RawMessage, commandID string) error {
	key := approvalKey(sessionID, requestID)
	j.mu.Lock()
	defer j.mu.Unlock()
	claim, ok := j.approvalClaims[key]
	if !ok {
		return nil
	}
	if claim.CommandID != commandID {
		return ErrApprovalClaimed
	}
	claim.Released = true
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "approval_claim",
		At:            now(),
		ApprovalClaim: &claim,
	}); err != nil {
		return err
	}
	delete(j.approvalClaims, key)
	return nil
}

func (j *Journal) IsApprovalPending(sessionID string, requestID json.RawMessage) bool {
	key := approvalKey(sessionID, requestID)
	j.mu.Lock()
	defer j.mu.Unlock()
	_, ok := j.pendingApprovals[key]
	return ok
}

// ActiveTurns rebuilds control ownership from the durable event stream after a
// cold recovery. Only turns with a terminal observation remain unselectable.
func (j *Journal) ActiveTurns(sessionID string) map[string]string {
	j.mu.Lock()
	defer j.mu.Unlock()
	active := make(map[string]string)
	for _, event := range j.events {
		if event.SessionID != sessionID || event.RunID == nil {
			continue
		}
		switch event.Type {
		case protocol.EventTypeRunStarted:
			active[*event.RunID] = *event.RunID
		case protocol.EventTypeRunCompleted, protocol.EventTypeRunFailed, protocol.EventTypeRunInterrupted:
			delete(active, *event.RunID)
		}
	}
	return active
}

// UniqueRunIDForCommand refuses to infer a run when another unresolved command
// could have produced the same observed turn. This keeps unknown reconciliation
// conservative for concurrent sends.
func (j *Journal) UniqueRunIDForCommand(sessionID, commandID, issuedAt string) (string, bool) {
	after, err := time.Parse(time.RFC3339Nano, issuedAt)
	if err != nil {
		return "", false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	type candidate struct {
		id string
		at time.Time
	}
	var candidates []candidate
	for _, event := range j.events {
		if event.SessionID != sessionID || event.Type != protocol.EventTypeRunStarted || event.RunID == nil {
			continue
		}
		occurredAt, parseErr := time.Parse(time.RFC3339Nano, event.OccurredAt)
		if parseErr != nil || occurredAt.Before(after) {
			continue
		}
		candidates = append(candidates, candidate{id: *event.RunID, at: occurredAt})
	}
	if len(candidates) != 1 {
		return "", false
	}
	for otherID, entry := range j.commands {
		if otherID == commandID || entry.command.SessionID != sessionID {
			continue
		}
		if entry.ack.State != protocol.CommandStateUnknown && entry.ack.State != protocol.CommandStateAccepted && entry.ack.State != protocol.CommandStateExecuting {
			continue
		}
		otherIssued, parseErr := time.Parse(time.RFC3339Nano, entry.command.IssuedAt)
		if parseErr == nil && !otherIssued.After(candidates[0].at) {
			return "", false
		}
	}
	return candidates[0].id, true
}

func (j *Journal) load() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	data, err := os.ReadFile(j.path)
	if err != nil {
		return fmt.Errorf("read journal: %w", err)
	}
	validEnd := 0
	needsNewline := false
	for validEnd < len(data) {
		relative := bytes.IndexByte(data[validEnd:], '\n')
		lineEnd := len(data)
		terminated := false
		if relative >= 0 {
			lineEnd = validEnd + relative
			terminated = true
		}
		line := bytes.TrimSpace(data[validEnd:lineEnd])
		if len(line) == 0 {
			if terminated {
				validEnd = lineEnd + 1
				continue
			}
			validEnd = lineEnd
			break
		}
		var record journalRecord
		if err := json.Unmarshal(line, &record); err != nil {
			if terminated {
				return fmt.Errorf("%w at byte %d: %v", ErrJournalCorrupt, validEnd, err)
			}
			break
		}
		if err := j.applyRecord(record); err != nil {
			return err
		}
		validEnd = lineEnd
		if terminated {
			validEnd++
		} else {
			needsNewline = true
		}
	}
	if validEnd != len(data) {
		if err := j.file.Truncate(int64(validEnd)); err != nil {
			return fmt.Errorf("truncate incomplete journal record: %w", err)
		}
		if err := j.file.Sync(); err != nil {
			return fmt.Errorf("sync journal truncation: %w", err)
		}
	}
	if needsNewline {
		if _, err := j.file.Write([]byte{'\n'}); err != nil {
			return fmt.Errorf("terminate complete journal record: %w", err)
		}
		if err := j.file.Sync(); err != nil {
			return fmt.Errorf("sync journal record terminator: %w", err)
		}
	}
	return nil
}

func (j *Journal) applyRecord(record journalRecord) error {
	if record.FormatVersion != journalFormatVersion {
		return fmt.Errorf("unsupported journal format version %d", record.FormatVersion)
	}
	switch record.Type {
	case "command":
		if record.Command == nil || record.Ack == nil || record.CommandID == "" || record.Digest == "" {
			return fmt.Errorf("%w: incomplete command record", ErrJournalCorrupt)
		}
		if existing, ok := j.commands[record.CommandID]; ok && existing.digest != record.Digest {
			return fmt.Errorf("%w: conflicting command record %q", ErrJournalCorrupt, record.CommandID)
		}
		j.commands[record.CommandID] = commandEntry{command: cloneCommand(*record.Command), digest: record.Digest, ack: cloneAck(*record.Ack)}
	case "command_update":
		if record.Ack == nil || record.CommandID == "" {
			return fmt.Errorf("%w: incomplete command update", ErrJournalCorrupt)
		}
		entry, ok := j.commands[record.CommandID]
		if !ok {
			return fmt.Errorf("%w: command update for %q", ErrJournalCorrupt, record.CommandID)
		}
		entry.ack = cloneAck(*record.Ack)
		j.commands[record.CommandID] = entry
	case "event":
		if record.Event == nil {
			return fmt.Errorf("%w: incomplete event record", ErrJournalCorrupt)
		}
		event := cloneEvent(*record.Event)
		if event.SessionID == "" || event.Cursor == "" || event.EventID == "" || event.Sequence <= 0 {
			return fmt.Errorf("%w: incomplete event", ErrJournalCorrupt)
		}
		if _, duplicate := j.eventIDs[event.EventID]; duplicate {
			return nil
		}
		j.events = append(j.events, event)
		j.eventIDs[event.EventID] = struct{}{}
		if event.Sequence > j.sequenceBySession[event.SessionID] {
			j.sequenceBySession[event.SessionID] = event.Sequence
		}
		j.updatePendingApprovalLocked(event)
	case "session":
		if record.Session == nil || record.Session.SessionID == "" || record.Session.ExternalThreadRef == "" {
			return fmt.Errorf("%w: incomplete session record", ErrJournalCorrupt)
		}
		j.sessions[record.Session.SessionID] = *record.Session
	case "reconciliation":
		if record.Reconciliation == nil || record.Reconciliation.CommandID == "" {
			return fmt.Errorf("%w: incomplete reconciliation record", ErrJournalCorrupt)
		}
	case "approval_claim":
		if record.ApprovalClaim == nil || record.ApprovalClaim.SessionID == "" || len(bytes.TrimSpace(record.ApprovalClaim.RequestID)) == 0 || record.ApprovalClaim.CommandID == "" || record.ApprovalClaim.Revision <= 0 {
			return fmt.Errorf("%w: incomplete approval claim", ErrJournalCorrupt)
		}
		claim := *record.ApprovalClaim
		claim.RequestID = append(json.RawMessage(nil), claim.RequestID...)
		key := approvalKey(claim.SessionID, claim.RequestID)
		if claim.Released {
			delete(j.approvalClaims, key)
		} else {
			j.approvalClaims[key] = claim
		}
	default:
		return fmt.Errorf("%w: unknown record type %q", ErrJournalCorrupt, record.Type)
	}
	return nil
}

func (j *Journal) markInFlightUnknown() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	for commandID, entry := range j.commands {
		if entry.ack.State != protocol.CommandStateAccepted && entry.ack.State != protocol.CommandStateExecuting {
			continue
		}
		ack := cloneAck(entry.ack)
		ack.State = protocol.CommandStateUnknown
		if err := j.appendLocked(journalRecord{
			FormatVersion: journalFormatVersion,
			Type:          "command_update",
			At:            now(),
			CommandID:     commandID,
			Ack:           &ack,
		}); err != nil {
			return fmt.Errorf("mark command %q unknown after restart: %w", commandID, err)
		}
		entry.ack = ack
		j.commands[commandID] = entry
	}
	return nil
}

func (j *Journal) appendLocked(record journalRecord) error {
	if j.file == nil {
		return errors.New("journal is closed")
	}
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode journal record: %w", err)
	}
	data = append(data, '\n')
	if _, err := j.file.Seek(0, io.SeekEnd); err != nil {
		return fmt.Errorf("seek journal end: %w", err)
	}
	start, err := j.file.Seek(0, io.SeekCurrent)
	if err != nil {
		return fmt.Errorf("locate journal end: %w", err)
	}
	written, err := writeAll(j.file, data)
	if err != nil {
		if truncateErr := j.file.Truncate(start); truncateErr != nil {
			return fmt.Errorf("write journal record after %d bytes: %w; truncate partial record: %v", written, err, truncateErr)
		}
		_ = j.file.Sync()
		return fmt.Errorf("write journal record after %d bytes: %w", written, err)
	}
	if err := j.file.Sync(); err != nil {
		return fmt.Errorf("sync journal record: %w", err)
	}
	return nil
}

func (j *Journal) updatePendingApprovalLocked(event protocol.Event) {
	if event.Type != protocol.EventTypeApprovalRequested && event.Type != protocol.EventTypeApprovalResolved && event.Type != protocol.EventTypeItemCompleted {
		return
	}
	var message struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			ThreadID  string          `json:"threadId"`
			TurnID    string          `json:"turnId"`
			RequestID json.RawMessage `json:"requestId"`
			Revision  int64           `json:"revision"`
			ItemID    string          `json:"itemId"`
			Item      struct {
				ID     string `json:"id"`
				Type   string `json:"type"`
				Status string `json:"status"`
			} `json:"item"`
		} `json:"params"`
	}
	if err := json.Unmarshal(event.Payload, &message); err != nil {
		return
	}
	requestID := message.ID
	if event.Type == protocol.EventTypeApprovalResolved && len(bytes.TrimSpace(message.Params.RequestID)) > 0 {
		requestID = message.Params.RequestID
	}
	key := approvalKey(event.SessionID, requestID)
	if event.Type != protocol.EventTypeItemCompleted && key == "" {
		return
	}
	if event.Type == protocol.EventTypeApprovalRequested {
		itemID := message.Params.Item.ID
		if itemID == "" {
			itemID = message.Params.ItemID
		}
		revision := message.Params.Revision
		if revision <= 0 {
			revision = 1
		}
		j.pendingApprovals[key] = PendingApproval{
			RequestID: append(json.RawMessage(nil), requestID...),
			SessionID: event.SessionID,
			RunID:     valueOrEmpty(event.RunID),
			ThreadID:  message.Params.ThreadID,
			TurnID:    message.Params.TurnID,
			ItemID:    itemID,
			Revision:  revision,
		}
		return
	}
	if event.Type == protocol.EventTypeApprovalResolved {
		delete(j.pendingApprovals, key)
		delete(j.approvalClaims, key)
		return
	}
	if event.Type == protocol.EventTypeItemCompleted && message.Params.Item.Status != "" && message.Params.Item.Status != "inProgress" {
		for requestKey, approval := range j.pendingApprovals {
			if approval.SessionID == event.SessionID && approval.ItemID != "" && approval.ItemID == message.Params.Item.ID {
				delete(j.pendingApprovals, requestKey)
				delete(j.approvalClaims, requestKey)
			}
		}
	}
}

func approvalKey(sessionID string, requestID json.RawMessage) string {
	trimmed := bytes.TrimSpace(requestID)
	if sessionID == "" || len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	return sessionID + "\x00" + string(trimmed)
}

func commandDigest(command protocol.Command) (string, error) {
	payload, err := canonicalJSON(command.Payload)
	if err != nil {
		return "", fmt.Errorf("canonicalize command payload: %w", err)
	}
	value := struct {
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
		Payload:   payload,
		RunID:     command.RunID,
		SessionID: command.SessionID,
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode command digest: %w", err)
	}
	return digestString(string(data)), nil
}

func canonicalJSON(data []byte) (json.RawMessage, error) {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func digestString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func cloneCommand(value protocol.Command) protocol.Command {
	value.Payload = append(json.RawMessage(nil), value.Payload...)
	if value.RunID != nil {
		runID := *value.RunID
		value.RunID = &runID
	}
	return value
}

func cloneAck(value protocol.CommandAck) protocol.CommandAck {
	value.Result = append(json.RawMessage(nil), value.Result...)
	if value.RunID != nil {
		runID := *value.RunID
		value.RunID = &runID
	}
	if value.EventCursor != nil {
		cursor := *value.EventCursor
		value.EventCursor = &cursor
	}
	if value.OperationID != nil {
		operationID := *value.OperationID
		value.OperationID = &operationID
	}
	if value.Error != nil {
		errorValue := *value.Error
		errorValue.Details = append(json.RawMessage(nil), value.Error.Details...)
		value.Error = &errorValue
	}
	return value
}

func cloneEvent(value protocol.Event) protocol.Event {
	value.Payload = append(json.RawMessage(nil), value.Payload...)
	if value.RunID != nil {
		runID := *value.RunID
		value.RunID = &runID
	}
	return value
}

func cloneApproval(value PendingApproval) PendingApproval {
	value.RequestID = append(json.RawMessage(nil), value.RequestID...)
	return value
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func now() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func writeAll(writer io.Writer, data []byte) (int, error) {
	total := 0
	for total < len(data) {
		written, err := writer.Write(data[total:])
		total += written
		if err != nil {
			return total, err
		}
		if written == 0 {
			return total, io.ErrShortWrite
		}
	}
	return total, nil
}
