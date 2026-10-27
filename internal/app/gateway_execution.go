package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	connectorruntime "github.com/IvanLi-CN/Loomhelm/internal/connector"
	"github.com/IvanLi-CN/Loomhelm/internal/events"
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
	gateway    *gateway.Server
	sessions   *sessions.Store
	runs       *runs.Store
	eventStore gatewayEventAppender
	now        func() time.Time
}

type gatewayEventAppender interface {
	Append(context.Context, protocol.Event) (events.AppendResult, error)
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

// HandleCommandAck is the authenticated durable ACK ingress. The command row
// supplies the session and exact platform run identity; the host access row
// prevents a connected but unrelated host from writing that fact. Missing
// optional ACK identity is filled only from the already locked command record,
// never from an active-run guess.
func (t *gatewayExecutionTransport) HandleCommandAck(ctx context.Context, connection hosts.Connection, _ string, platformSessionID string, ack protocol.CommandAck) error {
	if t == nil || t.sessions == nil || t.runs == nil {
		return fmt.Errorf("%w: gateway ACK stores are unavailable", hosts.ErrInvalid)
	}
	platformSessionID = strings.TrimSpace(platformSessionID)
	record, err := t.runs.Lookup(ctx, platformSessionID, ack.CommandID)
	if err != nil {
		if !errors.Is(err, runs.ErrCommandNotFound) {
			return err
		}
		intent, intentErr := t.sessions.GetIntentBySessionAndCommand(ctx, platformSessionID, ack.CommandID)
		if intentErr != nil {
			return err
		}
		if ack.RunID != nil {
			return fmt.Errorf("%w: session creation command %q must not carry a run id", hosts.ErrInvalid, ack.CommandID)
		}
		access, accessErr := t.sessions.GetAccess(ctx, intent.SessionID)
		if accessErr != nil {
			return fmt.Errorf("resolve session creation ACK access: %w", accessErr)
		}
		if strings.TrimSpace(access.HostID) == "" || access.HostID != connection.HostID || (access.IntentState != sessions.IntentStatePending && access.IntentState != sessions.IntentStateUnknown && access.IntentState != sessions.IntentStateConfirmed) {
			return fmt.Errorf("%w: creation command %q is not owned by gateway host %q", errGatewaySessionOwnership, ack.CommandID, connection.HostID)
		}
		if ack.State == protocol.CommandStateFailed || ack.State == protocol.CommandStateRejected {
			if _, err := t.sessions.MarkIntentDefiniteFailure(ctx, sessions.DefiniteFailureIntentInput{
				SessionID: intent.SessionID,
				State:     ack.State,
			}); err != nil {
				return fmt.Errorf("record definite session failure: %w", err)
			}
		}
		if ack.State == protocol.CommandStateSucceeded && (access.IntentState == sessions.IntentStateUnknown || access.IntentState == sessions.IntentStateConfirmed) {
			var opened sessionOpenResult
			if err := json.Unmarshal(ack.Result, &opened); err != nil || strings.TrimSpace(opened.ExternalThreadRef) == "" || strings.TrimSpace(opened.Generation) == "" {
				return fmt.Errorf("%w: session creation ACK does not contain a complete execution identity", hosts.ErrInvalid)
			}
			if _, err := t.sessions.ActivateIntent(ctx, sessions.ActivationInput{
				SessionID:           intent.SessionID,
				ExternalThreadRef:   opened.ExternalThreadRef,
				ExecutionGeneration: opened.Generation,
			}); err != nil {
				return fmt.Errorf("reconcile session creation ACK: %w", err)
			}
		}
		return nil
	}
	access, err := t.sessions.GetAccess(ctx, record.Intent.Command.SessionID)
	if err != nil {
		return fmt.Errorf("resolve gateway ACK session access: %w", err)
	}
	if strings.TrimSpace(access.HostID) == "" || access.HostID != connection.HostID || (access.IntentState != sessions.IntentStatePending && !access.Confirmed) {
		return fmt.Errorf("%w: command %q is not owned by gateway host %q", errGatewaySessionOwnership, ack.CommandID, connection.HostID)
	}
	if record.Intent.Command.RunID == nil {
		if ack.RunID != nil {
			return fmt.Errorf("%w: session command %q must not carry a run id", hosts.ErrInvalid, ack.CommandID)
		}
	} else if ack.RunID == nil {
		runID := *record.Intent.Command.RunID
		ack.RunID = &runID
	} else if *ack.RunID != *record.Intent.Command.RunID {
		return fmt.Errorf("%w: ACK run identity does not match command %q", hosts.ErrInvalid, ack.CommandID)
	}
	if _, err := t.runs.RecordExactCommandAck(ctx, platformSessionID, ack); err != nil && !errors.Is(err, protocol.ErrUnknownCommandResult) {
		return err
	}
	return nil
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
	if acknowledgePendingSessionCreated(access, connection, event) {
		if err := persistPendingSessionCreated(ctx, t.eventStore, event); err != nil {
			return fmt.Errorf("persist pending session-created event: %w", err)
		}
		return nil
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
	// Connector sequence values describe the adapter observation stream, which
	// can include telemetry or control events that this boundary acknowledges
	// without persisting. The event store owns the public session sequence.
	event.Sequence = 0
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

func persistPendingSessionCreated(ctx context.Context, appender gatewayEventAppender, event protocol.Event) error {
	if appender == nil {
		return runs.ErrControlServiceUnavailable
	}
	event.Sequence = 0
	_, err := appender.Append(ctx, event)
	return err
}

func acknowledgePendingSessionCreated(access sessions.SessionAccess, connection hosts.Connection, event protocol.Event) bool {
	return event.Type == protocol.EventTypeSessionCreated &&
		access.IntentState == sessions.IntentStatePending &&
		!access.Confirmed &&
		strings.TrimSpace(access.HostID) != "" &&
		access.HostID == connection.HostID
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
	case protocol.EventTypeSessionCreated, protocol.EventTypeSessionAttached, protocol.EventTypeReconciliationRequired, protocol.EventTypeReconciliationCompleted:
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

type gatewayNativeApprovalPayload struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type gatewayNativeApprovalParams struct {
	ThreadID  string          `json:"threadId"`
	TurnID    string          `json:"turnId"`
	RequestID json.RawMessage `json:"requestId"`
	Revision  int64           `json:"revision"`
	Command   string          `json:"command"`
	Item      struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Command string `json:"command"`
	} `json:"item"`
}

func normalizeGatewayApproval(event protocol.Event, generation string) (approvals.CreateRequest, error) {
	if event.RunID == nil || strings.TrimSpace(*event.RunID) == "" {
		return approvals.CreateRequest{}, fmt.Errorf("%w: %w", errGatewayApprovalPayload, hosts.ErrInvalid)
	}
	var shape map[string]json.RawMessage
	if err := json.Unmarshal(event.Payload, &shape); err != nil {
		return approvals.CreateRequest{}, fmt.Errorf("%w: %v: %w", errGatewayApprovalPayload, err, hosts.ErrInvalid)
	}
	if _, native := shape["method"]; native {
		return normalizeNativeGatewayApproval(event, generation)
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

func normalizeNativeGatewayApproval(event protocol.Event, generation string) (approvals.CreateRequest, error) {
	var payload gatewayNativeApprovalPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return approvals.CreateRequest{}, fmt.Errorf("%w: %v: %w", errGatewayApprovalPayload, err, hosts.ErrInvalid)
	}
	if payload.Method != "item/commandExecution/requestApproval" && payload.Method != "item/fileChange/requestApproval" {
		return approvals.CreateRequest{}, fmt.Errorf("%w: unsupported native approval method %q: %w", errGatewayApprovalPayload, payload.Method, hosts.ErrInvalid)
	}
	var params gatewayNativeApprovalParams
	if err := json.Unmarshal(payload.Params, &params); err != nil {
		return approvals.CreateRequest{}, fmt.Errorf("%w: native approval params are malformed: %v: %w", errGatewayApprovalPayload, err, hosts.ErrInvalid)
	}
	var paramsShape map[string]json.RawMessage
	if err := json.Unmarshal(payload.Params, &paramsShape); err != nil || paramsShape == nil {
		return approvals.CreateRequest{}, fmt.Errorf("%w: native approval params must be an object: %w", errGatewayApprovalPayload, hosts.ErrInvalid)
	}
	requestID := payload.ID
	if len(bytes.TrimSpace(requestID)) == 0 || bytes.Equal(bytes.TrimSpace(requestID), []byte("null")) {
		requestID = params.RequestID
	}
	if _, err := nativeApprovalID(requestID); err != nil {
		return approvals.CreateRequest{}, fmt.Errorf("%w: %v: %w", errGatewayApprovalPayload, err, hosts.ErrInvalid)
	}
	approvalID, err := connectorruntime.ScopedNativeApprovalID(event.SessionID, generation, requestID)
	if err != nil {
		return approvals.CreateRequest{}, fmt.Errorf("%w: %v: %w", errGatewayApprovalPayload, err, hosts.ErrInvalid)
	}
	revision := params.Revision
	if revision <= 0 {
		revision = 1
	}
	kind := "command"
	if payload.Method == "item/fileChange/requestApproval" || params.Item.Type == "fileChange" {
		kind = "file_change"
	}
	summary := strings.TrimSpace(params.Command)
	if summary == "" {
		summary = strings.TrimSpace(params.Item.Command)
	}
	if summary == "" {
		summary = kind + " approval"
	}
	contextPayload := json.RawMessage(`{}`)
	if len(bytes.TrimSpace(payload.Params)) != 0 {
		contextPayload = append(json.RawMessage(nil), payload.Params...)
	}
	return approvals.CreateRequest{
		NewInput: approvals.NewInput{
			ID:          approvalID,
			RunID:       *event.RunID,
			SessionID:   event.SessionID,
			Generation:  generation,
			Revision:    revision,
			Kind:        kind,
			Summary:     summary,
			RequestedAt: event.OccurredAt,
		},
		Context:          contextPayload,
		RequestedEventID: event.EventID,
	}, nil
}

func nativeApprovalID(raw json.RawMessage) (string, error) {
	value := bytes.TrimSpace(raw)
	if len(value) == 0 || bytes.Equal(value, []byte("null")) {
		return "", errors.New("native approval request id is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return "", errors.New("native approval request id must be a non-empty string or number")
	}
	switch value := decoded.(type) {
	case string:
		if strings.TrimSpace(value) == "" {
			return "", errors.New("native approval request id must be a non-empty string or number")
		}
		return value, nil
	case json.Number:
		return value.String(), nil
	default:
		return "", errors.New("native approval request id must be a non-empty string or number")
	}
}

var _ runs.CommandTransport = (*gatewayExecutionTransport)(nil)
