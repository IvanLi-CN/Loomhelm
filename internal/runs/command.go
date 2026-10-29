package runs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

var (
	ErrInvalidCommand        = errors.New("command is invalid")
	ErrCommandNotFound       = errors.New("command is not registered")
	ErrCommandNotUnknown     = errors.New("command is not awaiting reconciliation")
	ErrCommandTerminal       = errors.New("command is already terminal")
	ErrCommandTransition     = errors.New("command transition is invalid")
	ErrReconciliationUnknown = errors.New("reconciliation did not establish a command result")
)

// CommandIntent contains the transport command plus the execution generation
// that owns its side effect. Generation is kept separate from protocol.Command
// because it is an internal fencing fact, not a new public wire field.
type CommandIntent struct {
	Command       protocol.Command
	Generation    string
	ReceivedAt    string
	DraftRevision *int64
	DraftOwnerID  string
}

type CommandRecord struct {
	Intent              CommandIntent
	Digest              string
	State               protocol.CommandState
	ReceivedAt          string
	OperationID         string
	EventCursor         string
	ReconciliationState protocol.ReconciliationState
	ExactAckState       protocol.CommandState
	Result              json.RawMessage
	Error               *protocol.ApiError
}

type AcceptResult struct {
	Record       CommandRecord
	Deduplicated bool
}

type CommandObservation struct {
	State          protocol.CommandState
	Reconciliation protocol.ReconciliationState
	OperationID    string
	EventCursor    string
	Result         json.RawMessage
	Error          *protocol.ApiError
}

// ValidateIntent checks the identity and payload before an adapter or worker
// may be contacted. It intentionally does not authorize the caller or persist
// the command; those concerns belong to the application and durable store.
func ValidateIntent(intent CommandIntent) error {
	command := intent.Command
	if strings.TrimSpace(intent.Generation) == "" || strings.TrimSpace(intent.Generation) != intent.Generation {
		return fmt.Errorf("%w: generation is required", ErrInvalidCommand)
	}
	if err := protocol.ValidateCommand(command); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidCommand, err)
	}
	if strings.TrimSpace(command.CommandID) != command.CommandID {
		return fmt.Errorf("%w: command id must not have surrounding whitespace", ErrInvalidCommand)
	}
	if strings.TrimSpace(command.CommandID) == "" || strings.TrimSpace(command.SessionID) == "" || strings.TrimSpace(command.SessionID) != command.SessionID {
		return fmt.Errorf("%w: command identity is incomplete", ErrInvalidCommand)
	}
	if !validCommandKind(command.Kind) {
		return fmt.Errorf("%w: unsupported command kind %q", ErrInvalidCommand, command.Kind)
	}
	if _, err := canonicalPayload(command.Payload); err != nil {
		return fmt.Errorf("%w: payload: %v", ErrInvalidCommand, err)
	}
	if requiresRunID(command.Kind) && (command.RunID == nil || strings.TrimSpace(*command.RunID) == "") {
		return fmt.Errorf("%w: command kind %q requires run_id", ErrInvalidCommand, command.Kind)
	}
	if command.RunID != nil && strings.TrimSpace(*command.RunID) != *command.RunID {
		return fmt.Errorf("%w: run id must not have surrounding whitespace", ErrInvalidCommand)
	}
	return nil
}

func validCommandKind(kind protocol.CommandKind) bool {
	switch kind {
	case protocol.CommandKindSessionStart, protocol.CommandKindSessionAttach,
		protocol.CommandKindRunSend, protocol.CommandKindRunApprove,
		protocol.CommandKindRunDeny, protocol.CommandKindRunInterrupt:
		return true
	default:
		return false
	}
}

func requiresRunID(kind protocol.CommandKind) bool {
	return kind == protocol.CommandKindRunApprove || kind == protocol.CommandKindRunDeny || kind == protocol.CommandKindRunInterrupt
}

func canonicalPayload(payload json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, errors.New("payload must be a non-null JSON value")
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, errors.New("payload contains multiple JSON values")
		}
		return nil, err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

// Fingerprint is stable across retries that only change IssuedAt or JSON
// whitespace/object-key order. The command ID remains part of the identity.
func Fingerprint(intent CommandIntent) (string, error) {
	if err := ValidateIntent(intent); err != nil {
		return "", err
	}
	payload, err := canonicalPayload(intent.Command.Payload)
	if err != nil {
		return "", err
	}
	value := struct {
		CommandID     string               `json:"command_id"`
		Kind          protocol.CommandKind `json:"kind"`
		Payload       json.RawMessage      `json:"payload"`
		RunID         *string              `json:"run_id,omitempty"`
		SessionID     string               `json:"session_id"`
		Generation    string               `json:"generation"`
		DraftRevision *int64               `json:"draft_revision,omitempty"`
		DraftOwnerID  string               `json:"draft_owner_id,omitempty"`
	}{
		CommandID:     intent.Command.CommandID,
		Kind:          intent.Command.Kind,
		Payload:       payload,
		RunID:         intent.Command.RunID,
		SessionID:     intent.Command.SessionID,
		Generation:    intent.Generation,
		DraftRevision: intent.DraftRevision,
		DraftOwnerID:  intent.DraftOwnerID,
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode command fingerprint: %w", err)
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

// Ledger is a process-local command identity gate. It is intentionally not a
// persistence implementation: the real adapter must commit the accepted
// intent and every state change durably before crossing its side-effecting
// boundary. This type gives that adapter a deterministic transition contract
// and is also useful for race tests.
type Ledger struct {
	mu      sync.Mutex
	records map[string]CommandRecord
}

func NewLedger() *Ledger { return &Ledger{records: make(map[string]CommandRecord)} }

func (l *Ledger) Accept(intent CommandIntent) (AcceptResult, error) {
	if err := ValidateIntent(intent); err != nil {
		return AcceptResult{}, err
	}
	digest, err := Fingerprint(intent)
	if err != nil {
		return AcceptResult{}, err
	}
	if l == nil {
		return AcceptResult{}, errors.New("command ledger is nil")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.records == nil {
		l.records = make(map[string]CommandRecord)
	}
	if existing, ok := l.records[intent.Command.CommandID]; ok {
		if existing.Intent.Generation != intent.Generation {
			return AcceptResult{}, fmt.Errorf("%w: command %q belongs to generation %q", ErrStaleGeneration, intent.Command.CommandID, existing.Intent.Generation)
		}
		if existing.Digest != digest {
			return AcceptResult{}, fmt.Errorf("%w: command %q has a different payload or identity", protocol.ErrIdempotencyConflict, intent.Command.CommandID)
		}
		return AcceptResult{Record: cloneRecord(existing), Deduplicated: true}, nil
	}
	record := CommandRecord{Intent: cloneIntent(intent), Digest: digest, State: protocol.CommandStateAccepted, ReceivedAt: intent.ReceivedAt}
	l.records[intent.Command.CommandID] = record
	return AcceptResult{Record: cloneRecord(record)}, nil
}

// AcceptForGeneration applies the current-generation fence before registering
// a new command. A retry of an existing command may still use Accept directly
// so the durable command identity can be returned without a side effect.
func (l *Ledger) AcceptForGeneration(currentGeneration string, intent CommandIntent) (AcceptResult, error) {
	if err := CheckCurrentGeneration(currentGeneration, intent.Generation); err != nil {
		return AcceptResult{}, err
	}
	return l.Accept(intent)
}

func CheckCurrentGeneration(currentGeneration, candidateGeneration string) error {
	if strings.TrimSpace(currentGeneration) == "" || strings.TrimSpace(candidateGeneration) == "" || currentGeneration != candidateGeneration {
		return fmt.Errorf("%w: current=%q candidate=%q", ErrStaleGeneration, currentGeneration, candidateGeneration)
	}
	return nil
}

func (l *Ledger) Lookup(commandID string) (CommandRecord, error) {
	if strings.TrimSpace(commandID) == "" {
		return CommandRecord{}, fmt.Errorf("%w: command id is required", ErrCommandNotFound)
	}
	if l == nil {
		return CommandRecord{}, errors.New("command ledger is nil")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	record, ok := l.records[commandID]
	if !ok {
		return CommandRecord{}, ErrCommandNotFound
	}
	return cloneRecord(record), nil
}

func (l *Ledger) Transition(commandID, generation string, next protocol.CommandState, operationID string, result json.RawMessage, apiError *protocol.ApiError) (CommandRecord, error) {
	if l == nil {
		return CommandRecord{}, errors.New("command ledger is nil")
	}
	if strings.TrimSpace(generation) == "" {
		return CommandRecord{}, fmt.Errorf("%w: generation is required", ErrStaleGeneration)
	}
	if !validCommandState(next) {
		return CommandRecord{}, fmt.Errorf("%w: unsupported command state %q", ErrCommandTransition, next)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	record, ok := l.records[commandID]
	if !ok {
		return CommandRecord{}, ErrCommandNotFound
	}
	if record.Intent.Generation != generation {
		return CommandRecord{}, fmt.Errorf("%w: got %q, command belongs to %q", ErrStaleGeneration, generation, record.Intent.Generation)
	}
	if record.State == next {
		return cloneRecord(record), nil
	}
	if record.State == protocol.CommandStateUnknown {
		return CommandRecord{}, fmt.Errorf("%w: unknown command must be reconciled", ErrCommandNotUnknown)
	}
	if !allowedCommandTransition(record.State, next) {
		if isTerminalCommandState(record.State) {
			return CommandRecord{}, fmt.Errorf("%w: %s -> %s", ErrCommandTerminal, record.State, next)
		}
		return CommandRecord{}, fmt.Errorf("%w: %s -> %s", ErrCommandTransition, record.State, next)
	}
	record.State = next
	record.OperationID = operationID
	record.Result = append(json.RawMessage(nil), result...)
	record.Error = cloneAPIError(apiError)
	l.records[commandID] = record
	return cloneRecord(record), nil
}

func (l *Ledger) MarkUnknown(commandID, generation string) (CommandRecord, error) {
	return l.Transition(commandID, generation, protocol.CommandStateUnknown, "", nil, nil)
}

func (l *Ledger) Reconcile(commandID, generation string, observation CommandObservation) (CommandRecord, error) {
	if l == nil {
		return CommandRecord{}, errors.New("command ledger is nil")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	record, ok := l.records[commandID]
	if !ok {
		return CommandRecord{}, ErrCommandNotFound
	}
	if record.Intent.Generation != generation {
		return CommandRecord{}, fmt.Errorf("%w: got %q, command belongs to %q", ErrStaleGeneration, generation, record.Intent.Generation)
	}
	if record.State != protocol.CommandStateUnknown {
		if isTerminalCommandState(record.State) {
			return cloneRecord(record), nil
		}
		return CommandRecord{}, ErrCommandNotUnknown
	}
	switch observation.Reconciliation {
	case protocol.ReconciliationStateUnknown:
		return cloneRecord(record), fmt.Errorf("%w: command %q remains unknown", protocol.ErrUnknownCommandResult, commandID)
	case protocol.ReconciliationStateNotFound:
		observation.State = protocol.CommandStateRejected
	case protocol.ReconciliationStateConfirmed:
		if !validCommandState(observation.State) || observation.State == protocol.CommandStateAccepted || observation.State == protocol.CommandStateUnknown {
			return CommandRecord{}, fmt.Errorf("%w: confirmed observation needs executing or terminal state", ErrReconciliationUnknown)
		}
	default:
		return CommandRecord{}, fmt.Errorf("%w: unsupported reconciliation state %q", ErrReconciliationUnknown, observation.Reconciliation)
	}
	if !allowedReconciliationState(observation.State) {
		return CommandRecord{}, fmt.Errorf("%w: unknown -> %s", ErrCommandTransition, observation.State)
	}
	record.State = observation.State
	record.ReconciliationState = observation.Reconciliation
	record.OperationID = observation.OperationID
	record.EventCursor = observation.EventCursor
	record.Result = append(json.RawMessage(nil), observation.Result...)
	record.Error = cloneAPIError(observation.Error)
	l.records[commandID] = record
	return cloneRecord(record), nil
}

func validCommandState(state protocol.CommandState) bool {
	switch state {
	case protocol.CommandStateAccepted, protocol.CommandStateExecuting,
		protocol.CommandStateSucceeded, protocol.CommandStateFailed,
		protocol.CommandStateUnknown, protocol.CommandStateRejected:
		return true
	default:
		return false
	}
}

func isTerminalCommandState(state protocol.CommandState) bool {
	return state == protocol.CommandStateSucceeded || state == protocol.CommandStateFailed || state == protocol.CommandStateRejected
}

func allowedCommandTransition(from, to protocol.CommandState) bool {
	switch from {
	case protocol.CommandStateAccepted:
		return to == protocol.CommandStateExecuting || to == protocol.CommandStateSucceeded || to == protocol.CommandStateFailed || to == protocol.CommandStateUnknown || to == protocol.CommandStateRejected
	case protocol.CommandStateExecuting:
		return to == protocol.CommandStateSucceeded || to == protocol.CommandStateFailed || to == protocol.CommandStateUnknown
	default:
		return false
	}
}

func isDeliveryConfirmedAckState(state protocol.CommandState) bool {
	return state == protocol.CommandStateExecuting || state == protocol.CommandStateSucceeded
}

// DraftDeliveryConfirmed reports whether the durable command facts prove that
// the command reached the Connector, including when a later exact failed ACK
// follows an earlier executing ACK.
func (record CommandRecord) DraftDeliveryConfirmed() bool {
	return record.State == protocol.CommandStateExecuting ||
		record.State == protocol.CommandStateSucceeded ||
		isDeliveryConfirmedAckState(record.ExactAckState)
}

func allowedReconciliationState(state protocol.CommandState) bool {
	return state == protocol.CommandStateExecuting || state == protocol.CommandStateSucceeded || state == protocol.CommandStateFailed || state == protocol.CommandStateRejected
}

func (record CommandRecord) Ack() protocol.CommandAck {
	ack := protocol.CommandAck{
		CommandID:   record.Intent.Command.CommandID,
		ReceivedAt:  record.ReceivedAt,
		OperationID: optionalString(record.OperationID),
		EventCursor: optionalString(record.EventCursor),
		RunID:       cloneStringPointer(record.Intent.Command.RunID),
		Result:      append(json.RawMessage(nil), record.Result...),
		State:       record.State,
		Error:       cloneAPIError(record.Error),
	}
	return ack
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func cloneIntent(intent CommandIntent) CommandIntent {
	intent.Command.Payload = append(json.RawMessage(nil), intent.Command.Payload...)
	intent.Command.RunID = cloneStringPointer(intent.Command.RunID)
	if intent.DraftRevision != nil {
		revision := *intent.DraftRevision
		intent.DraftRevision = &revision
	}
	return intent
}

func cloneRecord(record CommandRecord) CommandRecord {
	record.Intent = cloneIntent(record.Intent)
	record.Result = append(json.RawMessage(nil), record.Result...)
	record.Error = cloneAPIError(record.Error)
	return record
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneAPIError(value *protocol.ApiError) *protocol.ApiError {
	if value == nil {
		return nil
	}
	copy := *value
	copy.Details = append(json.RawMessage(nil), value.Details...)
	return &copy
}
