package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/coder/websocket"
)

type ClientOptions struct {
	URL           string
	HostID        string
	Token         string
	HTTPClient    *http.Client
	MaxFrameBytes int64
}

type Client struct {
	url           string
	hostID        string
	token         string
	httpClient    *http.Client
	maxFrameBytes int64
}

var errGatewayRedirect = errors.New("gateway redirects are not allowed")

type ClientConnection struct {
	ws         *websocket.Conn
	maxFrame   int64
	hostID     string
	generation int64
	resume     []hosts.Cursor

	writeMu         sync.Mutex
	close           sync.Once
	artifactMu      sync.Mutex
	artifactPending map[string]chan artifactUploadResponse
	sourceMu        sync.Mutex
	sourcePending   map[string]chan sourceResponse
}

func NewClient(options ClientOptions) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(options.URL))
	if err != nil || parsed.Scheme != "wss" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("gateway client URL must be a credential-free wss URL without query or fragment")
	}
	if strings.TrimSpace(options.HostID) == "" {
		return nil, errors.New("gateway client host id must not be empty")
	}
	if strings.TrimSpace(options.Token) == "" {
		return nil, errors.New("gateway client credential must not be empty")
	}
	maxFrame := options.MaxFrameBytes
	if maxFrame == 0 {
		maxFrame = DefaultMaxFrame
	}
	if maxFrame <= 0 {
		return nil, errors.New("gateway client frame limit must be greater than zero")
	}
	return &Client{
		url:           parsed.String(),
		hostID:        strings.TrimSpace(options.HostID),
		token:         options.Token,
		httpClient:    options.HTTPClient,
		maxFrameBytes: maxFrame,
	}, nil
}

func (c *Client) Connect(ctx context.Context) (*ClientConnection, error) {
	if c == nil {
		return nil, errors.New("gateway client is nil")
	}
	if ctx == nil {
		return nil, errors.New("gateway client context must not be nil")
	}
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+c.token)
	httpClient := c.httpClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	httpClientCopy := *httpClient
	httpClientCopy.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errGatewayRedirect
	}
	ws, _, err := websocket.Dial(ctx, c.url, &websocket.DialOptions{
		HTTPClient:      &httpClientCopy,
		HTTPHeader:      header,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, fmt.Errorf("dial gateway: %w", err)
	}
	ws.SetReadLimit(c.maxFrameBytes)
	connection := &ClientConnection{ws: ws, maxFrame: c.maxFrameBytes, hostID: c.hostID, artifactPending: make(map[string]chan artifactUploadResponse), sourcePending: make(map[string]chan sourceResponse)}
	if err := connection.write(ctx, Message{Type: MessageHello, Protocol: ProtocolVersion, HostID: c.hostID}); err != nil {
		_ = ws.CloseNow()
		return nil, fmt.Errorf("send gateway hello: %w", err)
	}
	messageType, data, err := ws.Read(ctx)
	if err != nil {
		_ = ws.CloseNow()
		return nil, fmt.Errorf("read gateway hello acknowledgement: %w", err)
	}
	if messageType != websocket.MessageText {
		_ = ws.CloseNow()
		return nil, errors.New("gateway hello acknowledgement must be a text message")
	}
	message, err := decodeMessage(data, c.maxFrameBytes)
	if err != nil || message.Type != MessageHelloAck || message.HostID != c.hostID {
		_ = ws.CloseNow()
		if err != nil {
			return nil, fmt.Errorf("decode gateway hello acknowledgement: %w", err)
		}
		return nil, errors.New("gateway hello acknowledgement does not match the authenticated host")
	}
	connection.generation = message.Generation
	if len(message.Cursors) != 0 {
		connection.resume = make([]hosts.Cursor, 0, len(message.Cursors))
		for _, wire := range message.Cursors {
			cursor, cursorErr := hostCursor(wire)
			if cursorErr != nil {
				_ = ws.CloseNow()
				return nil, fmt.Errorf("decode gateway resume cursor: %w", cursorErr)
			}
			connection.resume = append(connection.resume, cursor)
		}
	}
	return connection, nil
}

func (c *ClientConnection) HostID() string {
	if c == nil {
		return ""
	}
	return c.hostID
}

func (c *ClientConnection) Generation() int64 {
	if c == nil {
		return 0
	}
	return c.generation
}

func (c *ClientConnection) ResumeCursor() *hosts.Cursor {
	if c == nil || len(c.resume) == 0 {
		return nil
	}
	copy := c.resume[0]
	return &copy
}

func (c *ClientConnection) ResumeCursors() []hosts.Cursor {
	if c == nil || len(c.resume) == 0 {
		return nil
	}
	result := make([]hosts.Cursor, len(c.resume))
	copy(result, c.resume)
	return result
}

func (c *ClientConnection) Read(ctx context.Context) (Message, error) {
	if c == nil || c.ws == nil {
		return Message{}, ErrConnectionClosed
	}
	for {
		messageType, data, err := c.ws.Read(ctx)
		if err != nil {
			c.failArtifactUploads(err)
			c.failSourceNotifications(err)
			return Message{}, err
		}
		if messageType != websocket.MessageText {
			err := errors.New("gateway messages must be text frames")
			c.failArtifactUploads(err)
			c.failSourceNotifications(err)
			return Message{}, err
		}
		message, err := decodeMessage(data, c.maxFrame)
		if err != nil {
			c.failArtifactUploads(err)
			c.failSourceNotifications(err)
			return Message{}, err
		}
		if message.Type == MessageArtifactAck {
			c.resolveArtifactAck(message)
			continue
		}
		if message.Type == MessageSourceAck {
			c.resolveSourceAck(message)
			continue
		}
		return message, nil
	}
}

func (c *ClientConnection) SendEvent(ctx context.Context, event protocol.Event) error {
	if c == nil {
		return ErrConnectionClosed
	}
	return c.write(ctx, Message{Type: MessageEvent, Event: &event})
}

func (c *ClientConnection) SendHeartbeat(ctx context.Context, cursor string) error {
	return c.SendHeartbeatForStream(ctx, "", "", cursor)
}

func (c *ClientConnection) SendHeartbeatForStream(ctx context.Context, sessionID, runID, cursor string) error {
	if c == nil {
		return ErrConnectionClosed
	}
	requestID, err := newRequestID()
	if err != nil {
		return err
	}
	return c.write(ctx, Message{
		Type:       MessageHeartbeat,
		RequestID:  requestID,
		Generation: c.generation,
		SessionID:  sessionID,
		RunID:      runID,
		Cursor:     cursor,
	})
}

func (c *ClientConnection) Acknowledge(ctx context.Context, requestID string, ack protocol.CommandAck) error {
	return c.AcknowledgeForSession(ctx, "", requestID, ack)
}

// AcknowledgeForSession carries the original platform session identity in the
// existing gateway envelope so the server can scope the durable command lookup.
func (c *ClientConnection) AcknowledgeForSession(ctx context.Context, sessionID, requestID string, ack protocol.CommandAck) error {
	if c == nil {
		return ErrConnectionClosed
	}
	if strings.TrimSpace(requestID) == "" {
		return errors.New("gateway acknowledgement request id must not be empty")
	}
	return c.write(ctx, Message{Type: MessageCommandAck, RequestID: requestID, Generation: c.generation, SessionID: sessionID, Ack: &ack})
}

func (c *ClientConnection) AcknowledgeSource(ctx context.Context, requestID string, ack SourceAck) error {
	if c == nil {
		return ErrConnectionClosed
	}
	if strings.TrimSpace(requestID) == "" {
		return errors.New("gateway source acknowledgement request id must not be empty")
	}
	return c.writeSourceSnapshot(ctx, requestID, ack)
}

func (c *ClientConnection) SendSourceNotification(ctx context.Context, notification SourceNotification) error {
	if c == nil {
		return ErrConnectionClosed
	}
	requestID := strings.TrimSpace(notification.EventID)
	if requestID == "" {
		var err error
		requestID, err = newRequestID()
		if err != nil {
			return err
		}
		notification.EventID = requestID
	}
	response := make(chan sourceResponse, 1)
	c.sourceMu.Lock()
	if c.sourcePending == nil {
		c.sourcePending = make(map[string]chan sourceResponse)
	}
	c.sourcePending[requestID] = response
	c.sourceMu.Unlock()
	if err := c.write(ctx, Message{
		Type:        MessageSourceEvent,
		RequestID:   requestID,
		Generation:  c.generation,
		SourceEvent: &notification,
	}); err != nil {
		c.removeSourcePending(requestID)
		return err
	}
	return c.waitForSourceResponse(ctx, requestID, response)
}

// SendSourceSnapshot sends a recovered snapshot and waits for the Server's
// durable import acknowledgement. Source commands keep their existing
// one-way acknowledgement path because the Server waits for those responses.
func (c *ClientConnection) SendSourceSnapshot(ctx context.Context, requestID string, ack SourceAck) error {
	if c == nil {
		return ErrConnectionClosed
	}
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return errors.New("gateway source snapshot request id must not be empty")
	}
	response := make(chan sourceResponse, 1)
	c.sourceMu.Lock()
	if c.sourcePending == nil {
		c.sourcePending = make(map[string]chan sourceResponse)
	}
	c.sourcePending[requestID] = response
	c.sourceMu.Unlock()
	if err := c.writeSourceSnapshot(ctx, requestID, ack); err != nil {
		c.removeSourcePending(requestID)
		return err
	}
	return c.waitForSourceResponse(ctx, requestID, response)
}

func (c *ClientConnection) waitForSourceResponse(ctx context.Context, requestID string, response <-chan sourceResponse) error {
	select {
	case result := <-response:
		if result.err != nil {
			return result.err
		}
		if result.ack == nil {
			return errors.New("gateway source acknowledgement was empty")
		}
		if result.ack.State != "succeeded" {
			if result.ack.Error != nil && strings.TrimSpace(result.ack.Error.Message) != "" {
				return fmt.Errorf("gateway source operation failed: %s", result.ack.Error.Message)
			}
			return fmt.Errorf("gateway source operation returned state %q", result.ack.State)
		}
		return nil
	case <-ctx.Done():
		c.removeSourcePending(requestID)
		return ctx.Err()
	}
}

func (c *ClientConnection) removeSourcePending(requestID string) {
	c.sourceMu.Lock()
	delete(c.sourcePending, requestID)
	c.sourceMu.Unlock()
}

func (c *ClientConnection) resolveSourceAck(message Message) {
	c.sourceMu.Lock()
	pending := c.sourcePending[message.RequestID]
	if pending != nil {
		delete(c.sourcePending, message.RequestID)
	}
	c.sourceMu.Unlock()
	if pending != nil {
		pending <- sourceResponse{ack: message.SourceAck}
	}
}

func (c *ClientConnection) failSourceNotifications(err error) {
	if err == nil {
		err = ErrConnectionClosed
	}
	c.sourceMu.Lock()
	pending := make([]chan sourceResponse, 0, len(c.sourcePending))
	for requestID, channel := range c.sourcePending {
		delete(c.sourcePending, requestID)
		pending = append(pending, channel)
	}
	c.sourceMu.Unlock()
	for _, channel := range pending {
		channel <- sourceResponse{err: err}
	}
}

func (c *ClientConnection) Close() error {
	if c == nil || c.ws == nil {
		return nil
	}
	var err error
	c.close.Do(func() {
		c.failArtifactUploads(ErrConnectionClosed)
		c.failSourceNotifications(ErrConnectionClosed)
		err = c.ws.Close(websocket.StatusNormalClosure, "connector closed")
	})
	return err
}

func (c *ClientConnection) write(ctx context.Context, message Message) error {
	data, err := encodeMessage(message, c.maxFrame)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.ws.Write(ctx, websocket.MessageText, data)
}
