package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

type TransportFactory func(context.Context) (RPCTransport, error)

type ClientInfo struct {
	Name    string
	Title   string
	Version string
}

type GatewayConfig struct {
	TransportFactory TransportFactory
	Process          ProcessTransportConfig
	ClientInfo       ClientInfo
}

type gatewaySession struct {
	session        protocol.GatewaySession
	transport      RPCTransport
	resumeResponse json.RawMessage
}

type gatewayStartRecord struct {
	session       protocol.GatewaySession
	requestDigest string
}

type gatewayStartCall struct {
	done          chan struct{}
	waiterEntered chan struct{}
	waiterOnce    sync.Once
	requestDigest string
	session       protocol.GatewaySession
	err           error
}

// Gateway owns independent app-server processes and never discovers or
// controls the private stdio child owned by ChatGPT Desktop.
type Gateway struct {
	mu            sync.Mutex
	reconcileMu   sync.Mutex
	factory       TransportFactory
	client        ClientInfo
	sessions      map[string]gatewaySession
	startMu       sync.Mutex
	startCalls    map[string]*gatewayStartCall
	startSessions map[string]gatewayStartRecord
}

func NewGateway(config GatewayConfig) (*Gateway, error) {
	client := config.ClientInfo
	if client.Name == "" {
		client.Name = "loomhelm_connector"
	}
	if client.Title == "" {
		client.Title = "Loomhelm Connector"
	}
	if client.Version == "" {
		client.Version = "dev"
	}
	factory := config.TransportFactory
	if factory == nil {
		processConfig := config.Process
		factory = func(ctx context.Context) (RPCTransport, error) {
			// The request context bounds initialize/thread-resume calls; it must
			// not own the lifetime of the host-owned session process.
			return NewProcessTransport(context.WithoutCancel(ctx), processConfig)
		}
	}
	return &Gateway{
		factory:       factory,
		client:        client,
		sessions:      make(map[string]gatewaySession),
		startCalls:    make(map[string]*gatewayStartCall),
		startSessions: make(map[string]gatewayStartRecord),
	}, nil
}

func (g *Gateway) StartNewSession(ctx context.Context, request protocol.NewSessionRequest) (protocol.GatewaySession, error) {
	if ctx == nil {
		return protocol.GatewaySession{}, errors.New("gateway context must not be nil")
	}
	if err := validateSessionCreationCommandID(request.CommandID); err != nil {
		return protocol.GatewaySession{}, err
	}
	requestDigest, err := sessionStartPayloadDigest(request)
	if err != nil {
		return protocol.GatewaySession{}, fmt.Errorf("digest session start request: %w", err)
	}
	g.startMu.Lock()
	if record, ok := g.startSessions[request.CommandID]; ok {
		if record.requestDigest != requestDigest {
			g.startMu.Unlock()
			return protocol.GatewaySession{}, protocol.ErrIdempotencyConflict
		}
		g.startMu.Unlock()
		return record.session, nil
	}
	if call, ok := g.startCalls[request.CommandID]; ok {
		if call.requestDigest != requestDigest {
			g.startMu.Unlock()
			return protocol.GatewaySession{}, protocol.ErrIdempotencyConflict
		}
		call.waiterOnce.Do(func() { close(call.waiterEntered) })
		g.startMu.Unlock()
		select {
		case <-call.done:
			return call.session, call.err
		case <-ctx.Done():
			return protocol.GatewaySession{}, ctx.Err()
		}
	}
	call := &gatewayStartCall{done: make(chan struct{}), waiterEntered: make(chan struct{}), requestDigest: requestDigest}
	g.startCalls[request.CommandID] = call
	g.startMu.Unlock()

	transport, err := g.factory(ctx)
	if err != nil {
		return g.finishNewSessionStart(request.CommandID, call, protocol.GatewaySession{}, err)
	}
	if err := g.initialize(ctx, transport); err != nil {
		_ = transport.Close()
		return g.finishNewSessionStart(request.CommandID, call, protocol.GatewaySession{}, err)
	}
	session := protocol.GatewaySession{
		Handle:     newOpaqueID("gateway"),
		Generation: newOpaqueID("generation"),
		Path:       protocol.SessionPathNew,
	}
	g.mu.Lock()
	g.sessions[session.Handle] = gatewaySession{session: session, transport: transport}
	g.mu.Unlock()
	return g.finishNewSessionStart(request.CommandID, call, session, nil)
}

func (g *Gateway) finishNewSessionStart(commandID string, call *gatewayStartCall, session protocol.GatewaySession, err error) (protocol.GatewaySession, error) {
	g.startMu.Lock()
	defer g.startMu.Unlock()
	delete(g.startCalls, commandID)
	call.session = session
	call.err = err
	if err == nil {
		g.startSessions[commandID] = gatewayStartRecord{session: session, requestDigest: call.requestDigest}
	}
	close(call.done)
	return session, err
}

// SetExternalThreadRef binds the app-server thread identity to the gateway
// generation that created it. This lets a later cold resume fence and close
// the superseded transport instead of leaving two generations alive.
func (g *Gateway) SetExternalThreadRef(session protocol.GatewaySession, externalThreadRef string) error {
	if session.Handle == "" || externalThreadRef == "" {
		return errors.New("gateway session handle and external thread reference are required")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	entry, ok := g.sessions[session.Handle]
	if !ok {
		return fmt.Errorf("gateway session %q is not available", session.Handle)
	}
	if entry.session.ExternalThreadRef != "" && entry.session.ExternalThreadRef != externalThreadRef {
		return fmt.Errorf("gateway session %q is already bound to another thread", session.Handle)
	}
	entry.session.ExternalThreadRef = externalThreadRef
	g.sessions[session.Handle] = entry
	return nil
}

func (g *Gateway) AttachActiveSession(context.Context, protocol.ExistingSessionRequest) (protocol.GatewaySession, error) {
	return protocol.GatewaySession{}, protocol.ErrUnsupportedSessionPath
}

// ReconcileSession cold-resumes a previously persisted host-owned thread in a
// fresh app-server generation. It is intentionally not an active Desktop
// attach operation.
func (g *Gateway) ReconcileSession(ctx context.Context, externalThreadRef string) (protocol.Reconciliation, error) {
	if ctx == nil {
		return protocol.Reconciliation{}, errors.New("gateway context must not be nil")
	}
	if externalThreadRef == "" {
		return protocol.Reconciliation{}, errors.New("external thread reference must not be empty")
	}
	g.reconcileMu.Lock()
	defer g.reconcileMu.Unlock()
	transport, err := g.factory(ctx)
	if err != nil {
		return protocol.Reconciliation{}, err
	}
	if err := g.initialize(ctx, transport); err != nil {
		_ = transport.Close()
		return protocol.Reconciliation{}, err
	}
	result, err := transport.Call(ctx, "thread/resume", mustRawJSON(map[string]any{
		"threadId":     externalThreadRef,
		"excludeTurns": true,
	}))
	if err != nil {
		_ = transport.Close()
		return protocol.Reconciliation{CommandID: externalThreadRef, ObservedAt: now(), State: protocol.ReconciliationStateUnknown, Note: stringPointer("thread/resume outcome is unknown")}, nil
	}
	if result.Error != nil {
		_ = transport.Close()
		return protocol.Reconciliation{CommandID: externalThreadRef, ObservedAt: now(), State: protocol.ReconciliationStateUnknown, Note: stringPointer("thread/resume was rejected by app-server")}, nil
	}
	threadID := threadIDFromResult(result.Result)
	if threadID != externalThreadRef {
		_ = transport.Close()
		return protocol.Reconciliation{CommandID: externalThreadRef, ObservedAt: now(), State: protocol.ReconciliationStateUnknown, Note: stringPointer("thread/resume returned a different thread identity")}, nil
	}
	session := protocol.GatewaySession{
		Handle:            newOpaqueID("gateway"),
		ExternalThreadRef: externalThreadRef,
		Generation:        newOpaqueID("generation"),
		Path:              protocol.SessionPathNew,
	}
	var previous []RPCTransport
	g.mu.Lock()
	for handle, entry := range g.sessions {
		if entry.session.ExternalThreadRef == externalThreadRef {
			delete(g.sessions, handle)
			previous = append(previous, entry.transport)
		}
	}
	g.sessions[session.Handle] = gatewaySession{session: session, transport: transport, resumeResponse: append(json.RawMessage(nil), result.Raw...)}
	g.mu.Unlock()
	for _, oldTransport := range previous {
		_ = oldTransport.Close()
	}
	return protocol.Reconciliation{CommandID: externalThreadRef, ObservedAt: now(), State: protocol.ReconciliationStateConfirmed}, nil
}

func (g *Gateway) RecoveredSession(externalThreadRef string) (protocol.GatewaySession, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, entry := range g.sessions {
		if entry.session.ExternalThreadRef == externalThreadRef {
			return entry.session, nil
		}
	}
	return protocol.GatewaySession{}, fmt.Errorf("recovered session %q is not available", externalThreadRef)
}

func (g *Gateway) RecoveredSessionResult(externalThreadRef string) (json.RawMessage, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, entry := range g.sessions {
		if entry.session.ExternalThreadRef == externalThreadRef {
			return append(json.RawMessage(nil), entry.resumeResponse...), nil
		}
	}
	return nil, fmt.Errorf("recovered session %q is not available", externalThreadRef)
}

func (g *Gateway) TransportFor(_ context.Context, session protocol.GatewaySession) (RPCTransport, error) {
	if session.Handle == "" {
		return nil, errors.New("gateway session handle must not be empty")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	entry, ok := g.sessions[session.Handle]
	if !ok {
		return nil, fmt.Errorf("gateway session %q is not available", session.Handle)
	}
	return entry.transport, nil
}

func (g *Gateway) CloseSession(_ context.Context, session protocol.GatewaySession) error {
	g.reconcileMu.Lock()
	defer g.reconcileMu.Unlock()
	g.startMu.Lock()
	for commandID, cached := range g.startSessions {
		if cached.session.Handle == session.Handle {
			delete(g.startSessions, commandID)
		}
	}
	g.startMu.Unlock()
	g.mu.Lock()
	entry, ok := g.sessions[session.Handle]
	if ok {
		delete(g.sessions, session.Handle)
	}
	g.mu.Unlock()
	if !ok {
		return nil
	}
	return entry.transport.Close()
}

func (g *Gateway) initialize(ctx context.Context, transport RPCTransport) error {
	params := mustRawJSON(map[string]any{
		"clientInfo": map[string]string{
			"name":    g.client.Name,
			"title":   g.client.Title,
			"version": g.client.Version,
		},
	})
	response, err := transport.Call(ctx, "initialize", params)
	if err != nil {
		return err
	}
	if response.Error != nil {
		return fmt.Errorf("app-server initialize failed with code %d", response.Error.Code)
	}
	if len(response.Result) == 0 {
		return errors.New("app-server initialize returned no result")
	}
	return transport.Notify(ctx, "initialized", json.RawMessage(`{}`))
}

func threadIDFromResult(result json.RawMessage) string {
	var value struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if json.Unmarshal(result, &value) == nil {
		return value.Thread.ID
	}
	return ""
}

func mustRawJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

func newOpaqueID(prefix string) string {
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UTC().UnixNano(), opaqueIDCounter.Add(1))
}

var opaqueIDCounter atomic.Uint64

var _ protocol.HostGateway = (*Gateway)(nil)
var _ io.Closer = (*ProcessTransport)(nil)
