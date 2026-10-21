package connector

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

const defaultMaxFrameBytes = 4 << 20

var (
	ErrTransportClosed = errors.New("RPC transport is closed")
	ErrUnknownOutcome  = errors.New("RPC side effect outcome is unknown")
)

// RPCError is the JSON-RPC error object returned by app-server.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// RPCMessage keeps the complete raw JSON object while exposing the fields
// needed by the adapter. Unknown app-server fields stay in Raw.
type RPCMessage struct {
	Raw    json.RawMessage
	ID     json.RawMessage
	Method string
	Params json.RawMessage
	Result json.RawMessage
	Error  *RPCError
}

func (m RPCMessage) IsResponse() bool {
	return len(m.ID) > 0 && m.Method == ""
}

func (m RPCMessage) IsRequest() bool {
	return len(m.ID) > 0 && m.Method != ""
}

func (m RPCMessage) IsNotification() bool {
	return len(m.ID) == 0 && m.Method != ""
}

func (m RPCMessage) Successful() bool {
	return m.IsResponse() && m.Error == nil && len(bytes.TrimSpace(m.Result)) > 0
}

// RPCTransport is the only transport contract consumed by the Codex adapter.
// It does not describe a pairing protocol or a public WebSocket endpoint.
type RPCTransport interface {
	Call(context.Context, string, json.RawMessage) (RPCMessage, error)
	Notify(context.Context, string, json.RawMessage) error
	Respond(context.Context, json.RawMessage, json.RawMessage) error
	Events() <-chan RPCMessage
	Close() error
}

// ProcessTransportConfig starts one host-owned app-server child. The caller
// supplies the exact CLI path and environment; credentials are never read or
// copied by this package.
type ProcessTransportConfig struct {
	CommandPath   string
	CommandArgs   []string
	CommandEnv    []string
	WorkingDir    string
	Stderr        io.Writer
	MaxFrameBytes int
}

// NewProcessTransport starts a JSONL app-server child. The default arguments
// are the documented stdio transport used by the R01 host-owned path.
func NewProcessTransport(ctx context.Context, config ProcessTransportConfig) (*ProcessTransport, error) {
	if ctx == nil {
		return nil, errors.New("transport context must not be nil")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.CommandPath) == "" {
		return nil, errors.New("app-server command path must not be empty")
	}
	if config.MaxFrameBytes == 0 {
		config.MaxFrameBytes = defaultMaxFrameBytes
	}
	if config.MaxFrameBytes < 1024 {
		return nil, errors.New("maximum RPC frame size must be at least 1024 bytes")
	}
	commandPath, err := filepath.Abs(config.CommandPath)
	if err != nil {
		return nil, fmt.Errorf("resolve app-server command path: %w", err)
	}
	if _, err := os.Stat(commandPath); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("stat app-server command: %w", err)
		}
		resolved, lookErr := exec.LookPath(config.CommandPath)
		if lookErr != nil {
			return nil, fmt.Errorf("find app-server command: %w", lookErr)
		}
		commandPath = resolved
	}
	args := append([]string(nil), config.CommandArgs...)
	if len(args) == 0 {
		args = []string{"app-server", "--listen", "stdio://"}
	}
	command := exec.Command(commandPath, args...)
	if config.CommandEnv != nil {
		command.Env = append([]string(nil), config.CommandEnv...)
	}
	if config.WorkingDir != "" {
		command.Dir = config.WorkingDir
	}
	if config.Stderr == nil {
		config.Stderr = io.Discard
	}
	command.Stderr = config.Stderr
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("create app-server stdin: %w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, fmt.Errorf("create app-server stdout: %w", err)
	}
	if err := command.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		return nil, fmt.Errorf("start app-server: %w", err)
	}

	transport := &ProcessTransport{
		command:       command,
		stdin:         stdin,
		stdout:        stdout,
		maxFrameBytes: config.MaxFrameBytes,
		pending:       make(map[string]pendingRPC),
		events:        make(chan RPCMessage, 128),
		done:          make(chan struct{}),
		waitDone:      make(chan struct{}),
	}
	go transport.readLoop()
	go transport.waitLoop()
	go func() {
		select {
		case <-ctx.Done():
			_ = transport.Close()
		case <-transport.done:
		}
	}()
	return transport, nil
}

type pendingRPC struct {
	result chan rpcResult
	sent   bool
}

type rpcResult struct {
	message RPCMessage
	err     error
}

// ProcessTransport is a single app-server process and one physical JSONL
// client. It is intentionally not a shared Desktop child or pairing bridge.
type ProcessTransport struct {
	command *exec.Cmd
	stdin   io.WriteCloser
	stdout  io.ReadCloser

	maxFrameBytes int
	writeMu       sync.Mutex
	id            atomic.Uint64

	pendingMu sync.Mutex
	pending   map[string]pendingRPC

	events         chan RPCMessage
	done           chan struct{}
	closed         sync.Once
	closeRequested atomic.Bool
	finish         sync.Once
	errMu          sync.Mutex
	err            error

	waitDone chan struct{}
}

func (p *ProcessTransport) Call(ctx context.Context, method string, params json.RawMessage) (RPCMessage, error) {
	if ctx == nil {
		return RPCMessage{}, errors.New("RPC call context must not be nil")
	}
	if strings.TrimSpace(method) == "" {
		return RPCMessage{}, errors.New("RPC method must not be empty")
	}
	if len(bytes.TrimSpace(params)) == 0 {
		params = json.RawMessage(`{}`)
	}
	if !json.Valid(params) {
		return RPCMessage{}, errors.New("RPC params must be valid JSON")
	}
	id := p.nextID()
	key := string(id)
	waiter := make(chan rpcResult, 1)
	p.pendingMu.Lock()
	select {
	case <-p.done:
		p.pendingMu.Unlock()
		return RPCMessage{}, ErrTransportClosed
	default:
	}
	p.pending[key] = pendingRPC{result: waiter}
	p.pendingMu.Unlock()

	err := p.writeRequest(id, method, params)
	if err != nil {
		p.pendingMu.Lock()
		delete(p.pending, key)
		p.pendingMu.Unlock()
		return RPCMessage{}, err
	}
	p.pendingMu.Lock()
	request, ok := p.pending[key]
	if ok {
		request.sent = true
		p.pending[key] = request
	}
	p.pendingMu.Unlock()
	if !ok {
		select {
		case result := <-waiter:
			return result.message, result.err
		default:
			return RPCMessage{}, ErrUnknownOutcome
		}
	}

	select {
	case result := <-waiter:
		return result.message, result.err
	case <-ctx.Done():
		p.pendingMu.Lock()
		delete(p.pending, key)
		p.pendingMu.Unlock()
		return RPCMessage{}, fmt.Errorf("%w: %v", ErrUnknownOutcome, ctx.Err())
	case <-p.done:
		select {
		case result := <-waiter:
			return result.message, result.err
		default:
		}
		p.pendingMu.Lock()
		request, existed := p.pending[key]
		delete(p.pending, key)
		p.pendingMu.Unlock()
		if existed && request.sent {
			return RPCMessage{}, ErrUnknownOutcome
		}
		return RPCMessage{}, ErrUnknownOutcome
	}
}

func (p *ProcessTransport) Notify(ctx context.Context, method string, params json.RawMessage) error {
	if ctx == nil {
		return errors.New("RPC notification context must not be nil")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(method) == "" {
		return errors.New("RPC method must not be empty")
	}
	if len(bytes.TrimSpace(params)) == 0 {
		params = json.RawMessage(`{}`)
	}
	if !json.Valid(params) {
		return errors.New("RPC params must be valid JSON")
	}
	return p.writeMessage(map[string]json.RawMessage{
		"jsonrpc": json.RawMessage(`"2.0"`),
		"method":  json.RawMessage(mustJSON(method)),
		"params":  append(json.RawMessage(nil), params...),
	})
}

func (p *ProcessTransport) Respond(ctx context.Context, id json.RawMessage, result json.RawMessage) error {
	if ctx == nil {
		return errors.New("RPC response context must not be nil")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(bytes.TrimSpace(id)) == 0 || bytes.Equal(bytes.TrimSpace(id), []byte("null")) || !json.Valid(id) {
		return errors.New("RPC response id must be a non-null JSON value")
	}
	if len(bytes.TrimSpace(result)) == 0 {
		result = json.RawMessage(`{}`)
	}
	if !json.Valid(result) {
		return errors.New("RPC response result must be valid JSON")
	}
	return p.writeMessage(map[string]json.RawMessage{
		"jsonrpc": json.RawMessage(`"2.0"`),
		"id":      append(json.RawMessage(nil), id...),
		"result":  append(json.RawMessage(nil), result...),
	})
}

func (p *ProcessTransport) Events() <-chan RPCMessage { return p.events }

func (p *ProcessTransport) Close() error {
	p.closeRequested.Store(true)
	p.closed.Do(func() {
		if p.stdin != nil {
			_ = p.stdin.Close()
		}
		if p.command != nil && p.command.Process != nil {
			_ = p.command.Process.Kill()
		}
		if p.stdout != nil {
			_ = p.stdout.Close()
		}
	})
	<-p.done
	<-p.waitDone
	p.errMu.Lock()
	defer p.errMu.Unlock()
	return p.err
}

func (p *ProcessTransport) nextID() json.RawMessage {
	return json.RawMessage(fmt.Sprintf("%d", p.id.Add(1)))
}

func (p *ProcessTransport) writeRequest(id json.RawMessage, method string, params json.RawMessage) error {
	return p.writeMessage(map[string]json.RawMessage{
		"jsonrpc": json.RawMessage(`"2.0"`),
		"id":      append(json.RawMessage(nil), id...),
		"method":  json.RawMessage(mustJSON(method)),
		"params":  append(json.RawMessage(nil), params...),
	})
}

func (p *ProcessTransport) writeMessage(fields map[string]json.RawMessage) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	select {
	case <-p.done:
		return ErrTransportClosed
	default:
	}
	data, err := json.Marshal(fields)
	if err != nil {
		return fmt.Errorf("encode RPC message: %w", err)
	}
	data = append(data, '\n')
	written, err := writeAll(p.stdin, data)
	if err != nil {
		return &TransportWriteError{BytesWritten: written, Err: err, Unknown: written > 0}
	}
	return nil
}

func (p *ProcessTransport) readLoop() {
	reader := bufio.NewReaderSize(p.stdout, 64*1024)
	for {
		frame, err := readJSONLFrame(reader, p.maxFrameBytes)
		if err != nil {
			if !p.closeRequested.Load() && !errors.Is(err, io.EOF) {
				p.setError(err)
			}
			p.finishTransport(err)
			return
		}
		message, err := parseRPCMessage(frame)
		if err != nil {
			p.setError(err)
			p.finishTransport(err)
			return
		}
		if message.IsResponse() {
			key := string(bytes.TrimSpace(message.ID))
			p.pendingMu.Lock()
			request, ok := p.pending[key]
			if ok {
				delete(p.pending, key)
			}
			p.pendingMu.Unlock()
			if ok {
				request.result <- rpcResult{message: message}
				continue
			}
		}
		select {
		case p.events <- message:
		case <-p.done:
			return
		}
	}
}

func (p *ProcessTransport) waitLoop() {
	err := p.command.Wait()
	if err != nil && !p.closeRequested.Load() && !errors.Is(err, os.ErrProcessDone) {
		p.setError(err)
	}
	p.finishTransport(err)
	close(p.waitDone)
}

func (p *ProcessTransport) finishTransport(err error) {
	p.finish.Do(func() {
		if err != nil && !p.closeRequested.Load() && !errors.Is(err, io.EOF) {
			p.setError(err)
		}
		close(p.done)
		p.pendingMu.Lock()
		pending := p.pending
		p.pending = make(map[string]pendingRPC)
		p.pendingMu.Unlock()
		for _, request := range pending {
			if request.sent {
				request.result <- rpcResult{err: ErrUnknownOutcome}
			} else {
				request.result <- rpcResult{err: ErrTransportClosed}
			}
		}
		close(p.events)
	})
}

func (p *ProcessTransport) setError(err error) {
	if err == nil {
		return
	}
	p.errMu.Lock()
	defer p.errMu.Unlock()
	if p.err == nil {
		p.err = err
	}
}

type TransportWriteError struct {
	BytesWritten int
	Err          error
	Unknown      bool
}

func (e *TransportWriteError) Error() string {
	return fmt.Sprintf("write RPC frame after %d bytes: %v", e.BytesWritten, e.Err)
}

func (e *TransportWriteError) Unwrap() error { return e.Err }

func (e *TransportWriteError) Is(target error) bool {
	return e.Unknown && target == ErrUnknownOutcome
}

func readJSONLFrame(reader *bufio.Reader, maxBytes int) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, errors.New("maximum RPC frame size must be greater than zero")
	}
	var frame []byte
	for {
		part, err := reader.ReadSlice('\n')
		frame = append(frame, part...)
		if len(frame) > maxBytes {
			return nil, fmt.Errorf("RPC frame exceeds %d bytes", maxBytes)
		}
		if err == nil {
			return frame, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			if len(bytes.TrimSpace(frame)) == 0 {
				return nil, io.EOF
			}
			return frame, nil
		}
		return nil, err
	}
}

func parseRPCMessage(frame []byte) (RPCMessage, error) {
	trimmed := bytes.TrimSpace(frame)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil {
		return RPCMessage{}, fmt.Errorf("decode RPC object: %w", err)
	}
	if fields == nil {
		return RPCMessage{}, errors.New("RPC message must be a JSON object")
	}
	message := RPCMessage{Raw: append(json.RawMessage(nil), trimmed...)}
	if value, ok := fields["id"]; ok {
		message.ID = append(json.RawMessage(nil), value...)
	}
	if value, ok := fields["method"]; ok {
		if err := json.Unmarshal(value, &message.Method); err != nil {
			return RPCMessage{}, fmt.Errorf("decode RPC method: %w", err)
		}
	}
	if value, ok := fields["params"]; ok {
		message.Params = append(json.RawMessage(nil), value...)
	}
	if value, ok := fields["result"]; ok {
		message.Result = append(json.RawMessage(nil), value...)
	}
	if value, ok := fields["error"]; ok {
		var rpcError RPCError
		if err := json.Unmarshal(value, &rpcError); err != nil {
			return RPCMessage{}, fmt.Errorf("decode RPC error: %w", err)
		}
		message.Error = &rpcError
	}
	if message.Method == "" && len(message.ID) == 0 {
		return RPCMessage{}, errors.New("RPC message has neither method nor id")
	}
	return message, nil
}

func mustJSON(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}
