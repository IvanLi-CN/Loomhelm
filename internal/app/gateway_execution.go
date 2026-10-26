package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
)

const connectorGatewayPath = "/gateway"

var (
	errGatewaySessionOwnership = errors.New("gateway event session is not owned by the connected host")
	errGatewayRunIdentity      = errors.New("gateway event does not identify a persisted platform run")
	errGatewayApprovalPayload  = errors.New("gateway approval event payload is not normalized")
)

type gatewayExecutionTransport struct {
	gateway  *gateway.Server
	sessions *sessions.Store
	runs     *runs.Store
	now      func() time.Time
}

func (t *gatewayExecutionTransport) SendCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, error) {
	if t == nil || t.gateway == nil || t.sessions == nil {
		return protocol.CommandAck{}, runs.ErrControlServiceUnavailable
	}
	access, err := t.sessions.GetAccess(ctx, command.SessionID)
	if err != nil {
		return protocol.CommandAck{}, fmt.Errorf("resolve command session host: %w", err)
	}
	if !access.Confirmed || strings.TrimSpace(access.HostID) == "" {
		return protocol.CommandAck{}, fmt.Errorf("%w: session %q is not bound to a confirmed host", hosts.ErrInvalid, command.SessionID)
	}
	return t.gateway.SendCommand(ctx, access.HostID, command)
}

// SendSessionCommand is the pre-activation command path. It uses the host
// selected for the durable creation intent because the Session has no
// confirmed access row yet.
func (t *gatewayExecutionTransport) SendSessionCommand(ctx context.Context, hostID string, command protocol.Command) (protocol.CommandAck, error) {
	if t == nil || t.gateway == nil || strings.TrimSpace(hostID) == "" {
		return protocol.CommandAck{}, runs.ErrControlServiceUnavailable
	}
	return t.gateway.SendCommand(ctx, hostID, command)
}

// ReconcileCommand is deliberately explicit: the Connector WSS protocol has
// no command-reconciliation frame. Reconciliation must therefore remain
// unknown until a later Connector contract supplies a durable observation.
func (t *gatewayExecutionTransport) ReconcileCommand(_ context.Context, command protocol.Command) (protocol.Reconciliation, error) {
	now := time.Now
	if t != nil && t.now != nil {
		now = t.now
	}
	note := "Connector WSS has no command reconciliation frame"
	return protocol.Reconciliation{
		CommandID:  command.CommandID,
		ObservedAt: now().UTC().Format(time.RFC3339Nano),
		State:      protocol.ReconciliationStateUnknown,
		Note:       &note,
	}, nil
}

func (t *gatewayExecutionTransport) HandleEvent(ctx context.Context, connection hosts.Connection, event protocol.Event) error {
	if t == nil || t.sessions == nil || t.runs == nil {
		return fmt.Errorf("%w: gateway execution stores are unavailable", hosts.ErrInvalid)
	}
	access, err := t.sessions.GetAccess(ctx, event.SessionID)
	if errors.Is(err, sessions.ErrSessionNotFound) {
		return fmt.Errorf("%w: %w", errGatewaySessionOwnership, hosts.ErrInvalid)
	}
	if err != nil {
		return fmt.Errorf("resolve gateway event session access: %w", err)
	}
	if !access.Confirmed || access.HostID == "" || access.HostID != connection.HostID {
		return fmt.Errorf("%w: %w", errGatewaySessionOwnership, hosts.ErrInvalid)
	}
	session, err := t.sessions.Get(ctx, event.SessionID)
	if err != nil {
		return fmt.Errorf("read gateway event session: %w", err)
	}
	if err := validateGatewayEventRun(session, t.runs, ctx, event); err != nil {
		return err
	}
	if event.Type == protocol.EventTypeApprovalRequested {
		request, err := normalizeGatewayApproval(event, session.Generation)
		if err != nil {
			return err
		}
		_, _, err = t.runs.ApplyApprovalRequestedEvent(ctx, session.Generation, event, request)
		return err
	}
	if _, err := t.runs.ApplyEvent(ctx, session.Generation, event); err != nil {
		return err
	}
	return nil
}

func validateGatewayEventRun(session sessions.Session, store *runs.Store, ctx context.Context, event protocol.Event) error {
	if !gatewayEventRequiresRun(event.Type) {
		return nil
	}
	if event.RunID == nil || strings.TrimSpace(*event.RunID) == "" {
		return fmt.Errorf("%w: %w", errGatewayRunIdentity, hosts.ErrInvalid)
	}
	runID := strings.TrimSpace(*event.RunID)
	if runID != *event.RunID {
		return fmt.Errorf("%w: run id must not have surrounding whitespace: %w", errGatewayRunIdentity, hosts.ErrInvalid)
	}
	run, err := store.GetRun(ctx, runID)
	if errors.Is(err, runs.ErrRunNotFound) {
		return fmt.Errorf("%w: %q: %w", errGatewayRunIdentity, runID, hosts.ErrInvalid)
	}
	if err != nil {
		return fmt.Errorf("read gateway event run: %w", err)
	}
	if run.SessionID != event.SessionID || run.Generation != session.Generation {
		return fmt.Errorf("%w: run %q is not part of session generation %q: %w", errGatewayRunIdentity, runID, session.Generation, hosts.ErrInvalid)
	}
	return nil
}

func gatewayEventRequiresRun(eventType protocol.EventType) bool {
	switch eventType {
	case protocol.EventTypeSessionCreated, protocol.EventTypeSessionAttached:
		return false
	default:
		return true
	}
}

type gatewayApprovalPayload struct {
	ApprovalID  string          `json:"approval_id"`
	Kind        string          `json:"kind"`
	Summary     string          `json:"summary"`
	Revision    int64           `json:"revision"`
	RequestedAt string          `json:"requested_at"`
	Context     json.RawMessage `json:"context"`
	RunID       string          `json:"run_id"`
	TurnID      string          `json:"turn_id"`
}

func normalizeGatewayApproval(event protocol.Event, generation string) (approvals.CreateRequest, error) {
	if event.RunID == nil || strings.TrimSpace(*event.RunID) == "" {
		return approvals.CreateRequest{}, fmt.Errorf("%w: %w", errGatewayApprovalPayload, hosts.ErrInvalid)
	}
	var payload gatewayApprovalPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return approvals.CreateRequest{}, fmt.Errorf("%w: %v: %w", errGatewayApprovalPayload, err, hosts.ErrInvalid)
	}
	if payload.TurnID != "" {
		return approvals.CreateRequest{}, fmt.Errorf("%w: external turn_id cannot identify a platform run: %w", errGatewayApprovalPayload, hosts.ErrInvalid)
	}
	if payload.RunID != "" && payload.RunID != *event.RunID {
		return approvals.CreateRequest{}, fmt.Errorf("%w: payload run_id does not match platform run_id: %w", errGatewayApprovalPayload, hosts.ErrInvalid)
	}
	if strings.TrimSpace(payload.ApprovalID) == "" || payload.ApprovalID != strings.TrimSpace(payload.ApprovalID) ||
		strings.TrimSpace(payload.Kind) == "" || payload.Kind != strings.TrimSpace(payload.Kind) || payload.Revision <= 0 {
		return approvals.CreateRequest{}, fmt.Errorf("%w: approval_id, kind and positive revision are required: %w", errGatewayApprovalPayload, hosts.ErrInvalid)
	}
	requestedAt := payload.RequestedAt
	if requestedAt == "" {
		requestedAt = event.OccurredAt
	}
	if _, err := time.Parse(time.RFC3339Nano, requestedAt); err != nil {
		return approvals.CreateRequest{}, fmt.Errorf("%w: requested_at is malformed: %w", errGatewayApprovalPayload, hosts.ErrInvalid)
	}
	contextPayload := payload.Context
	if len(strings.TrimSpace(string(contextPayload))) == 0 {
		contextPayload = json.RawMessage(`{}`)
	}
	if !json.Valid(contextPayload) {
		return approvals.CreateRequest{}, fmt.Errorf("%w: context must be valid JSON: %w", errGatewayApprovalPayload, hosts.ErrInvalid)
	}
	return approvals.CreateRequest{
		NewInput: approvals.NewInput{
			ID:          payload.ApprovalID,
			RunID:       *event.RunID,
			SessionID:   event.SessionID,
			Generation:  generation,
			Revision:    payload.Revision,
			Kind:        payload.Kind,
			Summary:     payload.Summary,
			RequestedAt: requestedAt,
		},
		Context:          append(json.RawMessage(nil), contextPayload...),
		RequestedEventID: event.EventID,
	}, nil
}

var _ runs.CommandTransport = (*gatewayExecutionTransport)(nil)
