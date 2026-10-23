package protocol

import (
	"context"
	"errors"
	"io"
	"strings"
)

var (
	ErrUnsupportedSessionPath = errors.New("session path is not supported by the configured host")
	ErrIdempotencyConflict    = errors.New("command id was reused with a different request")
	ErrCursorExpired          = errors.New("event cursor is expired")
	ErrUnknownCommandResult   = errors.New("command result is not yet established")
)

// NewSessionRequest is the Host Gateway input for the supported independent
// app-server path described by R01. CommandID identifies the creation intent:
// identical prompts with different IDs must create distinct sessions.
type NewSessionRequest struct {
	CommandID string
	ProjectID string
	TaskID    string
	Prompt    string
}

// ExistingSessionRequest identifies an already active session only when the
// execution environment exposes a verified path-addressable endpoint. The
// current Desktop process does not satisfy this contract and must return
// ErrUnsupportedSessionPath instead of silently starting a new session.
type ExistingSessionRequest struct {
	CommandID       string
	ProjectID       string
	TaskID          string
	ActiveThreadRef string
}

// GatewaySession is a host-owned transport handle. Handle is private to the
// service boundary; ExternalThreadRef is an opaque stable reference used for
// reconciliation and must not contain credentials.
type GatewaySession struct {
	Handle            string
	ExternalThreadRef string
	Generation        string
	Path              SessionPath
}

// AdapterSession is the Codex adapter's logical session identity. It keeps
// the host transport handle out of REST and MCP payloads.
type AdapterSession struct {
	SessionID         string
	ExternalThreadRef string
}

// HostGateway owns the selected execution host and app-server generation. The
// two open methods are intentionally separate so existing-session attachment
// cannot fall back to a new independent session.
type HostGateway interface {
	StartNewSession(context.Context, NewSessionRequest) (GatewaySession, error)
	AttachActiveSession(context.Context, ExistingSessionRequest) (GatewaySession, error)
	ReconcileSession(context.Context, string) (Reconciliation, error)
	CloseSession(context.Context, GatewaySession) error
}

// CodexAdapter translates platform commands to the host-owned Codex
// app-server protocol and translates observed messages into durable events.
type CodexAdapter interface {
	StartSession(context.Context, GatewaySession, NewSessionRequest) (AdapterSession, error)
	AttachSession(context.Context, GatewaySession, ExistingSessionRequest) (AdapterSession, error)
	SendCommand(context.Context, AdapterSession, Command) (CommandAck, error)
	ReconcileCommand(context.Context, AdapterSession, string) (Reconciliation, error)
	CloseSession(context.Context, AdapterSession) error
}

// EventQuery is the service-level cursor request. after_cursor is exclusive;
// a cursor is opaque and scoped to the authorized session/run stream.
type EventQuery struct {
	SessionID   string
	RunID       string
	AfterCursor string
	Limit       int64
}

// RunController owns command identity, deduplication, ACK persistence, and
// ordered event reads. It must reconcile an unknown command before accepting a
// side-effecting retry.
type RunController interface {
	AcceptCommand(context.Context, Command) (CommandAck, error)
	LookupCommand(context.Context, string) (CommandAck, error)
	ReadEvents(context.Context, EventQuery) (EventPage, error)
	ReconcileCommand(context.Context, string) (Reconciliation, error)
}

// ArtifactReader is the authorized stream for an original conversation file.
// Implementations must enforce session/project authorization before returning
// the reader and must preserve the stored bytes.
type ArtifactReader interface {
	io.Reader
	io.ReaderAt
	io.Seeker
	io.Closer
}

// ArtifactStore owns original bytes and metadata, but it does not create a
// product-facing standalone artifact navigation surface.
// Put admits only an io.ReadCloser whose prompt, concurrent Close unblocks
// Read. It owns and closes an admitted source exactly once on return or
// cancellation. A no-op closer is suitable only for finite nonblocking memory
// input. Implementations reject unsupported sources before staging bytes.
// Identical authorized retries preserve canonical metadata and may repair lost
// never-ready staging only under ADR 0005; final objects are never overwritten.
type ArtifactStore interface {
	Put(context.Context, Artifact, io.Reader) (Artifact, error)
	Metadata(context.Context, string) (Artifact, error)
	Open(context.Context, string) (Artifact, ArtifactReader, error)
}

// OpenSession selects exactly one R01 path. Existing-session attachment is
// explicit and never retries through StartNewSession after an attach failure.
func OpenSession(ctx context.Context, gateway HostGateway, adapter CodexAdapter, request CreateSessionRequest) (AdapterSession, error) {
	if ctx == nil {
		return AdapterSession{}, errors.New("session context must not be nil")
	}
	if gateway == nil || adapter == nil {
		return AdapterSession{}, errors.New("session gateway and adapter are required")
	}
	if strings.TrimSpace(request.CommandID) == "" {
		return AdapterSession{}, errors.New("session creation command id is required")
	}
	switch request.Path {
	case SessionPathNew:
		gatewaySession, err := gateway.StartNewSession(ctx, NewSessionRequest{
			CommandID: request.CommandID,
			ProjectID: valueOrEmpty(request.ProjectID),
			TaskID:    valueOrEmpty(request.TaskID),
			Prompt:    valueOrEmpty(request.Prompt),
		})
		if err != nil {
			return AdapterSession{}, err
		}
		return adapter.StartSession(ctx, gatewaySession, NewSessionRequest{
			CommandID: request.CommandID,
			ProjectID: valueOrEmpty(request.ProjectID),
			TaskID:    valueOrEmpty(request.TaskID),
			Prompt:    valueOrEmpty(request.Prompt),
		})
	case SessionPathExistingActive:
		if request.ActiveThreadRef == nil || *request.ActiveThreadRef == "" {
			return AdapterSession{}, ErrUnsupportedSessionPath
		}
		active := ExistingSessionRequest{
			CommandID:       request.CommandID,
			ProjectID:       valueOrEmpty(request.ProjectID),
			TaskID:          valueOrEmpty(request.TaskID),
			ActiveThreadRef: *request.ActiveThreadRef,
		}
		gatewaySession, err := gateway.AttachActiveSession(ctx, active)
		if err != nil {
			return AdapterSession{}, err
		}
		return adapter.AttachSession(ctx, gatewaySession, active)
	default:
		return AdapterSession{}, ErrUnsupportedSessionPath
	}
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// ValidateCommand checks the fields required before a command can enter the
// idempotent command ledger. Payload validation remains command-kind specific.
func ValidateCommand(value Command) error {
	if value.CommandID == "" {
		return errors.New("command id is required")
	}
	if value.Kind == "" {
		return errors.New("command kind is required")
	}
	if value.SessionID == "" {
		return errors.New("command session id is required")
	}
	if len(value.Payload) == 0 || string(value.Payload) == "null" {
		return errors.New("command payload is required")
	}
	return nil
}
