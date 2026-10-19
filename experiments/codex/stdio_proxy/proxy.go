package stdioproxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Client string

const (
	ClientDesktop Client = "desktop"
	ClientBridge  Client = "bridge"

	localInvalidRequestCode        = -32600
	localDesktopInitializationCode = -32001
	localDesktopOwnedCode          = -32002

	proxyIDPrefix = "loomhelm-proxy:"
)

type Config struct {
	ChildPath       string
	ChildArgs       []string
	ChildEnv        []string
	ChildDir        string
	SocketPath      string
	DesktopIn       io.Reader
	DesktopOut      io.Writer
	ChildStderr     io.Writer
	MaxFrameBytes   int
	BridgeQueueSize int
	Generation      string
	Logger          *slog.Logger
}

func Run(ctx context.Context, cfg Config) error {
	if err := ValidateChildPath(cfg.ChildPath, ""); err != nil {
		return err
	}
	if ctx == nil {
		return fmt.Errorf("proxy context must not be nil")
	}

	cmd := exec.Command(cfg.ChildPath, cfg.ChildArgs...)
	return runWithCommand(ctx, cfg, cmd)
}

func ValidateChildPath(path, wrapperPath string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("real child path must not be empty")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve real child path: %w", err)
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return fmt.Errorf("stat real child path: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("real child path must be a regular file")
	}

	resolvedChild, err := filepath.EvalSymlinks(absPath)
	if err != nil {
		return fmt.Errorf("resolve real child symlinks: %w", err)
	}
	if wrapperPath == "" {
		wrapperPath, err = os.Executable()
		if err != nil {
			return fmt.Errorf("resolve proxy executable: %w", err)
		}
	}
	absWrapper, err := filepath.Abs(wrapperPath)
	if err != nil {
		return fmt.Errorf("resolve proxy executable path: %w", err)
	}
	resolvedWrapper, err := filepath.EvalSymlinks(absWrapper)
	if err != nil {
		return fmt.Errorf("resolve proxy executable symlinks: %w", err)
	}
	if resolvedChild == resolvedWrapper {
		return fmt.Errorf("real child path must not point to the stdio proxy itself")
	}
	return nil
}

func ChildEnvironment(parent []string, realChildPath string) []string {
	if parent == nil {
		parent = os.Environ()
	}
	childPath, err := filepath.Abs(realChildPath)
	if err != nil {
		childPath = realChildPath
	}

	env := make([]string, 0, len(parent)+1)
	replacedCLIPath := false
	for _, entry := range parent {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || strings.HasPrefix(key, "LOOMHELM_STDIO_PROXY_") {
			continue
		}
		if key == "CODEX_CLI_PATH" {
			if !replacedCLIPath {
				env = append(env, "CODEX_CLI_PATH="+childPath)
				replacedCLIPath = true
			}
			continue
		}
		env = append(env, entry)
	}

	if !replacedCLIPath {
		env = append(env, "CODEX_CLI_PATH="+childPath)
	}
	return env
}

func runWithCommand(ctx context.Context, cfg Config, cmd *exec.Cmd) error {
	if ctx == nil {
		return fmt.Errorf("proxy context must not be nil")
	}
	cfg, err := cfg.normalized()
	if err != nil {
		return err
	}
	if cmd == nil {
		return fmt.Errorf("child command must not be nil")
	}

	listener, err := listenPrivateSocket(cfg.SocketPath)
	if err != nil {
		return err
	}
	defer os.Remove(cfg.SocketPath)

	childIn, err := cmd.StdinPipe()
	if err != nil {
		listener.Close()
		return fmt.Errorf("create child stdin: %w", err)
	}
	childOut, err := cmd.StdoutPipe()
	if err != nil {
		childIn.Close()
		listener.Close()
		return fmt.Errorf("create child stdout: %w", err)
	}
	cmd.Stderr = cfg.ChildStderr
	cmd.Env = append([]string(nil), cfg.ChildEnv...)
	if cfg.ChildDir != "" {
		cmd.Dir = cfg.ChildDir
	}
	if err := cmd.Start(); err != nil {
		childIn.Close()
		childOut.Close()
		listener.Close()
		return fmt.Errorf("start child: %w", err)
	}

	proxy := newProxy(cfg, listener, childIn, childOut, cmd)
	proxy.logger.Info("stdio proxy started", "generation", proxy.generation, "child_pid", cmd.Process.Pid, "socket", cfg.SocketPath)
	go proxy.readChild()
	go proxy.readDesktop()
	go proxy.acceptBridges()

	waitResult := make(chan error, 1)
	go func() { waitResult <- cmd.Wait() }()
	return proxy.wait(ctx, waitResult)
}

func (c Config) normalized() (Config, error) {
	if strings.TrimSpace(c.ChildPath) == "" {
		return Config{}, fmt.Errorf("child path must not be empty")
	}
	if strings.TrimSpace(c.SocketPath) == "" {
		return Config{}, fmt.Errorf("socket path must not be empty")
	}
	if !filepath.IsAbs(c.SocketPath) {
		return Config{}, fmt.Errorf("socket path must be absolute")
	}
	if c.DesktopIn == nil {
		return Config{}, fmt.Errorf("desktop input must not be nil")
	}
	if c.DesktopOut == nil {
		return Config{}, fmt.Errorf("desktop output must not be nil")
	}
	if c.MaxFrameBytes == 0 {
		c.MaxFrameBytes = DefaultMaxFrameBytes
	}
	if c.MaxFrameBytes < 1024 {
		return Config{}, fmt.Errorf("maximum frame size must be at least 1024 bytes")
	}
	if c.BridgeQueueSize == 0 {
		c.BridgeQueueSize = 64
	}
	if c.BridgeQueueSize < 1 {
		return Config{}, fmt.Errorf("bridge queue size must be positive")
	}
	if c.ChildEnv == nil {
		c.ChildEnv = os.Environ()
	}
	if c.ChildStderr == nil {
		c.ChildStderr = os.Stderr
	}
	if c.Logger == nil {
		c.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	c.ChildArgs = append([]string(nil), c.ChildArgs...)
	c.ChildEnv = append([]string(nil), c.ChildEnv...)
	return c, nil
}

type proxy struct {
	cfg      Config
	listener net.Listener
	childIn  io.WriteCloser
	childOut io.ReadCloser
	command  *exec.Cmd
	logger   *slog.Logger

	childWriteMu     sync.Mutex
	childInputClosed bool
	childCloseOnce   sync.Once

	desktopWriteMu sync.Mutex

	stateMu                    sync.Mutex
	desktopInitializePending   bool
	desktopInitializeResponded bool
	desktopInitializedNotified bool
	desktopReadyState          bool
	pendingClient              map[string]pendingClientRequest
	pendingServer              map[string]*pendingServerRequest
	serverByClientID           map[string]serverResponseRoute

	bridgeMu sync.Mutex
	bridge   *bridgeSession

	idMu       sync.Mutex
	idSequence uint64
	generation string

	shutdownOnce sync.Once
	shutdownCh   chan struct{}
	fatalCh      chan error
}

type pendingClientRequest struct {
	client     Client
	originalID json.RawMessage
	method     string
}

type pendingServerRequest struct {
	childID json.RawMessage
	method  string
	routes  map[Client]json.RawMessage
}

type serverResponseRoute struct {
	request *pendingServerRequest
	client  Client
}

func newProxy(cfg Config, listener net.Listener, childIn io.WriteCloser, childOut io.ReadCloser, command *exec.Cmd) *proxy {
	generation := cfg.Generation
	if generation == "" {
		generation = fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return &proxy{
		cfg:              cfg,
		listener:         listener,
		childIn:          childIn,
		childOut:         childOut,
		command:          command,
		logger:           cfg.Logger,
		pendingClient:    make(map[string]pendingClientRequest),
		pendingServer:    make(map[string]*pendingServerRequest),
		serverByClientID: make(map[string]serverResponseRoute),
		generation:       generation,
		shutdownCh:       make(chan struct{}),
		fatalCh:          make(chan error, 1),
	}
}

func (p *proxy) wait(ctx context.Context, waitResult <-chan error) error {
	select {
	case err := <-waitResult:
		p.shutdownClients()
		p.logger.Info("stdio proxy child exited", "generation", p.generation, "error", err)
		return err
	case err := <-p.fatalCh:
		p.logger.Error("stdio proxy protocol failure", "error", err)
		p.shutdownClients()
		childErr := p.stopChild(waitResult)
		if childErr != nil {
			return fmt.Errorf("proxy stopped after protocol failure: %w", childErr)
		}
		return err
	case <-ctx.Done():
		p.shutdownClients()
		childErr := p.stopChild(waitResult)
		if childErr != nil {
			return childErr
		}
		return nil
	}
}

func (p *proxy) stopChild(waitResult <-chan error) error {
	if p.command.Process == nil {
		return <-waitResult
	}
	if err := p.command.Process.Signal(os.Interrupt); err != nil && !errors.Is(err, os.ErrProcessDone) {
		p.logger.Warn("failed to interrupt child", "error", err)
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case err := <-waitResult:
		return err
	case <-timer.C:
		if err := p.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			p.logger.Warn("failed to kill child after interrupt timeout", "error", err)
		}
		return <-waitResult
	}
}

func (p *proxy) reportFatal(err error) {
	if err == nil {
		return
	}
	select {
	case p.fatalCh <- err:
	default:
	}
}

func (p *proxy) shutdownClients() {
	p.shutdownOnce.Do(func() {
		close(p.shutdownCh)
		_ = p.listener.Close()
	})
	if bridge := p.currentBridge(); bridge != nil {
		p.detachBridge(bridge)
	}
	p.failBridgePending()
}

func (p *proxy) readChild() {
	reader := newBufferedReader(p.childOut)
	for {
		frame, err := readFrame(reader, p.cfg.MaxFrameBytes)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				p.reportFatal(fmt.Errorf("read child stdout: %w", err))
			}
			return
		}
		if err := p.handleChildFrame(frame); err != nil {
			p.reportFatal(err)
			return
		}
	}
}

func (p *proxy) readDesktop() {
	reader := newBufferedReader(p.cfg.DesktopIn)
	for {
		frame, err := readFrame(reader, p.cfg.MaxFrameBytes)
		if err != nil {
			p.closeChildInput()
			if !errors.Is(err, io.EOF) {
				p.logger.Warn("desktop input closed with error", "error", err)
			}
			return
		}
		if err := p.handleClientFrame(ClientDesktop, frame); err != nil {
			p.reportFatal(err)
			return
		}
	}
}

func (p *proxy) acceptBridges() {
	for {
		connection, err := p.listener.Accept()
		if err != nil {
			select {
			case <-p.shutdownCh:
				return
			default:
			}
			p.logger.Warn("bridge accept failed", "error", err)
			return
		}

		if previous := p.currentBridge(); previous != nil {
			p.detachBridge(previous)
		}
		session := newBridgeSession(connection, p.cfg.BridgeQueueSize)
		p.bridgeMu.Lock()
		p.bridge = session
		p.bridgeMu.Unlock()
		go p.writeBridge(session)
		go p.readBridge(session)
	}
}

func (p *proxy) readBridge(session *bridgeSession) {
	defer p.detachBridge(session)
	reader := newBufferedReader(session.connection)
	for {
		frame, err := readFrame(reader, p.cfg.MaxFrameBytes)
		if err != nil {
			return
		}
		if err := p.handleClientFrame(ClientBridge, frame); err != nil {
			p.logger.Warn("bridge protocol failure", "error", err)
			return
		}
	}
}

func (p *proxy) writeBridge(session *bridgeSession) {
	for {
		select {
		case <-session.done:
			return
		case frame := <-session.queue:
			if err := writeFrame(session.connection, frame); err != nil {
				p.detachBridge(session)
				return
			}
		}
	}
}

func (p *proxy) handleClientFrame(client Client, frame []byte) error {
	message, err := parseRPCMessage(frame)
	if err != nil {
		return fmt.Errorf("decode %s frame: %w", client, err)
	}
	if message.hasMethod {
		if message.hasID {
			return p.handleClientRequest(client, message, frame)
		}
		return p.handleClientNotification(client, message, frame)
	}
	if message.hasID {
		return p.handleClientResponse(client, message, frame)
	}
	return fmt.Errorf("%s frame is neither a request, notification, nor response", client)
}

func (p *proxy) handleClientRequest(client Client, message rpcMessage, frame []byte) error {
	if isNullID(message.id) {
		return p.sendClientError(client, message.id, localInvalidRequestCode, "request id must not be null")
	}
	if message.method == "initialize" {
		if client != ClientDesktop {
			return p.sendClientError(client, message.id, localDesktopOwnedCode, "initialize is owned by the Desktop client")
		}
		if !p.beginDesktopInitialize() {
			return p.sendClientError(client, message.id, localInvalidRequestCode, "Desktop initialize has already started")
		}
	}
	if client == ClientBridge {
		if isOwnerBoundMethod(message.method) {
			return p.sendClientError(client, message.id, localDesktopOwnedCode, "this callback is owned by the Desktop client")
		}
		if !p.desktopReady() {
			return p.sendClientError(client, message.id, localDesktopInitializationCode, "Desktop initialize has not completed")
		}
	}

	proxyID := p.nextProxyID("client")
	mappedFrame, err := withID(frame, proxyID)
	if err != nil {
		return fmt.Errorf("rewrite %s request id: %w", client, err)
	}
	p.stateMu.Lock()
	p.pendingClient[idKey(proxyID)] = pendingClientRequest{
		client:     client,
		originalID: append(json.RawMessage(nil), message.id...),
		method:     message.method,
	}
	p.stateMu.Unlock()
	if err := p.sendToChild(mappedFrame); err != nil {
		if writeErr, ok := err.(*frameWriteError); ok && writeErr.BytesWritten > 0 {
			p.logger.Error("child request delivery is unknown; request will not be resent", "client", client, "method", message.method, "error", err)
			return nil
		}
		p.removePendingClient(proxyID)
		return err
	}
	return nil
}

func (p *proxy) handleClientNotification(client Client, message rpcMessage, frame []byte) error {
	if message.method == "initialized" {
		if client != ClientDesktop {
			return nil
		}
		p.markDesktopInitializedNotification()
	}
	if client == ClientBridge {
		if isOwnerBoundMethod(message.method) || !p.desktopReady() {
			return nil
		}
	}
	return p.sendToChild(frame)
}

func (p *proxy) handleClientResponse(client Client, message rpcMessage, frame []byte) error {
	if !message.isValidResponse() {
		p.logger.Warn("ignoring invalid or incomplete client response", "client", client, "id", string(message.id))
		return nil
	}

	key := clientResponseKey(client, message.id)
	p.stateMu.Lock()
	route, ok := p.serverByClientID[key]
	if !ok {
		p.stateMu.Unlock()
		p.logger.Warn("ignoring unknown or late client response", "client", client, "id", string(message.id))
		return nil
	}
	delete(p.serverByClientID, key)
	for target, proxyID := range route.request.routes {
		delete(p.serverByClientID, clientResponseKey(target, proxyID))
	}
	delete(p.pendingServer, idKey(route.request.childID))
	p.stateMu.Unlock()

	mappedFrame, err := withID(frame, route.request.childID)
	if err != nil {
		return fmt.Errorf("rewrite %s response id: %w", client, err)
	}
	if err := p.sendToChild(mappedFrame); err != nil {
		if writeErr, ok := err.(*frameWriteError); ok && writeErr.BytesWritten > 0 {
			p.logger.Error("approval or callback delivery is unknown; response will not be resent", "client", client, "method", route.request.method, "error", err)
		}
		return err
	}
	return nil
}

func (p *proxy) handleChildFrame(frame []byte) error {
	message, err := parseRPCMessage(frame)
	if err != nil {
		p.logger.Warn("broadcasting non-JSON child frame as opaque data", "error", err)
		return p.broadcast(frame)
	}
	if message.hasMethod {
		if message.hasID {
			return p.handleChildRequest(message, frame)
		}
		return p.handleChildNotification(message, frame)
	}
	if message.hasID {
		return p.handleChildResponse(message, frame)
	}
	return p.broadcast(frame)
}

func (p *proxy) handleChildResponse(message rpcMessage, frame []byte) error {
	if !message.isValidResponse() {
		return fmt.Errorf("child emitted an invalid JSON-RPC response")
	}
	p.stateMu.Lock()
	pending, ok := p.pendingClient[idKey(message.id)]
	if ok {
		delete(p.pendingClient, idKey(message.id))
	}
	p.stateMu.Unlock()
	if !ok {
		p.logger.Warn("ignoring child response with unknown id", "id", string(message.id))
		return nil
	}

	if pending.method == "initialize" && pending.client == ClientDesktop {
		p.markDesktopInitializeResponse(message.hasResult && !message.hasError)
	}
	mappedFrame, err := withID(frame, pending.originalID)
	if err != nil {
		return fmt.Errorf("restore child response id: %w", err)
	}
	return p.sendToClient(pending.client, mappedFrame)
}

func (p *proxy) handleChildNotification(message rpcMessage, frame []byte) error {
	if isOwnerBoundMethod(message.method) {
		return p.sendToDesktop(frame)
	}
	return p.broadcast(frame)
}

func (p *proxy) handleChildRequest(message rpcMessage, frame []byte) error {
	if isNullID(message.id) {
		return fmt.Errorf("child server request %q has a null id", message.method)
	}
	if isProxyID(message.id) {
		return fmt.Errorf("child server request %q used the reserved proxy id namespace", message.method)
	}

	approval := isOrdinaryApprovalMethod(message.method) && !isOwnerBoundMethod(message.method)
	bridge := p.currentBridge()
	targets := []Client{ClientDesktop}
	if approval && bridge != nil {
		targets = append(targets, ClientBridge)
	}

	request := &pendingServerRequest{
		childID: append(json.RawMessage(nil), message.id...),
		method:  message.method,
		routes:  make(map[Client]json.RawMessage, len(targets)),
	}
	childKey := idKey(message.id)
	p.stateMu.Lock()
	if _, exists := p.pendingServer[childKey]; exists {
		p.stateMu.Unlock()
		return fmt.Errorf("child reused active server request id %s", childKey)
	}
	for _, target := range targets {
		proxyID := p.nextProxyID(string(target))
		request.routes[target] = proxyID
		p.serverByClientID[clientResponseKey(target, proxyID)] = serverResponseRoute{request: request, client: target}
	}
	p.pendingServer[childKey] = request
	p.stateMu.Unlock()

	for _, target := range targets {
		proxyID := request.routes[target]
		mappedFrame, err := withID(frame, proxyID)
		if err != nil {
			return fmt.Errorf("rewrite child request %q id: %w", message.method, err)
		}
		if target == ClientBridge {
			if bridge == nil || !p.enqueueBridge(bridge, mappedFrame) {
				p.removeServerRoute(request, target, proxyID)
			}
			continue
		}
		if err := p.sendToDesktop(mappedFrame); err != nil {
			return err
		}
	}
	return nil
}

func (p *proxy) sendClientError(client Client, id json.RawMessage, code int, message string) error {
	frame, err := errorFrame(id, code, message)
	if err != nil {
		return err
	}
	return p.sendToClient(client, frame)
}

func (p *proxy) sendToChild(frame []byte) error {
	p.childWriteMu.Lock()
	defer p.childWriteMu.Unlock()
	if p.childInputClosed {
		return io.ErrClosedPipe
	}
	return writeFrame(p.childIn, frame)
}

func (p *proxy) closeChildInput() {
	p.childCloseOnce.Do(func() {
		p.childWriteMu.Lock()
		p.childInputClosed = true
		p.childWriteMu.Unlock()
		_ = p.childIn.Close()
	})
}

func (p *proxy) sendToClient(client Client, frame []byte) error {
	if client == ClientDesktop {
		return p.sendToDesktop(frame)
	}
	if client != ClientBridge {
		return fmt.Errorf("unknown client %q", client)
	}
	bridge := p.currentBridge()
	if bridge == nil {
		return nil
	}
	p.enqueueBridge(bridge, frame)
	return nil
}

func (p *proxy) sendToDesktop(frame []byte) error {
	p.desktopWriteMu.Lock()
	defer p.desktopWriteMu.Unlock()
	return writeFrame(p.cfg.DesktopOut, frame)
}

func (p *proxy) broadcast(frame []byte) error {
	if err := p.sendToDesktop(frame); err != nil {
		return fmt.Errorf("write frame to Desktop: %w", err)
	}
	if bridge := p.currentBridge(); bridge != nil {
		p.enqueueBridge(bridge, frame)
	}
	return nil
}

func (p *proxy) enqueueBridge(bridge *bridgeSession, frame []byte) bool {
	if bridge.enqueue(frame) {
		return true
	}
	p.detachBridge(bridge)
	p.logger.Warn("bridge disconnected after bounded queue reached capacity", "queue_size", p.cfg.BridgeQueueSize)
	return false
}

func (p *proxy) beginDesktopInitialize() bool {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.desktopInitializePending || p.desktopInitializeResponded {
		return false
	}
	p.desktopInitializePending = true
	return true
}

func (p *proxy) markDesktopInitializeResponse(success bool) {
	p.stateMu.Lock()
	p.desktopInitializePending = false
	p.desktopInitializeResponded = success
	p.desktopReadyState = success && p.desktopInitializedNotified
	p.stateMu.Unlock()
}

func (p *proxy) markDesktopInitializedNotification() {
	p.stateMu.Lock()
	p.desktopInitializedNotified = true
	p.desktopReadyState = p.desktopInitializeResponded
	p.stateMu.Unlock()
}

func (p *proxy) desktopReady() bool {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	return p.desktopReadyState
}

func (p *proxy) removePendingClient(proxyID json.RawMessage) {
	p.stateMu.Lock()
	delete(p.pendingClient, idKey(proxyID))
	p.stateMu.Unlock()
}

func (p *proxy) removeServerRoute(request *pendingServerRequest, client Client, proxyID json.RawMessage) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	key := clientResponseKey(client, proxyID)
	delete(p.serverByClientID, key)
	if current, ok := request.routes[client]; ok && idKey(current) == idKey(proxyID) {
		delete(request.routes, client)
	}
	if len(request.routes) == 0 {
		delete(p.pendingServer, idKey(request.childID))
	}
}

func (p *proxy) failBridgePending() {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	for key, pending := range p.pendingClient {
		if pending.client == ClientBridge {
			delete(p.pendingClient, key)
		}
	}
	for childKey, request := range p.pendingServer {
		if proxyID, ok := request.routes[ClientBridge]; ok {
			delete(p.serverByClientID, clientResponseKey(ClientBridge, proxyID))
			delete(request.routes, ClientBridge)
		}
		if len(request.routes) == 0 {
			delete(p.pendingServer, childKey)
		}
	}
}

func (p *proxy) currentBridge() *bridgeSession {
	p.bridgeMu.Lock()
	defer p.bridgeMu.Unlock()
	return p.bridge
}

func (p *proxy) detachBridge(session *bridgeSession) {
	if session == nil {
		return
	}
	p.bridgeMu.Lock()
	current := p.bridge == session
	if current {
		p.bridge = nil
	}
	p.bridgeMu.Unlock()
	session.close()
	if current {
		p.failBridgePending()
	}
}

func (p *proxy) nextProxyID(role string) json.RawMessage {
	p.idMu.Lock()
	p.idSequence++
	sequence := p.idSequence
	p.idMu.Unlock()
	value := fmt.Sprintf("%s%s:%s:%d", proxyIDPrefix, p.generation, role, sequence)
	encoded, _ := json.Marshal(value)
	return encoded
}

func idKey(id json.RawMessage) string {
	return string(bytes.TrimSpace(id))
}

func clientResponseKey(client Client, id json.RawMessage) string {
	return string(client) + "\x00" + idKey(id)
}

func isProxyID(id json.RawMessage) bool {
	var value string
	if err := json.Unmarshal(id, &value); err != nil {
		return false
	}
	return strings.HasPrefix(value, proxyIDPrefix)
}

func isOrdinaryApprovalMethod(method string) bool {
	normalized := strings.ToLower(method)
	return normalized == "requestapproval" || strings.HasSuffix(normalized, "/requestapproval")
}

func isOwnerBoundMethod(method string) bool {
	normalized := strings.ToLower(method)
	return strings.Contains(normalized, "userverification") ||
		strings.Contains(normalized, "mcp") ||
		strings.HasPrefix(normalized, "account/") ||
		strings.Contains(normalized, "plugin")
}

func newBufferedReader(reader io.Reader) *bufio.Reader {
	return bufio.NewReader(reader)
}

func listenPrivateSocket(path string) (net.Listener, error) {
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, fmt.Errorf("create socket directory: %w", err)
	}
	info, err := os.Stat(parent)
	if err != nil {
		return nil, fmt.Errorf("stat socket directory: %w", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("socket directory %q must not be accessible to group or other users", parent)
	}
	if _, err := os.Lstat(path); err == nil {
		return nil, fmt.Errorf("socket path already exists: %s", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect socket path: %w", err)
	}

	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listen on private Unix socket: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		listener.Close()
		os.Remove(path)
		return nil, fmt.Errorf("set Unix socket permissions: %w", err)
	}
	return listener, nil
}

type bridgeSession struct {
	connection net.Conn
	queue      chan []byte
	done       chan struct{}
	closeOnce  sync.Once
}

func newBridgeSession(connection net.Conn, queueSize int) *bridgeSession {
	return &bridgeSession{
		connection: connection,
		queue:      make(chan []byte, queueSize),
		done:       make(chan struct{}),
	}
}

func (s *bridgeSession) enqueue(frame []byte) bool {
	select {
	case <-s.done:
		return false
	default:
	}
	copyFrame := append([]byte(nil), frame...)
	select {
	case <-s.done:
		return false
	case s.queue <- copyFrame:
		return true
	default:
		return false
	}
}

func (s *bridgeSession) close() {
	s.closeOnce.Do(func() {
		close(s.done)
		_ = s.connection.Close()
	})
}
