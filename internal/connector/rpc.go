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
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultMaxFrameBytes      = 4 << 20
	maxEventQueueBytes        = 64 << 20
	maxAbandonedRPC           = 4096
	eventQueueMessageOverhead = 1024
)

var (
	ErrTransportClosed    = errors.New("RPC transport is closed")
	ErrUnknownOutcome     = errors.New("RPC side effect outcome is unknown")
	ErrEventQueueOverflow = errors.New("RPC event queue exceeded its memory limit")
	ErrRPCStateOverflow   = errors.New("RPC transport abandoned state exceeded its memory limit")
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
	Raw         json.RawMessage
	ID          json.RawMessage
	Method      string
	Params      json.RawMessage
	Result      json.RawMessage
	Error       *RPCError
	operation   string
	runID       string
	commandID   string
	observation chan rpcObservation
}

type rpcCommandIDContextKey struct{}

func withRPCCommandID(ctx context.Context, commandID string) context.Context {
	if commandID == "" {
		return ctx
	}
	return context.WithValue(ctx, rpcCommandIDContextKey{}, commandID)
}

func rpcCommandIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	commandID, _ := ctx.Value(rpcCommandIDContextKey{}).(string)
	return commandID
}

type rpcObservation struct {
	eventCursor string
	err         error
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
// supplies the exact CLI path. An explicit CommandEnv is passed through as-is;
// the default environment is a small non-secret allowlist.
type ProcessTransportConfig struct {
	CommandPath       string
	CommandArgs       []string
	CommandEnv        []string
	WorkingDir        string
	Stderr            io.Writer
	MaxFrameBytes     int
	afterRequestWrite func(string)
}

func resolveProcessCommandPath(command string) (string, error) {
	var resolved string
	if filepath.IsAbs(command) || strings.ContainsAny(command, `/\\`) {
		absolute, err := filepath.Abs(command)
		if err != nil {
			return "", fmt.Errorf("resolve app-server command path: %w", err)
		}
		if _, err := os.Stat(absolute); err != nil {
			return "", fmt.Errorf("stat app-server command: %w", err)
		}
		resolved = absolute
	} else {
		var err error
		resolved, err = exec.LookPath(command)
		if err != nil {
			return "", fmt.Errorf("find app-server command: %w", err)
		}
	}
	if runtime.GOOS == "windows" {
		switch strings.ToLower(filepath.Ext(resolved)) {
		case ".bat", ".cmd":
			return "", fmt.Errorf("app-server command %q must be an executable, not a batch file", resolved)
		}
	}
	return resolved, nil
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
	commandPath, err := resolveProcessCommandPath(config.CommandPath)
	if err != nil {
		return nil, err
	}
	args := append([]string(nil), config.CommandArgs...)
	if len(args) == 0 {
		args = []string{"app-server", "--listen", "stdio://"}
	}
	command := exec.Command(commandPath, args...)
	if config.CommandEnv != nil {
		command.Env = append([]string(nil), config.CommandEnv...)
	} else {
		command.Env = sanitizedCommandEnv()
	}
	if config.WorkingDir != "" {
		command.Dir = config.WorkingDir
	}
	if config.Stderr == nil {
		config.Stderr = io.Discard
	}
	command.Stderr = config.Stderr
	configureProcessGroup(command)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("create app-server stdin: %w", err)
	}
	stdout, stdoutWriter, err := os.Pipe()
	if err != nil {
		stdin.Close()
		return nil, fmt.Errorf("create app-server stdout: %w", err)
	}
	command.Stdout = stdoutWriter
	if err := command.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stdoutWriter.Close()
		return nil, fmt.Errorf("start app-server: %w", err)
	}
	if err := stdoutWriter.Close(); err != nil {
		stdin.Close()
		stdout.Close()
		_ = command.Process.Kill()
		return nil, fmt.Errorf("close parent app-server stdout: %w", err)
	}

	transport := &ProcessTransport{
		command:           command,
		stdin:             stdin,
		stdout:            stdout,
		maxFrameBytes:     config.MaxFrameBytes,
		pending:           make(map[string]pendingRPC),
		events:            make(chan RPCMessage),
		done:              make(chan struct{}),
		waitDone:          make(chan struct{}),
		readDone:          make(chan struct{}),
		eventDispatchDone: make(chan struct{}),
		eventStop:         make(chan struct{}),
		afterRequestWrite: config.afterRequestWrite,
		abandoned:         make(map[string]pendingRPC),
	}
	transport.eventCond = sync.NewCond(&transport.eventMu)
	go transport.readLoop()
	go transport.waitLoop()
	go transport.dispatchEvents()
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
	result        chan rpcResult
	sent          bool
	writing       bool
	method        string
	runID         string
	commandID     string
	observe       bool
	observation   chan rpcObservation
	earlyResponse *RPCMessage
	abandoned     bool
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
	abandoned map[string]pendingRPC

	events               chan RPCMessage
	eventMu              sync.Mutex
	eventCond            *sync.Cond
	eventQueue           []RPCMessage
	eventQueueBytes      int
	eventDispatchStopped bool
	eventDispatchDone    chan struct{}
	eventStop            chan struct{}
	eventStopOnce        sync.Once
	afterRequestWrite    func(string)
	done                 chan struct{}
	closed               sync.Once
	eventsClosed         sync.Once
	closeRequested       atomic.Bool
	finish               sync.Once
	errMu                sync.Mutex
	err                  error

	waitDone chan struct{}
	readDone chan struct{}
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
	observation := make(chan rpcObservation, 1)
	runID := rpcRequestRunID(method, params)
	p.pendingMu.Lock()
	select {
	case <-p.done:
		p.pendingMu.Unlock()
		return RPCMessage{}, ErrTransportClosed
	default:
	}
	if err := ctx.Err(); err != nil {
		p.pendingMu.Unlock()
		return RPCMessage{}, err
	}
	p.pending[key] = pendingRPC{
		result:      waiter,
		writing:     true,
		method:      method,
		runID:       runID,
		commandID:   rpcCommandIDFromContext(ctx),
		observation: observation,
	}
	p.pendingMu.Unlock()

	err := p.writeRequest(ctx, id, method, params)
	p.pendingMu.Lock()
	request, exists := p.pending[key]
	if err != nil {
		if exists {
			delete(p.pending, key)
			if request.earlyResponse != nil {
				earlyResponse := *request.earlyResponse
				request.earlyResponse = nil
				p.pendingMu.Unlock()
				p.deliverResponse(request, earlyResponse)
				return waitForRPCResult(waiter)
			}
			var writeErr *TransportWriteError
			if errors.As(err, &writeErr) && writeErr.Unknown {
				request.abandoned = true
				if !p.addAbandonedLocked(key, request) {
					p.pendingMu.Unlock()
					p.failRPCStateOverflow()
					return RPCMessage{ID: append(json.RawMessage(nil), id...)}, ErrUnknownOutcome
				}
			}
		}
		p.pendingMu.Unlock()
		var writeErr *TransportWriteError
		if errors.As(err, &writeErr) && writeErr.Unknown {
			return RPCMessage{ID: append(json.RawMessage(nil), id...)}, ErrUnknownOutcome
		}
		return RPCMessage{}, err
	}
	if !exists {
		p.pendingMu.Unlock()
		return waitForRPCResult(waiter)
	}
	request.writing = false
	request.sent = true
	earlyResponse := request.earlyResponse
	request.earlyResponse = nil
	if earlyResponse != nil {
		delete(p.pending, key)
	} else if err := ctx.Err(); err != nil {
		delete(p.pending, key)
		request.abandoned = true
		if !p.addAbandonedLocked(key, request) {
			p.pendingMu.Unlock()
			p.failRPCStateOverflow()
			return RPCMessage{ID: append(json.RawMessage(nil), id...)}, ErrUnknownOutcome
		}
	} else {
		p.pending[key] = request
	}
	p.pendingMu.Unlock()
	if earlyResponse != nil {
		p.deliverResponse(request, *earlyResponse)
		return waitForRPCResult(waiter)
	}

	select {
	case result := <-waiter:
		return result.message, result.err
	case <-ctx.Done():
		select {
		case result := <-waiter:
			return result.message, result.err
		default:
		}
		p.abandon(key)
		return RPCMessage{ID: append(json.RawMessage(nil), id...)}, fmt.Errorf("%w: %v", ErrUnknownOutcome, ctx.Err())
	case <-p.done:
		select {
		case result := <-waiter:
			return result.message, result.err
		default:
		}
		p.abandon(key)
		return RPCMessage{ID: append(json.RawMessage(nil), id...)}, ErrUnknownOutcome
	}
}

func waitForRPCResult(waiter <-chan rpcResult) (RPCMessage, error) {
	result := <-waiter
	return result.message, result.err
}

func (p *ProcessTransport) abandon(key string) {
	overflow := false
	p.pendingMu.Lock()
	request, ok := p.pending[key]
	if ok {
		delete(p.pending, key)
		request.abandoned = true
		overflow = !p.addAbandonedLocked(key, request)
	}
	p.pendingMu.Unlock()
	if overflow {
		p.failRPCStateOverflow()
	}
}

func (p *ProcessTransport) addAbandonedLocked(key string, request pendingRPC) bool {
	if p.abandoned == nil {
		p.abandoned = make(map[string]pendingRPC)
	}
	if _, exists := p.abandoned[key]; !exists && len(p.abandoned) >= maxAbandonedRPC {
		return false
	}
	p.abandoned[key] = request
	return true
}

func (p *ProcessTransport) failRPCStateOverflow() {
	p.setError(ErrRPCStateOverflow)
	p.finishTransport(ErrRPCStateOverflow)
	go func() { _ = p.Close() }()
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
	return p.writeMessageContext(ctx, map[string]json.RawMessage{
		"jsonrpc": json.RawMessage(`"2.0"`),
		"method":  json.RawMessage(mustJSON(method)),
		"params":  append(json.RawMessage(nil), params...),
	}, nil)
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
	return p.writeMessageContext(ctx, map[string]json.RawMessage{
		"jsonrpc": json.RawMessage(`"2.0"`),
		"id":      append(json.RawMessage(nil), id...),
		"result":  append(json.RawMessage(nil), result...),
	}, nil)
}

func (p *ProcessTransport) Events() <-chan RPCMessage { return p.events }

func (p *ProcessTransport) Close() error {
	p.closeRequested.Store(true)
	p.stopEventDispatch()
	p.closed.Do(func() {
		if p.stdin != nil {
			_ = p.stdin.Close()
		}
		if p.command != nil && p.command.Process != nil {
			if err := killProcessGroup(p.command); err != nil {
				_ = p.command.Process.Kill()
			}
		}
		if p.stdout != nil {
			_ = p.stdout.Close()
		}
	})
	<-p.done
	<-p.waitDone
	<-p.readDone
	if p.eventDispatchDone != nil {
		<-p.eventDispatchDone
	}
	p.errMu.Lock()
	defer p.errMu.Unlock()
	return p.err
}

func (p *ProcessTransport) nextID() json.RawMessage {
	return json.RawMessage(fmt.Sprintf("%d", p.id.Add(1)))
}

func (p *ProcessTransport) writeRequest(ctx context.Context, id json.RawMessage, method string, params json.RawMessage) error {
	return p.writeMessageContext(ctx, map[string]json.RawMessage{
		"jsonrpc": json.RawMessage(`"2.0"`),
		"id":      append(json.RawMessage(nil), id...),
		"method":  json.RawMessage(mustJSON(method)),
		"params":  append(json.RawMessage(nil), params...),
	}, func() {
		if p.afterRequestWrite != nil {
			p.afterRequestWrite(method)
		}
	})
}

func (p *ProcessTransport) writeMessage(fields map[string]json.RawMessage) error {
	return p.writeMessageContext(context.Background(), fields, nil)
}

func (p *ProcessTransport) writeMessageContext(ctx context.Context, fields map[string]json.RawMessage, afterWrite func()) error {
	if ctx == nil {
		return errors.New("RPC write context must not be nil")
	}
	data, err := json.Marshal(fields)
	if err != nil {
		return fmt.Errorf("encode RPC message: %w", err)
	}
	data = append(data, '\n')
	type writeResult struct {
		written int
		err     error
	}
	result := make(chan writeResult, 1)
	go func() {
		p.writeMu.Lock()
		select {
		case <-p.done:
			p.writeMu.Unlock()
			result <- writeResult{err: ErrTransportClosed}
			return
		default:
		}
		written, writeErr := writeAll(p.stdin, data)
		p.writeMu.Unlock()
		result <- writeResult{written: written, err: writeErr}
		if writeErr == nil && afterWrite != nil {
			afterWrite()
		}
	}()
	select {
	case value := <-result:
		if value.err != nil {
			return &TransportWriteError{BytesWritten: value.written, Err: value.err, Unknown: value.written > 0}
		}
		return nil
	case <-ctx.Done():
		select {
		case value := <-result:
			if value.err != nil {
				return &TransportWriteError{BytesWritten: value.written, Err: value.err, Unknown: value.written > 0}
			}
			return nil
		default:
		}
		// A blocked pipe write cannot be interrupted portably through io.Writer.
		// Closing the owned transport is the only bounded way to stop it while
		// preserving the unknown-outcome classification for the caller.
		go func() { _ = p.Close() }()
		return &TransportWriteError{Err: ctx.Err(), Unknown: true}
	}
}

func (p *ProcessTransport) readLoop() {
	defer func() {
		if p.eventCond == nil {
			p.eventsClosed.Do(func() { close(p.events) })
		}
		close(p.readDone)
	}()
	reader := bufio.NewReaderSize(p.stdout, 64*1024)
	for {
		frame, err := readJSONLFrame(reader, p.maxFrameBytes)
		if err != nil {
			if !p.closeRequested.Load() && !errors.Is(err, io.EOF) {
				p.setError(err)
			}
			p.finishTransport(err)
			if !p.closeRequested.Load() && !errors.Is(err, io.EOF) {
				go func() { _ = p.Close() }()
			}
			return
		}
		message, err := parseRPCMessage(frame)
		if err != nil {
			p.setError(err)
			p.finishTransport(err)
			if !p.closeRequested.Load() {
				go func() { _ = p.Close() }()
			}
			return
		}
		if message.IsResponse() {
			key := string(bytes.TrimSpace(message.ID))
			p.pendingMu.Lock()
			request, ok := p.pending[key]
			if ok {
				if request.writing {
					response := message
					request.earlyResponse = &response
					p.pending[key] = request
					p.pendingMu.Unlock()
					continue
				}
				delete(p.pending, key)
			} else {
				request, ok = p.abandoned[key]
				if ok {
					delete(p.abandoned, key)
					request.abandoned = true
				}
			}
			p.pendingMu.Unlock()
			if ok {
				if request.method != "" {
					message.operation = request.method
				}
				message.runID = request.runID
				message.commandID = request.commandID
				message.observation = request.observation
				if request.abandoned {
					if err := p.enqueueEvent(message); err != nil {
						p.setError(err)
						p.finishTransport(err)
						go func() { _ = p.Close() }()
						return
					}
					continue
				}
				p.deliverResponse(request, message)
				continue
			}
		}
		if err := p.enqueueEvent(message); err != nil {
			p.setError(err)
			p.finishTransport(err)
			go func() { _ = p.Close() }()
			return
		}
	}
}

func (p *ProcessTransport) deliverResponse(request pendingRPC, message RPCMessage) {
	message = responseForPending(request, message)
	if p.closeRequested.Load() || transportDone(p.done) {
		message.observation = nil
		request.result <- rpcResult{message: message}
		return
	}
	if err := p.enqueueEvent(message); err != nil {
		if errors.Is(err, ErrTransportClosed) || p.closeRequested.Load() || transportDone(p.done) {
			message.observation = nil
			request.result <- rpcResult{message: message}
			return
		}
		p.setError(err)
		p.finishTransport(err)
		go func() { _ = p.Close() }()
		request.result <- rpcResult{err: fmt.Errorf("%w: %v", ErrUnknownOutcome, err)}
		return
	}
	request.result <- rpcResult{message: message}
}

func (p *ProcessTransport) deliverResponseBeforeFinish(request pendingRPC, message RPCMessage) bool {
	message = responseForPending(request, message)
	if p.closeRequested.Load() || transportDone(p.done) {
		message.observation = nil
		request.result <- rpcResult{message: message}
		return true
	}
	if err := p.enqueueEvent(message); err != nil {
		if errors.Is(err, ErrTransportClosed) || p.closeRequested.Load() || transportDone(p.done) {
			message.observation = nil
			request.result <- rpcResult{message: message}
			return true
		}
		notifyRPCObservation(message.observation, rpcObservation{err: ErrUnknownOutcome})
		return false
	}
	request.result <- rpcResult{message: message}
	return true
}

func responseForPending(request pendingRPC, message RPCMessage) RPCMessage {
	if message.operation == "" {
		message.operation = request.method
	}
	message.runID = request.runID
	message.commandID = request.commandID
	message.observation = request.observation
	return message
}

func (p *ProcessTransport) enqueueEvent(message RPCMessage) error {
	if p.eventCond == nil {
		if p.closeRequested.Load() || transportDone(p.done) {
			notifyRPCObservation(message.observation, rpcObservation{err: ErrTransportClosed})
			return ErrTransportClosed
		}
		select {
		case p.events <- message:
			return nil
		case <-p.done:
			return ErrTransportClosed
		}
	}
	p.eventMu.Lock()
	if p.eventDispatchStopped || p.closeRequested.Load() || transportDone(p.done) {
		p.eventMu.Unlock()
		notifyRPCObservation(message.observation, rpcObservation{err: ErrTransportClosed})
		return ErrTransportClosed
	}
	messageBytes := rpcMessageQueueCost(message)
	if messageBytes > maxEventQueueBytes || p.eventQueueBytes > maxEventQueueBytes-messageBytes {
		p.eventMu.Unlock()
		return ErrEventQueueOverflow
	}
	p.eventQueue = append(p.eventQueue, message)
	p.eventQueueBytes += messageBytes
	p.eventCond.Signal()
	p.eventMu.Unlock()
	return nil
}

func (p *ProcessTransport) dispatchEvents() {
	if p.eventCond == nil {
		return
	}
	defer close(p.eventDispatchDone)
	for {
		p.eventMu.Lock()
		for len(p.eventQueue) == 0 && !p.closeRequested.Load() && !transportDone(p.done) {
			p.eventCond.Wait()
		}
		if p.closeRequested.Load() {
			discarded := p.eventQueue
			p.eventQueue = nil
			p.eventQueueBytes = 0
			p.eventDispatchStopped = true
			p.eventMu.Unlock()
			notifyRPCObservations(discarded, ErrTransportClosed)
			p.eventsClosed.Do(func() { close(p.events) })
			return
		}
		if len(p.eventQueue) == 0 && transportDone(p.done) {
			p.eventDispatchStopped = true
			p.eventMu.Unlock()
			p.eventsClosed.Do(func() { close(p.events) })
			return
		}
		message := p.eventQueue[0]
		p.eventQueue[0] = RPCMessage{}
		p.eventQueue = p.eventQueue[1:]
		messageBytes := rpcMessageQueueCost(message)
		p.eventQueueBytes -= messageBytes
		p.eventMu.Unlock()
		select {
		case p.events <- message:
		case <-p.eventStop:
			p.eventMu.Lock()
			discarded := append([]RPCMessage{message}, p.eventQueue...)
			p.eventQueue = nil
			p.eventQueueBytes = 0
			p.eventDispatchStopped = true
			p.eventMu.Unlock()
			notifyRPCObservations(discarded, ErrTransportClosed)
			p.eventsClosed.Do(func() { close(p.events) })
			return
		}
	}
}

func transportDone(done <-chan struct{}) bool {
	select {
	case <-done:
		return true
	default:
		return false
	}
}

func rpcMessageQueueCost(message RPCMessage) int {
	cost := eventQueueMessageOverhead + len(message.Raw) + len(message.ID) + len(message.Method) + len(message.Params) + len(message.Result) + len(message.operation) + len(message.runID) + len(message.commandID)
	if message.Error != nil {
		cost += eventQueueMessageOverhead + len(message.Error.Message) + len(message.Error.Data)
	}
	if cost < eventQueueMessageOverhead {
		return eventQueueMessageOverhead
	}
	return cost
}

func (p *ProcessTransport) stopEventDispatch() {
	if p.eventCond == nil {
		return
	}
	p.eventStopOnce.Do(func() {
		close(p.eventStop)
		p.eventMu.Lock()
		p.eventCond.Broadcast()
		p.eventMu.Unlock()
	})
}

func (p *ProcessTransport) waitLoop() {
	err := p.command.Wait()
	if err != nil && !p.closeRequested.Load() && !errors.Is(err, os.ErrProcessDone) {
		p.setError(err)
	}
	if p.closeRequested.Load() {
		// A caller-initiated close must unblock a reader that is backpressured
		// by an abandoned events queue.
		p.finishTransport(err)
	} else {
		// A child can leave descendants holding the inherited stdout pipe open
		// after the leader exits. Kill the owned process group before waiting for
		// readLoop so natural process exit cannot strand Close forever.
		_ = killProcessGroup(p.command)
		// stdout is an explicitly-owned pipe, so Wait cannot close it before
		// readLoop has drained the child's final frames.
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-p.readDone:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		case <-timer.C:
			_ = p.stdout.Close()
			<-p.readDone
		}
	}
	p.finishTransport(err)
	close(p.waitDone)
}

func (p *ProcessTransport) finishTransport(err error) {
	p.finish.Do(func() {
		if err != nil && !p.closeRequested.Load() && !errors.Is(err, io.EOF) {
			p.setError(err)
		}
		p.pendingMu.Lock()
		pending := p.pending
		p.pending = make(map[string]pendingRPC)
		p.abandoned = make(map[string]pendingRPC)
		p.pendingMu.Unlock()
		for _, request := range pending {
			if request.earlyResponse != nil && p.deliverResponseBeforeFinish(request, *request.earlyResponse) {
				continue
			}
			if request.sent || request.writing {
				request.result <- rpcResult{err: ErrUnknownOutcome}
			} else {
				request.result <- rpcResult{err: ErrTransportClosed}
			}
		}
		close(p.done)
		if p.eventCond != nil {
			p.eventMu.Lock()
			p.eventCond.Broadcast()
			p.eventMu.Unlock()
		}
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

func notifyRPCObservations(messages []RPCMessage, err error) {
	for _, message := range messages {
		notifyRPCObservation(message.observation, rpcObservation{err: err})
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
	if version, ok := fields["jsonrpc"]; ok {
		var jsonrpc string
		if err := json.Unmarshal(version, &jsonrpc); err != nil || jsonrpc != "2.0" {
			return RPCMessage{}, errors.New("RPC message must use jsonrpc version 2.0 when provided")
		}
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
	if message.Error != nil && len(bytes.TrimSpace(message.Result)) > 0 {
		return RPCMessage{}, errors.New("RPC response must not contain both result and error")
	}
	if message.Method == "" && len(message.ID) == 0 {
		return RPCMessage{}, errors.New("RPC message has neither method nor id")
	}
	return message, nil
}

func rpcRequestRunID(method string, params json.RawMessage) string {
	if method != "turn/interrupt" && method != "turn/steer" {
		return ""
	}
	var value struct {
		TurnID         string `json:"turnId"`
		ExpectedTurnID string `json:"expectedTurnId"`
	}
	if json.Unmarshal(params, &value) != nil {
		return ""
	}
	if value.TurnID != "" {
		return value.TurnID
	}
	return value.ExpectedTurnID
}

func sanitizedCommandEnv() []string {
	allowed := []string{
		"HOME", "PATH", "USER", "LOGNAME", "SHELL", "PWD", "TMPDIR", "TMP", "TEMP",
		"LANG", "TERM", "COLORTERM", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CODEX_HOME",
		"USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SystemRoot",
		"WINDIR", "ComSpec", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE",
	}
	env := make([]string, 0, len(allowed))
	for _, name := range allowed {
		value, ok := os.LookupEnv(name)
		if ok {
			env = append(env, name+"="+value)
		}
	}
	return env
}

func mustJSON(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}
