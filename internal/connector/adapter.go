package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

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
	operationMu    sync.Mutex
	session        protocol.AdapterSession
	gatewaySession protocol.GatewaySession
	transport      RPCTransport
	activeTurns    map[string]string
	eventMu        sync.Mutex
	closed         atomic.Bool
	eventErrMu     sync.Mutex
	eventErr       error
}

// Adapter is the host-owned Codex app-server adapter. It translates only the
// already-approved protocol.Command kinds and persists every side effect
// boundary through Journal before contacting app-server.
type Adapter struct {
	provider TransportProvider
	journal  *Journal
	config   AdapterConfig

	mu         sync.Mutex
	recoveryMu sync.Mutex
	sessions   map[string]*adapterSessionState
	startMu    sync.Mutex
	startCalls map[string]*sessionStartCall
}

type sessionStartCall struct {
	done          chan struct{}
	waiterEntered chan struct{}
	waiterOnce    sync.Once
	gatewayHandle string
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
	return &Adapter{
		provider:   provider,
		journal:    journal,
		config:     config,
		sessions:   make(map[string]*adapterSessionState),
		startCalls: make(map[string]*sessionStartCall),
	}, nil
}

func NewCodexAdapter(provider TransportProvider, journal *Journal) (*Adapter, error) {
	return NewAdapter(provider, journal, AdapterConfig{})
}

func (a *Adapter) StartSession(ctx context.Context, gatewaySession protocol.GatewaySession, request protocol.NewSessionRequest) (protocol.AdapterSession, error) {
	if ctx == nil {
		return protocol.AdapterSession{}, errors.New("adapter context must not be nil")
	}
	if err := validateSessionCreationCommandID(request.CommandID); err != nil {
		return protocol.AdapterSession{}, err
	}
	for {
		release, wait := a.acquireSessionStart(request.CommandID, gatewaySession.Handle)
		if wait == nil {
			defer release()
			break
		}
		select {
		case <-wait.done:
		case <-ctx.Done():
			if wait.gatewayHandle != gatewaySession.Handle {
				cleanupCtx := context.WithoutCancel(ctx)
				_ = a.closeUnusedGatewaySession(cleanupCtx, gatewaySession, nil)
			}
			return protocol.AdapterSession{}, ctx.Err()
		}
	}
	transport, err := a.provider.TransportFor(ctx, gatewaySession)
	if err != nil {
		return protocol.AdapterSession{}, err
	}
	if existing, ok, err := a.journal.ResolvedSessionStart(request); err != nil {
		_ = a.discardUnusedGatewaySession(ctx, gatewaySession, transport, nil)
		return protocol.AdapterSession{}, err
	} else if ok {
		if state := a.sessionState(existing.SessionID); state != nil && !state.closed.Load() && a.isCurrentState(state) {
			if err := a.discardUnusedGatewaySession(ctx, gatewaySession, transport, state); err != nil {
				return state.session, err
			}
			return state.session, a.ensureInitialPrompt(ctx, request, state.session)
		}
		return a.resumeExistingSession(ctx, gatewaySession, request, transport, existing)
	}
	intentID, err := a.journal.BeginSessionStart(gatewaySession, request)
	if err != nil {
		if !errors.Is(err, ErrUnknownOutcome) {
			_ = a.discardUnusedGatewaySession(ctx, gatewaySession, transport, nil)
		}
		return protocol.AdapterSession{}, err
	}
	if existing, ok, err := a.journal.ResolvedSessionStart(request); err != nil {
		_ = a.discardUnusedGatewaySession(ctx, gatewaySession, transport, nil)
		return protocol.AdapterSession{}, err
	} else if ok {
		if state := a.sessionState(existing.SessionID); state != nil && !state.closed.Load() && a.isCurrentState(state) {
			if err := a.discardUnusedGatewaySession(ctx, gatewaySession, transport, state); err != nil {
				return state.session, err
			}
			return state.session, a.ensureInitialPrompt(ctx, request, state.session)
		}
		return a.resumeExistingSession(ctx, gatewaySession, request, transport, existing)
	}
	params := a.threadStartParams(request)
	response, err := transport.Call(ctx, "thread/start", mustRawJSON(params))
	if err != nil {
		if !errors.Is(err, ErrUnknownOutcome) {
			_ = a.journal.FailSessionStart(intentID)
			_ = a.closeUnusedGatewaySession(context.WithoutCancel(ctx), gatewaySession, transport)
		} else {
			go a.watchUnknownSessionStart(gatewaySession, intentID, transport)
		}
		return protocol.AdapterSession{}, err
	}
	if response.Error != nil {
		_ = a.journal.FailSessionStart(intentID)
		_ = a.closeUnusedGatewaySession(context.WithoutCancel(ctx), gatewaySession, transport)
		return protocol.AdapterSession{}, rpcResponseError("thread/start", response)
	}
	session, err := a.bindStartedSession(gatewaySession, intentID, response, transport)
	if err != nil {
		return protocol.AdapterSession{}, err
	}
	if strings.TrimSpace(request.Prompt) != "" {
		if _, err := a.SendCommand(ctx, session, initialPromptCommand(session, request)); err != nil {
			return session, err
		}
	}
	return session, nil
}

func (a *Adapter) acquireSessionStart(commandID, gatewayHandle string) (func(), *sessionStartCall) {
	a.startMu.Lock()
	defer a.startMu.Unlock()
	if wait, ok := a.startCalls[commandID]; ok {
		wait.waiterOnce.Do(func() { close(wait.waiterEntered) })
		return nil, wait
	}
	call := &sessionStartCall{done: make(chan struct{}), waiterEntered: make(chan struct{}), gatewayHandle: gatewayHandle}
	a.startCalls[commandID] = call
	return func() {
		a.startMu.Lock()
		if current, ok := a.startCalls[commandID]; ok && current == call {
			delete(a.startCalls, commandID)
			close(call.done)
		}
		a.startMu.Unlock()
	}, nil
}

func (a *Adapter) discardUnusedGatewaySession(ctx context.Context, gatewaySession protocol.GatewaySession, transport RPCTransport, activeState *adapterSessionState) error {
	if activeState != nil && activeState.gatewaySession.Handle == gatewaySession.Handle {
		return nil
	}
	return a.closeUnusedGatewaySession(ctx, gatewaySession, transport)
}

func (a *Adapter) closeUnusedGatewaySession(ctx context.Context, gatewaySession protocol.GatewaySession, transport RPCTransport) error {
	if closer, ok := a.provider.(interface {
		CloseSession(context.Context, protocol.GatewaySession) error
	}); ok {
		return closer.CloseSession(ctx, gatewaySession)
	}
	if transport == nil {
		var err error
		transport, err = a.provider.TransportFor(ctx, gatewaySession)
		if err != nil {
			return err
		}
	}
	return transport.Close()
}

func (a *Adapter) bindStartedSession(gatewaySession protocol.GatewaySession, intentID string, response RPCMessage, transport RPCTransport) (protocol.AdapterSession, error) {
	externalThreadRef := threadIDFromResult(response.Result)
	if externalThreadRef == "" {
		_ = a.closeUnusedGatewaySession(context.Background(), gatewaySession, transport)
		return protocol.AdapterSession{}, fmt.Errorf("%w: thread/start returned no thread id", ErrUnknownOutcome)
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
	if err := a.journal.ResolveSessionStart(intentID, session.SessionID, externalThreadRef, gatewaySession.Generation); err != nil {
		_ = a.closeUnusedGatewaySession(context.Background(), gatewaySession, transport)
		return protocol.AdapterSession{}, err
	}
	if binder, ok := a.provider.(interface {
		SetExternalThreadRef(protocol.GatewaySession, string) error
	}); ok {
		if err := binder.SetExternalThreadRef(gatewaySession, externalThreadRef); err != nil {
			_ = a.closeUnusedGatewaySession(context.Background(), gatewaySession, transport)
			return protocol.AdapterSession{}, err
		}
	}
	if _, err := a.appendObservedEvent(state, protocol.EventTypeSessionCreated, "thread/start", response.Raw, ""); err != nil {
		_ = a.closeUnusedGatewaySession(context.Background(), gatewaySession, transport)
		return protocol.AdapterSession{}, err
	}
	a.mu.Lock()
	a.sessions[session.SessionID] = state
	a.mu.Unlock()
	go a.consume(state)
	return session, nil
}

func (a *Adapter) watchUnknownSessionStart(gatewaySession protocol.GatewaySession, intentID string, transport RPCTransport) {
	for message := range transport.Events() {
		if !message.IsResponse() || message.operation != "thread/start" {
			continue
		}
		if message.Error != nil {
			_ = a.journal.FailSessionStart(intentID)
			_ = a.closeUnusedGatewaySession(context.Background(), gatewaySession, transport)
			return
		}
		if _, err := a.bindStartedSession(gatewaySession, intentID, message, transport); err != nil {
			return
		}
		return
	}
}

func (a *Adapter) resumeExistingSession(ctx context.Context, gatewaySession protocol.GatewaySession, request protocol.NewSessionRequest, transport RPCTransport, existing protocol.AdapterSession) (protocol.AdapterSession, error) {
	response, err := transport.Call(ctx, "thread/resume", mustRawJSON(map[string]any{
		"threadId":     existing.ExternalThreadRef,
		"excludeTurns": true,
	}))
	if err != nil {
		_ = transport.Close()
		return existing, err
	}
	if response.Error != nil {
		_ = transport.Close()
		return existing, rpcResponseError("thread/resume", response)
	}
	if threadIDFromResult(response.Result) != existing.ExternalThreadRef {
		_ = transport.Close()
		return existing, errors.New("thread/resume returned a different thread id")
	}
	session, err := a.bindRecoveredSession(gatewaySession, existing.ExternalThreadRef, "thread/resume", response.Raw, transport)
	if err != nil {
		return existing, err
	}
	if strings.TrimSpace(request.Prompt) == "" {
		return session, nil
	}
	return session, a.ensureInitialPrompt(ctx, request, session)
}

func (a *Adapter) ensureInitialPrompt(ctx context.Context, request protocol.NewSessionRequest, session protocol.AdapterSession) error {
	if strings.TrimSpace(request.Prompt) == "" {
		return nil
	}
	initialAck, lookupErr := a.journal.LookupCommand(session.SessionID + ":initial")
	if errors.Is(lookupErr, ErrCommandNotFound) {
		_, err := a.SendCommand(ctx, session, initialPromptCommand(session, request))
		return err
	}
	if lookupErr != nil {
		return lookupErr
	}
	switch initialAck.State {
	case protocol.CommandStateUnknown, protocol.CommandStateAccepted, protocol.CommandStateExecuting:
		return protocol.ErrUnknownCommandResult
	case protocol.CommandStateFailed, protocol.CommandStateRejected:
		return errors.New("initial prompt outcome is already failed")
	default:
		return nil
	}
}

func initialPromptCommand(session protocol.AdapterSession, request protocol.NewSessionRequest) protocol.Command {
	commandID := session.SessionID + ":initial"
	return protocol.Command{
		CommandID: commandID,
		IssuedAt:  now(),
		Kind:      protocol.CommandKindRunSend,
		Payload:   mustRawJSON(protocol.SubmitRunRequest{CommandID: commandID, Prompt: request.Prompt}),
		SessionID: session.SessionID,
	}
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
		_ = transport.Close()
		return protocol.AdapterSession{}, err
	}
	if response.Error != nil {
		_ = transport.Close()
		return protocol.AdapterSession{}, rpcResponseError("thread/resume", response)
	}
	if threadIDFromResult(response.Result) != externalThreadRef {
		_ = transport.Close()
		return protocol.AdapterSession{}, errors.New("thread/resume returned a different thread id")
	}
	return a.bindRecoveredSession(gatewaySession, externalThreadRef, "thread/resume", response.Raw, transport)
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
	return a.bindRecoveredSession(gatewaySession, externalThreadRef, "thread/resume", a.recoveredSessionResult(externalThreadRef), transport)
}

func (a *Adapter) recoveredSessionResult(externalThreadRef string) json.RawMessage {
	if provider, ok := a.provider.(interface {
		RecoveredSessionResult(string) (json.RawMessage, error)
	}); ok {
		if result, err := provider.RecoveredSessionResult(externalThreadRef); err == nil && len(result) > 0 {
			return result
		}
	}
	return mustRawJSON(map[string]any{"thread": map[string]string{"id": externalThreadRef}})
}

func (a *Adapter) bindRecoveredSession(gatewaySession protocol.GatewaySession, externalThreadRef, method string, result json.RawMessage, transport RPCTransport) (protocol.AdapterSession, error) {
	a.recoveryMu.Lock()
	defer a.recoveryMu.Unlock()
	return a.bindRecoveredSessionLocked(gatewaySession, externalThreadRef, method, result, transport)
}

func (a *Adapter) bindRecoveredSessionLocked(gatewaySession protocol.GatewaySession, externalThreadRef, method string, result json.RawMessage, transport RPCTransport) (protocol.AdapterSession, error) {
	session := protocol.AdapterSession{SessionID: stableSessionID(externalThreadRef), ExternalThreadRef: externalThreadRef}
	state := &adapterSessionState{session: session, gatewaySession: gatewaySession, transport: transport, activeTurns: a.journal.ActiveTurns(session.SessionID)}
	if binder, ok := a.provider.(interface {
		SetExternalThreadRef(protocol.GatewaySession, string) error
	}); ok {
		if err := binder.SetExternalThreadRef(gatewaySession, externalThreadRef); err != nil {
			_ = transport.Close()
			return protocol.AdapterSession{}, err
		}
	}
	a.mu.Lock()
	previous := a.sessions[session.SessionID]
	if previous != nil {
		delete(a.sessions, session.SessionID)
	}
	a.mu.Unlock()
	if previous != nil {
		_ = a.closeState(previous)
	}
	if err := a.journal.RecordSession(session.SessionID, externalThreadRef, gatewaySession.Generation); err != nil {
		_ = a.closeState(state)
		return protocol.AdapterSession{}, err
	}
	source := protocol.EventSourceHostObservation
	var envelope struct {
		JSONRPC string `json:"jsonrpc"`
	}
	if json.Unmarshal(result, &envelope) == nil && envelope.JSONRPC != "" {
		source = protocol.EventSourceAppServer
	}
	if _, err := a.appendObservedEventFromSource(state, protocol.EventTypeReconciliationCompleted, source, method, result, ""); err != nil {
		_ = a.closeState(state)
		return protocol.AdapterSession{}, err
	}
	a.mu.Lock()
	a.sessions[session.SessionID] = state
	a.mu.Unlock()
	go a.consume(state)
	return session, nil
}

func (a *Adapter) CloseSession(_ context.Context, session protocol.AdapterSession) error {
	a.recoveryMu.Lock()
	defer a.recoveryMu.Unlock()
	state := a.removeSession(session.SessionID)
	if state == nil {
		return nil
	}
	return a.closeState(state)
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
	state.operationMu.Lock()
	defer state.operationMu.Unlock()
	if !a.isCurrentState(state) || state.closed.Load() {
		return protocol.CommandAck{}, fmt.Errorf("adapter session %q generation is no longer active", session.SessionID)
	}
	if err := state.persistenceError(); err != nil {
		return protocol.CommandAck{}, fmt.Errorf("adapter event journal is unavailable: %w", err)
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
	state.operationMu.Lock()
	defer state.operationMu.Unlock()
	if !a.isCurrentState(state) || state.closed.Load() {
		return protocol.CommandAck{}, fmt.Errorf("adapter session %q generation is no longer active", session.SessionID)
	}
	if err := state.persistenceError(); err != nil {
		return protocol.CommandAck{}, fmt.Errorf("adapter event journal is unavailable: %w", err)
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
	response, callErr := state.transport.Call(withRPCCommandID(ctx, command.CommandID), "turn/steer", mustRawJSON(map[string]any{
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
	if command.SessionID != session.SessionID {
		return protocol.Reconciliation{}, fmt.Errorf("command %q belongs to adapter session %q, not %q", commandID, command.SessionID, session.SessionID)
	}
	if previous, ok := a.journal.Reconciliation(commandID); ok && previous.State != protocol.ReconciliationStateUnknown {
		return previous, nil
	}
	if ack.State == protocol.CommandStateSucceeded || ack.State == protocol.CommandStateFailed || ack.State == protocol.CommandStateRejected {
		reconciliationState := protocol.ReconciliationStateConfirmed
		if ack.State == protocol.CommandStateFailed || ack.State == protocol.CommandStateRejected {
			reconciliationState = protocol.ReconciliationStateNotFound
		}
		value := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: reconciliationState, EventCursor: ack.EventCursor}
		if err := a.journal.RecordReconciliation(value); err != nil {
			return value, err
		}
		return value, nil
	}
	if ack.State == protocol.CommandStateAccepted || ack.State == protocol.CommandStateExecuting {
		value := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: protocol.ReconciliationStateUnknown, Note: stringPointer("command remains in flight; external outcome has not been observed")}
		if err := a.journal.RecordReconciliation(value); err != nil {
			return value, err
		}
		return value, nil
	}
	state := a.sessionState(session.SessionID)
	if state == nil {
		return protocol.Reconciliation{}, fmt.Errorf("adapter session %q is not available", session.SessionID)
	}
	state.operationMu.Lock()
	defer state.operationMu.Unlock()
	if !a.isCurrentState(state) || state.closed.Load() {
		return protocol.Reconciliation{}, fmt.Errorf("adapter session %q generation is no longer active", session.SessionID)
	}
	latestCommand, latestAck, err := a.journal.Command(commandID)
	if err != nil {
		return protocol.Reconciliation{}, err
	}
	if latestCommand.SessionID != session.SessionID {
		return protocol.Reconciliation{}, fmt.Errorf("command %q belongs to adapter session %q, not %q", commandID, latestCommand.SessionID, session.SessionID)
	}
	command = latestCommand
	ack = latestAck
	if previous, ok := a.journal.Reconciliation(commandID); ok && previous.State != protocol.ReconciliationStateUnknown {
		return previous, nil
	}
	if ack.State == protocol.CommandStateSucceeded || ack.State == protocol.CommandStateFailed || ack.State == protocol.CommandStateRejected {
		reconciliationState := protocol.ReconciliationStateConfirmed
		if ack.State == protocol.CommandStateFailed || ack.State == protocol.CommandStateRejected {
			reconciliationState = protocol.ReconciliationStateNotFound
		}
		value := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: reconciliationState, EventCursor: ack.EventCursor}
		if err := a.journal.RecordReconciliation(value); err != nil {
			return value, err
		}
		return value, nil
	}
	if ack.State == protocol.CommandStateAccepted || ack.State == protocol.CommandStateExecuting {
		value := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: protocol.ReconciliationStateUnknown, Note: stringPointer("command remains in flight; external outcome has not been observed")}
		if err := a.journal.RecordReconciliation(value); err != nil {
			return value, err
		}
		return value, nil
	}
	if updated, bound, err := a.bindPersistedOperation(commandID, session.SessionID, ack); err != nil {
		return protocol.Reconciliation{}, err
	} else {
		ack = updated
		if bound && ack.State == protocol.CommandStateSucceeded {
			reconciliation := protocol.Reconciliation{
				CommandID:   commandID,
				ObservedAt:  now(),
				State:       protocol.ReconciliationStateConfirmed,
				EventCursor: ack.EventCursor,
				Note:        stringPointer("persisted app-server RPC response proves command delivery"),
			}
			if err := a.journal.RecordReconciliation(reconciliation); err != nil {
				return reconciliation, err
			}
			return reconciliation, nil
		}
	}
	if ack.State == protocol.CommandStateFailed {
		reconciliation := protocol.Reconciliation{
			CommandID:   commandID,
			ObservedAt:  now(),
			State:       protocol.ReconciliationStateNotFound,
			EventCursor: ack.EventCursor,
			Note:        stringPointer("persisted app-server RPC error proves the command did not complete"),
		}
		if err := a.journal.RecordReconciliation(reconciliation); err != nil {
			return reconciliation, err
		}
		return reconciliation, nil
	}
	if command.Kind == protocol.CommandKindRunApprove || command.Kind == protocol.CommandKindRunDeny {
		observedDecision, ok := a.journal.ApprovalResult(commandID)
		reconciliation := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: protocol.ReconciliationStateUnknown}
		expectedDecision := "decline"
		if command.Kind == protocol.CommandKindRunApprove {
			expectedDecision = "accept"
		}
		if !ok {
			reconciliation.Note = stringPointer("approval resolution has not been observed")
		} else if observedDecision == approvalResolutionCleared {
			reconciliation.Note = stringPointer("approval response was cleared; item outcome remains pending")
		} else if observedDecision == expectedDecision {
			reconciliation.State = protocol.ReconciliationStateConfirmed
			ack.State = protocol.CommandStateSucceeded
			ack.Error = nil
			if err := a.journal.UpdateCommand(commandID, ack); err != nil {
				return reconciliation, err
			}
		} else if observedDecision != "unknown" {
			reconciliation.State = protocol.ReconciliationStateNotFound
			reconciliation.Note = stringPointer(fmt.Sprintf("approval resolved as %q", observedDecision))
			ack.State = protocol.CommandStateFailed
			ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeConflict, Message: valueOrEmpty(reconciliation.Note), RequestID: commandID}
			if err := a.journal.UpdateCommand(commandID, ack); err != nil {
				return reconciliation, err
			}
		}
		if err := a.journal.RecordReconciliation(reconciliation); err != nil {
			return reconciliation, err
		}
		return reconciliation, nil
	}
	turns, err := a.listTurns(ctx, state)
	if err != nil {
		value := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: protocol.ReconciliationStateUnknown, Note: stringPointer("turn history could not be read; command remains unknown")}
		if recordErr := a.journal.RecordReconciliation(value); recordErr != nil {
			return value, recordErr
		}
		return value, nil
	}
	runObserved := ack.RunID != nil
	matched, ambiguous := matchCommandTurn(command, ack, turns)
	reconciliation := protocol.Reconciliation{CommandID: commandID, ObservedAt: now(), State: protocol.ReconciliationStateUnknown}
	if matched != nil && !ambiguous {
		outcome, established := commandOutcomeFromTurn(command, *matched)
		if !established {
			reconciliation.Note = stringPointer("turn history does not prove this command outcome; command remains unknown and is not replayed")
		} else {
			reconciliation.State = protocol.ReconciliationStateConfirmed
			if matched.ID != "" {
				cursor := a.journalLastCursor(session.SessionID, matched.ID)
				if cursor != "" {
					reconciliation.EventCursor = &cursor
				}
				turnID := matched.ID
				ack.RunID = &turnID
				ack.State = outcome
				ack.Error = nil
				if outcome == protocol.CommandStateFailed {
					ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeConflict, Message: "app-server turn ended unsuccessfully", RequestID: commandID}
				}
				if err := a.journal.UpdateCommand(commandID, ack); err != nil {
					return reconciliation, fmt.Errorf("persist reconciled command %q: %w", commandID, err)
				}
			}
		}
	} else if matched == nil && !ambiguous {
		if runObserved {
			reconciliation.Note = stringPointer("a run was observed but its durable turn outcome is unavailable; command remains unknown and is not replayed")
		} else {
			reconciliation.Note = stringPointer("turn history does not prove that this command was not executed; command remains unknown and is not replayed")
		}
	} else {
		reconciliation.Note = stringPointer("turn history does not prove this command outcome; command remains unknown and is not replayed")
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
		response, callErr := state.transport.Call(withRPCCommandID(ctx, command.CommandID), "turn/steer", mustRawJSON(map[string]any{
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
	response, callErr := state.transport.Call(withRPCCommandID(ctx, command.CommandID), "turn/start", mustRawJSON(params))
	turnID := turnIDFromResult(response.Result)
	return a.finishRPCCommand(ctx, state, command, ack, response, callErr, turnID, "turn/start")
}

func (a *Adapter) resolveApproval(ctx context.Context, state *adapterSessionState, command protocol.Command, ack protocol.CommandAck) (protocol.CommandAck, error) {
	payload, err := decodeCommandPayload(command.Payload)
	if err != nil {
		return a.rejectCommand(command, ack, err)
	}
	requestID := firstRaw(payload, "approval_id", "request_id", "server_request_id", "rpc_id")
	runID := valueOrEmpty(command.RunID)
	if runID == "" {
		runID = firstString(payload, "run_id", "turn_id")
	}
	if len(requestID) == 0 {
		pending := a.journal.PendingApprovalsForGeneration(state.session.SessionID, state.gatewaySession.Generation, runID)
		if len(pending) != 1 {
			return a.rejectCommand(command, ack, errors.New("approval command does not identify exactly one pending approval"))
		}
		requestID = pending[0].RequestID
	}
	canonicalApproval, err := a.journal.FindPendingApprovalForGeneration(state.session.SessionID, state.gatewaySession.Generation, runID, requestID)
	if err != nil {
		return a.rejectCommand(command, ack, err)
	}
	requestID = canonicalApproval.RequestID
	decision := "deny"
	if command.Kind == protocol.CommandKindRunApprove {
		decision = "approve"
	}
	if requested := firstString(payload, "decision"); requested != "" && requested != decision {
		return a.rejectCommand(command, ack, errors.New("approval decision conflicts with command kind"))
	}
	if payloadCommandID := firstString(payload, "command_id"); payloadCommandID != "" && payloadCommandID != command.CommandID {
		return a.rejectCommand(command, ack, errors.New("approval command id conflicts with envelope command id"))
	}
	revision, ok := firstInt64(payload, "revision")
	if !ok || revision <= 0 {
		return a.rejectCommand(command, ack, errors.New("approval revision must be a positive integer"))
	}
	pending, alreadyClaimed, err := a.journal.ClaimApproval(state.session.SessionID, requestID, revision, command.CommandID, decision)
	if err != nil {
		return a.rejectCommand(command, ack, err)
	}
	if alreadyClaimed {
		return a.finishTransportError(command, ack, ErrUnknownOutcome, "approval response")
	}
	if runID != "" && pending.RunID == "" {
		if err := a.journal.ReleaseApprovalClaim(state.session.SessionID, requestID, command.CommandID); err != nil {
			return ack, fmt.Errorf("release approval claim: %w", err)
		}
		return a.rejectCommand(command, ack, errors.New("approval request has no durable run identity"))
	}
	if runID != "" && pending.RunID != runID {
		if err := a.journal.ReleaseApprovalClaim(state.session.SessionID, requestID, command.CommandID); err != nil {
			return ack, fmt.Errorf("release approval claim: %w", err)
		}
		return a.rejectCommand(command, ack, errors.New("approval run does not match the pending request"))
	}
	if runID == "" {
		runID = pending.TurnID
	}
	// Codex app-server uses accept/decline while the public contract uses
	// approve/deny. Keep that translation at the host boundary.
	hostDecision := "decline"
	if decision == "approve" {
		hostDecision = "accept"
	}
	result := mustRawJSON(map[string]string{"decision": hostDecision})
	if err := state.transport.Respond(ctx, requestID, result); err != nil {
		if !errors.Is(err, ErrUnknownOutcome) {
			if releaseErr := a.journal.ReleaseApprovalClaim(state.session.SessionID, requestID, command.CommandID); releaseErr != nil {
				return ack, fmt.Errorf("release approval claim after response failure: %w", releaseErr)
			}
		}
		return a.finishTransportError(command, ack, err, "approval response")
	}
	resolutionCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	observedDecision, err := waitForApprovalResolution(resolutionCtx, a.journal, state.session.SessionID, requestID, command.CommandID)
	if err != nil {
		unknownErr := fmt.Errorf("%w: approval resolution was not observed: %v", ErrUnknownOutcome, err)
		return a.finishTransportError(command, ack, unknownErr, "approval response")
	}
	if observedDecision == "unknown" || observedDecision == approvalResolutionCleared {
		// A live serverRequest/resolved event without a resolution confirms that
		// app-server accepted the response, while item execution remains a
		// separate observation used by cold reconciliation.
		if observedDecision == approvalResolutionCleared {
			ack.State = protocol.CommandStateSucceeded
			ack.Error = nil
			ack.Result = append(json.RawMessage(nil), result...)
			if runID != "" {
				ack.RunID = &runID
			}
			if err := a.journal.UpdateCommand(command.CommandID, ack); err != nil {
				return ack, err
			}
			return ack, nil
		}
		unknownErr := fmt.Errorf("%w: app-server approval resolution is unknown", ErrUnknownOutcome)
		return a.finishTransportError(command, ack, unknownErr, "approval response")
	}
	if observedDecision != hostDecision {
		ack.State = protocol.CommandStateFailed
		ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeConflict, Message: fmt.Sprintf("approval resolved as %q, requested %q", observedDecision, hostDecision), RequestID: command.CommandID}
		if updateErr := a.journal.UpdateCommand(command.CommandID, ack); updateErr != nil {
			return ack, updateErr
		}
		return ack, fmt.Errorf("approval resolved as %q, requested %q", observedDecision, hostDecision)
	}
	ack.State = protocol.CommandStateSucceeded
	ack.Error = nil
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
	response, callErr := state.transport.Call(withRPCCommandID(ctx, command.CommandID), "turn/interrupt", mustRawJSON(map[string]string{
		"threadId": state.session.ExternalThreadRef,
		"turnId":   turnID,
	}))
	return a.finishRPCCommand(ctx, state, command, ack, response, callErr, turnID, "turn/interrupt")
}

func (a *Adapter) finishRPCCommand(ctx context.Context, state *adapterSessionState, command protocol.Command, ack protocol.CommandAck, response RPCMessage, callErr error, runID, operation string) (protocol.CommandAck, error) {
	if response.commandID == "" {
		response.commandID = command.CommandID
	}
	if runID != "" {
		ack.RunID = &runID
	}
	if operation != "" {
		operationID := operation
		if responseID := bytes.TrimSpace(response.ID); len(responseID) > 0 && !bytes.Equal(responseID, []byte("null")) {
			operationID = rpcOperationIdentity(state.gatewaySession.Generation, responseID)
		}
		ack.OperationID = &operationID
	}
	if callErr != nil {
		return a.finishTransportError(command, ack, callErr, operation)
	}
	if response.observation != nil {
		cursor, err := waitForRPCObservation(response.observation)
		if err != nil {
			if errors.Is(err, ErrUnknownOutcome) {
				state.eventMu.Lock()
				event, persistErr := a.appendRPCResponseEvent(state, operation, response, runID)
				state.eventMu.Unlock()
				if persistErr == nil && event.Cursor != "" {
					ack.EventCursor = &event.Cursor
				}
			}
			unknownErr := fmt.Errorf("%w: persist %s response observation: %v", ErrUnknownOutcome, operation, err)
			return a.finishTransportError(command, ack, unknownErr, operation)
		}
		if cursor != "" {
			ack.EventCursor = &cursor
		}
	} else if event, err := a.appendRPCResponseEvent(state, operation, response, runID); err != nil {
		return ack, fmt.Errorf("persist %s response observation: %w", operation, err)
	} else if event.Cursor != "" {
		ack.EventCursor = &event.Cursor
	}
	if response.Error != nil {
		ack.State = protocol.CommandStateFailed
		ack.Error = rpcAPIError(response.Error, command.CommandID)
		if err := a.journal.UpdateCommand(command.CommandID, ack); err != nil {
			return ack, fmt.Errorf("persist %s failure: %w", operation, err)
		}
		return ack, rpcResponseError(operation, response)
	}
	if len(bytes.TrimSpace(response.Result)) == 0 {
		unknownErr := fmt.Errorf("%w: app-server %s returned an incomplete response", ErrUnknownOutcome, operation)
		return a.finishTransportError(command, ack, unknownErr, operation)
	}
	if operation == "turn/start" && turnIDFromResult(response.Result) == "" {
		unknownErr := fmt.Errorf("%w: app-server turn/start returned no turn identity", ErrUnknownOutcome)
		return a.finishTransportError(command, ack, unknownErr, operation)
	}
	ack.State = protocol.CommandStateSucceeded
	ack.Result = append(json.RawMessage(nil), response.Result...)
	if runID == "" {
		runID = turnIDFromResult(response.Result)
	}
	if runID != "" {
		ack.RunID = &runID
	}
	if err := a.journal.UpdateCommand(command.CommandID, ack); err != nil {
		return ack, err
	}
	return ack, nil
}

func (a *Adapter) appendRPCResponseEvent(state *adapterSessionState, operation string, response RPCMessage, runID string) (protocol.Event, error) {
	if state == nil || len(response.Raw) == 0 {
		return protocol.Event{}, nil
	}
	observed, err := a.appendObservedEvent(state, protocol.EventTypeUnknown, operation, response.Raw, runID)
	if err != nil || len(response.ID) == 0 || operation == "" {
		return observed, err
	}
	return a.appendRPCResponseCorrelation(state, operation, response, runID, observed)
}

func (a *Adapter) appendRPCResponseCorrelation(state *adapterSessionState, operation string, response RPCMessage, runID string, observed protocol.Event) (protocol.Event, error) {
	operationID := rpcOperationIdentity(state.gatewaySession.Generation, response.ID)
	value := map[string]any{
		"generation":   state.gatewaySession.Generation,
		"method":       operation,
		"operation_id": operationID,
	}
	if response.Error != nil {
		value["error"] = response.Error
	}
	payload := mustRawJSON(value)
	if response.commandID != "" {
		var object map[string]json.RawMessage
		if json.Unmarshal(payload, &object) == nil {
			object["command_id"] = mustRawJSON(response.commandID)
			payload = mustRawJSON(object)
		}
	}
	correlation, err := a.appendObservedEventFromSource(state, protocol.EventTypeUnknown, protocol.EventSourceHostObservation, "rpc/response", payload, runID)
	if err != nil {
		return observed, err
	}
	return correlation, nil
}

func waitForRPCObservation(observation <-chan rpcObservation) (string, error) {
	if observation == nil {
		return "", nil
	}
	value := <-observation
	return value.eventCursor, value.err
}

func (a *Adapter) finishTransportError(command protocol.Command, ack protocol.CommandAck, err error, operation string) (protocol.CommandAck, error) {
	if isUnknownTransportError(err) {
		ack.State = protocol.CommandStateUnknown
		ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeUnknownResult, Message: "command outcome is unknown", RequestID: command.CommandID}
		if persistErr := a.journal.UpdateCommand(command.CommandID, ack); persistErr != nil {
			return ack, fmt.Errorf("persist unknown %s result: %w", operation, persistErr)
		}
		return ack, protocol.ErrUnknownCommandResult
	}
	ack.State = protocol.CommandStateFailed
	ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeConflict, Message: "app-server operation failed", RequestID: command.CommandID}
	if persistErr := a.journal.UpdateCommand(command.CommandID, ack); persistErr != nil {
		return ack, fmt.Errorf("persist failed %s result: %w", operation, persistErr)
	}
	return ack, fmt.Errorf("%s: %w", operation, err)
}

func isUnknownTransportError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrUnknownOutcome) {
		return true
	}
	var writeErr *TransportWriteError
	return errors.As(err, &writeErr) && writeErr.Unknown
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
		if err := a.observe(state, message); err != nil {
			state.setPersistenceError(err)
			state.closed.Store(true)
			_ = state.transport.Close()
			return
		}
	}
	if state.closed.Load() || !a.isCurrentState(state) {
		return
	}
	state.eventMu.Lock()
	defer state.eventMu.Unlock()
	if state.closed.Load() || !a.isCurrentState(state) {
		return
	}
	state.closed.Store(true)
	if _, err := a.appendObservedEventFromSource(state, protocol.EventTypeReconciliationRequired, protocol.EventSourceHostObservation, "transport/closed", mustRawJSON(map[string]string{"generation": state.gatewaySession.Generation}), ""); err != nil {
		state.setPersistenceError(err)
	}
}

func (a *Adapter) observe(state *adapterSessionState, message RPCMessage) error {
	if message.IsResponse() {
		if !journaledResponseOperation(message.operation) {
			notifyRPCObservation(message.observation, rpcObservation{})
			return nil
		}
		state.eventMu.Lock()
		defer state.eventMu.Unlock()
		if state.closed.Load() || !a.isCurrentState(state) {
			notifyRPCObservation(message.observation, rpcObservation{err: ErrUnknownOutcome})
			return nil
		}
		runID := message.runID
		if runID == "" {
			runID = turnIDFromResult(message.Result)
		}
		event, err := a.appendRPCResponseEvent(state, message.operation, message, runID)
		if err != nil {
			notifyRPCObservation(message.observation, rpcObservation{err: err})
			return err
		}
		notifyRPCObservation(message.observation, rpcObservation{eventCursor: event.Cursor})
		return nil
	}
	state.eventMu.Lock()
	defer state.eventMu.Unlock()
	if state.closed.Load() || !a.isCurrentState(state) {
		return nil
	}
	eventType := eventTypeForMethod(message.Method, message)
	runID := runIDFromMessage(message)
	if eventType == protocol.EventTypeApprovalResolved && runID == "" {
		runID = a.approvalRunID(state, message)
	}
	state.mu.Lock()
	if message.Method == "turn/started" && runID != "" {
		state.activeTurns[runID] = runID
	}
	if eventType == protocol.EventTypeRunCompleted || eventType == protocol.EventTypeRunFailed || eventType == protocol.EventTypeRunInterrupted {
		delete(state.activeTurns, runID)
	}
	state.mu.Unlock()
	if state.closed.Load() || !a.isCurrentState(state) {
		return nil
	}
	_, err := a.appendObservedEvent(state, eventType, message.Method, message.Raw, runID)
	return err
}

func journaledResponseOperation(operation string) bool {
	switch operation {
	case "turn/start", "turn/steer", "turn/interrupt":
		return true
	default:
		return false
	}
}

func notifyRPCObservation(observation chan rpcObservation, value rpcObservation) {
	if observation == nil {
		return
	}
	select {
	case observation <- value:
	default:
	}
}

func (a *Adapter) appendObservedEvent(state *adapterSessionState, eventType protocol.EventType, method string, payload json.RawMessage, runID string) (protocol.Event, error) {
	return a.appendObservedEventFromSource(state, eventType, protocol.EventSourceAppServer, method, payload, runID)
}

func (a *Adapter) appendObservedEventFromSource(state *adapterSessionState, eventType protocol.EventType, source protocol.EventSource, method string, payload json.RawMessage, runID string) (protocol.Event, error) {
	if len(payload) == 0 {
		payload = mustRawJSON(map[string]any{"method": method})
	}
	if !json.Valid(payload) {
		payload = mustRawJSON(map[string]any{"method": method, "raw": string(payload)})
	}
	if source == protocol.EventSourceHostObservation && method != "" {
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
		Source:    source,
		Payload:   append(json.RawMessage(nil), payload...),
	}
	if runID != "" {
		event.RunID = &runID
	}
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

func (a *Adapter) removeSession(sessionID string) *adapterSessionState {
	a.mu.Lock()
	state := a.sessions[sessionID]
	if state != nil {
		delete(a.sessions, sessionID)
	}
	a.mu.Unlock()
	return state
}

func (a *Adapter) closeState(state *adapterSessionState) error {
	if state == nil {
		return nil
	}
	state.closed.Store(true)
	closeErr := state.transport.Close()
	state.eventMu.Lock()
	state.eventMu.Unlock()
	state.operationMu.Lock()
	state.operationMu.Unlock()
	return closeErr
}

func (a *Adapter) isCurrentState(state *adapterSessionState) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[state.session.SessionID] == state
}

func (s *adapterSessionState) setPersistenceError(err error) {
	if err == nil {
		return
	}
	s.eventErrMu.Lock()
	if s.eventErr == nil {
		s.eventErr = err
	}
	s.eventErrMu.Unlock()
}

func (s *adapterSessionState) persistenceError() error {
	s.eventErrMu.Lock()
	defer s.eventErrMu.Unlock()
	return s.eventErr
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

func firstInt64(payload map[string]json.RawMessage, names ...string) (int64, bool) {
	for _, name := range names {
		value, ok := payload[name]
		if !ok {
			continue
		}
		var result int64
		if json.Unmarshal(value, &result) == nil {
			return result, true
		}
	}
	return 0, false
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

func waitForApprovalResolution(ctx context.Context, journal *Journal, sessionID string, requestID json.RawMessage, commandID string) (string, error) {
	if result, ok := journal.ApprovalResult(commandID); ok {
		return result, nil
	}
	if !journal.IsApprovalPending(sessionID, requestID) {
		if result, ok := journal.ApprovalResult(commandID); ok {
			return result, nil
		}
		return "", errors.New("approval result is not durable")
	}
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-ticker.C:
			if result, ok := journal.ApprovalResult(commandID); ok {
				return result, nil
			}
			if !journal.IsApprovalPending(sessionID, requestID) {
				if result, ok := journal.ApprovalResult(commandID); ok {
					return result, nil
				}
				return "", errors.New("approval result is not durable")
			}
		}
	}
}

type appServerTurn struct {
	ID             string          `json:"id"`
	Status         string          `json:"status"`
	CreatedAt      string          `json:"createdAt"`
	CreatedAtSnake string          `json:"created_at"`
	Input          json.RawMessage `json:"input"`
	Items          json.RawMessage `json:"items"`
}

type appServerTurnsPage struct {
	Data            *[]appServerTurn `json:"data"`
	Turns           *[]appServerTurn `json:"turns"`
	NextCursor      *string          `json:"nextCursor"`
	NextCursorSnake *string          `json:"next_cursor"`
}

func (a *Adapter) listTurns(ctx context.Context, state *adapterSessionState) ([]appServerTurn, error) {
	var turns []appServerTurn
	cursor := ""
	for pageNumber := 0; pageNumber < 100; pageNumber++ {
		params := map[string]any{
			"threadId":  state.session.ExternalThreadRef,
			"limit":     100,
			"itemsView": "summary",
		}
		if cursor != "" {
			params["cursor"] = cursor
		}
		result, err := state.transport.Call(ctx, "thread/turns/list", mustRawJSON(params))
		if err != nil {
			return nil, err
		}
		if result.Error != nil {
			return nil, errors.New(result.Error.Message)
		}
		page, ok := parseTurnsPage(result.Result)
		if !ok {
			return nil, errors.New("thread/turns/list returned an invalid page")
		}
		if page.Data != nil {
			turns = append(turns, (*page.Data)...)
		} else if page.Turns != nil {
			turns = append(turns, (*page.Turns)...)
		}
		nextCursor := valueOrEmpty(page.NextCursor)
		if nextCursor == "" {
			nextCursor = valueOrEmpty(page.NextCursorSnake)
		}
		if nextCursor == "" {
			return turns, nil
		}
		if nextCursor == cursor {
			return nil, errors.New("thread/turns/list returned a repeated pagination cursor")
		}
		cursor = nextCursor
	}
	return nil, errors.New("thread/turns/list pagination exceeded the safety limit")
}

func parseTurnsPage(result json.RawMessage) (appServerTurnsPage, bool) {
	var value appServerTurnsPage
	if json.Unmarshal(result, &value) != nil || (value.Data == nil && value.Turns == nil) {
		return appServerTurnsPage{}, false
	}
	return value, true
}

func matchCommandTurn(command protocol.Command, ack protocol.CommandAck, turns []appServerTurn) (*appServerTurn, bool) {
	requestedID := valueOrEmpty(ack.RunID)
	if requestedID == "" {
		requestedID = commandTargetTurnID(command)
	}
	if requestedID != "" {
		for index := range turns {
			if turns[index].ID == requestedID {
				if command.Kind == protocol.CommandKindRunSend && turnProvidesCommandEvidence(turns[index]) && !commandMatchesTurn(command, turns[index]) {
					return nil, false
				}
				return &turns[index], false
			}
		}
		return nil, false
	}
	return nil, false
}

func commandTargetTurnID(command protocol.Command) string {
	switch command.Kind {
	case protocol.CommandKindRunInterrupt:
		payload, err := decodeCommandPayload(command.Payload)
		if err == nil {
			if turnID := firstString(payload, "turn_id", "expected_turn_id"); turnID != "" {
				return turnID
			}
		}
		return valueOrEmpty(command.RunID)
	case protocol.CommandKindRunSend:
		payload, err := decodeCommandPayload(command.Payload)
		if err != nil || (!firstBool(payload, "steer", "turn_steer") && firstString(payload, "expected_turn_id", "turn_id") == "") {
			return ""
		}
		if turnID := firstString(payload, "expected_turn_id", "turn_id"); turnID != "" {
			return turnID
		}
		return valueOrEmpty(command.RunID)
	default:
		return ""
	}
}

func (a *Adapter) bindPersistedOperation(commandID, sessionID string, ack protocol.CommandAck) (protocol.CommandAck, bool, error) {
	operationID := valueOrEmpty(ack.OperationID)
	rawOperationID := rpcOperationRawID(operationID)
	var exactMatched *protocol.Event
	exactMatches := 0
	var rawMatched *protocol.Event
	rawMatches := 0
	qualifiedRawMatches := 0
	var commandMatched *protocol.Event
	commandMatches := 0
	commandOperationID := ""
	afterCursor := ""
	for {
		page, err := a.journal.ReadEvents(protocol.EventQuery{SessionID: sessionID, AfterCursor: afterCursor, Limit: 1000})
		if err != nil {
			return ack, false, fmt.Errorf("read persisted operation %q for command %q: %w", operationID, commandID, err)
		}
		for index := range page.Events {
			event := &page.Events[index]
			if event.Type != protocol.EventTypeUnknown {
				continue
			}
			if event.Source == protocol.EventSourceHostObservation {
				persistedOperationID := rpcEnvelopeOperationID(event.Payload)
				persistedCommandID := rpcEnvelopeCommandID(event.Payload)
				if persistedOperationID != "" && rpcOperationRawID(persistedOperationID) == rawOperationID {
					qualifiedRawMatches++
				}
				if persistedCommandID != "" && persistedCommandID != commandID {
					continue
				}
				if persistedCommandID == commandID && persistedOperationID != "" {
					commandMatches++
					commandMatched = event
					commandOperationID = persistedOperationID
				}
				if persistedOperationID == operationID {
					exactMatches++
					exactMatched = event
				}
				continue
			}
			if rpcEnvelopeID(event.Payload) == rawOperationID {
				rawMatches++
				rawMatched = event
			}
		}
		if !page.HasMore || page.NextCursor == nil || *page.NextCursor == "" {
			break
		}
		afterCursor = *page.NextCursor
	}
	if operationID == "" {
		if commandMatches != 1 {
			return ack, false, nil
		}
		operationID = commandOperationID
		rawOperationID = rpcOperationRawID(operationID)
		exactMatched = commandMatched
		exactMatches = 1
		ack.OperationID = &operationID
	}
	var matched *protocol.Event
	switch {
	case exactMatches == 1:
		matched = exactMatched
	case exactMatches > 1:
		return ack, false, nil
	case strings.IndexByte(operationID, 0) < 0 && rawMatches == 1 && qualifiedRawMatches == 0:
		matched = rawMatched
	default:
		return ack, false, nil
	}
	if matched == nil {
		return ack, false, nil
	}
	ack.EventCursor = &matched.Cursor
	if matched.RunID != nil && strings.TrimSpace(*matched.RunID) != "" {
		runID := *matched.RunID
		ack.RunID = &runID
	}
	if rpcEnvelopeError(matched.Payload) {
		ack.State = protocol.CommandStateFailed
		ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeConflict, Message: "app-server operation failed", RequestID: commandID}
		ack.Result = nil
	} else {
		ack.State = protocol.CommandStateSucceeded
		ack.Error = nil
	}
	if err := a.journal.UpdateCommand(commandID, ack); err != nil {
		return ack, false, fmt.Errorf("persist operation observation for command %q: %w", commandID, err)
	}
	return ack, true, nil
}

func rpcEnvelopeID(payload json.RawMessage) string {
	var envelope struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return ""
	}
	return strings.TrimSpace(string(envelope.ID))
}

func rpcEnvelopeOperationID(payload json.RawMessage) string {
	var envelope struct {
		OperationID string `json:"operation_id"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return ""
	}
	return strings.TrimSpace(envelope.OperationID)
}

func rpcEnvelopeCommandID(payload json.RawMessage) string {
	var envelope struct {
		CommandID string `json:"command_id"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return ""
	}
	return strings.TrimSpace(envelope.CommandID)
}

func rpcEnvelopeError(payload json.RawMessage) bool {
	var envelope struct {
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return false
	}
	value := bytes.TrimSpace(envelope.Error)
	return len(value) > 0 && !bytes.Equal(value, []byte("null"))
}

func rpcOperationIdentity(generation string, id json.RawMessage) string {
	rawID := strings.TrimSpace(string(id))
	generation = strings.TrimSpace(generation)
	if generation == "" {
		return rawID
	}
	return generation + "\x00" + rawID
}

func rpcOperationRawID(operationID string) string {
	if separator := strings.IndexByte(operationID, 0); separator >= 0 {
		return operationID[separator+1:]
	}
	return operationID
}

func turnProvidesCommandEvidence(turn appServerTurn) bool {
	input := bytes.TrimSpace(turn.Input)
	if len(input) > 0 && !bytes.Equal(input, []byte("[]")) && !bytes.Equal(input, []byte("null")) {
		return true
	}
	var items []struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(turn.Items, &items) != nil {
		return false
	}
	for _, item := range items {
		if item.Type == "userMessage" {
			return true
		}
	}
	return false
}

func commandCanConfirmFromTurn(command protocol.Command, turn appServerTurn) bool {
	outcome, established := commandOutcomeFromTurn(command, turn)
	return established && outcome == protocol.CommandStateSucceeded
}

func commandOutcomeFromTurn(command protocol.Command, turn appServerTurn) (protocol.CommandState, bool) {
	switch command.Kind {
	case protocol.CommandKindRunInterrupt:
		if strings.EqualFold(turn.Status, "interrupted") {
			return protocol.CommandStateSucceeded, true
		}
		if strings.EqualFold(turn.Status, "failed") || strings.EqualFold(turn.Status, "error") {
			return protocol.CommandStateFailed, true
		}
		return "", false
	case protocol.CommandKindRunSend:
		payload, err := decodeCommandPayload(command.Payload)
		if err == nil && (firstBool(payload, "steer", "turn_steer") || firstString(payload, "expected_turn_id", "turn_id") != "") {
			return "", false
		}
		if turn.ID == "" {
			return "", false
		}
		return protocol.CommandStateSucceeded, true
	default:
		return "", false
	}
}

func commandMatchesTurn(command protocol.Command, turn appServerTurn) bool {
	payload, err := decodeCommandPayload(command.Payload)
	if err != nil {
		return false
	}
	if prompt := firstString(payload, "prompt", "text"); prompt != "" {
		return turnContainsPrompt(turn, prompt)
	}
	input := payload["input"]
	if len(bytes.TrimSpace(input)) == 0 {
		return false
	}
	wanted, err := canonicalJSON(input)
	if err != nil {
		return false
	}
	for _, candidate := range []json.RawMessage{turn.Input} {
		if len(bytes.TrimSpace(candidate)) == 0 {
			continue
		}
		actual, actualErr := canonicalJSON(candidate)
		if actualErr == nil && bytes.Equal(actual, wanted) {
			return true
		}
	}
	return false
}

func turnContainsPrompt(turn appServerTurn, prompt string) bool {
	wanted := strings.TrimSpace(prompt)
	if wanted == "" {
		return false
	}
	for _, value := range []json.RawMessage{turn.Input, turn.Items} {
		if len(value) == 0 {
			continue
		}
		var list []struct {
			Text    string `json:"text"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal(value, &list) == nil {
			for _, item := range list {
				if strings.TrimSpace(item.Text) == wanted {
					return true
				}
				for _, content := range item.Content {
					if strings.TrimSpace(content.Text) == wanted {
						return true
					}
				}
			}
		}
		var object struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(value, &object) == nil && strings.TrimSpace(object.Text) == wanted {
			return true
		}
	}
	return false
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

func (a *Adapter) approvalRunID(state *adapterSessionState, message RPCMessage) string {
	if state == nil {
		return ""
	}
	var params struct {
		RequestID json.RawMessage `json:"requestId"`
	}
	if json.Unmarshal(message.Params, &params) != nil || len(bytes.TrimSpace(params.RequestID)) == 0 {
		return ""
	}
	pending, err := a.journal.FindPendingApprovalForGeneration(state.session.SessionID, state.gatewaySession.Generation, "", params.RequestID)
	if err != nil {
		return ""
	}
	if pending.RunID != "" {
		return pending.RunID
	}
	return pending.TurnID
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
	case "item/fileChange/requestApproval":
		return protocol.EventTypeApprovalRequested
	case "serverRequest/resolved":
		return protocol.EventTypeApprovalResolved
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
		case "completed":
			return protocol.EventTypeRunCompleted
		default:
			return protocol.EventTypeUnknown
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
	return fmt.Errorf("app-server %s failed with code %d", operation, response.Error.Code)
}

func rpcAPIError(value *RPCError, requestID string) *protocol.ApiError {
	if value == nil {
		return nil
	}
	code := protocol.ErrorCodeConflict
	if value.Code == -32600 || value.Code == -32602 {
		code = protocol.ErrorCodeInvalidRequest
	}
	message := "app-server request failed"
	if code == protocol.ErrorCodeInvalidRequest {
		message = "app-server rejected the request"
	}
	return &protocol.ApiError{Code: code, Message: message, RequestID: requestID}
}

func stableSessionID(externalThreadRef string) string {
	digest := digestString(externalThreadRef)
	return "session-" + digest[:24]
}

func stringPointer(value string) *string { return &value }

var _ protocol.CodexAdapter = (*Adapter)(nil)
