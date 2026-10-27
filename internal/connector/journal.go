package connector

import (
	"bufio"
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
	"strings"
	"sync"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

const (
	legacyJournalFormatVersion   = 1
	previousJournalFormatVersion = 2
	identityJournalFormatVersion = 3
	journalFormatVersion         = 4
	maxJournalBytes              = int64(256 << 20)
	maxJournalRecordBytes        = 8 << 20
	maxJournalEvents             = 1_000_000
)

const approvalResolutionCleared = "cleared"

var (
	ErrCommandNotFound       = errors.New("command is not present in the journal")
	ErrCommandScopeUnknown   = errors.New("command namespace is unknown")
	ErrCommandScopeAmbiguous = errors.New("command namespace is ambiguous")
	ErrJournalCorrupt        = errors.New("journal contains a corrupt record")
	ErrJournalTooLarge       = errors.New("journal exceeds its configured resource limit")
	ErrApprovalNotFound      = errors.New("approval is not pending in the journal")
	ErrApprovalClaimed       = errors.New("approval is already claimed")
)

type journalRecord struct {
	FormatVersion  int                      `json:"format_version"`
	Type           string                   `json:"type"`
	At             string                   `json:"at"`
	Namespace      *CommandNamespace        `json:"namespace,omitempty"`
	Command        *protocol.Command        `json:"command,omitempty"`
	CommandID      string                   `json:"command_id,omitempty"`
	Digest         string                   `json:"digest,omitempty"`
	Ack            *protocol.CommandAck     `json:"ack,omitempty"`
	Event          *protocol.Event          `json:"event,omitempty"`
	Session        *journalSession          `json:"session,omitempty"`
	SessionStart   *sessionStartIntent      `json:"session_start,omitempty"`
	SessionAlias   *SessionAlias            `json:"session_alias,omitempty"`
	RunBinding     *RunBinding              `json:"run_binding,omitempty"`
	ObservedEvent  *journalObservedEvent    `json:"observed_event,omitempty"`
	Reconciliation *protocol.Reconciliation `json:"reconciliation,omitempty"`
	ApprovalClaim  *approvalClaimRecord     `json:"approval_claim,omitempty"`
	GatewayLink    *GatewaySessionLink      `json:"gateway_link,omitempty"`
}

type journalSession struct {
	SessionID         string `json:"session_id"`
	ExternalThreadRef string `json:"external_thread_ref"`
	Generation        string `json:"generation"`
	UpdatedAt         string `json:"updated_at"`
}

type sessionStartIntent struct {
	IntentID          string `json:"intent_id"`
	PlatformSessionID string `json:"platform_session_id,omitempty"`
	GatewayHandle     string `json:"gateway_handle"`
	Generation        string `json:"generation"`
	CommandID         string `json:"command_id"`
	RequestDigest     string `json:"request_digest"`
	State             string `json:"state"`
	ExternalThreadRef string `json:"external_thread_ref,omitempty"`
	UpdatedAt         string `json:"updated_at"`
}

// GatewaySessionLink retains the verified relationship between a private
// gateway generation and the platform session it created.
type GatewaySessionLink struct {
	GatewayHandle     string `json:"gateway_handle"`
	PlatformSessionID string `json:"platform_session_id"`
	AdapterSessionID  string `json:"adapter_session_id"`
	ExternalThreadRef string `json:"external_thread_ref"`
	Generation        string `json:"generation"`
	CommandID         string `json:"command_id"`
	UpdatedAt         string `json:"updated_at"`
}

// SessionStartProof is the exact durable evidence produced by a resolved
// session-start intent. It is kept private to the Connector recovery boundary;
// public command and session contracts continue to expose only their existing
// identities.
type SessionStartProof struct {
	IntentID       string
	GatewayHandle  string
	Generation     string
	CommandID      string
	RequestDigest  string
	AdapterSession protocol.AdapterSession
}

type commandEntry struct {
	command protocol.Command
	digest  string
	ack     protocol.CommandAck
	legacy  bool
}

type Journal struct {
	mu sync.Mutex

	path             string
	file             *os.File
	fatalErr         error
	formatMarkerSeen bool

	commands                    map[string]commandEntry
	commandKeysByID             map[string]map[string]struct{}
	events                      []protocol.Event
	eventIDs                    map[string]struct{}
	eventIndexByID              map[string]int
	eventIndexByCursor          map[string]int
	reconciliations             map[string]protocol.Reconciliation
	sessions                    map[string]journalSession
	sessionStarts               map[string]sessionStartIntent
	sessionStartByCommand       map[string]string
	legacySessionStartIDs       map[string]struct{}
	gatewayLinks                map[string]GatewaySessionLink
	legacySessionFacts          map[string]SessionAlias
	sessionAliases              map[string]SessionAlias
	sessionAliasByAdapter       map[string]string
	sessionAliasByTuple         map[string]SessionAlias
	runBindings                 map[string]RunBinding
	runBindingByCommand         map[string]string
	runBindingByNativeTurn      map[string]string
	runBindingByNativeOperation map[string]string
	observedEvents              map[string]journalObservedEvent

	sequenceBySession map[string]int64
	pendingApprovals  map[string]PendingApproval
	approvalClaims    map[string]approvalClaimRecord
	approvalResults   map[string]string
}

// PendingApproval is the durable identity needed to answer one app-server
// approval request after a Connector restart or transport reconnect.
type PendingApproval struct {
	RequestID  json.RawMessage
	SessionID  string
	Generation string
	RunID      string
	ThreadID   string
	TurnID     string
	ItemID     string
	Revision   int64
	Command    string
}

type approvalClaimRecord struct {
	SessionID  string          `json:"session_id"`
	RequestID  json.RawMessage `json:"request_id"`
	Generation string          `json:"generation,omitempty"`
	RunID      string          `json:"run_id,omitempty"`
	TurnID     string          `json:"turn_id,omitempty"`
	ItemID     string          `json:"item_id,omitempty"`
	Revision   int64           `json:"revision"`
	CommandID  string          `json:"command_id"`
	Decision   string          `json:"decision"`
	Released   bool            `json:"released,omitempty"`
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
	fileInfo, statErr := os.Lstat(absPath)
	fileExisted := statErr == nil
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return nil, fmt.Errorf("stat journal file: %w", statErr)
	}
	if fileExisted {
		if fileInfo.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("journal path must not be a symlink")
		}
		if !fileInfo.Mode().IsRegular() {
			return nil, fmt.Errorf("journal path %q is not a regular file", absPath)
		}
		if err := validateJournalFile(absPath); err != nil {
			return nil, err
		}
	}
	directoryPath := filepath.Dir(absPath)
	newDirectories, err := prepareJournalDirectories(directoryPath)
	if err != nil {
		return nil, err
	}
	if err := validateJournalDirectory(directoryPath); err != nil {
		return nil, err
	}
	file, err := openJournalFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("open journal: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, fmt.Errorf("secure journal permissions: %w", err)
	}
	if err := secureJournalFile(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("secure journal ACL: %w", err)
	}
	if err := validateJournalFileHandle(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("validate opened journal: %w", err)
	}
	if err := lockJournalFile(file); err != nil {
		file.Close()
		return nil, fmt.Errorf("lock journal ownership: %w", err)
	}
	if !fileExisted {
		for _, directory := range newDirectories {
			if err := syncJournalDirectory(filepath.Dir(directory)); err != nil {
				_ = unlockJournalFile(file)
				_ = file.Close()
				return nil, fmt.Errorf("sync journal directory entry: %w", err)
			}
		}
		if err := syncJournalDirectory(directoryPath); err != nil {
			_ = unlockJournalFile(file)
			_ = file.Close()
			return nil, fmt.Errorf("sync journal directory entry: %w", err)
		}
	}

	journal := &Journal{
		path:                        absPath,
		file:                        file,
		commands:                    make(map[string]commandEntry),
		commandKeysByID:             make(map[string]map[string]struct{}),
		eventIDs:                    make(map[string]struct{}),
		eventIndexByID:              make(map[string]int),
		eventIndexByCursor:          make(map[string]int),
		reconciliations:             make(map[string]protocol.Reconciliation),
		sessions:                    make(map[string]journalSession),
		sessionStarts:               make(map[string]sessionStartIntent),
		sessionStartByCommand:       make(map[string]string),
		legacySessionStartIDs:       make(map[string]struct{}),
		gatewayLinks:                make(map[string]GatewaySessionLink),
		legacySessionFacts:          make(map[string]SessionAlias),
		sessionAliases:              make(map[string]SessionAlias),
		sessionAliasByAdapter:       make(map[string]string),
		sessionAliasByTuple:         make(map[string]SessionAlias),
		runBindings:                 make(map[string]RunBinding),
		runBindingByCommand:         make(map[string]string),
		runBindingByNativeTurn:      make(map[string]string),
		runBindingByNativeOperation: make(map[string]string),
		observedEvents:              make(map[string]journalObservedEvent),
		sequenceBySession:           make(map[string]int64),
		pendingApprovals:            make(map[string]PendingApproval),
		approvalClaims:              make(map[string]approvalClaimRecord),
		approvalResults:             make(map[string]string),
	}
	if err := journal.load(); err != nil {
		_ = unlockJournalFile(file)
		_ = file.Close()
		return nil, err
	}
	if err := journal.ensureFormatMarker(); err != nil {
		_ = unlockJournalFile(file)
		_ = file.Close()
		return nil, err
	}
	if err := journal.markInFlightUnknown(); err != nil {
		_ = unlockJournalFile(file)
		_ = file.Close()
		return nil, err
	}
	return journal, nil
}

func missingJournalDirectories(path string) ([]string, error) {
	var missing []string
	current := filepath.Clean(path)
	for {
		_, err := os.Lstat(current)
		if err == nil {
			if err := validateJournalDirectoryAncestors(current); err != nil {
				return nil, err
			}
			return missing, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("stat journal parent directory: %w", err)
		}
		missing = append(missing, current)
		parent := filepath.Dir(current)
		if parent == current {
			return nil, errors.New("journal parent directory has no existing ancestor")
		}
		current = parent
	}
}

func validateJournalDirectoryAncestors(path string) error {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve journal parent path: %w", err)
	}
	cleanPath := filepath.Clean(absPath)
	root := filepath.VolumeName(cleanPath) + string(filepath.Separator)
	relative, err := filepath.Rel(root, cleanPath)
	if err != nil {
		return fmt.Errorf("relate journal parent path to root: %w", err)
	}
	if relative == "." {
		return nil
	}
	current := root
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if err != nil {
			return fmt.Errorf("stat journal parent path %q: %w", current, err)
		}
		if info.Mode()&os.ModeSymlink != 0 && !allowedJournalAncestorSymlink(current) {
			return fmt.Errorf("journal parent path %q must not contain a symlink", current)
		}
		if info.Mode()&os.ModeSymlink == 0 && !info.IsDir() {
			return fmt.Errorf("journal parent path %q is not a directory", current)
		}
	}
	return nil
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
	return j.BeginCommandInNamespace(commandNamespaceForCommand(command), command)
}

// BeginCommandInNamespace records or deduplicates a command in the exact
// namespace supplied by the caller. A v4 command in another namespace never
// blocks this command, even when the command IDs are identical.
func (j *Journal) BeginCommandInNamespace(namespace CommandNamespace, command protocol.Command) (protocol.CommandAck, bool, error) {
	if err := protocol.ValidateCommand(command); err != nil {
		return protocol.CommandAck{}, false, err
	}
	if err := validateCommandNamespace(namespace, command); err != nil {
		return protocol.CommandAck{}, false, err
	}
	digest, err := commandDigest(command)
	if err != nil {
		return protocol.CommandAck{}, false, err
	}

	j.mu.Lock()
	defer j.mu.Unlock()
	key := commandNamespaceKey(namespace, command.CommandID)
	if entry, ok := j.commands[key]; ok {
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
		Namespace:     &namespace,
		Digest:        digest,
		Ack:           &ack,
	}); err != nil {
		return protocol.CommandAck{}, false, err
	}
	j.indexCommandLocked(key, command.CommandID, commandEntry{command: cloneCommand(command), digest: digest, ack: cloneAck(ack)})
	return ack, false, nil
}

func (j *Journal) UpdateCommand(commandID string, ack protocol.CommandAck) error {
	j.mu.Lock()
	key, err := j.uniqueCommandKeyLocked(commandID)
	j.mu.Unlock()
	if err != nil {
		return err
	}
	return j.updateCommandInKey(key, commandID, ack)
}

func (j *Journal) UpdateCommandInNamespace(namespace CommandNamespace, commandID string, ack protocol.CommandAck) error {
	if commandID == "" {
		return fmt.Errorf("command id must not be empty")
	}
	if err := namespace.validate(); err != nil {
		return err
	}
	return j.updateCommandInKey(commandNamespaceKey(namespace, commandID), commandID, ack)
}

func (j *Journal) updateCommandInKey(key, commandID string, ack protocol.CommandAck) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	entry, ok := j.commands[key]
	if !ok {
		return ErrCommandNotFound
	}
	if ack.CommandID != "" && ack.CommandID != commandID {
		return fmt.Errorf("command ACK identity %q does not match command %q", ack.CommandID, commandID)
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
		Namespace:     namespaceFromCommandKey(key),
		Ack:           &ack,
	}); err != nil {
		return err
	}
	entry.ack = cloneAck(ack)
	j.commands[key] = entry
	return nil
}

func (j *Journal) LookupCommand(commandID string) (protocol.CommandAck, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	key, err := j.uniqueCommandKeyLocked(commandID)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	entry, ok := j.commands[key]
	if !ok {
		return protocol.CommandAck{}, ErrCommandNotFound
	}
	return cloneAck(entry.ack), nil
}

func (j *Journal) LookupCommandInNamespace(namespace CommandNamespace, commandID string) (protocol.CommandAck, error) {
	if err := namespace.validate(); err != nil {
		return protocol.CommandAck{}, err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	entry, ok := j.commands[commandNamespaceKey(namespace, commandID)]
	if !ok {
		return protocol.CommandAck{}, j.missingScopedCommandErrorLocked(namespace, commandID)
	}
	return cloneAck(entry.ack), nil
}

// LookupCommandForRequest checks the durable command identity without requiring
// a live adapter. A caller can return this ACK before reacquiring a transport;
// a missing command remains unpersisted until the adapter accepts it.
func (j *Journal) LookupCommandForRequest(command protocol.Command) (protocol.CommandAck, bool, error) {
	return j.LookupCommandForRequestInNamespace(commandNamespaceForCommand(command), command)
}

func (j *Journal) LookupCommandForRequestInNamespace(namespace CommandNamespace, command protocol.Command) (protocol.CommandAck, bool, error) {
	if err := protocol.ValidateCommand(command); err != nil {
		return protocol.CommandAck{}, false, err
	}
	if err := validateCommandNamespace(namespace, command); err != nil {
		return protocol.CommandAck{}, false, err
	}
	digest, err := commandDigest(command)
	if err != nil {
		return protocol.CommandAck{}, false, err
	}

	j.mu.Lock()
	defer j.mu.Unlock()
	entry, ok := j.commands[commandNamespaceKey(namespace, command.CommandID)]
	if !ok {
		if err := j.missingScopedCommandErrorLocked(namespace, command.CommandID); !errors.Is(err, ErrCommandNotFound) {
			return protocol.CommandAck{}, false, err
		}
		return protocol.CommandAck{}, false, nil
	}
	if entry.digest != digest {
		return protocol.CommandAck{}, true, protocol.ErrIdempotencyConflict
	}
	ack := cloneAck(entry.ack)
	ack.Deduplicated = true
	return ack, true, nil
}

func (j *Journal) Command(commandID string) (protocol.Command, protocol.CommandAck, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	key, err := j.uniqueCommandKeyLocked(commandID)
	if err != nil {
		return protocol.Command{}, protocol.CommandAck{}, err
	}
	entry, ok := j.commands[key]
	if !ok {
		return protocol.Command{}, protocol.CommandAck{}, ErrCommandNotFound
	}
	return cloneCommand(entry.command), cloneAck(entry.ack), nil
}

func (j *Journal) CommandInNamespace(namespace CommandNamespace, commandID string) (protocol.Command, protocol.CommandAck, error) {
	if err := namespace.validate(); err != nil {
		return protocol.Command{}, protocol.CommandAck{}, err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	entry, ok := j.commands[commandNamespaceKey(namespace, commandID)]
	if !ok {
		return protocol.Command{}, protocol.CommandAck{}, j.missingScopedCommandErrorLocked(namespace, commandID)
	}
	return cloneCommand(entry.command), cloneAck(entry.ack), nil
}

func (j *Journal) indexCommandLocked(key, commandID string, entry commandEntry) {
	j.commands[key] = entry
	if j.commandKeysByID[commandID] == nil {
		j.commandKeysByID[commandID] = make(map[string]struct{})
	}
	j.commandKeysByID[commandID][key] = struct{}{}
}

func (j *Journal) uniqueCommandKeyLocked(commandID string) (string, error) {
	keys := j.commandKeysByID[strings.TrimSpace(commandID)]
	if len(keys) == 0 {
		return "", ErrCommandNotFound
	}
	if len(keys) != 1 {
		return "", ErrCommandScopeAmbiguous
	}
	for key := range keys {
		return key, nil
	}
	return "", ErrCommandNotFound
}

func (j *Journal) missingScopedCommandErrorLocked(namespace CommandNamespace, commandID string) error {
	keys := j.commandKeysByID[strings.TrimSpace(commandID)]
	if len(keys) == 0 {
		return ErrCommandNotFound
	}
	for key := range keys {
		if j.commands[key].legacy {
			if len(keys) == 1 {
				return fmt.Errorf("legacy command %q has no proven mapping to %s: %w", commandID, namespace.String(), ErrCommandScopeUnknown)
			}
			return fmt.Errorf("legacy command %q has ambiguous mapping to %s: %w", commandID, namespace.String(), ErrCommandScopeAmbiguous)
		}
	}
	return ErrCommandNotFound
}

func namespaceFromCommandKey(key string) *CommandNamespace {
	parts := strings.Split(key, "\x00")
	if len(parts) != 3 {
		return nil
	}
	namespace := CommandNamespace{Kind: CommandNamespaceKind(parts[0]), ID: parts[1]}
	return &namespace
}

func (j *Journal) AppendEvent(event protocol.Event) (protocol.Event, error) {
	if event.SessionID == "" {
		return protocol.Event{}, fmt.Errorf("event session id must not be empty")
	}

	j.mu.Lock()
	defer j.mu.Unlock()
	if event.Type == protocol.EventTypeApprovalResolved && (event.RunID == nil || strings.TrimSpace(*event.RunID) == "") {
		if runID := j.approvalRunIDLocked(event); runID != "" {
			event.RunID = &runID
		}
	}
	if event.EventID != "" {
		if _, ok := j.eventIDs[event.EventID]; ok {
			for _, existing := range j.events {
				if existing.EventID == event.EventID {
					return cloneEvent(existing), nil
				}
			}
		}
	}
	if len(j.events) >= maxJournalEvents {
		return protocol.Event{}, fmt.Errorf("%w: event count exceeds %d", ErrJournalTooLarge, maxJournalEvents)
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
	if _, exists := j.eventIndexByID[event.EventID]; !exists {
		j.eventIndexByID[event.EventID] = len(j.events) - 1
	}
	if _, exists := j.eventIndexByCursor[event.Cursor]; !exists {
		j.eventIndexByCursor[event.Cursor] = len(j.events) - 1
	}
	j.eventIDs[event.EventID] = struct{}{}
	if event.Sequence > j.sequenceBySession[event.SessionID] {
		j.sequenceBySession[event.SessionID] = event.Sequence
	}
	j.updatePendingApprovalLocked(event, j.sessionGenerationLocked(event.SessionID))
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
		index, found := j.eventIndexByCursor[query.AfterCursor]
		if !found || index < 0 || index >= len(j.events) {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		}
		event := j.events[index]
		if event.SessionID != query.SessionID || (query.RunID != "" && valueOrEmpty(event.RunID) != query.RunID) {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		}
		start = index + 1
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
	j.legacySessionFacts[sessionID] = SessionAlias{
		AdapterSessionID:  record.SessionID,
		ExternalThreadRef: record.ExternalThreadRef,
		Generation:        record.Generation,
		UpdatedAt:         record.UpdatedAt,
	}
	return nil
}

func validateSessionCreationCommandID(commandID string) error {
	if strings.TrimSpace(commandID) == "" {
		return errors.New("session creation command id is required")
	}
	return nil
}

func sessionStartPayloadDigest(request protocol.NewSessionRequest) (string, error) {
	payload := struct {
		ProjectID string `json:"project_id"`
		TaskID    string `json:"task_id"`
		Prompt    string `json:"prompt"`
	}{
		ProjectID: request.ProjectID,
		TaskID:    request.TaskID,
		Prompt:    request.Prompt,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return digestString(string(data)), nil
}

// BeginSessionStart records the child-generation intent before thread/start
// crosses the app-server side-effect boundary. An unresolved equivalent intent
// blocks a duplicate start until a caller explicitly reconciles it.
func (j *Journal) BeginSessionStart(gatewaySession protocol.GatewaySession, request protocol.NewSessionRequest) (string, error) {
	return j.beginSessionStart("", gatewaySession, request)
}

// BeginSessionStartForPlatform records the exact platform-to-gateway proof
// before the native thread/start side effect. Legacy callers must use
// BeginSessionStart so unattributed historical records remain unrecoverable.
func (j *Journal) BeginSessionStartForPlatform(platformSessionID string, gatewaySession protocol.GatewaySession, request protocol.NewSessionRequest) (string, error) {
	platformSessionID = normalizeIdentityPart(platformSessionID)
	if platformSessionID == "" {
		return "", ErrCommandScopeUnknown
	}
	return j.beginSessionStart(platformSessionID, gatewaySession, request)
}

func (j *Journal) beginSessionStart(platformSessionID string, gatewaySession protocol.GatewaySession, request protocol.NewSessionRequest) (string, error) {
	if gatewaySession.Handle == "" || gatewaySession.Generation == "" {
		return "", errors.New("gateway session handle and generation are required")
	}
	if err := validateSessionCreationCommandID(request.CommandID); err != nil {
		return "", err
	}
	requestDigest, err := sessionStartPayloadDigest(request)
	if err != nil {
		return "", fmt.Errorf("digest session start request: %w", err)
	}
	intent := sessionStartIntent{
		IntentID:          gatewaySession.Generation,
		PlatformSessionID: platformSessionID,
		GatewayHandle:     gatewaySession.Handle,
		Generation:        gatewaySession.Generation,
		CommandID:         request.CommandID,
		RequestDigest:     requestDigest,
		State:             "pending",
		UpdatedAt:         now(),
	}
	namespace := GatewayCommandNamespace(gatewaySession.Handle)
	j.mu.Lock()
	defer j.mu.Unlock()
	commandKey := commandNamespaceKey(namespace, request.CommandID)
	if intentID, ok := j.sessionStartByCommand[commandKey]; ok {
		existing := j.sessionStarts[intentID]
		if existing.PlatformSessionID != platformSessionID {
			return "", fmt.Errorf("%w: session start command %q has incompatible platform attribution", ErrCommandScopeAmbiguous, request.CommandID)
		}
		if existing.RequestDigest != requestDigest {
			return "", protocol.ErrIdempotencyConflict
		}
		if existing.State == "resolved" {
			return existing.IntentID, nil
		}
		if existing.State == "pending" {
			return "", fmt.Errorf("%w: unresolved session start intent exists", ErrUnknownOutcome)
		}
	}
	if platformSessionID == "" {
		if intentID, found, err := j.legacyResolvedSessionStartLocked(request.CommandID, requestDigest); err != nil {
			return "", err
		} else if found {
			return intentID, nil
		}
	}
	if existing, ok := j.sessionStarts[intent.IntentID]; ok {
		if existing.PlatformSessionID != intent.PlatformSessionID || existing.GatewayHandle != intent.GatewayHandle || existing.CommandID != intent.CommandID || existing.Generation != intent.Generation {
			return "", fmt.Errorf("%w: session start intent id %q is already owned by another namespace", ErrCommandScopeAmbiguous, intent.IntentID)
		}
		if existing.State == "pending" {
			return "", fmt.Errorf("%w: session start intent %q is already pending", ErrUnknownOutcome, intent.IntentID)
		}
	}
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "session_start",
		At:            intent.UpdatedAt,
		Namespace:     &namespace,
		SessionStart:  &intent,
	}); err != nil {
		return "", err
	}
	j.sessionStarts[intent.IntentID] = intent
	j.sessionStartByCommand[commandKey] = intent.IntentID
	return intent.IntentID, nil
}

func (j *Journal) ResolvedSessionStart(request protocol.NewSessionRequest) (protocol.AdapterSession, bool, error) {
	proof, found, err := j.ResolvedSessionStartProof(request)
	if err != nil || !found {
		return protocol.AdapterSession{}, found, err
	}
	return proof.AdapterSession, true, nil
}

func (j *Journal) ResolvedSessionStartForGateway(gatewayHandle string, request protocol.NewSessionRequest) (protocol.AdapterSession, bool, error) {
	proof, found, err := j.ResolvedSessionStartProofForGateway(gatewayHandle, request)
	if err != nil || !found {
		return protocol.AdapterSession{}, found, err
	}
	return proof.AdapterSession, true, nil
}

// HasPendingSessionStart reports whether one legacy-compatible unresolved
// creation intent exists for the request. It refuses to choose between
// multiple gateway namespaces.
func (j *Journal) HasPendingSessionStart(request protocol.NewSessionRequest) (bool, error) {
	if err := validateSessionCreationCommandID(request.CommandID); err != nil {
		return false, err
	}
	requestDigest, err := sessionStartPayloadDigest(request)
	if err != nil {
		return false, fmt.Errorf("digest session start request: %w", err)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	matching := 0
	for _, intent := range j.sessionStarts {
		if intent.CommandID == request.CommandID && intent.RequestDigest == requestDigest && intent.State == "pending" {
			matching++
		}
	}
	if matching > 1 {
		return false, ErrCommandScopeAmbiguous
	}
	return matching == 1, nil
}

// ResolvedSessionStartProof returns the exact resolved creation intent needed
// to rebuild a missing platform alias without starting a native session again.
func (j *Journal) ResolvedSessionStartProof(request protocol.NewSessionRequest) (SessionStartProof, bool, error) {
	if err := validateSessionCreationCommandID(request.CommandID); err != nil {
		return SessionStartProof{}, false, err
	}
	requestDigest, err := sessionStartPayloadDigest(request)
	if err != nil {
		return SessionStartProof{}, false, fmt.Errorf("digest session start request: %w", err)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	var selected *sessionStartIntent
	var matching int
	for _, intent := range j.sessionStarts {
		if intent.CommandID == "" || intent.CommandID != request.CommandID {
			continue
		}
		if intent.RequestDigest != requestDigest {
			return SessionStartProof{}, false, protocol.ErrIdempotencyConflict
		}
		if intent.State != "resolved" || intent.ExternalThreadRef == "" {
			continue
		}
		matching++
		if selected == nil {
			value := intent
			selected = &value
		}
	}
	if matching > 1 {
		return SessionStartProof{}, false, ErrCommandScopeAmbiguous
	}
	if selected == nil {
		return SessionStartProof{}, false, nil
	}
	return SessionStartProof{
		IntentID:      selected.IntentID,
		GatewayHandle: selected.GatewayHandle,
		Generation:    selected.Generation,
		CommandID:     selected.CommandID,
		RequestDigest: selected.RequestDigest,
		AdapterSession: protocol.AdapterSession{
			SessionID:         stableSessionID(selected.ExternalThreadRef),
			ExternalThreadRef: selected.ExternalThreadRef,
		},
	}, true, nil
}

func (j *Journal) ResolvedSessionStartProofForGateway(gatewayHandle string, request protocol.NewSessionRequest) (SessionStartProof, bool, error) {
	if strings.TrimSpace(gatewayHandle) == "" {
		return SessionStartProof{}, false, ErrCommandScopeUnknown
	}
	if err := validateSessionCreationCommandID(request.CommandID); err != nil {
		return SessionStartProof{}, false, err
	}
	requestDigest, err := sessionStartPayloadDigest(request)
	if err != nil {
		return SessionStartProof{}, false, fmt.Errorf("digest session start request: %w", err)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.resolvedSessionStartProofForGatewayLocked(gatewayHandle, request.CommandID, requestDigest)
}

func (j *Journal) resolvedSessionStartProofForGatewayLocked(gatewayHandle, commandID, requestDigest string) (SessionStartProof, bool, error) {
	intentID, ok := j.sessionStartByCommand[commandNamespaceKey(GatewayCommandNamespace(gatewayHandle), commandID)]
	if !ok {
		return SessionStartProof{}, false, nil
	}
	intent, ok := j.sessionStarts[intentID]
	if !ok {
		return SessionStartProof{}, false, fmt.Errorf("session start intent %q is missing: %w", intentID, ErrCommandScopeUnknown)
	}
	if intent.RequestDigest != requestDigest {
		return SessionStartProof{}, false, protocol.ErrIdempotencyConflict
	}
	if intent.State != "resolved" || intent.ExternalThreadRef == "" {
		return SessionStartProof{}, false, nil
	}
	return sessionStartProof(intent), true, nil
}

// ResolvedSessionStartProofForPlatform resolves a creation intent through the
// already verified platform alias. It is the recovery path for a link record
// that was not appended after the native session had already been resolved;
// it never falls back to a bare command ID.
func (j *Journal) ResolvedSessionStartProofForPlatform(platformSessionID string, request protocol.NewSessionRequest) (SessionStartProof, bool, error) {
	platformSessionID = normalizeIdentityPart(platformSessionID)
	if platformSessionID == "" {
		return SessionStartProof{}, false, ErrCommandScopeUnknown
	}
	if err := validateSessionCreationCommandID(request.CommandID); err != nil {
		return SessionStartProof{}, false, err
	}
	requestDigest, err := sessionStartPayloadDigest(request)
	if err != nil {
		return SessionStartProof{}, false, fmt.Errorf("digest session start request: %w", err)
	}

	j.mu.Lock()
	defer j.mu.Unlock()
	alias, ok := j.sessionAliases[platformSessionID]
	if !ok {
		var selected *sessionStartIntent
		var matching int
		for _, intent := range j.sessionStarts {
			if intent.PlatformSessionID != platformSessionID || intent.CommandID != request.CommandID || intent.State != "resolved" || intent.ExternalThreadRef == "" {
				continue
			}
			if intent.RequestDigest != requestDigest {
				return SessionStartProof{}, false, protocol.ErrIdempotencyConflict
			}
			matching++
			if selected == nil {
				value := intent
				selected = &value
			}
		}
		if matching > 1 {
			return SessionStartProof{}, false, ErrCommandScopeAmbiguous
		}
		if selected == nil {
			return SessionStartProof{}, false, fmt.Errorf("platform session %q has no exact resolved creation proof: %w", platformSessionID, errors.Join(ErrCommandScopeUnknown, ErrIdentityNotFound))
		}
		return sessionStartProof(*selected), true, nil
	}
	if alias.CommandID != request.CommandID {
		return SessionStartProof{}, false, ErrIdentityConflict
	}
	if link, linked, linkErr := j.gatewaySessionLinkForPlatformLocked(platformSessionID); linkErr != nil {
		return SessionStartProof{}, false, linkErr
	} else if linked {
		if !gatewaySessionLinkMatchesAlias(link, alias) {
			return SessionStartProof{}, false, ErrIdentityConflict
		}
		proof, found, proofErr := j.resolvedSessionStartProofForGatewayLocked(link.GatewayHandle, request.CommandID, requestDigest)
		if proofErr != nil {
			return SessionStartProof{}, false, proofErr
		}
		if !found {
			return SessionStartProof{}, false, fmt.Errorf("platform session %q gateway link has no resolved creation intent: %w", platformSessionID, ErrCommandScopeUnknown)
		}
		proof.AdapterSession.SessionID = alias.AdapterSessionID
		return proof, true, nil
	}
	var selected *sessionStartIntent
	var matching int
	for _, intent := range j.sessionStarts {
		if intent.CommandID != alias.CommandID || intent.State != "resolved" || intent.ExternalThreadRef != alias.ExternalThreadRef || intent.Generation != alias.Generation {
			continue
		}
		if intent.RequestDigest != requestDigest {
			return SessionStartProof{}, false, protocol.ErrIdempotencyConflict
		}
		matching++
		if selected == nil {
			value := intent
			selected = &value
		}
	}
	if matching > 1 {
		return SessionStartProof{}, false, ErrCommandScopeAmbiguous
	}
	if selected == nil {
		return SessionStartProof{}, false, fmt.Errorf("platform session %q has no matching resolved creation intent: %w", platformSessionID, ErrCommandScopeUnknown)
	}
	proof := sessionStartProof(*selected)
	proof.AdapterSession.SessionID = alias.AdapterSessionID
	return proof, true, nil
}

func sessionStartProof(intent sessionStartIntent) SessionStartProof {
	return SessionStartProof{
		IntentID:       intent.IntentID,
		GatewayHandle:  intent.GatewayHandle,
		Generation:     intent.Generation,
		CommandID:      intent.CommandID,
		RequestDigest:  intent.RequestDigest,
		AdapterSession: protocol.AdapterSession{SessionID: stableSessionID(intent.ExternalThreadRef), ExternalThreadRef: intent.ExternalThreadRef},
	}
}

// ResolveSessionStart atomically persists the durable session identity with
// the app-server thread identity learned from thread/start.
func (j *Journal) ResolveSessionStart(intentID, sessionID, externalThreadRef, generation string) error {
	if intentID == "" || sessionID == "" || externalThreadRef == "" {
		return errors.New("session start resolution identity is incomplete")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	intent, ok := j.sessionStarts[intentID]
	if !ok {
		return fmt.Errorf("session start intent %q is not present", intentID)
	}
	if intent.State == "resolved" {
		if intent.ExternalThreadRef == externalThreadRef {
			return nil
		}
		return fmt.Errorf("session start intent %q was resolved to another thread", intentID)
	}
	if intent.State != "pending" {
		return fmt.Errorf("session start intent %q is not pending", intentID)
	}
	if generation == "" {
		generation = intent.Generation
	}
	updatedAt := now()
	session := journalSession{SessionID: sessionID, ExternalThreadRef: externalThreadRef, Generation: generation, UpdatedAt: updatedAt}
	resolved := intent
	resolved.State = "resolved"
	resolved.ExternalThreadRef = externalThreadRef
	resolved.UpdatedAt = updatedAt
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "session",
		At:            updatedAt,
		Namespace:     namespacePointer(GatewayCommandNamespace(intent.GatewayHandle)),
		Session:       &session,
		SessionStart:  &resolved,
	}); err != nil {
		return err
	}
	j.sessions[sessionID] = session
	j.sessionStarts[intentID] = resolved
	return nil
}

// FailSessionStart clears a deterministic pre-side-effect failure while
// preserving unknown transport outcomes as pending intents.
func (j *Journal) FailSessionStart(intentID string) error {
	if intentID == "" {
		return errors.New("session start intent id must not be empty")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	intent, ok := j.sessionStarts[intentID]
	if !ok {
		return fmt.Errorf("session start intent %q is not present", intentID)
	}
	if intent.State == "failed" {
		return nil
	}
	if intent.State != "pending" {
		return fmt.Errorf("session start intent %q is not pending", intentID)
	}
	intent.State = "failed"
	intent.UpdatedAt = now()
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "session_start",
		At:            intent.UpdatedAt,
		Namespace:     namespacePointer(GatewayCommandNamespace(intent.GatewayHandle)),
		SessionStart:  &intent,
	}); err != nil {
		return err
	}
	j.sessionStarts[intentID] = intent
	return nil
}

func normalizeGatewaySessionLink(link GatewaySessionLink) (GatewaySessionLink, error) {
	link.GatewayHandle = normalizeIdentityPart(link.GatewayHandle)
	link.PlatformSessionID = normalizeIdentityPart(link.PlatformSessionID)
	link.AdapterSessionID = normalizeIdentityPart(link.AdapterSessionID)
	link.ExternalThreadRef = normalizeIdentityPart(link.ExternalThreadRef)
	link.Generation = normalizeIdentityPart(link.Generation)
	link.CommandID = normalizeIdentityPart(link.CommandID)
	if err := requireIdentityParts("gateway session link", link.GatewayHandle, link.PlatformSessionID, link.AdapterSessionID, link.ExternalThreadRef, link.Generation, link.CommandID); err != nil {
		return GatewaySessionLink{}, err
	}
	if link.UpdatedAt == "" {
		link.UpdatedAt = now()
	}
	return link, nil
}

func sameGatewaySessionLinkIdentity(left, right GatewaySessionLink) bool {
	return left.GatewayHandle == right.GatewayHandle &&
		left.PlatformSessionID == right.PlatformSessionID &&
		left.AdapterSessionID == right.AdapterSessionID &&
		left.ExternalThreadRef == right.ExternalThreadRef &&
		left.Generation == right.Generation &&
		left.CommandID == right.CommandID
}

func gatewaySessionLinkMatchesAlias(link GatewaySessionLink, alias SessionAlias) bool {
	return link.PlatformSessionID == alias.PlatformSessionID &&
		link.AdapterSessionID == alias.AdapterSessionID &&
		link.ExternalThreadRef == alias.ExternalThreadRef &&
		link.Generation == alias.Generation &&
		link.CommandID == alias.CommandID
}

// RecordGatewaySessionLink retains the exact gateway-to-platform creation
// relationship after the adapter has confirmed the native thread identity.
func (j *Journal) RecordGatewaySessionLink(link GatewaySessionLink) error {
	link, err := normalizeGatewaySessionLink(link)
	if err != nil {
		return err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	alias, ok := j.sessionAliases[link.PlatformSessionID]
	if !ok {
		return fmt.Errorf("platform session %q has no verified adapter alias: %w", link.PlatformSessionID, ErrIdentityNotFound)
	}
	if alias.AdapterSessionID != link.AdapterSessionID ||
		alias.ExternalThreadRef != link.ExternalThreadRef ||
		alias.Generation != link.Generation ||
		alias.CommandID != link.CommandID {
		return ErrIdentityConflict
	}
	if existing, ok := j.gatewayLinks[link.GatewayHandle]; ok {
		if sameGatewaySessionLinkIdentity(existing, link) {
			return nil
		}
		return ErrCommandScopeAmbiguous
	}
	if intentID, ok := j.sessionStartByCommand[commandNamespaceKey(GatewayCommandNamespace(link.GatewayHandle), link.CommandID)]; ok {
		intent := j.sessionStarts[intentID]
		if intent.Generation != link.Generation || intent.ExternalThreadRef != link.ExternalThreadRef {
			return ErrIdentityConflict
		}
	}
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "gateway_session_link",
		At:            link.UpdatedAt,
		GatewayLink:   &link,
	}); err != nil {
		return err
	}
	j.gatewayLinks[link.GatewayHandle] = link
	return nil
}

func (j *Journal) GatewaySessionLink(gatewayHandle string) (GatewaySessionLink, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	link, ok := j.gatewayLinks[normalizeIdentityPart(gatewayHandle)]
	return link, ok
}

func (j *Journal) GatewaySessionLinkForPlatform(platformSessionID string) (GatewaySessionLink, bool, error) {
	platformSessionID = normalizeIdentityPart(platformSessionID)
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.gatewaySessionLinkForPlatformLocked(platformSessionID)
}

func (j *Journal) gatewaySessionLinkForPlatformLocked(platformSessionID string) (GatewaySessionLink, bool, error) {
	var found GatewaySessionLink
	for _, link := range j.gatewayLinks {
		if link.PlatformSessionID != platformSessionID {
			continue
		}
		if found.GatewayHandle != "" {
			if found.CommandID != link.CommandID {
				return GatewaySessionLink{}, false, ErrCommandScopeAmbiguous
			}
			if link.UpdatedAt > found.UpdatedAt {
				found = link
			}
			continue
		}
		found = link
	}
	return found, found.GatewayHandle != "", nil
}

func (j *Journal) RecordReconciliation(value protocol.Reconciliation) error {
	if value.CommandID == "" {
		return errors.New("reconciliation command id must not be empty")
	}
	j.mu.Lock()
	key, err := j.uniqueCommandKeyLocked(value.CommandID)
	j.mu.Unlock()
	if err != nil {
		return err
	}
	namespace := namespaceFromCommandKey(key)
	if namespace == nil {
		return ErrCommandScopeUnknown
	}
	return j.RecordReconciliationInNamespace(*namespace, value)
}

func (j *Journal) RecordReconciliationInNamespace(namespace CommandNamespace, value protocol.Reconciliation) error {
	if value.CommandID == "" {
		return errors.New("reconciliation command id must not be empty")
	}
	if err := namespace.validate(); err != nil {
		return err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	key := commandNamespaceKey(namespace, value.CommandID)
	if _, ok := j.commands[key]; !ok {
		return j.missingScopedCommandErrorLocked(namespace, value.CommandID)
	}
	if err := j.appendLocked(journalRecord{
		FormatVersion:  journalFormatVersion,
		Type:           "reconciliation",
		At:             value.ObservedAt,
		Namespace:      &namespace,
		Reconciliation: &value,
	}); err != nil {
		return err
	}
	j.reconciliations[key] = cloneReconciliation(value)
	return nil
}

func (j *Journal) Reconciliation(commandID string) (protocol.Reconciliation, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	key, err := j.uniqueCommandKeyLocked(commandID)
	if err != nil {
		return protocol.Reconciliation{}, false
	}
	value, ok := j.reconciliations[key]
	if !ok {
		return protocol.Reconciliation{}, false
	}
	return cloneReconciliation(value), true
}

func (j *Journal) ReconciliationInNamespace(namespace CommandNamespace, commandID string) (protocol.Reconciliation, bool, error) {
	if err := namespace.validate(); err != nil {
		return protocol.Reconciliation{}, false, err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	key := commandNamespaceKey(namespace, commandID)
	if _, ok := j.commands[key]; !ok {
		return protocol.Reconciliation{}, false, j.missingScopedCommandErrorLocked(namespace, commandID)
	}
	value, ok := j.reconciliations[key]
	if !ok {
		return protocol.Reconciliation{}, false, nil
	}
	return cloneReconciliation(value), true, nil
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

// Sessions returns the durable adapter session identities in stable order for
// Connector startup and outbound event replay. It does not create or recover
// an app-server session; those side effects remain owned by the composition
// layer and the Gateway/Adapter pair.
func (j *Journal) Sessions() []protocol.AdapterSession {
	j.mu.Lock()
	defer j.mu.Unlock()
	values := make([]protocol.AdapterSession, 0, len(j.sessions))
	for _, session := range j.sessions {
		values = append(values, protocol.AdapterSession{SessionID: session.SessionID, ExternalThreadRef: session.ExternalThreadRef})
	}
	sort.Slice(values, func(i, k int) bool { return values[i].SessionID < values[k].SessionID })
	return values
}

func (j *Journal) PendingApprovals(sessionID, runID string) []PendingApproval {
	return j.PendingApprovalsForGeneration(sessionID, "", runID)
}

func (j *Journal) PendingApprovalsForGeneration(sessionID, generation, runID string) []PendingApproval {
	j.mu.Lock()
	defer j.mu.Unlock()
	values := make([]PendingApproval, 0)
	for _, approval := range j.pendingApprovals {
		if approval.SessionID != sessionID || (generation != "" && approval.Generation != generation) || (runID != "" && approval.RunID != runID) {
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
		if existing.CommandID != commandID || existing.Decision != decision || existing.Revision != revision || !approvalClaimMatches(existing, pending) {
			return PendingApproval{}, false, ErrApprovalClaimed
		}
		return cloneApproval(pending), true, nil
	}
	claim := approvalClaimRecord{
		SessionID:  sessionID,
		RequestID:  append(json.RawMessage(nil), requestID...),
		Generation: pending.Generation,
		RunID:      pending.RunID,
		TurnID:     pending.TurnID,
		ItemID:     pending.ItemID,
		Revision:   revision,
		CommandID:  commandID,
		Decision:   decision,
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

// FindPendingApproval resolves the public approval id to the exact raw JSON-RPC
// request id that must be answered. Numeric and string JSON ids remain distinct.
func (j *Journal) FindPendingApproval(sessionID, runID string, requestID json.RawMessage) (PendingApproval, error) {
	return j.FindPendingApprovalForGeneration(sessionID, "", runID, requestID)
}

func (j *Journal) FindPendingApprovalForGeneration(sessionID, generation, runID string, requestID json.RawMessage) (PendingApproval, error) {
	wanted := approvalIDIdentity(requestID)
	wantedText := approvalIDText(requestID)
	j.mu.Lock()
	defer j.mu.Unlock()
	var exact, textual *PendingApproval
	for _, approval := range j.pendingApprovals {
		if approval.SessionID != sessionID || (generation != "" && approval.Generation != generation) || (runID != "" && approval.RunID != runID) {
			continue
		}
		if approvalIDIdentity(approval.RequestID) == wanted {
			if exact != nil {
				return PendingApproval{}, fmt.Errorf("approval id %q is ambiguous", approvalIDText(requestID))
			}
			value := cloneApproval(approval)
			exact = &value
			continue
		}
		if wantedText == "" || approvalIDText(approval.RequestID) != wantedText {
			continue
		}
		if textual != nil {
			return PendingApproval{}, fmt.Errorf("approval id %q is ambiguous", approvalIDText(requestID))
		}
		value := cloneApproval(approval)
		textual = &value
	}
	if exact != nil {
		return *exact, nil
	}
	if textual == nil {
		return PendingApproval{}, ErrApprovalNotFound
	}
	return *textual, nil
}

func (j *Journal) ApprovalResult(commandID string) (string, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	key, err := j.uniqueApprovalResultKeyLocked(commandID)
	if err != nil {
		return "", false
	}
	result, ok := j.approvalResults[key]
	return result, ok
}

func (j *Journal) ApprovalResultInNamespace(namespace CommandNamespace, commandID string) (string, bool, error) {
	if err := namespace.validate(); err != nil {
		return "", false, err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	key := commandNamespaceKey(namespace, commandID)
	result, ok := j.approvalResults[key]
	return result, ok, nil
}

func (j *Journal) uniqueApprovalResultKeyLocked(commandID string) (string, error) {
	var found string
	for key := range j.approvalResults {
		parts := strings.Split(key, "\x00")
		if len(parts) != 3 || parts[2] != strings.TrimSpace(commandID) {
			continue
		}
		if found != "" {
			return "", ErrCommandScopeAmbiguous
		}
		found = key
	}
	if found == "" {
		return "", ErrCommandNotFound
	}
	return found, nil
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

func (j *Journal) load() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	info, err := j.file.Stat()
	if err != nil {
		return fmt.Errorf("stat journal: %w", err)
	}
	if info.Size() > maxJournalBytes {
		return fmt.Errorf("%w: file size %d exceeds %d bytes", ErrJournalTooLarge, info.Size(), maxJournalBytes)
	}
	if _, err := j.file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("seek journal start: %w", err)
	}
	reader := bufio.NewReaderSize(j.file, 64*1024)
	validEnd := int64(0)
	needsNewline := false
	for validEnd < info.Size() {
		lineStart := validEnd
		line, recordSize, terminated, err := readJournalRecord(reader)
		if err != nil {
			return fmt.Errorf("read journal: %w", err)
		}
		if recordSize == 0 {
			break
		}
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			validEnd = lineStart + recordSize
			if terminated {
				continue
			}
			break
		}
		var record journalRecord
		if err := json.Unmarshal(line, &record); err != nil {
			if terminated {
				return fmt.Errorf("%w at byte %d: %v", ErrJournalCorrupt, lineStart, err)
			}
			break
		}
		if err := j.applyRecord(record); err != nil {
			return err
		}
		validEnd = lineStart + recordSize
		if terminated {
		} else {
			needsNewline = true
		}
	}
	if validEnd != info.Size() {
		if err := j.file.Truncate(validEnd); err != nil {
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

func (j *Journal) ensureFormatMarker() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.formatMarkerSeen {
		return nil
	}
	if err := j.appendLocked(journalRecord{FormatVersion: journalFormatVersion, Type: "journal_header", At: now()}); err != nil {
		return fmt.Errorf("write journal format marker: %w", err)
	}
	j.formatMarkerSeen = true
	return nil
}

func readJournalRecord(reader *bufio.Reader) ([]byte, int64, bool, error) {
	var record []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		record = append(record, chunk...)
		if len(record) > maxJournalRecordBytes {
			return nil, int64(len(record)), false, fmt.Errorf("%w: record exceeds %d bytes", ErrJournalTooLarge, maxJournalRecordBytes)
		}
		if err == nil {
			return record[:len(record)-1], int64(len(record)), true, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			if len(record) == 0 {
				return nil, 0, false, nil
			}
			return record, int64(len(record)), false, nil
		}
		return nil, int64(len(record)), false, err
	}
}

func commandNamespaceFromRecord(command protocol.Command, namespace *CommandNamespace, formatVersion int) (CommandNamespace, bool, error) {
	if formatVersion >= journalFormatVersion {
		if namespace == nil {
			return CommandNamespace{}, false, ErrCommandScopeUnknown
		}
		if err := namespace.validate(); err != nil {
			return CommandNamespace{}, false, err
		}
		if err := validateCommandNamespace(*namespace, command); err != nil {
			return CommandNamespace{}, false, err
		}
		return *namespace, false, nil
	}
	legacyNamespace := commandNamespaceForCommand(command)
	if err := legacyNamespace.validate(); err != nil {
		return CommandNamespace{}, false, err
	}
	return legacyNamespace, true, nil
}

func (j *Journal) commandUpdateKeyLocked(record journalRecord) (string, error) {
	if record.FormatVersion >= journalFormatVersion {
		if record.Namespace == nil {
			return "", ErrCommandScopeUnknown
		}
		if err := record.Namespace.validate(); err != nil {
			return "", err
		}
		key := commandNamespaceKey(*record.Namespace, record.CommandID)
		if _, ok := j.commands[key]; !ok {
			return "", j.missingScopedCommandErrorLocked(*record.Namespace, record.CommandID)
		}
		return key, nil
	}
	return j.uniqueCommandKeyLocked(record.CommandID)
}

func (j *Journal) applyRecord(record journalRecord) error {
	if record.Type == "journal_header" {
		if record.FormatVersion != journalFormatVersion || j.formatMarkerSeen {
			return fmt.Errorf("%w: invalid journal format marker", ErrJournalCorrupt)
		}
		j.formatMarkerSeen = true
		return nil
	}
	if record.FormatVersion != legacyJournalFormatVersion && record.FormatVersion != previousJournalFormatVersion && record.FormatVersion != identityJournalFormatVersion && record.FormatVersion != journalFormatVersion {
		return fmt.Errorf("%w: unsupported journal format version %d", ErrJournalCorrupt, record.FormatVersion)
	}
	if record.FormatVersion == journalFormatVersion && !j.formatMarkerSeen {
		return fmt.Errorf("%w: journal v%d record is missing its format marker", ErrJournalCorrupt, journalFormatVersion)
	}
	if j.formatMarkerSeen && record.FormatVersion != journalFormatVersion {
		return fmt.Errorf("%w: legacy journal writer appended after v%d marker", ErrJournalCorrupt, journalFormatVersion)
	}
	switch record.Type {
	case "command":
		if record.Command == nil || record.Ack == nil || record.CommandID == "" || record.Digest == "" {
			return fmt.Errorf("%w: incomplete command record", ErrJournalCorrupt)
		}
		if record.Command.CommandID != record.CommandID || record.Ack.CommandID != record.CommandID {
			return fmt.Errorf("%w: command identity mismatch for %q", ErrJournalCorrupt, record.CommandID)
		}
		digest, err := commandDigest(*record.Command)
		if err != nil {
			return fmt.Errorf("%w: normalize command digest: %v", ErrJournalCorrupt, err)
		}
		if record.FormatVersion >= previousJournalFormatVersion && record.Digest != digest {
			legacyDigest, legacyErr := commandDigestWithIssuedAt(*record.Command)
			if legacyErr != nil || record.Digest != legacyDigest {
				return fmt.Errorf("%w: command digest mismatch for %q", ErrJournalCorrupt, record.CommandID)
			}
		}
		namespace, legacy, err := commandNamespaceFromRecord(*record.Command, record.Namespace, record.FormatVersion)
		if err != nil {
			return fmt.Errorf("%w: command %q namespace: %v", ErrJournalCorrupt, record.CommandID, err)
		}
		key := commandNamespaceKey(namespace, record.CommandID)
		if existing, ok := j.commands[key]; ok && existing.digest != digest {
			return fmt.Errorf("%w: conflicting command record %q in %s", ErrJournalCorrupt, record.CommandID, namespace.String())
		}
		if _, ok := j.commands[key]; ok {
			return nil
		}
		j.indexCommandLocked(key, record.CommandID, commandEntry{command: cloneCommand(*record.Command), digest: digest, ack: cloneAck(*record.Ack), legacy: legacy})
	case "command_update":
		if record.Ack == nil || record.CommandID == "" {
			return fmt.Errorf("%w: incomplete command update", ErrJournalCorrupt)
		}
		if record.Ack.CommandID != "" && record.Ack.CommandID != record.CommandID {
			return fmt.Errorf("%w: command update identity mismatch for %q", ErrJournalCorrupt, record.CommandID)
		}
		key, err := j.commandUpdateKeyLocked(record)
		if err != nil {
			return fmt.Errorf("%w: command update for %q: %v", ErrJournalCorrupt, record.CommandID, err)
		}
		entry, ok := j.commands[key]
		if !ok {
			return fmt.Errorf("%w: command update for %q", ErrJournalCorrupt, record.CommandID)
		}
		ack := cloneAck(*record.Ack)
		ack.CommandID = record.CommandID
		entry.ack = ack
		j.commands[key] = entry
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
		if len(j.events) >= maxJournalEvents {
			return fmt.Errorf("%w: event count exceeds %d", ErrJournalTooLarge, maxJournalEvents)
		}
		if event.Type == protocol.EventTypeApprovalResolved && (event.RunID == nil || strings.TrimSpace(*event.RunID) == "") {
			if runID := j.approvalRunIDLocked(event); runID != "" {
				event.RunID = &runID
			}
		}
		j.events = append(j.events, event)
		if _, exists := j.eventIndexByID[event.EventID]; !exists {
			j.eventIndexByID[event.EventID] = len(j.events) - 1
		}
		if _, exists := j.eventIndexByCursor[event.Cursor]; !exists {
			j.eventIndexByCursor[event.Cursor] = len(j.events) - 1
		}
		j.eventIDs[event.EventID] = struct{}{}
		if event.Sequence > j.sequenceBySession[event.SessionID] {
			j.sequenceBySession[event.SessionID] = event.Sequence
		}
		j.updatePendingApprovalLocked(event, j.sessionGenerationLocked(event.SessionID))
	case "session":
		if record.Session == nil || record.Session.SessionID == "" || record.Session.ExternalThreadRef == "" {
			return fmt.Errorf("%w: incomplete session record", ErrJournalCorrupt)
		}
		j.sessions[record.Session.SessionID] = *record.Session
		j.legacySessionFacts[record.Session.SessionID] = SessionAlias{
			AdapterSessionID:  record.Session.SessionID,
			ExternalThreadRef: record.Session.ExternalThreadRef,
			Generation:        record.Session.Generation,
			UpdatedAt:         record.Session.UpdatedAt,
		}
		if record.SessionStart != nil {
			if err := j.applySessionStartLoadedLocked(*record.SessionStart, record.Namespace, record.FormatVersion); err != nil {
				return err
			}
		}
	case "session_alias":
		if record.FormatVersion != identityJournalFormatVersion && record.FormatVersion != journalFormatVersion {
			return fmt.Errorf("%w: session alias requires journal format version %d or %d", ErrJournalCorrupt, identityJournalFormatVersion, journalFormatVersion)
		}
		if record.SessionAlias == nil {
			return fmt.Errorf("%w: incomplete session alias", ErrJournalCorrupt)
		}
		alias, err := normalizeSessionAlias(*record.SessionAlias)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrJournalCorrupt, err)
		}
		if err := j.applySessionAliasLoadedLocked(alias); err != nil {
			return err
		}
	case "run_binding":
		if record.FormatVersion != identityJournalFormatVersion && record.FormatVersion != journalFormatVersion {
			return fmt.Errorf("%w: run binding requires journal format version %d or %d", ErrJournalCorrupt, identityJournalFormatVersion, journalFormatVersion)
		}
		if record.RunBinding == nil {
			return fmt.Errorf("%w: incomplete run binding", ErrJournalCorrupt)
		}
		binding, err := normalizeRunBinding(*record.RunBinding)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrJournalCorrupt, err)
		}
		if err := j.applyRunBindingLoadedLocked(binding); err != nil {
			return err
		}
	case "observed_event":
		if record.FormatVersion != identityJournalFormatVersion && record.FormatVersion != journalFormatVersion {
			return fmt.Errorf("%w: observed event requires journal format version %d or %d", ErrJournalCorrupt, identityJournalFormatVersion, journalFormatVersion)
		}
		if record.ObservedEvent == nil {
			return fmt.Errorf("%w: incomplete observed event", ErrJournalCorrupt)
		}
		observed := *record.ObservedEvent
		if observed.RawPayload != nil {
			observed.Event.Payload = json.RawMessage(cloneRawPayload(observed.RawPayload.Bytes))
		}
		observation, err := normalizeEventObservation(observed.Observation)
		if err != nil || observed.Event.SessionID == "" || observed.Event.EventID == "" || observed.Event.Cursor == "" || observed.Event.Sequence <= 0 {
			if err == nil {
				err = errors.New("observed event identity is incomplete")
			}
			return fmt.Errorf("%w: %v", ErrJournalCorrupt, err)
		}
		if observed.Event.RunID != nil && strings.TrimSpace(*observed.Event.RunID) != "" {
			return fmt.Errorf("%w: observed event must not persist a platform run id", ErrJournalCorrupt)
		}
		if observation.AdapterSessionID != observed.Event.SessionID {
			return fmt.Errorf("%w: observed event adapter session mismatch", ErrJournalCorrupt)
		}
		observed.Observation = observation
		if existing, ok := j.observedEvents[observed.Event.EventID]; ok {
			if !sameObservedEvent(existing, observed.Event, observed.Observation) {
				return fmt.Errorf("%w: conflicting observed event %q", ErrJournalCorrupt, observed.Event.EventID)
			}
			return nil
		}
		if _, duplicate := j.eventIDs[observed.Event.EventID]; duplicate {
			return fmt.Errorf("%w: observed event %q conflicts with an existing event", ErrJournalCorrupt, observed.Event.EventID)
		}
		if len(j.events) >= maxJournalEvents {
			return fmt.Errorf("%w: event count exceeds %d", ErrJournalTooLarge, maxJournalEvents)
		}
		j.events = append(j.events, cloneEvent(observed.Event))
		j.observedEvents[observed.Event.EventID] = observed
		j.eventIndexByID[observed.Event.EventID] = len(j.events) - 1
		if _, exists := j.eventIndexByCursor[observed.Event.Cursor]; !exists {
			j.eventIndexByCursor[observed.Event.Cursor] = len(j.events) - 1
		}
		j.eventIDs[observed.Event.EventID] = struct{}{}
		if observed.Event.Sequence > j.sequenceBySession[observed.Event.SessionID] {
			j.sequenceBySession[observed.Event.SessionID] = observed.Event.Sequence
		}
		approvalEvent := cloneEvent(observed.Event)
		if observed.Observation.NativeTurnID != "" {
			approvalEvent.RunID = stringPointer(observed.Observation.NativeTurnID)
		}
		if approvalEvent.Type == protocol.EventTypeApprovalResolved && (approvalEvent.RunID == nil || strings.TrimSpace(*approvalEvent.RunID) == "") {
			if runID := j.approvalRunIDLockedForGeneration(approvalEvent, observed.Observation.Generation); runID != "" {
				approvalEvent.RunID = &runID
			}
		}
		j.updatePendingApprovalLocked(approvalEvent, observed.Observation.Generation)
	case "session_start":
		if record.SessionStart == nil {
			return fmt.Errorf("%w: incomplete session start intent", ErrJournalCorrupt)
		}
		if err := j.applySessionStartLoadedLocked(*record.SessionStart, record.Namespace, record.FormatVersion); err != nil {
			return err
		}
	case "reconciliation":
		if record.Reconciliation == nil || record.Reconciliation.CommandID == "" {
			return fmt.Errorf("%w: incomplete reconciliation record", ErrJournalCorrupt)
		}
		key, err := j.reconciliationKeyLoadedLocked(record)
		if err != nil {
			return fmt.Errorf("%w: reconciliation command %q namespace: %v", ErrJournalCorrupt, record.Reconciliation.CommandID, err)
		}
		j.reconciliations[key] = cloneReconciliation(*record.Reconciliation)
	case "gateway_session_link":
		if record.FormatVersion != journalFormatVersion || record.GatewayLink == nil {
			return fmt.Errorf("%w: gateway session link requires v%d", ErrJournalCorrupt, journalFormatVersion)
		}
		link, err := normalizeGatewaySessionLink(*record.GatewayLink)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrJournalCorrupt, err)
		}
		alias, ok := j.sessionAliases[link.PlatformSessionID]
		if !ok {
			return fmt.Errorf("%w: gateway session link %q has no verified adapter alias", ErrJournalCorrupt, link.GatewayHandle)
		}
		if alias.AdapterSessionID != link.AdapterSessionID ||
			alias.ExternalThreadRef != link.ExternalThreadRef ||
			alias.Generation != link.Generation ||
			alias.CommandID != link.CommandID {
			return fmt.Errorf("%w: gateway session link %q disagrees with its adapter alias", ErrJournalCorrupt, link.GatewayHandle)
		}
		if existing, ok := j.gatewayLinks[link.GatewayHandle]; ok && !sameGatewaySessionLinkIdentity(existing, link) {
			return fmt.Errorf("%w: conflicting gateway session link %q", ErrJournalCorrupt, link.GatewayHandle)
		}
		j.gatewayLinks[link.GatewayHandle] = link
	case "approval_claim":
		if record.ApprovalClaim == nil || record.ApprovalClaim.SessionID == "" || len(bytes.TrimSpace(record.ApprovalClaim.RequestID)) == 0 || record.ApprovalClaim.CommandID == "" || record.ApprovalClaim.Revision <= 0 {
			return fmt.Errorf("%w: incomplete approval claim", ErrJournalCorrupt)
		}
		claim := *record.ApprovalClaim
		claim.RequestID = append(json.RawMessage(nil), claim.RequestID...)
		key := approvalKey(claim.SessionID, claim.RequestID)
		if pending, pendingExists := j.pendingApprovals[key]; pendingExists {
			if claim.Generation == "" {
				claim.Generation = pending.Generation
			}
			if claim.RunID == "" {
				claim.RunID = pending.RunID
			}
			if claim.TurnID == "" {
				claim.TurnID = pending.TurnID
			}
			if claim.ItemID == "" {
				claim.ItemID = pending.ItemID
			}
		}
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

func (j *Journal) applySessionStartLoadedLocked(intent sessionStartIntent, namespace *CommandNamespace, formatVersion int) error {
	if err := validateSessionStartIntent(intent, formatVersion != legacyJournalFormatVersion); err != nil {
		return err
	}
	if formatVersion >= journalFormatVersion {
		if namespace == nil || namespace.Kind != CommandNamespaceGateway || namespace.ID != intent.GatewayHandle {
			return fmt.Errorf("%w: session start namespace does not match gateway handle %q", ErrJournalCorrupt, intent.GatewayHandle)
		}
	}
	if existing, ok := j.sessionStarts[intent.IntentID]; ok {
		if existing.PlatformSessionID != intent.PlatformSessionID || existing.GatewayHandle != intent.GatewayHandle || existing.Generation != intent.Generation || existing.CommandID != intent.CommandID || existing.RequestDigest != intent.RequestDigest {
			return fmt.Errorf("%w: conflicting session start intent %q", ErrJournalCorrupt, intent.IntentID)
		}
		if existing.State == "resolved" && intent.State == "pending" {
			return fmt.Errorf("%w: session start intent %q regressed from resolved", ErrJournalCorrupt, intent.IntentID)
		}
		if existing.State == "resolved" && intent.State == "resolved" && existing.ExternalThreadRef != intent.ExternalThreadRef {
			return fmt.Errorf("%w: session start intent %q resolved to multiple threads", ErrJournalCorrupt, intent.IntentID)
		}
	}
	j.sessionStarts[intent.IntentID] = intent
	if formatVersion < journalFormatVersion {
		j.legacySessionStartIDs[intent.IntentID] = struct{}{}
	}
	if intent.CommandID != "" {
		key := commandNamespaceKey(GatewayCommandNamespace(intent.GatewayHandle), intent.CommandID)
		if existingIntentID, ok := j.sessionStartByCommand[key]; ok && existingIntentID != intent.IntentID {
			return fmt.Errorf("%w: session start command %q maps to multiple gateway intents", ErrJournalCorrupt, intent.CommandID)
		}
		j.sessionStartByCommand[key] = intent.IntentID
	}
	return nil
}

func (j *Journal) legacyResolvedSessionStartLocked(commandID, requestDigest string) (string, bool, error) {
	var found string
	for intentID := range j.legacySessionStartIDs {
		intent, ok := j.sessionStarts[intentID]
		if !ok || intent.CommandID != commandID {
			continue
		}
		if intent.RequestDigest != requestDigest {
			return "", false, protocol.ErrIdempotencyConflict
		}
		if intent.State != "resolved" || intent.ExternalThreadRef == "" {
			continue
		}
		if found != "" {
			return "", false, ErrCommandScopeAmbiguous
		}
		found = intentID
	}
	return found, found != "", nil
}

func (j *Journal) reconciliationKeyLoadedLocked(record journalRecord) (string, error) {
	if record.FormatVersion >= journalFormatVersion {
		if record.Namespace == nil {
			return "", ErrCommandScopeUnknown
		}
		if err := record.Namespace.validate(); err != nil {
			return "", err
		}
		key := commandNamespaceKey(*record.Namespace, record.Reconciliation.CommandID)
		if _, ok := j.commands[key]; !ok {
			return "", j.missingScopedCommandErrorLocked(*record.Namespace, record.Reconciliation.CommandID)
		}
		return key, nil
	}
	return j.uniqueCommandKeyLocked(record.Reconciliation.CommandID)
}

func validateSessionStartIntent(intent sessionStartIntent, requireCommandID bool) error {
	if intent.IntentID == "" || intent.GatewayHandle == "" || intent.Generation == "" || intent.RequestDigest == "" {
		return fmt.Errorf("%w: incomplete session start intent", ErrJournalCorrupt)
	}
	if intent.PlatformSessionID != "" && (strings.TrimSpace(intent.PlatformSessionID) != intent.PlatformSessionID || strings.ContainsRune(intent.PlatformSessionID, '\x00')) {
		return fmt.Errorf("%w: invalid platform session attribution", ErrJournalCorrupt)
	}
	if requireCommandID && strings.TrimSpace(intent.CommandID) == "" {
		return fmt.Errorf("%w: session start intent command id is required", ErrJournalCorrupt)
	}
	switch intent.State {
	case "pending", "resolved", "failed":
		return nil
	default:
		return fmt.Errorf("%w: unknown session start intent state %q", ErrJournalCorrupt, intent.State)
	}
}

func (j *Journal) markInFlightUnknown() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	for key, entry := range j.commands {
		if entry.ack.State != protocol.CommandStateAccepted && entry.ack.State != protocol.CommandStateExecuting {
			continue
		}
		ack := cloneAck(entry.ack)
		ack.State = protocol.CommandStateUnknown
		if err := j.appendLocked(journalRecord{
			FormatVersion: journalFormatVersion,
			Type:          "command_update",
			At:            now(),
			CommandID:     entry.command.CommandID,
			Namespace:     namespaceFromCommandKey(key),
			Ack:           &ack,
		}); err != nil {
			return fmt.Errorf("mark command %q unknown after restart: %w", entry.command.CommandID, err)
		}
		entry.ack = ack
		j.commands[key] = entry
	}
	return nil
}

func (j *Journal) appendLocked(record journalRecord) error {
	if j.fatalErr != nil {
		return fmt.Errorf("journal write path is unusable: %w", j.fatalErr)
	}
	if j.file == nil {
		return errors.New("journal is closed")
	}
	data, err := json.Marshal(record)
	if err != nil {
		return j.poisonLocked(fmt.Errorf("encode journal record: %w", err))
	}
	data = append(data, '\n')
	if len(data) > maxJournalRecordBytes {
		return fmt.Errorf("%w: record exceeds %d bytes", ErrJournalTooLarge, maxJournalRecordBytes)
	}
	if _, err := j.file.Seek(0, io.SeekEnd); err != nil {
		return j.poisonLocked(fmt.Errorf("seek journal end: %w", err))
	}
	start, err := j.file.Seek(0, io.SeekCurrent)
	if err != nil {
		return j.poisonLocked(fmt.Errorf("locate journal end: %w", err))
	}
	if start > maxJournalBytes-int64(len(data)) {
		return j.poisonLocked(fmt.Errorf("%w: file would exceed %d bytes", ErrJournalTooLarge, maxJournalBytes))
	}
	written, err := writeAll(j.file, data)
	if err != nil {
		if truncateErr := j.file.Truncate(start); truncateErr != nil {
			return j.poisonLocked(fmt.Errorf("write journal record after %d bytes: %w; truncate partial record: %v", written, err, truncateErr))
		}
		_ = j.file.Sync()
		return j.poisonLocked(fmt.Errorf("write journal record after %d bytes: %w", written, err))
	}
	if err := j.file.Sync(); err != nil {
		return j.poisonLocked(fmt.Errorf("sync journal record: %w", err))
	}
	return nil
}

func (j *Journal) poisonLocked(err error) error {
	if j.fatalErr == nil {
		j.fatalErr = err
	}
	return fmt.Errorf("journal write path is unusable: %w", j.fatalErr)
}

func (j *Journal) sessionGenerationLocked(sessionID string) string {
	if session, ok := j.sessions[sessionID]; ok {
		return session.Generation
	}
	return ""
}

func (j *Journal) updatePendingApprovalLocked(event protocol.Event, generation string) {
	if event.Type != protocol.EventTypeApprovalRequested && event.Type != protocol.EventTypeApprovalResolved && event.Type != protocol.EventTypeItemCompleted {
		return
	}
	var message struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			ThreadID   string          `json:"threadId"`
			TurnID     string          `json:"turnId"`
			RequestID  json.RawMessage `json:"requestId"`
			Revision   int64           `json:"revision"`
			Resolution string          `json:"resolution"`
			Command    string          `json:"command"`
			ItemID     string          `json:"itemId"`
			Item       struct {
				ID      string `json:"id"`
				Type    string `json:"type"`
				Status  string `json:"status"`
				Command string `json:"command"`
			} `json:"item"`
		} `json:"params"`
	}
	if err := json.Unmarshal(event.Payload, &message); err != nil {
		return
	}
	requestID := message.ID
	if event.Type == protocol.EventTypeApprovalRequested && (len(bytes.TrimSpace(requestID)) == 0 || bytes.Equal(bytes.TrimSpace(requestID), []byte("null"))) {
		requestID = message.Params.RequestID
	}
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
		command := message.Params.Command
		if command == "" {
			command = message.Params.Item.Command
		}
		pending := PendingApproval{
			RequestID:  append(json.RawMessage(nil), requestID...),
			SessionID:  event.SessionID,
			Generation: generation,
			RunID:      valueOrEmpty(event.RunID),
			ThreadID:   message.Params.ThreadID,
			TurnID:     message.Params.TurnID,
			ItemID:     itemID,
			Revision:   revision,
			Command:    command,
		}
		if _, exists := j.pendingApprovals[key]; exists {
			if claim, claimed := j.approvalClaims[key]; claimed && !approvalClaimMatches(claim, pending) {
				delete(j.approvalClaims, key)
			}
		}
		j.pendingApprovals[key] = pending
		return
	}
	if event.Type == protocol.EventTypeApprovalResolved {
		rawResolution := strings.TrimSpace(message.Params.Resolution)
		resolution := normalizeApprovalDecision(rawResolution)
		pending, pendingExists := j.pendingApprovals[key]
		if !pendingExists || !approvalEventMatchesPending(event, pending, message.Params.TurnID) {
			return
		}
		if claim, claimed := j.approvalClaims[key]; claimed {
			if !approvalClaimMatches(claim, pending) || !approvalPendingMatchesGeneration(j.sessions, pending, generation) {
				delete(j.pendingApprovals, key)
				delete(j.approvalClaims, key)
				return
			}
			if rawResolution == "" {
				// A request can be cleared without proving which decision was
				// applied. Record delivery separately and keep the claim until
				// item/completed supplies the resulting item status.
				j.approvalResults[commandNamespaceKey(AdapterSessionCommandNamespace(event.SessionID), claim.CommandID)] = approvalResolutionCleared
				return
			}
			if resolution == "" {
				resolution = "unknown"
			}
			j.approvalResults[commandNamespaceKey(AdapterSessionCommandNamespace(event.SessionID), claim.CommandID)] = resolution
		}
		delete(j.pendingApprovals, key)
		delete(j.approvalClaims, key)
		return
	}
	if event.Type == protocol.EventTypeItemCompleted && message.Params.Item.Status != "" && message.Params.Item.Status != "inProgress" {
		for requestKey, approval := range j.pendingApprovals {
			if approval.SessionID == event.SessionID && approval.ItemID != "" && approval.ItemID == message.Params.Item.ID && approvalEventMatchesPending(event, approval, message.Params.TurnID) {
				if claim, claimed := j.approvalClaims[requestKey]; claimed {
					if !approvalClaimMatches(claim, approval) || !approvalPendingMatchesGeneration(j.sessions, approval, generation) {
						delete(j.pendingApprovals, requestKey)
						delete(j.approvalClaims, requestKey)
						continue
					}
					resolution := normalizeApprovalDecision(claim.Decision)
					if strings.EqualFold(message.Params.Item.Status, "declined") {
						resolution = "decline"
					}
					if resolution == "" {
						resolution = "unknown"
					}
					j.approvalResults[commandNamespaceKey(AdapterSessionCommandNamespace(event.SessionID), claim.CommandID)] = resolution
				}
				delete(j.pendingApprovals, requestKey)
				delete(j.approvalClaims, requestKey)
			}
		}
	}
}

func (j *Journal) approvalRunIDLocked(event protocol.Event) string {
	return j.approvalRunIDLockedForGeneration(event, j.sessionGenerationLocked(event.SessionID))
}

func (j *Journal) approvalRunIDLockedForGeneration(event protocol.Event, generation string) string {
	requestID := approvalRequestIDFromPayload(event.Payload)
	key := approvalKey(event.SessionID, requestID)
	if key == "" {
		return ""
	}
	pending, ok := j.pendingApprovals[key]
	if !ok || !approvalPendingMatchesGeneration(j.sessions, pending, generation) {
		return ""
	}
	if pending.RunID != "" {
		return pending.RunID
	}
	return pending.TurnID
}

func approvalRequestIDFromPayload(payload json.RawMessage) json.RawMessage {
	var message struct {
		Params struct {
			RequestID json.RawMessage `json:"requestId"`
		} `json:"params"`
	}
	if err := json.Unmarshal(payload, &message); err != nil {
		return nil
	}
	return append(json.RawMessage(nil), message.Params.RequestID...)
}

func approvalClaimMatches(claim approvalClaimRecord, pending PendingApproval) bool {
	if claim.SessionID != pending.SessionID || approvalIDIdentity(claim.RequestID) != approvalIDIdentity(pending.RequestID) {
		return false
	}
	if claim.Generation != "" && pending.Generation != "" && claim.Generation != pending.Generation {
		return false
	}
	if claim.RunID != "" && pending.RunID != "" && claim.RunID != pending.RunID {
		return false
	}
	if claim.TurnID != "" && pending.TurnID != "" && claim.TurnID != pending.TurnID {
		return false
	}
	if claim.ItemID != "" && pending.ItemID != "" && claim.ItemID != pending.ItemID {
		return false
	}
	return true
}

func approvalPendingMatchesCurrentGeneration(sessions map[string]journalSession, pending PendingApproval) bool {
	session, ok := sessions[pending.SessionID]
	if !ok || session.Generation == "" {
		return true
	}
	if pending.Generation == "" {
		return false
	}
	return session.Generation == pending.Generation
}

func approvalPendingMatchesGeneration(sessions map[string]journalSession, pending PendingApproval, generation string) bool {
	if strings.TrimSpace(generation) != "" {
		return pending.Generation == "" || pending.Generation == generation
	}
	return approvalPendingMatchesCurrentGeneration(sessions, pending)
}

func approvalKey(sessionID string, requestID json.RawMessage) string {
	identity := approvalIDIdentity(requestID)
	if sessionID == "" || identity == "" {
		return ""
	}
	return sessionID + "\x00" + identity
}

func approvalEventMatchesPending(event protocol.Event, pending PendingApproval, turnID string) bool {
	expectedRunID := strings.TrimSpace(pending.RunID)
	if expectedRunID == "" {
		expectedRunID = strings.TrimSpace(pending.TurnID)
	}
	if expectedRunID == "" {
		return false
	}
	matches := func(value string) bool {
		value = strings.TrimSpace(value)
		return value == expectedRunID || value == strings.TrimSpace(pending.RunID) || value == strings.TrimSpace(pending.TurnID)
	}
	eventRunID := strings.TrimSpace(valueOrEmpty(event.RunID))
	turnID = strings.TrimSpace(turnID)
	if eventRunID == "" && turnID == "" {
		return false
	}
	return (eventRunID == "" || matches(eventRunID)) && (turnID == "" || matches(turnID))
}

func approvalIDText(requestID json.RawMessage) string {
	trimmed := bytes.TrimSpace(requestID)
	var value string
	if json.Unmarshal(trimmed, &value) == nil {
		return value
	}
	return string(trimmed)
}

func approvalIDIdentity(requestID json.RawMessage) string {
	trimmed := bytes.TrimSpace(requestID)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	if trimmed[0] == '"' {
		var value string
		if json.Unmarshal(trimmed, &value) == nil {
			return "string\x00" + value
		}
	}
	return "json\x00" + string(trimmed)
}

func normalizeApprovalDecision(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "approve", "accept":
		return "accept"
	case "deny", "decline":
		return "decline"
	default:
		return ""
	}
}

func commandDigest(command protocol.Command) (string, error) {
	return commandDigestValue(command, false)
}

func commandDigestWithIssuedAt(command protocol.Command) (string, error) {
	return commandDigestValue(command, true)
}

func commandDigestValue(command protocol.Command, includeIssuedAt bool) (string, error) {
	payload, err := canonicalJSON(command.Payload)
	if err != nil {
		return "", fmt.Errorf("canonicalize command payload: %w", err)
	}
	var value any
	if includeIssuedAt {
		value = struct {
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
	} else {
		value = struct {
			CommandID string               `json:"command_id"`
			Kind      protocol.CommandKind `json:"kind"`
			Payload   json.RawMessage      `json:"payload"`
			RunID     *string              `json:"run_id,omitempty"`
			SessionID string               `json:"session_id"`
		}{
			CommandID: command.CommandID,
			Kind:      command.Kind,
			Payload:   payload,
			RunID:     command.RunID,
			SessionID: command.SessionID,
		}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode command digest: %w", err)
	}
	return digestString(string(data)), nil
}

func canonicalJSON(data []byte) (json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, errors.New("JSON payload contains multiple values")
		}
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

func cloneReconciliation(value protocol.Reconciliation) protocol.Reconciliation {
	if value.EventCursor != nil {
		cursor := *value.EventCursor
		value.EventCursor = &cursor
	}
	if value.Note != nil {
		note := *value.Note
		value.Note = &note
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
