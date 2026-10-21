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

type ClientConnection struct {
	ws         *websocket.Conn
	maxFrame   int64
	hostID     string
	generation int64
	resume     []hosts.Cursor

	writeMu sync.Mutex
	close   sync.Once
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
	ws, _, err := websocket.Dial(ctx, c.url, &websocket.DialOptions{
		HTTPClient:      c.httpClient,
		HTTPHeader:      header,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, fmt.Errorf("dial gateway: %w", err)
	}
	ws.SetReadLimit(c.maxFrameBytes)
	connection := &ClientConnection{ws: ws, maxFrame: c.maxFrameBytes, hostID: c.hostID}
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
	messageType, data, err := c.ws.Read(ctx)
	if err != nil {
		return Message{}, err
	}
	if messageType != websocket.MessageText {
		return Message{}, errors.New("gateway messages must be text frames")
	}
	return decodeMessage(data, c.maxFrame)
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
	if c == nil {
		return ErrConnectionClosed
	}
	if strings.TrimSpace(requestID) == "" {
		return errors.New("gateway acknowledgement request id must not be empty")
	}
	return c.write(ctx, Message{Type: MessageCommandAck, RequestID: requestID, Generation: c.generation, Ack: &ack})
}

func (c *ClientConnection) Close() error {
	if c == nil || c.ws == nil {
		return nil
	}
	var err error
	c.close.Do(func() { err = c.ws.Close(websocket.StatusNormalClosure, "connector closed") })
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
