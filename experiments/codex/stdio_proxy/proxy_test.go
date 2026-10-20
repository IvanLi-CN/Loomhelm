package stdioproxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const bridgeReadTimeout = 3 * time.Second

func TestProxyPreservesInvocationAndHandshakeBoundary(t *testing.T) {
	fixture := startFixtureProxy(t, fixtureOptions{})
	defer fixture.close(t)

	info, err := os.Stat(fixture.socketPath)
	if err != nil {
		t.Fatalf("stat control socket: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("socket permissions = %o, want 600", got)
	}
	parentInfo, err := os.Stat(filepath.Dir(fixture.socketPath))
	if err != nil {
		t.Fatalf("stat socket directory: %v", err)
	}
	if got := parentInfo.Mode().Perm(); got != 0o700 {
		t.Fatalf("socket directory permissions = %o, want 700", got)
	}

	args := readFixtureFile(t, fixture.argsPath)
	if !strings.Contains(args, "-test.run=TestProxyFixture\x00-test.count=1") {
		t.Fatalf("child argv was not preserved: %q", args)
	}
	if got := readFixtureFile(t, fixture.markerPath); got != "preserved" {
		t.Fatalf("child environment marker = %q, want preserved", got)
	}
	if got := readFixtureFile(t, fixture.cwdPath); got != fixture.childDir {
		t.Fatalf("child cwd = %q, want %q", got, fixture.childDir)
	}

	bridge, bridgeReader := fixture.connectBridge(t)
	defer bridge.Close()
	completeBridgeHandshake(t, bridge, bridgeReader)

	writeRequest(t, fixture.desktopInput, "desktop-init", "initialize", nil)
	initializeResponse := waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.isResponse() && idKey(message.id) == `"desktop-init"`
	})
	if !initializeResponse.hasResult || initializeResponse.hasError {
		t.Fatalf("Desktop initialize response = %+v", initializeResponse.fields)
	}
	var initializeResult map[string]any
	if err := json.Unmarshal(initializeResponse.fields["result"], &initializeResult); err != nil {
		t.Fatalf("decode initialize result: %v", err)
	}
	if initializeResult["identity"] != "desktop" {
		t.Fatalf("initialize identity = %#v, want desktop", initializeResult["identity"])
	}
	writeNotification(t, fixture.desktopInput, "initialized", map[string]any{})
	waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.hasMethod && message.method == "fixture/desktop-initialized"
	})

	writeRequest(t, fixture.desktopInput, "same", "fixture/echo", nil)
	writeRequest(t, bridge, "same", "fixture/echo", nil)
	desktopEcho := waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.isResponse() && idKey(message.id) == `"same"`
	})
	bridgeEcho := readBridgeUntil(t, bridge, bridgeReader, bridgeReadTimeout, func(message rpcMessage) bool {
		return message.isResponse() && idKey(message.id) == `"same"`
	})
	if !desktopEcho.hasResult || !bridgeEcho.hasResult {
		t.Fatalf("collision responses were not successful: Desktop=%+v bridge=%+v", desktopEcho.fields, bridgeEcho.fields)
	}
	var desktopEchoResult, bridgeEchoResult map[string]any
	if err := json.Unmarshal(desktopEcho.fields["result"], &desktopEchoResult); err != nil {
		t.Fatalf("decode Desktop collision result: %v", err)
	}
	if err := json.Unmarshal(bridgeEcho.fields["result"], &bridgeEchoResult); err != nil {
		t.Fatalf("decode bridge collision result: %v", err)
	}
	if desktopEchoResult["child_id"] == bridgeEchoResult["child_id"] {
		t.Fatalf("proxy did not isolate child request ids: Desktop=%#v bridge=%#v", desktopEchoResult, bridgeEchoResult)
	}

	writeRequest(t, fixture.desktopInput, "notify", "fixture/notify", nil)
	waitForOrderedMethods(t, fixture.output, []string{"fixture/unknown/one", "fixture/unknown/two"})
	readBridgeUntil(t, bridge, bridgeReader, bridgeReadTimeout, func(message rpcMessage) bool {
		return message.hasMethod && message.method == "fixture/unknown/one"
	})
	readBridgeUntil(t, bridge, bridgeReader, bridgeReadTimeout, func(message rpcMessage) bool {
		return message.hasMethod && message.method == "fixture/unknown/two"
	})
	waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.isResponse() && idKey(message.id) == `"notify"`
	})
}

func TestProxyArbitratesApprovalsAndKeepsOwnerCallbacksOnDesktop(t *testing.T) {
	fixture := startFixtureProxy(t, fixtureOptions{})
	defer fixture.close(t)
	completeDesktopHandshake(t, fixture)
	bridge, bridgeReader := fixture.connectBridge(t)
	defer bridge.Close()
	completeBridgeHandshake(t, bridge, bridgeReader)

	writeRequest(t, fixture.desktopInput, "approval", "fixture/requestApproval", nil)
	desktopApproval := waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.hasMethod && message.method == "item/commandExecution/requestApproval"
	})
	bridgeApproval := readBridgeUntil(t, bridge, bridgeReader, bridgeReadTimeout, func(message rpcMessage) bool {
		return message.hasMethod && message.method == "item/commandExecution/requestApproval"
	})
	if idKey(desktopApproval.id) == idKey(bridgeApproval.id) {
		t.Fatalf("approval ids were not isolated: %s", idKey(desktopApproval.id))
	}

	var responses sync.WaitGroup
	responses.Add(2)
	go func() {
		defer responses.Done()
		writeResponse(t, bridge, bridgeApproval.id, map[string]any{"decision": "accept"})
	}()
	go func() {
		defer responses.Done()
		writeResponse(t, fixture.desktopInput, desktopApproval.id, map[string]any{"decision": "decline"})
	}()
	responses.Wait()

	approvalSeen := waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.hasMethod && message.method == "fixture/approval-seen"
	})
	var seenParams map[string]any
	if err := json.Unmarshal(approvalSeen.fields["params"], &seenParams); err != nil {
		t.Fatalf("decode approval observation: %v", err)
	}
	if seenParams["count"] != float64(1) {
		t.Fatalf("approval response count = %#v, want one", seenParams["count"])
	}
	approvalResponse := waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.isResponse() && idKey(message.id) == `"approval"`
	})
	if !approvalResponse.hasResult || approvalResponse.hasError {
		t.Fatalf("approval response = %+v", approvalResponse.fields)
	}

	writeResponse(t, fixture.desktopInput, desktopApproval.id, map[string]any{"decision": "late"})
	writeRequest(t, fixture.desktopInput, "after-late", "fixture/echo", nil)
	waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.isResponse() && idKey(message.id) == `"after-late"`
	})
	for _, message := range fixture.output.snapshot() {
		if message, err := parseRPCMessage(message); err == nil && message.hasMethod && message.method == "fixture/unexpected-response" {
			t.Fatal("late duplicate approval response was forwarded to the child")
		}
	}

	writeRequest(t, bridge, "owner", "fixture/owner", nil)
	ownerRequest := waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.hasMethod && message.method == "userVerification"
	})
	assertBridgeDoesNotReceiveMethod(t, bridge, bridgeReader, "userVerification", 150*time.Millisecond)
	writeResponse(t, fixture.desktopInput, ownerRequest.id, map[string]any{"approved": true})
	readBridgeUntil(t, bridge, bridgeReader, bridgeReadTimeout, func(message rpcMessage) bool {
		return message.isResponse() && idKey(message.id) == `"owner"`
	})

	if err := bridge.Close(); err != nil {
		t.Fatalf("close bridge: %v", err)
	}
	writeRequest(t, fixture.desktopInput, "after-disconnect", "fixture/echo", nil)
	waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.isResponse() && idKey(message.id) == `"after-disconnect"`
	})

	reconnected, reconnectedReader := fixture.connectBridge(t)
	defer reconnected.Close()
	completeBridgeHandshake(t, reconnected, reconnectedReader)
	writeRequest(t, reconnected, "reconnect", "fixture/echo", nil)
	readBridgeUntil(t, reconnected, reconnectedReader, bridgeReadTimeout, func(message rpcMessage) bool {
		return message.isResponse() && idKey(message.id) == `"reconnect"`
	})
	if got := readFixtureFile(t, fixture.pidPath); got == "" {
		t.Fatal("child pid evidence disappeared after bridge reconnect")
	}
}

func TestProxyChildExitAndSignal(t *testing.T) {
	t.Run("exit_without_restart", func(t *testing.T) {
		fixture := startFixtureProxy(t, fixtureOptions{})
		writeRequest(t, fixture.desktopInput, "exit", "fixture/exit", nil)
		err := fixture.wait(t, 3*time.Second)
		var exitError *exec.ExitError
		if !errors.As(err, &exitError) || exitError.ExitCode() != 17 {
			t.Fatalf("proxy child exit = %v, want exit code 17", err)
		}
		if _, err := strconv.Atoi(readFixtureFile(t, fixture.pidPath)); err != nil {
			t.Fatalf("child pid evidence = %q, want one pid", readFixtureFile(t, fixture.pidPath))
		}
	})

	t.Run("context_signal_reaches_child", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		fixture := startFixtureProxyWithContext(t, ctx, fixtureOptions{signalPath: filepath.Join(t.TempDir(), "signal.txt")})
		cancel()
		if err := fixture.wait(t, 3*time.Second); err != nil {
			t.Fatalf("proxy signal shutdown error = %v", err)
		}
		if got := readFixtureFile(t, fixture.signalPath); got != "interrupt" {
			t.Fatalf("child signal = %q, want interrupt", got)
		}
	})
}

func TestBridgeQueueIsBounded(t *testing.T) {
	left, right := net.Pipe()
	defer right.Close()
	session := newBridgeSession(left, 1)
	if !session.enqueue([]byte("first\n")) {
		t.Fatal("first frame was rejected")
	}
	if session.enqueue([]byte("second\n")) {
		t.Fatal("second frame bypassed the bounded queue")
	}
	session.close()
	if session.enqueue([]byte("after-close\n")) {
		t.Fatal("closed bridge accepted a frame")
	}
}

func TestChildEnvironmentPreventsWrapperRecursion(t *testing.T) {
	env := ChildEnvironment([]string{
		"KEEP=1",
		"CODEX_APP_TOOLS_PIPE_PATH=/private/pipe",
		"CODEX_CLI_PATH=/private/wrapper",
		"LOOMHELM_STDIO_PROXY_REAL_CLI=/private/real",
		"LOOMHELM_STDIO_PROXY_SOCKET=/private/socket",
	}, "/private/pinned-real")
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "KEEP=1") || !strings.Contains(joined, "CODEX_APP_TOOLS_PIPE_PATH=/private/pipe") {
		t.Fatalf("unrelated child environment was not preserved: %q", joined)
	}
	if !strings.Contains(joined, "CODEX_CLI_PATH=/private/pinned-real") {
		t.Fatalf("child CODEX_CLI_PATH was not pinned: %q", joined)
	}
	if strings.Contains(joined, "CODEX_CLI_PATH=/private/wrapper") || strings.Contains(joined, "LOOMHELM_STDIO_PROXY_") {
		t.Fatalf("wrapper recursion controls leaked into child environment: %q", joined)
	}
}

func TestValidateChildPathRejectsProxySelf(t *testing.T) {
	path, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}
	if err := ValidateChildPath(path, path); err == nil {
		t.Fatal("ValidateChildPath() accepted the proxy executable as its child")
	}
}

func TestFrameWriteReportsPartialDelivery(t *testing.T) {
	writer := &partialWriter{limit: 2, err: errors.New("fixture write failure")}
	err := writeFrame(writer, []byte(`{"jsonrpc":"2.0"}`))
	var writeError *frameWriteError
	if !errors.As(err, &writeError) {
		t.Fatalf("writeFrame() error = %v, want frameWriteError", err)
	}
	if writeError.BytesWritten != 2 {
		t.Fatalf("partial bytes = %d, want 2", writeError.BytesWritten)
	}
}

type fixtureOptions struct {
	childDir   string
	signalPath string
}

type runningFixture struct {
	desktopInput    *io.PipeWriter
	output          *frameCollector
	socketPath      string
	childDir        string
	argsPath        string
	markerPath      string
	cwdPath         string
	pidPath         string
	signalPath      string
	signalReadyPath string
	done            chan error
	finished        chan struct{}
	resultMu        sync.Mutex
	result          error
	cancel          context.CancelFunc
}

func startFixtureProxy(t *testing.T, options fixtureOptions) *runningFixture {
	ctx, cancel := context.WithCancel(context.Background())
	fixture := startFixtureProxyWithContext(t, ctx, options)
	fixture.cancel = cancel
	return fixture
}

func startFixtureProxyWithContext(t *testing.T, ctx context.Context, options fixtureOptions) *runningFixture {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "loomhelm-r01-")
	if err != nil {
		t.Fatalf("create short fixture root: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	childDir := options.childDir
	if childDir == "" {
		childDir = filepath.Join(root, "child-cwd")
		if err := os.Mkdir(childDir, 0o700); err != nil {
			t.Fatalf("create child cwd: %v", err)
		}
	}
	socketDir := filepath.Join(root, "socket")
	if err := os.Mkdir(socketDir, 0o700); err != nil {
		t.Fatalf("create socket directory: %v", err)
	}
	socketPath := filepath.Join(socketDir, "control.sock")
	argsPath := filepath.Join(root, "args.txt")
	markerPath := filepath.Join(root, "marker.txt")
	cwdPath := filepath.Join(root, "cwd.txt")
	pidPath := filepath.Join(root, "pid.txt")
	signalPath := options.signalPath
	if signalPath == "" {
		signalPath = filepath.Join(root, "signal.txt")
	}

	desktopReader, desktopWriter := io.Pipe()
	childPath, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}
	childEnv := append(os.Environ(),
		"LOOMHELM_PROXY_FIXTURE=1",
		"LOOMHELM_PROXY_FIXTURE_ARGS_FILE="+argsPath,
		"LOOMHELM_PROXY_FIXTURE_MARKER=preserved",
		"LOOMHELM_PROXY_FIXTURE_MARKER_FILE="+markerPath,
		"LOOMHELM_PROXY_FIXTURE_CWD_FILE="+cwdPath,
		"LOOMHELM_PROXY_FIXTURE_PID_FILE="+pidPath,
		"LOOMHELM_PROXY_FIXTURE_SIGNAL_FILE="+signalPath,
		"LOOMHELM_PROXY_FIXTURE_APPROVAL_FILE="+filepath.Join(root, "approval.txt"),
	)
	command := exec.Command(childPath, "-test.run=TestProxyFixture", "-test.count=1")
	fixture := &runningFixture{
		desktopInput:    desktopWriter,
		output:          newFrameCollector(),
		socketPath:      socketPath,
		childDir:        resolvedPath(childDir),
		argsPath:        argsPath,
		markerPath:      markerPath,
		cwdPath:         cwdPath,
		pidPath:         pidPath,
		signalPath:      signalPath,
		signalReadyPath: signalPath + ".ready",
		done:            make(chan error, 1),
		finished:        make(chan struct{}),
	}
	config := Config{
		ChildPath:       childPath,
		ChildArgs:       command.Args[1:],
		ChildEnv:        childEnv,
		ChildDir:        childDir,
		SocketPath:      socketPath,
		DesktopIn:       desktopReader,
		DesktopOut:      fixture.output,
		ChildStderr:     io.Discard,
		Generation:      "test-generation",
		BridgeQueueSize: 4,
	}
	go func() {
		err := runWithCommand(ctx, config, command)
		fixture.resultMu.Lock()
		fixture.result = err
		fixture.resultMu.Unlock()
		close(fixture.finished)
		fixture.done <- err
	}()
	waitForPathOrProcessExit(t, socketPath, fixture.done)
	t.Cleanup(func() {
		if !fixture.isDone() {
			if fixture.cancel != nil {
				fixture.cancel()
			}
			_ = fixture.desktopInput.Close()
			_ = fixture.wait(t, 6*time.Second)
		}
	})
	waitForPath(t, argsPath)
	waitForPath(t, markerPath)
	waitForPath(t, cwdPath)
	waitForPath(t, pidPath)
	waitForPath(t, signalPath+".ready")
	return fixture
}

func (f *runningFixture) connectBridge(t *testing.T) (net.Conn, *bufio.Reader) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		connection, err := net.Dial("unix", f.socketPath)
		if err == nil {
			return connection, bufio.NewReader(connection)
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out connecting to bridge socket %s", f.socketPath)
	return nil, nil
}

func (f *runningFixture) close(t *testing.T) {
	t.Helper()
	if !f.isDone() {
		if f.cancel != nil {
			f.cancel()
		}
		_ = f.desktopInput.Close()
		f.wait(t, 6*time.Second)
	}
}

func (f *runningFixture) wait(t *testing.T, timeout time.Duration) error {
	t.Helper()
	select {
	case err := <-f.done:
		return err
	case <-f.finished:
		f.resultMu.Lock()
		err := f.result
		f.resultMu.Unlock()
		return err
	case <-time.After(timeout):
		t.Fatalf("proxy did not exit within %s", timeout)
		return nil
	}
}

func (f *runningFixture) isDone() bool {
	select {
	case <-f.finished:
		return true
	default:
		return false
	}
}

func completeDesktopHandshake(t *testing.T, fixture *runningFixture) {
	t.Helper()
	writeRequest(t, fixture.desktopInput, "desktop-init", "initialize", nil)
	waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.isResponse() && idKey(message.id) == `"desktop-init"`
	})
	writeNotification(t, fixture.desktopInput, "initialized", map[string]any{})
	waitForCollectorMessage(t, fixture.output, func(message rpcMessage) bool {
		return message.hasMethod && message.method == "fixture/desktop-initialized"
	})
}

func completeBridgeHandshake(t *testing.T, connection net.Conn, reader *bufio.Reader) {
	t.Helper()
	writeRequest(t, connection, "bridge-init", "initialize", nil)
	response := readBridgeMessage(t, connection, reader, bridgeReadTimeout)
	if got := responseErrorCode(t, response); got != localDesktopOwnedCode {
		t.Fatalf("bridge initialize error code = %d, want %d", got, localDesktopOwnedCode)
	}
}

func writeRequest(t *testing.T, writer io.Writer, id, method string, params any) {
	t.Helper()
	writeJSON(t, writer, map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	})
}

func writeResponse(t *testing.T, writer io.Writer, id json.RawMessage, result any) {
	t.Helper()
	writeJSON(t, writer, map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  result,
	})
}

func writeNotification(t *testing.T, writer io.Writer, method string, params any) {
	t.Helper()
	writeJSON(t, writer, map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func writeJSON(t *testing.T, writer io.Writer, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode test JSON: %v", err)
	}
	if err := writeFrame(writer, data); err != nil {
		t.Fatalf("write test JSON: %v", err)
	}
}

func waitForCollectorMessage(t *testing.T, collector *frameCollector, predicate func(rpcMessage) bool) rpcMessage {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		frames, changed := collector.snapshotAndSignal()
		for _, frame := range frames {
			message, err := parseRPCMessage(frame)
			if err == nil && predicate(message) {
				return message
			}
		}
		timer := time.NewTimer(time.Until(deadline))
		select {
		case <-changed:
			timer.Stop()
		case <-timer.C:
		}
	}
	t.Fatalf("timed out waiting for Desktop frame")
	return rpcMessage{}
}

func waitForOrderedMethods(t *testing.T, collector *frameCollector, methods []string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		frames, changed := collector.snapshotAndSignal()
		seen := make([]string, 0, len(methods))
		for _, frame := range frames {
			message, err := parseRPCMessage(frame)
			if err == nil && message.hasMethod {
				for len(seen) < len(methods) && message.method == methods[len(seen)] {
					seen = append(seen, message.method)
					break
				}
			}
		}
		if len(seen) == len(methods) {
			return
		}
		timer := time.NewTimer(time.Until(deadline))
		select {
		case <-changed:
			timer.Stop()
		case <-timer.C:
		}
	}
	t.Fatalf("timed out waiting for ordered methods %v", methods)
}

func readBridgeMessage(t *testing.T, connection net.Conn, reader *bufio.Reader, timeout time.Duration) rpcMessage {
	t.Helper()
	message, err := tryReadBridgeMessage(connection, reader, timeout)
	if err != nil {
		t.Fatalf("read bridge message: %v", err)
	}
	return message
}

func readBridgeUntil(t *testing.T, connection net.Conn, reader *bufio.Reader, timeout time.Duration, predicate func(rpcMessage) bool) rpcMessage {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		message, err := tryReadBridgeMessage(connection, reader, time.Until(deadline))
		if err != nil {
			t.Fatalf("read bridge message: %v", err)
		}
		if predicate(message) {
			return message
		}
	}
	t.Fatalf("timed out waiting for bridge message")
	return rpcMessage{}
}

func assertBridgeDoesNotReceiveMethod(t *testing.T, connection net.Conn, reader *bufio.Reader, method string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		message, err := tryReadBridgeMessage(connection, reader, time.Until(deadline))
		if err != nil {
			if isTimeout(err) {
				return
			}
			t.Fatalf("read bridge message while checking %s: %v", method, err)
		}
		if message.hasMethod && message.method == method {
			t.Fatalf("method %s leaked to bridge: %+v", method, message.fields)
		}
	}
}

func tryReadBridgeMessage(connection net.Conn, reader *bufio.Reader, timeout time.Duration) (rpcMessage, error) {
	if err := connection.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return rpcMessage{}, err
	}
	frame, err := readFrame(reader, DefaultMaxFrameBytes)
	if err != nil {
		return rpcMessage{}, err
	}
	return parseRPCMessage(frame)
}

func responseErrorCode(t *testing.T, message rpcMessage) int {
	t.Helper()
	var responseError struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(message.fields["error"], &responseError); err != nil {
		t.Fatalf("decode response error: %v", err)
	}
	return responseError.Code
}

func readFixtureFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture file %s: %v", path, err)
	}
	return strings.TrimSpace(string(data))
}

func waitForPath(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

func resolvedPath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	return resolved
}

func waitForPathOrProcessExit(t *testing.T, path string, done <-chan error) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		select {
		case err := <-done:
			t.Fatalf("proxy exited before creating %s: %v", path, err)
		default:
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

type frameCollector struct {
	mu      sync.Mutex
	buffer  []byte
	frames  [][]byte
	changed chan struct{}
}

func newFrameCollector() *frameCollector {
	return &frameCollector{changed: make(chan struct{})}
}

func (c *frameCollector) Write(data []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buffer = append(c.buffer, data...)
	for {
		index := bytes.IndexByte(c.buffer, '\n')
		if index < 0 {
			break
		}
		c.frames = append(c.frames, append([]byte(nil), c.buffer[:index+1]...))
		c.buffer = c.buffer[index+1:]
	}
	close(c.changed)
	c.changed = make(chan struct{})
	return len(data), nil
}

func (c *frameCollector) snapshotAndSignal() ([][]byte, <-chan struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	frames := make([][]byte, len(c.frames))
	for index, frame := range c.frames {
		frames[index] = append([]byte(nil), frame...)
	}
	return frames, c.changed
}

func (c *frameCollector) snapshot() [][]byte {
	frames, _ := c.snapshotAndSignal()
	return frames
}

func isTimeout(err error) bool {
	var netError net.Error
	return errors.As(err, &netError) && netError.Timeout()
}

type partialWriter struct {
	limit int
	err   error
}

func (w *partialWriter) Write(data []byte) (int, error) {
	if len(data) <= w.limit {
		return len(data), w.err
	}
	return w.limit, w.err
}

func TestProxyFixture(t *testing.T) {
	if os.Getenv("LOOMHELM_PROXY_FIXTURE") != "1" {
		return
	}
	writeFixtureFile(os.Getenv("LOOMHELM_PROXY_FIXTURE_ARGS_FILE"), strings.Join(os.Args, "\x00"))
	writeFixtureFile(os.Getenv("LOOMHELM_PROXY_FIXTURE_MARKER_FILE"), os.Getenv("LOOMHELM_PROXY_FIXTURE_MARKER"))
	writeFixtureFile(os.Getenv("LOOMHELM_PROXY_FIXTURE_CWD_FILE"), mustGetwd())
	writeFixtureFile(os.Getenv("LOOMHELM_PROXY_FIXTURE_PID_FILE"), strconv.Itoa(os.Getpid()))

	if signalPath := os.Getenv("LOOMHELM_PROXY_FIXTURE_SIGNAL_FILE"); signalPath != "" {
		signals := make(chan os.Signal, 1)
		signalNotify(signals)
		writeFixtureFile(signalPath+".ready", "ready")
		go func() {
			sig := <-signals
			writeFixtureFile(signalPath, sig.String())
			os.Exit(0)
		}()
	}

	reader := bufio.NewReader(os.Stdin)
	for {
		frame, err := readFrame(reader, DefaultMaxFrameBytes)
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			os.Exit(12)
		}
		message, err := parseRPCMessage(frame)
		if err != nil {
			os.Exit(13)
		}
		if !message.hasMethod {
			writeFixtureFile(os.Getenv("LOOMHELM_PROXY_FIXTURE_APPROVAL_FILE"), "unexpected")
			fixtureNotification("fixture/unexpected-response", map[string]any{})
			continue
		}
		switch message.method {
		case "initialize":
			fixtureResponse(message.id, map[string]any{
				"identity":     "desktop",
				"capabilities": map[string]any{"fixture": true},
			})
		case "initialized":
			fixtureNotification("fixture/desktop-initialized", map[string]any{})
		case "fixture/echo":
			fixtureResponse(message.id, map[string]any{"child_id": json.RawMessage(message.id)})
		case "fixture/notify":
			fixtureNotification("fixture/unknown/one", map[string]any{"order": 1})
			fixtureNotification("fixture/unknown/two", map[string]any{"order": 2})
			fixtureResponse(message.id, map[string]any{"notified": true})
		case "fixture/requestApproval":
			fixtureResponseToApproval(reader, message.id, "item/commandExecution/requestApproval")
		case "fixture/owner":
			fixtureResponseToApproval(reader, message.id, "userVerification")
		case "fixture/exit":
			os.Exit(17)
		case "fixture/burst":
			count := 16
			if rawParams, ok := message.fields["params"]; ok {
				var params struct {
					Count int `json:"count"`
				}
				if json.Unmarshal(rawParams, &params) == nil && params.Count > 0 {
					count = params.Count
				}
			}
			for index := 0; index < count; index++ {
				fixtureNotification(fmt.Sprintf("fixture/burst/%d", index), map[string]any{"index": index})
			}
			fixtureResponse(message.id, map[string]any{"count": count})
		}
	}
}

func fixtureResponseToApproval(reader *bufio.Reader, originalID json.RawMessage, method string) {
	fixtureID := json.RawMessage(`"fixture-request-1"`)
	fixtureRequest := map[string]any{
		"jsonrpc": "2.0",
		"id":      fixtureID,
		"method":  method,
		"params":  map[string]any{"fixture": true},
	}
	fixtureWrite(fixtureRequest)
	frame, err := readFrame(reader, DefaultMaxFrameBytes)
	if err != nil {
		os.Exit(14)
	}
	response, err := parseRPCMessage(frame)
	if err != nil || !response.isValidResponse() {
		os.Exit(15)
	}
	writeFixtureFile(os.Getenv("LOOMHELM_PROXY_FIXTURE_APPROVAL_FILE"), "seen")
	fixtureNotification("fixture/approval-seen", map[string]any{"count": 1})
	fixtureResponse(originalID, map[string]any{
		"callback_method": method,
		"response":        response.fields["result"],
	})
}

func fixtureResponse(id json.RawMessage, result any) {
	fixtureWrite(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func fixtureNotification(method string, params any) {
	fixtureWrite(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func fixtureWrite(value any) {
	data, err := json.Marshal(value)
	if err != nil {
		os.Exit(16)
	}
	if err := writeFrame(os.Stdout, data); err != nil {
		os.Exit(16)
	}
}

func writeFixtureFile(path, value string) {
	if path == "" {
		return
	}
	if err := os.WriteFile(path, []byte(value+"\n"), 0o600); err != nil {
		os.Exit(18)
	}
}

func mustGetwd() string {
	path, err := os.Getwd()
	if err != nil {
		return "<error>"
	}
	return path
}

// signalNotify is split out so the fixture remains easy to identify in the test binary.
func signalNotify(signals chan<- os.Signal) {
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
}
