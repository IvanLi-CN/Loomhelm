package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

type TransportProvider interface {
	TransportFor(context.Context, protocol.GatewaySession) (RPCTransport, error)
}

type AdapterConfig struct {
	Journal               *Journal
	Model                 string
	ReasoningEffort       string
	ApprovalPolicy        string
	Sandbox               string
	WorkingDir            string
	RuntimeWorkspaceRoots []string
	ServiceName           string
}

type adapterSessionState struct {
	mu             sync.Mutex
	session        protocol.AdapterSession
	gatewaySession protocol.GatewaySession
	transport      RPCTransport
	activeTurns    map[string]string
}

// Adapter is the host-owned Codex app-server adapter. It translates only the
// already-approved protocol.Command kinds and persists every side effect
// boundary through Journal before contacting app-server.
type Adapter struct {
	provider TransportProvider
	journal  *Journal
	config   AdapterConfig

	mu       sync.Mutex
	sessions map[string]*adapterSessionState
}

func NewAdapter(provider TransportProvider, journal *Journal, config AdapterConfig) (*Adapter, error) {
	if provider == nil {
		return nil, errors.New("transport provider must not be nil")
	}
	if journal == nil {
		return nil, errors.New("connector journal must not be nil")
	}
	if config.Model == "" {
		config.Model = "gpt-5.6-luna"
	}
	if config.ReasoningEffort == "" {
		config.ReasoningEffort = "max"
	}
	if config.ApprovalPolicy == "" {
		config.ApprovalPolicy = "untrusted"
	}
	if config.Sandbox == "" {
		config.Sandbox = "workspace-write"
	}
	if config.ServiceName == "" {
		config.ServiceName = "loomhelm_connector"
	}
	return &Adapter{provider: provider, journal: journal, config: config, sessions: make(map[string]*adapterSessionState)}, nil
}

func NewCodexAdapter(provider TransportProvider, journal *Journal) (*Adapter, error) {
	return NewAdapter(provider, journal, AdapterConfig{})
}

func (a *Adapter) StartSession(ctx context.Context, gatewaySession protocol.GatewaySession, request protocol.NewSessionRequest) (protocol.AdapterSession, error) {
	if ctx == nil {
		return protocol.AdapterSession{}, errors.New("adapter context must not be nil")
	}
	transport, err := a.provider.TransportFor(ctx, gatewaySession)
	if err != nil {
		return protocol.AdapterSession{}, err
	}
	params := a.threadStartParams(request)
	response, err := transport.Call(ctx, "thread/start", mustRawJSON(params))
	if err != nil {
		return protocol.AdapterSession{}, err
	}
	if response.Error != nil {
		return protocol.AdapterSession{}, rpcResponseError("thread/start", response)
	}
	externalThreadRef := threadIDFromResult(response.Result)
	if externalThreadRef == "" {
		return protocol.AdapterSession{}, errors.New("thread/start returned no thread id")
	}
	session := protocol.AdapterSession{
		SessionID:         stableSessionID(externalThreadRef),
		ExternalThreadRef: externalThreadRef,
	}
	state := &adapterSessionState{
		session:        session,
		gatewaySession: gatewaySession,
		transport:      transport,
		activeTurns:    make(map[string]string),
	}
	a.mu.Lock()
	a.sessions[session.SessionID] = state
	a.mu.Unlock()
	go a.consume(state)
	if err := a.journal.RecordSession(session.SessionID, externalThreadRef, gatewaySession.Generation); err != nil {
		a.removeSession(session.SessionID)
		return protocol.AdapterSession{}, err
	}
	if _, err := a.appendObservedEvent(state, protocol.EventTypeSessionCreated, "thread/start", response.Result, ""); err != nil {
		a.removeSession(session.SessionID)
		return protocol.AdapterSession{}, err
	}
	if strings.TrimSpace(request.Prompt) != "" {
		commandID := session.SessionID + ":initial"
		payload := mustRawJSON(protocol.SubmitRunRequest{CommandID: commandID, Prompt: request.Prompt})
		command := protocol.Command{
			CommandID: commandID,
			IssuedAt:  now(),
			Kind:      protocol.CommandKindRunSend,
			Payload:   payload,
			SessionID: session.SessionID,
		}
		if _, err := a.SendCommand(ctx, session, command); err != nil {
			return protocol.AdapterSession{}, err
		}
	}
	return session, nil
}

func (a *Adapter) AttachSession(context.Context, protocol.GatewaySession, protocol.ExistingSessionRequest) (protocol.AdapterSession, error) {
	return protocol.AdapterSession{}, protocol.ErrUnsupportedSessionPath
}

// RecoverSession is the explicit cold-resume path used after a host-owned
// process restart. It does not claim to attach to a live Desktop process.
func (a *Adapter) RecoverSession(ctx context.Context, gatewaySession protocol.GatewaySession, externalThreadRef string) (protocol.AdapterSession, error) {
	if ctx == nil {
		return protocol.AdapterSession{}, errors.New("adapter context must not be nil")
	}
	if externalThreadRef == "" {
		return protocol.AdapterSession{}, errors.New("external thread reference must not be empty")
	}
	transport, err := a.provider.TransportFor(ctx, gatewaySession)
	if err != nil {
		return protocol.AdapterSession{}, err
	}
	response, err := transport.Call(ctx, "thread/resume", mustRawJSON(map[string]any{
		"threadId":     externalThreadRef,
		"excludeTurns": true,
	}))
	if err != nil {
		return protocol.AdapterSession{}, err
	}
	if response.Error != nil {
		return protocol.AdapterSession{}, rpcResponseError("thread/resume", response)
	}
	if threadIDFromResult(response.Result) != externalThreadRef {
		return protocol.AdapterSession{}, errors.New("thread/resume returned a different thread id")
	}
	return a.bindRecoveredSession(gatewaySession, externalThreadRef, "thread/resume", response.Result, transport)
}

// BindRecoveredSession registers a session after Gateway.ReconcileSession has
// already resumed the thread. It intentionally performs no second resume RPC.
func (a *Adapter) BindRecoveredSession(ctx context.Context, gatewaySession protocol.GatewaySession, externalThreadRef string) (protocol.AdapterSession, error) {
	if ctx == nil {
		return protocol.AdapterSession{}, errors.New("adapter context must not be nil")
	}
	if externalThreadRef == "" {
		return protocol.AdapterSession{}, errors.New("external thread reference must not be empty")
	}
	if gatewaySession.ExternalThreadRef != "" && gatewaySession.ExternalThreadRef != externalThreadRef {
		return protocol.AdapterSession{}, errors.New("gateway and adapter recovery thread identities do not match")
	}
	transport, err := a.provider.TransportFor(ctx, gatewaySession)
	if err != nil {
		return protocol.AdapterSession{}, err
	}
	return a.bindRecoveredSession(gatewaySession, externalThreadRef, "thread/resume", mustRawJSON(map[string]any{
		"thread": map[string]string{"id": externalThreadRef},
	}), transport)
}

func (a *Adapter) bindRecoveredSession(gatewaySession protocol.GatewaySession, externalThreadRef, method string, result json.RawMessage, transport RPCTransport) (protocol.AdapterSession, error) {
	session := protocol.AdapterSession{SessionID: stableSessionID(externalThreadRef), ExternalThreadRef: externalThreadRef}
	state := &adapterSessionState{session: session, gatewaySession: gatewaySession, transport: transport, activeTurns: make(map[string]string)}
	a.mu.Lock()
	a.sessions[session.SessionID] = state
	a.mu.Unlock()
	go a.consume(state)
	if err := a.journal.RecordSession(session.SessionID, externalThreadRef, gatewaySession.Generation); err != nil {
		a.removeSession(session.SessionID)
		return protocol.AdapterSession{}, err
	}
	if _, err := a.appendObservedEvent(state, protocol.EventTypeReconciliationCompleted, method, result, ""); err != nil {
		a.removeSession(session.SessionID)
		return protocol.AdapterSession{}, err
	}
	return session, nil
}

func (a *Adapter) CloseSession(_ context.Context, session protocol.AdapterSession) error {
	a.removeSession(session.SessionID)
	return nil
}

func (a *Adapter) SendCommand(ctx context.Context, session protocol.AdapterSession, command protocol.Command) (protocol.CommandAck, error) {
	if ctx == nil {
		return protocol.CommandAck{}, errors.New("adapter context must not be nil")
	}
	if command.SessionID != session.SessionID {
		return protocol.CommandAck{}, fmt.Errorf("command session id %q does not match adapter session %q", command.SessionID, session.SessionID)
	}
	if err := protocol.ValidateCommand(command); err != nil {
		return protocol.CommandAck{}, err
	}
	state := a.sessionState(session.SessionID)
	if state == nil {
		return protocol.CommandAck{}, fmt.Errorf("adapter session %q is not available", session.SessionID)
	}
	ack, deduplicated, err := a.journal.BeginCommand(command)
	if err != nil {
		return ack, err
	}
	if deduplicated {
		if ack.State == protocol.CommandStateUnknown {
			return ack, protocol.ErrUnknownCommandResult
		}
		return ack, nil
	}
	ack.State = protocol.CommandStateExecuting
	if err := a.journal.UpdateCommand(command.CommandID, ack); err != nil {
		return ack, err
	}

	switch command.Kind {
	case protocol.CommandKindRunSend:
		return a.sendRun(ctx, state, command, ack)
	case protocol.CommandKindRunApprove, protocol.CommandKindRunDeny:
		return a.resolveApproval(ctx, state, command, ack)
	case protocol.CommandKindRunInterrupt:
		return a.interruptRun(ctx, state, command, ack)
	default:
		return a.rejectCommand(command, ack, fmt.Errorf("command kind %q is not accepted by the Codex adapter", command.Kind))
	}
}

// Steer maps a public run.send command to the app-server turn/steer method.
// It is separate because the versioned public contract intentionally exposes
// one run-send command kind while the host protocol has a distinct control RPC.
func (a *Adapter) Steer(ctx context.Context, session protocol.AdapterSession, command protocol.Command) (protocol.CommandAck, error) {
	if command.Kind != protocol.CommandKindRunSend {
		return protocol.CommandAck{}, fmt.Errorf("steer requires command kind %q", protocol.CommandKindRunSend)
	}
	if command.SessionID != session.SessionID {
		return protocol.CommandAck{}, fmt.Errorf("command session id %q does not match adapter session %q", command.SessionID, session.SessionID)
	}
	state := a.sessionState(session.SessionID)
	if state == nil {
		return protocol.CommandAck{}, fmt.Errorf("adapter session %q is not available", session.SessionID)
	}
	ack, deduplicated, err := a.journal.BeginCommand(command)
	if err != nil {
		return ack, err
	}
	if deduplicated {
		if ack.State == protocol.CommandStateUnknown {
			return ack, protocol.ErrUnknownCommandResult
		}
		return ack, nil
	}
	ack.State = protocol.CommandStateExecuting
	if err := a.journal.UpdateCommand(command.CommandID, ack); err != nil {
		return ack, err
	}
	payload, err := decodeCommandPayload(command.Payload)
	if err != nil {
		return a.rejectCommand(command, ack, err)
	}
	turnID := firstString(payload, "expected_turn_id", "turn_id")
	if turnID == "" {
		turnID = valueOrEmpty(command.RunID)
	}
	if turnID == "" {
		turnID = a.activeTurn(state, "")
	}
	if turnID == "" {
		return a.rejectCommand(command, ack, errors.New("steer requires an active turn id"))
	}
	input, err := turnInput(payload)
	if err != nil {
		return a.rejectCommand(command, ack, err)
	}
	response, callErr := state.transport.Call(ctx, "turn/steer", mustRawJSON(map[string]any{
		"threadId":       session.ExternalThreadRef,
		"expectedTurnId": turnID,
		"input":          input,
	}))
	return a.finishRPCCommand(ctx, state, command, ack, response, callErr, turnID, "turn/steer")
}

func (a *Adapter) ReconcileCommand(ctx context.Context, session protocol.AdapterSession, commandID string) (protocol.Reconciliation, error) {
	if ctx == nil {
		return protocol.Reconciliation{}, errors.New("adapter context must not be nil")
	}
	command, ack, err := a.journal.Command(commandID)
	if err != nil {
		return protocol.Reconciliation{}, err
	}
	if ack.State != protocol.CommandStateUnknown {
		state := protocol.ReconciliationStateConfirmed
		if ack.State == protocol.CommandStateFailed || ack.State == protocol.CommandStateRejected {
			state = protocol.ReconciliationStateNotFound
		}
		value := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: state, EventCursor: ack.EventCursor}
		_ = a.journal.RecordReconciliation(value)
		return value, nil
	}
	state := a.sessionState(session.SessionID)
	if state == nil {
		return protocol.Reconciliation{}, fmt.Errorf("adapter session %q is not available", session.SessionID)
	}
	result, err := state.transport.Call(ctx, "thread/turns/list", mustRawJSON(map[string]any{
		"threadId":  session.ExternalThreadRef,
		"limit":     100,
		"itemsView": "summary",
	}))
	if err != nil {
		value := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: protocol.ReconciliationStateUnknown, Note: stringPointer(err.Error())}
		_ = a.journal.RecordReconciliation(value)
		return value, nil
	}
	if result.Error != nil {
		value := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: protocol.ReconciliationStateUnknown, Note: stringPointer(result.Error.Message)}
		_ = a.journal.RecordReconciliation(value)
		return value, nil
	}
	turns := extractTurns(result.Result)
	matched, ambiguous := matchCommandTurn(command, ack, turns)
	reconciliation := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: protocol.ReconciliationStateUnknown}
	if matched != nil && !ambiguous {
		reconciliation.State = protocol.ReconciliationStateConfirmed
		if matched.ID != "" {
			cursor := a.journalLastCursor(session.SessionID, matched.ID)
			if cursor != "" {
				reconciliation.EventCursor = &cursor
			}
			turnID := matched.ID
			ack.RunID = &turnID
			ack.State = protocol.CommandStateSucceeded
			if err := a.journal.UpdateCommand(commandID, ack); err != nil {
				return reconciliation, fmt.Errorf("persist reconciled command %q: %w", commandID, err)
			}
		}
	} else if matched == nil && !ambiguous {
		reconciliation.State = protocol.ReconciliationStateNotFound
		reconciliation.Note = stringPointer("no unique matching turn was observed; command is not replayed")
	} else {
		reconciliation.Note = stringPointer("multiple turns could match; command remains unknown and is not replayed")
	}
	if err := a.journal.RecordReconciliation(reconciliation); err != nil {
		return reconciliation, err
	}
	return reconciliation, nil
}

func (a *Adapter) sendRun(ctx context.Context, state *adapterSessionState, command protocol.Command, ack protocol.CommandAck) (protocol.CommandAck, error) {
	payload, err := decodeCommandPayload(command.Payload)
	if err != nil {
		return a.rejectCommand(command, ack, err)
	}
	if firstBool(payload, "steer", "turn_steer") || firstString(payload, "expected_turn_id", "turn_id") != "" {
		turnID := firstString(payload, "expected_turn_id", "turn_id")
		if turnID == "" {
			turnID = valueOrEmpty(command.RunID)
		}
		if turnID == "" {
			turnID = a.activeTurn(state, "")
		}
		if turnID == "" {
			return a.rejectCommand(command, ack, errors.New("steer requires an active turn id"))
		}
		input, inputErr := turnInput(payload)
		if inputErr != nil {
			return a.rejectCommand(command, ack, inputErr)
		}
		response, callErr := state.transport.Call(ctx, "turn/steer", mustRawJSON(map[string]any{
			"threadId":       state.session.ExternalThreadRef,
			"expectedTurnId": turnID,
			"input":          input,
		}))
		return a.finishRPCCommand(ctx, state, command, ack, response, callErr, turnID, "turn/steer")
	}
	prompt := firstString(payload, "prompt", "text")
	input := payload["input"]
	if prompt == "" && len(input) == 0 {
		return a.rejectCommand(command, ack, errors.New("run.send requires prompt or input"))
	}
	if len(input) == 0 {
		input = mustRawJSON([]map[string]string{{"type": "text", "text": prompt}})
	}
	params := map[string]any{
		"threadId":       state.session.ExternalThreadRef,
		"input":          json.RawMessage(input),
		"model":          stringOrDefault(payload, "model", a.config.Model),
		"effort":         stringOrDefault(payload, "reasoning_effort", stringOrDefault(payload, "effort", a.config.ReasoningEffort)),
		"approvalPolicy": a.config.ApprovalPolicy,
		"sandboxPolicy":  a.sandboxPolicy(),
	}
	response, callErr := state.transport.Call(ctx, "turn/start", mustRawJSON(params))
	turnID := turnIDFromResult(response.Result)
	return a.finishRPCCommand(ctx, state, command, ack, response, callErr, turnID, "turn/start")
}

func (a *Adapter) resolveApproval(ctx context.Context, state *adapterSessionState, command protocol.Command, ack protocol.CommandAck) (protocol.CommandAck, error) {
	payload, err := decodeCommandPayload(command.Payload)
	if err != nil {
		return a.rejectCommand(command, ack, err)
	}
	requestID := firstRaw(payload, "request_id", "server_request_id", "approval_id", "rpc_id")
	runID := valueOrEmpty(command.RunID)
	if runID == "" {
		runID = firstString(payload, "run_id", "turn_id")
	}
	if len(requestID) == 0 {
		pending := a.journal.PendingApprovals(state.session.SessionID, runID)
		if len(pending) != 1 {
			return a.rejectCommand(command, ack, errors.New("approval command does not identify exactly one pending approval"))
		}
		requestID = pending[0].RequestID
	}
	decision := "decline"
	if command.Kind == protocol.CommandKindRunApprove {
		decision = "accept"
	}
	if requested := firstString(payload, "decision"); requested != "" && requested != decision {
		return a.rejectCommand(command, ack, errors.New("approval decision conflicts with command kind"))
	}
	result := mustRawJSON(map[string]string{"decision": decision})
	if err := state.transport.Respond(ctx, requestID, result); err != nil {
		return a.finishTransportError(command, ack, err, "approval response")
	}
	resolvedPayload := mustRawJSON(map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(requestID),
		"method":  "approval/response",
		"result":  json.RawMessage(result),
	})
	if _, err := a.appendObservedEvent(state, protocol.EventTypeApprovalResolved, "approval/response", resolvedPayload, runID); err != nil {
		return ack, err
	}
	ack.State = protocol.CommandStateSucceeded
	ack.Result = append(json.RawMessage(nil), result...)
	if runID != "" {
		ack.RunID = &runID
	}
	if err := a.journal.UpdateCommand(command.CommandID, ack); err != nil {
		return ack, err
	}
	return ack, nil
}

func (a *Adapter) interruptRun(ctx context.Context, state *adapterSessionState, command protocol.Command, ack protocol.CommandAck) (protocol.CommandAck, error) {
	payload, err := decodeCommandPayload(command.Payload)
	if err != nil {
		return a.rejectCommand(command, ack, err)
	}
	turnID := firstString(payload, "turn_id", "expected_turn_id")
	if turnID == "" {
		turnID = valueOrEmpty(command.RunID)
	}
	if turnID == "" {
		turnID = a.activeTurn(state, firstString(payload, "run_id"))
	}
	if turnID == "" {
		return a.rejectCommand(command, ack, errors.New("interrupt requires an active turn id"))
	}
	response, callErr := state.transport.Call(ctx, "turn/interrupt", mustRawJSON(map[string]string{
		"threadId": state.session.ExternalThreadRef,
		"turnId":   turnID,
	}))
	return a.finishRPCCommand(ctx, state, command, ack, response, callErr, turnID, "turn/interrupt")
}

func (a *Adapter) finishRPCCommand(_ context.Context, _ *adapterSessionState, command protocol.Command, ack protocol.CommandAck, response RPCMessage, callErr error, runID, operation string) (protocol.CommandAck, error) {
	if callErr != nil {
		return a.finishTransportError(command, ack, callErr, operation)
	}
	if response.Error != nil {
		ack.State = protocol.CommandStateFailed
		ack.Error = rpcAPIError(response.Error)
		if err := a.journal.UpdateCommand(command.CommandID, ack); err != nil {
			return ack, fmt.Errorf("persist %s failure: %w", operation, err)
		}
		return ack, rpcResponseError(operation, response)
	}
	ack.State = protocol.CommandStateSucceeded
	ack.Result = append(json.RawMessage(nil), response.Result...)
	if runID == "" {
		runID = turnIDFromResult(response.Result)
	}
	if runID != "" {
		ack.RunID = &runID
	}
	if operation != "" {
		ack.OperationID = stringPointer(operation)
	}
	if err := a.journal.UpdateCommand(command.CommandID, ack); err != nil {
		return ack, err
	}
	return ack, nil
}

func (a *Adapter) finishTransportError(command protocol.Command, ack protocol.CommandAck, err error, operation string) (protocol.CommandAck, error) {
	if errors.Is(err, ErrUnknownOutcome) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		ack.State = protocol.CommandStateUnknown
		ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeUnknownResult, Message: err.Error(), RequestID: command.CommandID}
		if persistErr := a.journal.UpdateCommand(command.CommandID, ack); persistErr != nil {
			return ack, fmt.Errorf("persist unknown %s result: %w", operation, persistErr)
		}
		return ack, protocol.ErrUnknownCommandResult
	}
	ack.State = protocol.CommandStateFailed
	ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeConflict, Message: err.Error(), RequestID: command.CommandID}
	if persistErr := a.journal.UpdateCommand(command.CommandID, ack); persistErr != nil {
		return ack, fmt.Errorf("persist failed %s result: %w", operation, persistErr)
	}
	return ack, fmt.Errorf("%s: %w", operation, err)
}

func (a *Adapter) rejectCommand(command protocol.Command, ack protocol.CommandAck, err error) (protocol.CommandAck, error) {
	ack.State = protocol.CommandStateRejected
	ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeInvalidRequest, Message: err.Error(), RequestID: command.CommandID}
	if persistErr := a.journal.UpdateCommand(command.CommandID, ack); persistErr != nil {
		return ack, fmt.Errorf("persist rejected command: %w", persistErr)
	}
	return ack, err
}

func (a *Adapter) consume(state *adapterSessionState) {
	for message := range state.transport.Events() {
		a.observe(state, message)
	}
	_, _ = a.appendObservedEvent(state, protocol.EventTypeReconciliationRequired, "transport/closed", mustRawJSON(map[string]string{"generation": state.gatewaySession.Generation}), "")
}

func (a *Adapter) observe(state *adapterSessionState, message RPCMessage) {
	if message.IsResponse() {
		return
	}
	eventType := eventTypeForMethod(message.Method, message)
	runID := runIDFromMessage(message)
	state.mu.Lock()
	if message.Method == "turn/started" && runID != "" {
		state.activeTurns[runID] = runID
	}
	if message.Method == "turn/completed" && runID != "" {
		delete(state.activeTurns, runID)
	}
	state.mu.Unlock()
	_, _ = a.appendObservedEvent(state, eventType, message.Method, message.Raw, runID)
}

func (a *Adapter) appendObservedEvent(state *adapterSessionState, eventType protocol.EventType, method string, payload json.RawMessage, runID string) (protocol.Event, error) {
	if len(payload) == 0 {
		payload = mustRawJSON(map[string]any{"method": method})
	}
	if !json.Valid(payload) {
		payload = mustRawJSON(map[string]any{"method": method, "raw": string(payload)})
	}
	if method != "" {
		var object map[string]json.RawMessage
		if json.Unmarshal(payload, &object) == nil {
			if _, ok := object["method"]; !ok {
				object["method"] = mustRawJSON(method)
				payload = mustRawJSON(object)
			}
		}
	}
	event := protocol.Event{
		SessionID: state.session.SessionID,
		Type:      eventType,
		Source:    protocol.EventSourceAppServer,
		Payload:   append(json.RawMessage(nil), payload...),
	}
	if runID != "" {
		event.RunID = &runID
	}
	event.EventID = digestString(state.session.SessionID + "\x00" + method + "\x00" + string(payload))
	return a.journal.AppendEvent(event)
}

func (a *Adapter) threadStartParams(request protocol.NewSessionRequest) map[string]any {
	params := map[string]any{
		"model":          a.config.Model,
		"approvalPolicy": a.config.ApprovalPolicy,
		"sandbox":        a.config.Sandbox,
		"serviceName":    a.config.ServiceName,
	}
	if a.config.WorkingDir != "" {
		params["cwd"] = a.config.WorkingDir
	}
	if len(a.config.RuntimeWorkspaceRoots) > 0 {
		params["runtimeWorkspaceRoots"] = append([]string(nil), a.config.RuntimeWorkspaceRoots...)
	}
	if request.ProjectID != "" {
		params["loomhelmProjectId"] = request.ProjectID
	}
	if request.TaskID != "" {
		params["loomhelmTaskId"] = request.TaskID
	}
	return params
}

func (a *Adapter) sandboxPolicy() map[string]any {
	policy := map[string]any{"type": "workspaceWrite"}
	if len(a.config.RuntimeWorkspaceRoots) > 0 {
		policy["writableRoots"] = append([]string(nil), a.config.RuntimeWorkspaceRoots...)
	}
	return policy
}

func (a *Adapter) sessionState(sessionID string) *adapterSessionState {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[sessionID]
}

func (a *Adapter) removeSession(sessionID string) {
	a.mu.Lock()
	delete(a.sessions, sessionID)
	a.mu.Unlock()
}

func (a *Adapter) activeTurn(state *adapterSessionState, runID string) string {
	if runID != "" {
		state.mu.Lock()
		defer state.mu.Unlock()
		return state.activeTurns[runID]
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.activeTurns) != 1 {
		return ""
	}
	for _, turnID := range state.activeTurns {
		return turnID
	}
	return ""
}

func (a *Adapter) journalLastCursor(sessionID, runID string) string {
	page, err := a.journal.ReadEvents(protocol.EventQuery{SessionID: sessionID, RunID: runID, Limit: 1000})
	if err != nil || len(page.Events) == 0 {
		return ""
	}
	return page.Events[len(page.Events)-1].Cursor
}

func decodeCommandPayload(data []byte) (map[string]json.RawMessage, error) {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, fmt.Errorf("decode command payload: %w", err)
	}
	if value == nil {
		return nil, errors.New("command payload must be a JSON object")
	}
	return value, nil
}

func turnInput(payload map[string]json.RawMessage) (json.RawMessage, error) {
	if input := payload["input"]; len(input) > 0 {
		if !json.Valid(input) {
			return nil, errors.New("command input must be valid JSON")
		}
		return append(json.RawMessage(nil), input...), nil
	}
	text := firstString(payload, "prompt", "text")
	if text == "" {
		return nil, errors.New("steer requires prompt or input")
	}
	return mustRawJSON([]map[string]string{{"type": "text", "text": text}}), nil
}

func firstString(payload map[string]json.RawMessage, names ...string) string {
	for _, name := range names {
		value, ok := payload[name]
		if !ok {
			continue
		}
		var result string
		if json.Unmarshal(value, &result) == nil && result != "" {
			return result
		}
	}
	return ""
}

func firstRaw(payload map[string]json.RawMessage, names ...string) json.RawMessage {
	for _, name := range names {
		if value := payload[name]; len(value) > 0 && !bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return append(json.RawMessage(nil), value...)
		}
	}
	return nil
}

func firstBool(payload map[string]json.RawMessage, names ...string) bool {
	for _, name := range names {
		var value bool
		if json.Unmarshal(payload[name], &value) == nil && value {
			return true
		}
	}
	return false
}

func stringOrDefault(payload map[string]json.RawMessage, name, fallback string) string {
	if value := firstString(payload, name); value != "" {
		return value
	}
	return fallback
}

type appServerTurn struct {
	ID     string          `json:"id"`
	Status string          `json:"status"`
	Input  json.RawMessage `json:"input"`
}

func extractTurns(result json.RawMessage) []appServerTurn {
	var value struct {
		Data  []appServerTurn `json:"data"`
		Turns []appServerTurn `json:"turns"`
	}
	if json.Unmarshal(result, &value) != nil {
		return nil
	}
	if len(value.Data) > 0 {
		return value.Data
	}
	return value.Turns
}

func matchCommandTurn(command protocol.Command, ack protocol.CommandAck, turns []appServerTurn) (*appServerTurn, bool) {
	requestedID := valueOrEmpty(ack.RunID)
	if requestedID == "" {
		requestedID = valueOrEmpty(command.RunID)
	}
	if requestedID != "" {
		for index := range turns {
			if turns[index].ID == requestedID {
				return &turns[index], false
			}
		}
		return nil, false
	}
	payload, err := decodeCommandPayload(command.Payload)
	if err != nil {
		return nil, false
	}
	prompt := firstString(payload, "prompt", "text")
	if prompt == "" {
		return nil, false
	}
	var matches []appServerTurn
	for _, turn := range turns {
		if bytes.Contains(turn.Input, []byte(prompt)) {
			matches = append(matches, turn)
		}
	}
	if len(matches) == 1 {
		return &matches[0], false
	}
	return nil, len(matches) > 1
}

func turnIDFromResult(result json.RawMessage) string {
	var value struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
		TurnID string `json:"turnId"`
	}
	if json.Unmarshal(result, &value) != nil {
		return ""
	}
	if value.Turn.ID != "" {
		return value.Turn.ID
	}
	return value.TurnID
}

func runIDFromMessage(message RPCMessage) string {
	var params struct {
		TurnID string `json:"turnId"`
		Turn   struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(message.Params, &params) != nil {
		return ""
	}
	if params.Turn.ID != "" {
		return params.Turn.ID
	}
	return params.TurnID
}

func eventTypeForMethod(method string, message RPCMessage) protocol.EventType {
	switch method {
	case "thread/started":
		return protocol.EventTypeSessionCreated
	case "turn/started":
		return protocol.EventTypeRunStarted
	case "item/agentMessage/delta":
		return protocol.EventTypeMessageDelta
	case "item/started":
		return protocol.EventTypeItemStarted
	case "item/completed":
		return protocol.EventTypeItemCompleted
	case "item/commandExecution/requestApproval":
		return protocol.EventTypeApprovalRequested
	case "turn/completed":
		var params struct {
			Turn struct {
				Status string `json:"status"`
			} `json:"turn"`
		}
		_ = json.Unmarshal(message.Params, &params)
		switch params.Turn.Status {
		case "interrupted":
			return protocol.EventTypeRunInterrupted
		case "failed", "error":
			return protocol.EventTypeRunFailed
		default:
			return protocol.EventTypeRunCompleted
		}
	case "turn/failed":
		return protocol.EventTypeRunFailed
	default:
		return protocol.EventTypeUnknown
	}
}

func rpcResponseError(operation string, response RPCMessage) error {
	if response.Error == nil {
		return fmt.Errorf("app-server %s returned no result", operation)
	}
	return fmt.Errorf("app-server %s failed (%d): %s", operation, response.Error.Code, response.Error.Message)
}

func rpcAPIError(value *RPCError) *protocol.ApiError {
	if value == nil {
		return nil
	}
	code := protocol.ErrorCodeConflict
	if value.Code == -32600 || value.Code == -32602 {
		code = protocol.ErrorCodeInvalidRequest
	}
	return &protocol.ApiError{Code: code, Message: value.Message, RequestID: fmt.Sprintf("rpc-%d", value.Code), Details: append(json.RawMessage(nil), value.Data...)}
}

func stableSessionID(externalThreadRef string) string {
	digest := digestString(externalThreadRef)
	return "session-" + digest[:24]
}

func stringPointer(value string) *string { return &value }

var _ protocol.CodexAdapter = (*Adapter)(nil)
