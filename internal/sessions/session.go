// Package sessions owns session lifecycle transitions and the immutable
// task/session association boundary. Persistence and authorization stay in the
// application layer.
package sessions

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

var (
	ErrInvalidSession     = errors.New("session is invalid")
	ErrSessionTransition  = errors.New("session transition is invalid")
	ErrSessionTerminal    = errors.New("session is already terminal")
	ErrSessionBound       = errors.New("session is already bound to a task")
	ErrTaskBound          = errors.New("task is already bound to a session")
	ErrProjectMismatch    = errors.New("session and task belong to different projects")
	ErrShareConfirmation  = errors.New("projectless session requires explicit sharing confirmation")
	ErrStaleGeneration    = errors.New("session generation is stale")
	ErrSessionUnconfirmed = errors.New("session creation intent is not confirmed")
)

type Session struct {
	protocol.Session
	Generation     string
	LastCursor     string
	TerminalReason string
}

type NewInput struct {
	ID                string
	Path              protocol.SessionPath
	ProjectID         string
	TaskID            string
	ExternalThreadRef string
	Generation        string
	CreatedAt         string
	UpdatedAt         string
}

// IntentState distinguishes a durable creation attempt from a confirmed
// Session. An intent never exposes an external thread reference until the
// execution boundary confirms one.
type IntentState string

const (
	IntentStatePending   IntentState = "pending"
	IntentStateUnknown   IntentState = "unknown"
	IntentStateConfirmed IntentState = "confirmed"
)

// CreationIntentInput contains authorization facts resolved by the caller's
// application boundary. CreatorUserID and HostID are not public request
// declarations; the caller must derive them from authenticated identity and
// the configured host selection.
type CreationIntentInput struct {
	SessionID     string
	CommandID     string
	CreatorUserID string
	HostID        string
	Path          protocol.SessionPath
	ProjectID     string
	TaskID        string
	Parameters    []byte
	Summary       string
	CreatedAt     string
	UpdatedAt     string
}

type CreationIntent struct {
	SessionID           string
	CommandID           string
	CreatorUserID       string
	HostID              string
	Path                protocol.SessionPath
	ProjectID           string
	TaskID              string
	Parameters          []byte
	Digest              string
	Summary             string
	UnknownReason       string
	ExternalThreadRef   string
	ExecutionGeneration string
	State               IntentState
	CreatedAt           string
	UpdatedAt           string
}

// ActivationInput names the execution generation explicitly. Host WSS and
// Worker generations are owned by their own boundaries and are intentionally
// absent from this type.
type ActivationInput struct {
	SessionID           string
	ExternalThreadRef   string
	ExecutionGeneration string
	UpdatedAt           string
}

type UnknownIntentInput struct {
	SessionID string
	Reason    string
	UpdatedAt string
}

type SessionAccess struct {
	SessionID     string
	CreatorUserID string
	HostID        string
	ProjectID     string
	IntentState   IntentState
	Confirmed     bool
}

// CreationBoundary is the narrow internal persistence contract used by the
// application coordinator. It deliberately does not expose the full Session
// lifecycle store or any public REST schema.
type CreationBoundary interface {
	CreateIntent(context.Context, CreationIntentInput) (CreationIntent, error)
	GetIntent(context.Context, string) (CreationIntent, error)
	MarkIntentUnknown(context.Context, UnknownIntentInput) (CreationIntent, error)
	ActivateIntent(context.Context, ActivationInput) (Session, error)
	GetAccess(context.Context, string) (SessionAccess, error)
}

type BindRequest struct {
	TaskID               string
	TaskProjectID        string
	CurrentTaskSessionID string
	ConfirmShare         bool
}

func New(input NewInput) (Session, error) {
	if strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.Generation) == "" {
		return Session{}, fmt.Errorf("%w: id and generation are required", ErrInvalidSession)
	}
	if input.Path != protocol.SessionPathNew && input.Path != protocol.SessionPathExistingActive {
		return Session{}, fmt.Errorf("%w: unsupported session path %q", ErrInvalidSession, input.Path)
	}
	if input.TaskID != "" && input.ProjectID == "" {
		return Session{}, fmt.Errorf("%w: a task-bound session requires a project", ErrInvalidSession)
	}
	return Session{
		Session: protocol.Session{
			ID:                input.ID,
			Path:              input.Path,
			ProjectID:         optionalString(input.ProjectID),
			TaskID:            optionalString(input.TaskID),
			ExternalThreadRef: input.ExternalThreadRef,
			State:             protocol.SessionStateStarting,
			CreatedAt:         input.CreatedAt,
			UpdatedAt:         input.UpdatedAt,
		},
		Generation: input.Generation,
	}, nil
}

func (s Session) CheckGeneration(generation string) error {
	if strings.TrimSpace(generation) == "" || generation != s.Generation {
		return fmt.Errorf("%w: got %q, session belongs to %q", ErrStaleGeneration, generation, s.Generation)
	}
	return nil
}

func (s Session) Activate(generation, externalThreadRef, updatedAt string) (Session, error) {
	if strings.TrimSpace(generation) == "" || strings.TrimSpace(externalThreadRef) == "" {
		return Session{}, fmt.Errorf("%w: generation and external thread reference are required", ErrInvalidSession)
	}
	if s.State == protocol.SessionStateClosed || s.State == protocol.SessionStateUnsupported {
		return Session{}, fmt.Errorf("%w: %s cannot become active", ErrSessionTerminal, s.State)
	}
	if s.State == protocol.SessionStateActive && s.Generation != generation {
		return Session{}, fmt.Errorf("%w: active session cannot switch generation without reconciliation", ErrStaleGeneration)
	}
	if s.State != protocol.SessionStateStarting && s.State != protocol.SessionStateReconciling && s.State != protocol.SessionStateDisconnected && s.State != protocol.SessionStateActive {
		return Session{}, fmt.Errorf("%w: %s -> active", ErrSessionTransition, s.State)
	}
	s.State = protocol.SessionStateActive
	s.ExternalThreadRef = externalThreadRef
	s.Generation = generation
	s.UpdatedAt = updatedAt
	return s, nil
}

func (s Session) Disconnect(generation, updatedAt string) (Session, error) {
	if err := s.CheckGeneration(generation); err != nil {
		return Session{}, err
	}
	switch s.State {
	case protocol.SessionStateActive, protocol.SessionStateStarting, protocol.SessionStateReconciling:
		s.State = protocol.SessionStateDisconnected
		s.UpdatedAt = updatedAt
		return s, nil
	case protocol.SessionStateDisconnected:
		return s, nil
	case protocol.SessionStateClosed, protocol.SessionStateUnsupported:
		return Session{}, fmt.Errorf("%w: %s cannot disconnect", ErrSessionTerminal, s.State)
	default:
		return Session{}, fmt.Errorf("%w: unknown state %q", ErrSessionTransition, s.State)
	}
}

func (s Session) BeginReconciliation(generation, updatedAt string) (Session, error) {
	if err := s.CheckGeneration(generation); err != nil {
		return Session{}, err
	}
	switch s.State {
	case protocol.SessionStateStarting, protocol.SessionStateActive, protocol.SessionStateDisconnected:
		s.State = protocol.SessionStateReconciling
		s.UpdatedAt = updatedAt
		return s, nil
	case protocol.SessionStateReconciling:
		return s, nil
	case protocol.SessionStateClosed, protocol.SessionStateUnsupported:
		return Session{}, fmt.Errorf("%w: %s cannot reconcile", ErrSessionTerminal, s.State)
	default:
		return Session{}, fmt.Errorf("%w: unknown state %q", ErrSessionTransition, s.State)
	}
}

func (s Session) Reconcile(generation string, state protocol.ReconciliationState, externalThreadRef, updatedAt string) (Session, error) {
	if err := s.CheckGeneration(generation); err != nil {
		return Session{}, err
	}
	if s.State != protocol.SessionStateReconciling && s.State != protocol.SessionStateDisconnected && s.State != protocol.SessionStateStarting {
		if state == protocol.ReconciliationStateConfirmed && s.State == protocol.SessionStateActive {
			return s, nil
		}
		return Session{}, fmt.Errorf("%w: %s is not reconciling", ErrSessionTransition, s.State)
	}
	switch state {
	case protocol.ReconciliationStateConfirmed:
		if strings.TrimSpace(externalThreadRef) == "" && strings.TrimSpace(s.ExternalThreadRef) == "" {
			return Session{}, fmt.Errorf("%w: confirmed session has no external thread reference", ErrInvalidSession)
		}
		if externalThreadRef != "" {
			s.ExternalThreadRef = externalThreadRef
		}
		s.State = protocol.SessionStateActive
		s.UpdatedAt = updatedAt
		return s, nil
	case protocol.ReconciliationStateNotFound:
		s.State = protocol.SessionStateClosed
		s.UpdatedAt = updatedAt
		return s, nil
	case protocol.ReconciliationStateUnknown:
		s.State = protocol.SessionStateDisconnected
		s.UpdatedAt = updatedAt
		return s, nil
	default:
		return Session{}, fmt.Errorf("%w: unsupported reconciliation state %q", ErrSessionTransition, state)
	}
}

func (s Session) MarkUnsupported(updatedAt string) (Session, error) {
	if s.State == protocol.SessionStateClosed || s.State == protocol.SessionStateUnsupported {
		return Session{}, fmt.Errorf("%w: %s cannot become unsupported", ErrSessionTerminal, s.State)
	}
	s.State = protocol.SessionStateUnsupported
	s.UpdatedAt = updatedAt
	return s, nil
}

func (s Session) Close(generation, updatedAt string) (Session, error) {
	if err := s.CheckGeneration(generation); err != nil {
		return Session{}, err
	}
	if s.State == protocol.SessionStateClosed {
		return s, nil
	}
	if s.State == protocol.SessionStateUnsupported {
		return s, nil
	}
	s.State = protocol.SessionStateClosed
	s.UpdatedAt = updatedAt
	return s, nil
}

// BindTask returns the Session side of a two-row binding transaction. The
// caller must persist the matching Task update atomically and must re-check
// CurrentTaskSessionID under that transaction's lock.
func (s Session) BindTask(request BindRequest) (Session, error) {
	if strings.TrimSpace(request.TaskID) == "" || strings.TrimSpace(request.TaskProjectID) == "" {
		return Session{}, fmt.Errorf("%w: task id and task project are required", ErrInvalidSession)
	}
	if s.State == protocol.SessionStateClosed || s.State == protocol.SessionStateUnsupported {
		return Session{}, fmt.Errorf("%w: terminal session cannot bind a task", ErrSessionTerminal)
	}
	if taskID := optionalStringValue(s.TaskID); taskID != "" {
		if taskID == request.TaskID && request.CurrentTaskSessionID == s.ID {
			return s, nil
		}
		return Session{}, ErrSessionBound
	}
	if request.CurrentTaskSessionID != "" && request.CurrentTaskSessionID != s.ID {
		return Session{}, ErrTaskBound
	}
	if projectID := optionalStringValue(s.ProjectID); projectID != "" && projectID != request.TaskProjectID {
		return Session{}, ErrProjectMismatch
	}
	if optionalStringValue(s.ProjectID) == "" && !request.ConfirmShare {
		return Session{}, ErrShareConfirmation
	}
	s.ProjectID = optionalString(request.TaskProjectID)
	s.TaskID = optionalString(request.TaskID)
	return s, nil
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func optionalStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
