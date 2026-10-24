package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/coder/websocket"
)

var (
	ErrNoActiveConnection      = errors.New("no active host gateway connection")
	ErrConnectionClosed        = errors.New("host gateway connection is closed")
	ErrUnknownDelivery         = errors.New("gateway delivery result is unknown")
	ErrServerDraining          = errors.New("host gateway is draining")
	ErrConnectionSuperseded    = errors.New("host gateway connection was superseded")
	ErrEventHandlerUnavailable = errors.New("gateway event handler is not configured")
)

type ServerOptions struct {
	MaxFrameBytes    int64
	HandshakeTimeout time.Duration
	EventHandler     EventHandler
}

type Server struct {
	registry Registry
	options  ServerOptions

	mu            sync.RWMutex
	connections   map[string]*serverConnection
	draining      bool
	handshakes    int
	handshakeDone chan struct{}
}

type serverConnection struct {
	ws         *websocket.Conn
	registry   Registry
	connection hosts.Connection
	maxFrame   int64
	onEvent    EventHandler

	writeMu     sync.Mutex
	done        chan struct{}
	close       sync.Once
	handlerDone chan struct{}

	pendingMu sync.Mutex
	pending   map[string]chan commandResponse
}

type commandResponse struct {
	ack *protocol.CommandAck
	err error
}

func NewServer(registry Registry, options ...ServerOptions) (*Server, error) {
	if registry == nil {
		return nil, errors.New("gateway registry is required")
	}
	config := ServerOptions{MaxFrameBytes: DefaultMaxFrame, HandshakeTimeout: 10 * time.Second}
	if len(options) > 0 {
		if options[0].MaxFrameBytes != 0 {
			config.MaxFrameBytes = options[0].MaxFrameBytes
		}
		if options[0].HandshakeTimeout != 0 {
			config.HandshakeTimeout = options[0].HandshakeTimeout
		}
		config.EventHandler = options[0].EventHandler
	}
	if config.MaxFrameBytes <= 0 {
		return nil, errors.New("gateway frame limit must be greater than zero")
	}
	if config.HandshakeTimeout <= 0 {
		return nil, errors.New("gateway handshake timeout must be greater than zero")
	}
	handshakeDone := make(chan struct{})
	close(handshakeDone)
	return &Server{
		registry:      registry,
		options:       config,
		connections:   make(map[string]*serverConnection),
		handshakeDone: handshakeDone,
	}, nil
}

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if !s.beginHandshake() {
		http.Error(writer, http.StatusText(http.StatusServiceUnavailable), http.StatusServiceUnavailable)
		return
	}
	defer s.endHandshake()
	token, ok := bearerToken(request.Header.Get("Authorization"))
	if !ok {
		http.Error(writer, "gateway authentication required", http.StatusUnauthorized)
		return
	}
	credential, err := s.registry.Authenticate(request.Context(), token)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, hosts.ErrCredentialRevoked) {
			status = http.StatusUnauthorized
		}
		http.Error(writer, http.StatusText(status), status)
		return
	}
	ws, err := websocket.Accept(writer, request, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(s.options.MaxFrameBytes)
	connection, err := s.acceptHello(request.Context(), ws, credential)
	if err != nil {
		_ = ws.CloseNow()
		return
	}
	defer func() {
		defer close(connection.handlerDone)
		_ = s.registry.CloseConnection(context.Background(), connection.connection)
		s.remove(connection)
		connection.closeNow()
	}()
	if err := connection.write(request.Context(), Message{
		Type:       MessageHelloAck,
		HostID:     connection.connection.HostID,
		Generation: connection.connection.Generation,
		Cursors:    resumeCursors(connection.connection.ResumeCursors),
	}); err != nil {
		return
	}
	if err := connection.readLoop(request.Context()); err != nil && !errors.Is(err, context.Canceled) {
		connection.closeNow()
	}
}

func (s *Server) acceptHello(ctx context.Context, ws *websocket.Conn, credential hosts.Credential) (*serverConnection, error) {
	helloCtx, cancel := context.WithTimeout(ctx, s.options.HandshakeTimeout)
	defer cancel()
	messageType, data, err := ws.Read(helloCtx)
	if err != nil {
		return nil, fmt.Errorf("read gateway hello: %w", err)
	}
	if messageType != websocket.MessageText {
		return nil, errors.New("gateway hello must be a text message")
	}
	hello, err := decodeMessage(data, s.options.MaxFrameBytes)
	if err != nil {
		return nil, fmt.Errorf("decode gateway hello: %w", err)
	}
	if hello.Type != MessageHello || hello.HostID != credential.HostID || hello.Protocol != ProtocolVersion {
		return nil, errors.New("gateway hello does not match the authenticated host")
	}
	connection, err := s.registry.OpenConnection(ctx, credential)
	if err != nil {
		return nil, fmt.Errorf("open host gateway connection: %w", err)
	}
	result := &serverConnection{
		ws:          ws,
		registry:    s.registry,
		connection:  connection,
		maxFrame:    s.options.MaxFrameBytes,
		onEvent:     s.options.EventHandler,
		done:        make(chan struct{}),
		handlerDone: make(chan struct{}),
		pending:     make(map[string]chan commandResponse),
	}
	ack := Message{
		Type:       MessageHelloAck,
		HostID:     connection.HostID,
		Generation: connection.Generation,
		Cursors:    resumeCursors(connection.ResumeCursors),
	}
	if _, err := encodeMessage(ack, s.options.MaxFrameBytes); err != nil {
		_ = s.registry.CloseConnection(context.Background(), connection)
		result.closeNow()
		return nil, fmt.Errorf("encode gateway hello acknowledgement: %w", err)
	}
	if err := s.replace(result); err != nil {
		_ = s.registry.CloseConnection(context.Background(), connection)
		result.closeNow()
		return nil, err
	}
	return result, nil
}

func (s *Server) replace(connection *serverConnection) error {
	s.mu.Lock()
	if s.draining {
		s.mu.Unlock()
		return ErrServerDraining
	}
	previous := s.connections[connection.connection.HostID]
	if previous != nil && previous.connection.Generation >= connection.connection.Generation {
		s.mu.Unlock()
		return ErrConnectionSuperseded
	}
	s.connections[connection.connection.HostID] = connection
	s.mu.Unlock()
	if previous != nil {
		previous.closeNow()
	}
	return nil
}

func (s *Server) remove(connection *serverConnection) {
	s.mu.Lock()
	if current := s.connections[connection.connection.HostID]; current == connection {
		delete(s.connections, connection.connection.HostID)
	}
	s.mu.Unlock()
}

func (s *Server) SendCommand(ctx context.Context, hostID string, command protocol.Command) (protocol.CommandAck, error) {
	if ctx == nil {
		return protocol.CommandAck{}, errors.New("gateway command context must not be nil")
	}
	if err := protocol.ValidateCommand(command); err != nil {
		return protocol.CommandAck{}, err
	}
	s.mu.RLock()
	connection := s.connections[strings.TrimSpace(hostID)]
	s.mu.RUnlock()
	if connection == nil {
		return protocol.CommandAck{}, ErrNoActiveConnection
	}
	return connection.sendCommand(ctx, command)
}

func (s *Server) Shutdown(ctx context.Context) error {
	if ctx == nil {
		return errors.New("gateway shutdown context must not be nil")
	}
	s.mu.Lock()
	s.draining = true
	connections := make([]*serverConnection, 0, len(s.connections))
	for _, connection := range s.connections {
		connections = append(connections, connection)
	}
	s.connections = make(map[string]*serverConnection)
	handshakeDone := s.handshakeDone
	s.mu.Unlock()
	var shutdownErrors []error
	for _, connection := range connections {
		connection.closeNow()
		if err := s.registry.CloseConnection(ctx, connection.connection); err != nil {
			shutdownErrors = append(shutdownErrors, err)
		}
		select {
		case <-connection.handlerDone:
		case <-ctx.Done():
			shutdownErrors = append(shutdownErrors, ctx.Err())
		}
	}
	select {
	case <-handshakeDone:
	case <-ctx.Done():
		shutdownErrors = append(shutdownErrors, ctx.Err())
	}
	return errors.Join(shutdownErrors...)
}

func (s *Server) beginHandshake() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.draining {
		return false
	}
	if s.handshakes == 0 {
		s.handshakeDone = make(chan struct{})
	}
	s.handshakes++
	return true
}

func (s *Server) endHandshake() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handshakes--
	if s.handshakes == 0 {
		close(s.handshakeDone)
	}
}

func (c *serverConnection) readLoop(ctx context.Context) error {
	for {
		messageType, data, err := c.ws.Read(ctx)
		if err != nil {
			return err
		}
		if messageType != websocket.MessageText {
			return errors.New("gateway messages must be text frames")
		}
		message, err := decodeMessage(data, c.maxFrame)
		if err != nil {
			return err
		}
		switch message.Type {
		case MessageHeartbeat:
			if err := c.handleHeartbeat(ctx, message); err != nil {
				return err
			}
		case MessageEvent:
			if err := c.handleEvent(ctx, message); err != nil {
				return err
			}
		case MessageCommandAck:
			c.resolve(message)
		default:
			return fmt.Errorf("unexpected Connector gateway message %q", message.Type)
		}
	}
}

func (c *serverConnection) handleHeartbeat(ctx context.Context, message Message) error {
	var err error
	if message.Cursor != "" {
		err = c.registry.Checkpoint(ctx, c.connection, hosts.Cursor{
			SessionID: message.SessionID,
			RunID:     message.RunID,
			Value:     message.Cursor,
		})
	} else {
		err = c.registry.Touch(ctx, c.connection)
	}
	if err != nil {
		_ = c.writeError(ctx, connectionErrorCode(err, "heartbeat_rejected"), err.Error())
		return err
	}
	return c.write(ctx, Message{Type: MessageHeartbeatAck, RequestID: message.RequestID, Generation: c.connection.Generation})
}

func (c *serverConnection) handleEvent(ctx context.Context, message Message) error {
	if c.onEvent == nil {
		err := ErrEventHandlerUnavailable
		_ = c.writeError(ctx, connectionErrorCode(err, "event_rejected"), err.Error())
		return err
	}
	event := *message.Event
	err := c.registry.ProcessEvent(ctx, c.connection, hosts.Cursor{
		SessionID: event.SessionID,
		RunID:     eventRunID(event),
		Value:     event.Cursor,
	}, func(handlerCtx context.Context) error {
		return c.onEvent(handlerCtx, c.connection, event)
	})
	if err != nil {
		_ = c.writeError(ctx, connectionErrorCode(err, "event_rejected"), err.Error())
		return err
	}
	return nil
}

func eventRunID(event protocol.Event) string {
	if event.RunID == nil {
		return ""
	}
	return *event.RunID
}

func connectionErrorCode(err error, fallback string) string {
	if errors.Is(err, hosts.ErrConnectionStale) || errors.Is(err, hosts.ErrCredentialRevoked) {
		return "stale_generation"
	}
	if errors.Is(err, hosts.ErrInvalid) {
		return "invalid_request"
	}
	return fallback
}

func (c *serverConnection) sendCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, error) {
	requestID, err := newRequestID()
	if err != nil {
		return protocol.CommandAck{}, err
	}
	data, err := encodeMessage(Message{
		Type:       MessageCommand,
		RequestID:  requestID,
		Generation: c.connection.Generation,
		Command:    &command,
	}, c.maxFrame)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	response := make(chan commandResponse, 1)
	c.pendingMu.Lock()
	c.pending[requestID] = response
	c.pendingMu.Unlock()
	deliveryErr := c.registry.AuthorizeCommand(ctx, c.connection, func() error {
		return c.writeData(ctx, data)
	})
	if deliveryErr != nil {
		c.removePending(requestID)
		if errors.Is(deliveryErr, hosts.ErrCommandNotDelivered) || errors.Is(deliveryErr, ErrConnectionClosed) || errors.Is(deliveryErr, hosts.ErrConnectionStale) {
			return protocol.CommandAck{}, deliveryErr
		}
		return protocol.CommandAck{}, fmt.Errorf("%w: %v", protocol.ErrUnknownCommandResult, deliveryErr)
	}
	select {
	case result := <-response:
		if result.err != nil {
			return protocol.CommandAck{}, result.err
		}
		if result.ack == nil || result.ack.CommandID != command.CommandID {
			return protocol.CommandAck{}, fmt.Errorf("%w: gateway command acknowledgement identity mismatch", protocol.ErrUnknownCommandResult)
		}
		return *result.ack, nil
	case <-ctx.Done():
		c.removePending(requestID)
		return protocol.CommandAck{}, protocol.ErrUnknownCommandResult
	case <-c.done:
		c.removePending(requestID)
		return protocol.CommandAck{}, protocol.ErrUnknownCommandResult
	}
}

func (c *serverConnection) resolve(message Message) {
	c.pendingMu.Lock()
	response := c.pending[message.RequestID]
	delete(c.pending, message.RequestID)
	c.pendingMu.Unlock()
	if response != nil {
		response <- commandResponse{ack: message.Ack}
	}
}

func (c *serverConnection) removePending(requestID string) {
	c.pendingMu.Lock()
	delete(c.pending, requestID)
	c.pendingMu.Unlock()
}

func (c *serverConnection) write(ctx context.Context, message Message) error {
	data, err := encodeMessage(message, c.maxFrame)
	if err != nil {
		return err
	}
	return c.writeData(ctx, data)
}

func (c *serverConnection) writeData(ctx context.Context, data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	select {
	case <-c.done:
		return ErrConnectionClosed
	default:
	}
	if err := c.ws.Write(ctx, websocket.MessageText, data); err != nil {
		return err
	}
	return nil
}

func (c *serverConnection) writeError(ctx context.Context, code, message string) error {
	return c.write(ctx, Message{Type: MessageError, Error: &WireError{Code: code, Message: message}})
}

func (c *serverConnection) closeNow() {
	c.close.Do(func() {
		close(c.done)
		_ = c.ws.CloseNow()
	})
}

func bearerToken(header string) (string, bool) {
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}

func resumeCursors(cursors []hosts.Cursor) []WireCursor {
	if len(cursors) == 0 {
		return nil
	}
	result := make([]WireCursor, 0, len(cursors))
	for _, cursor := range cursors {
		result = append(result, wireCursor(cursor))
	}
	return result
}
