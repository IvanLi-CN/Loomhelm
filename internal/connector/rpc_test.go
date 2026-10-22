package connector

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProcessTransportUsesJSONLAndPreservesResponses(t *testing.T) {
	transport, err := NewProcessTransport(context.Background(), ProcessTransportConfig{
		CommandPath: os.Args[0],
		CommandArgs: []string{"-test.run=TestProcessTransportHelper", "--", "echo"},
		CommandEnv:  append(os.Environ(), "LOOMHELM_RPC_HELPER=1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := transport.Call(context.Background(), "echo", json.RawMessage(`{"input":"hello"}`))
	if err != nil {
		t.Fatal(err)
	}
	if response.Error != nil || string(response.Result) != `{"input":"hello","unknown":true}` {
		t.Fatalf("RPC response = %+v", response)
	}
	if err := transport.Notify(context.Background(), "notice", json.RawMessage(`{"value":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := transport.Close(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		t.Fatal(err)
	}
}

func TestProcessTransportTimeoutIsUnknownOutcome(t *testing.T) {
	transport, err := NewProcessTransport(context.Background(), ProcessTransportConfig{
		CommandPath: os.Args[0],
		CommandArgs: []string{"-test.run=TestProcessTransportHelper", "--", "delay"},
		CommandEnv:  append(os.Environ(), "LOOMHELM_RPC_HELPER=1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err = transport.Call(ctx, "delay", json.RawMessage(`{}`))
	if !errors.Is(err, ErrUnknownOutcome) {
		t.Fatalf("timeout error = %v, want unknown outcome", err)
	}
	_ = transport.Close()
}

func TestProcessTransportPreCanceledCallDoesNotWrite(t *testing.T) {
	var writes atomic.Int32
	transport, err := NewProcessTransport(context.Background(), ProcessTransportConfig{
		CommandPath:       os.Args[0],
		CommandArgs:       []string{"-test.run=TestProcessTransportHelper", "--", "echo"},
		CommandEnv:        append(os.Environ(), "LOOMHELM_RPC_HELPER=1"),
		afterRequestWrite: func(string) { writes.Add(1) },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = transport.Call(ctx, "echo", json.RawMessage(`{"input":"must not be sent"}`))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-canceled call error = %v, want context canceled", err)
	}
	if writes.Load() != 0 {
		t.Fatalf("pre-canceled call wrote %d requests, want 0", writes.Load())
	}
	_ = transport.Close()
}

func TestProcessTransportCancelsAfterWriteWithoutLosingResponseObservation(t *testing.T) {
	transport, err := NewProcessTransport(context.Background(), ProcessTransportConfig{
		CommandPath: os.Args[0],
		CommandArgs: []string{"-test.run=TestProcessTransportHelper", "--", "burst-response"},
		CommandEnv:  append(os.Environ(), "LOOMHELM_RPC_HELPER=1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	transport.afterRequestWrite = func(method string) {
		if method == "burst-response" {
			cancel()
		}
	}
	message, err := transport.Call(ctx, "burst-response", json.RawMessage(`{}`))
	if !errors.Is(err, ErrUnknownOutcome) {
		t.Fatalf("after-write cancellation error = %v, want unknown outcome", err)
	}
	if len(message.ID) == 0 {
		t.Fatal("after-write cancellation did not preserve the JSON-RPC request ID")
	}
	foundResponse := false
	deadline := time.After(2 * time.Second)
	for !foundResponse {
		select {
		case message, ok := <-transport.Events():
			if !ok {
				t.Fatal("transport closed before the late response was observed")
			}
			if message.IsResponse() {
				foundResponse = true
				if string(message.Result) != `{"ok":true}` {
					t.Fatalf("late response = %s, want {\"ok\":true}", message.Result)
				}
			}
		case <-deadline:
			t.Fatal("timed out waiting for the late response observation")
		}
	}
	_ = transport.Close()
}

func TestProcessTransportHandlesResponseAfterLargeNotificationBurst(t *testing.T) {
	transport, err := NewProcessTransport(context.Background(), ProcessTransportConfig{
		CommandPath: os.Args[0],
		CommandArgs: []string{"-test.run=TestProcessTransportHelper", "--", "burst-response"},
		CommandEnv:  append(os.Environ(), "LOOMHELM_RPC_HELPER=1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := transport.Call(context.Background(), "burst-response", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(response.Result) != `{"ok":true}` {
		t.Fatalf("burst response = %s, want {\"ok\":true}", response.Result)
	}
	_ = transport.Close()
}

func TestProcessTransportWriteErrorClassifiesPartialWrites(t *testing.T) {
	partial := &partialWriter{limit: 3}
	transport := &ProcessTransport{stdin: nopWriteCloser{Writer: partial}, done: make(chan struct{}), pending: make(map[string]pendingRPC)}
	err := transport.writeMessage(map[string]json.RawMessage{"jsonrpc": json.RawMessage(`"2.0"`)})
	var writeErr *TransportWriteError
	if !errors.As(err, &writeErr) || !writeErr.Unknown || writeErr.BytesWritten != 3 {
		t.Fatalf("partial write error = %T %v", err, err)
	}
}

func TestProcessTransportDoesNotCloseEventsWhileReaderIsSending(t *testing.T) {
	stdout := io.NopCloser(strings.NewReader(`{"jsonrpc":"2.0","method":"notice","params":{}}` + "\n"))
	transport := &ProcessTransport{
		stdout:        stdout,
		maxFrameBytes: defaultMaxFrameBytes,
		pending:       make(map[string]pendingRPC),
		events:        make(chan RPCMessage),
		done:          make(chan struct{}),
		readDone:      make(chan struct{}),
	}
	go transport.readLoop()
	time.Sleep(time.Millisecond)
	transport.finishTransport(nil)
	<-transport.readDone
	if _, ok := <-transport.events; ok {
		t.Fatal("events channel remained open after reader exit")
	}
}

func TestProcessTransportRejectsEventsAfterDispatcherStops(t *testing.T) {
	transport := &ProcessTransport{
		eventCond: sync.NewCond(&sync.Mutex{}),
		done:      make(chan struct{}),
	}
	transport.eventMu.Lock()
	transport.eventDispatchStopped = true
	transport.eventMu.Unlock()
	observation := make(chan rpcObservation, 1)
	if err := transport.enqueueEvent(RPCMessage{observation: observation}); !errors.Is(err, ErrTransportClosed) {
		t.Fatalf("enqueue after dispatcher stop error = %v, want %v", err, ErrTransportClosed)
	}
	select {
	case result := <-observation:
		if !errors.Is(result.err, ErrTransportClosed) {
			t.Fatalf("stopped dispatcher observation error = %v, want %v", result.err, ErrTransportClosed)
		}
	case <-time.After(time.Second):
		t.Fatal("stopped dispatcher did not notify response observation")
	}
}

func TestProcessTransportDrainsStdoutBeforeChildExit(t *testing.T) {
	transport, err := NewProcessTransport(context.Background(), ProcessTransportConfig{
		CommandPath: os.Args[0],
		CommandArgs: []string{"-test.run=TestProcessTransportHelper", "--", "burst-exit"},
		CommandEnv:  append(os.Environ(), "LOOMHELM_RPC_HELPER=1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Notify(context.Background(), "burst-exit", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	count := 0
	for range transport.Events() {
		count++
	}
	if count != 256 {
		t.Fatalf("child exit event count = %d, want 256", count)
	}
	if err := transport.Close(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		t.Fatal(err)
	}
}

func TestProcessTransportCloseUnblocksFullEventQueue(t *testing.T) {
	transport, err := NewProcessTransport(context.Background(), ProcessTransportConfig{
		CommandPath: os.Args[0],
		CommandArgs: []string{"-test.run=TestProcessTransportHelper", "--", "burst"},
		CommandEnv:  append(os.Environ(), "LOOMHELM_RPC_HELPER=1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Notify(context.Background(), "burst", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	waitForQueuedEvent(t, transport, "burst-complete")
	closed := make(chan error, 1)
	go func() { closed <- transport.Close() }()
	select {
	case err := <-closed:
		if err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("transport close remained blocked by a full event queue")
	}
}

func waitForQueuedEvent(t *testing.T, transport *ProcessTransport, method string) {
	t.Helper()
	found := make(chan struct{})
	stop := make(chan struct{})
	go func() {
		transport.eventMu.Lock()
		defer transport.eventMu.Unlock()
		for {
			for _, message := range transport.eventQueue {
				if message.Method == method {
					close(found)
					return
				}
			}
			select {
			case <-stop:
				return
			default:
			}
			transport.eventCond.Wait()
		}
	}()
	select {
	case <-found:
		close(stop)
	case <-time.After(time.Second):
		close(stop)
		transport.eventMu.Lock()
		transport.eventCond.Broadcast()
		transport.eventMu.Unlock()
		t.Fatal("burst helper did not enqueue its completion marker")
	}
}

func TestProcessTransportRejectsAmbiguousRPCResponse(t *testing.T) {
	if _, err := parseRPCMessage([]byte(`{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1,"message":"ambiguous"}}`)); err == nil {
		t.Fatal("RPC response containing both result and error was accepted")
	}
}

func TestProcessTransportRequiresJSONRPCVersion(t *testing.T) {
	if _, err := parseRPCMessage([]byte(`{"jsonrpc":"1.0","id":1,"result":{}}`)); err == nil {
		t.Fatal("RPC frame with an incorrect jsonrpc version was accepted")
	}
	if message, err := parseRPCMessage([]byte(`{"id":1,"result":{}}`)); err != nil || !message.IsResponse() {
		t.Fatalf("Codex response without jsonrpc version = %+v, error = %v", message, err)
	}
}

func TestSanitizedCommandEnvExcludesSecrets(t *testing.T) {
	t.Setenv("LOOMHELM_RPC_SECRET", "must-not-cross-boundary")
	t.Setenv("HOME", "/tmp/loomhelm-home")
	env := sanitizedCommandEnv()
	joined := strings.Join(env, "\n")
	if strings.Contains(joined, "LOOMHELM_RPC_SECRET") || strings.Contains(joined, "must-not-cross-boundary") {
		t.Fatalf("sanitized command environment leaked secret: %q", joined)
	}
	if !strings.Contains(joined, "HOME=/tmp/loomhelm-home") {
		t.Fatalf("sanitized command environment omitted safe HOME: %q", joined)
	}
}

func TestProcessTransportHelper(t *testing.T) {
	if os.Getenv("LOOMHELM_RPC_HELPER") != "1" {
		return
	}
	reader := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for reader.Scan() {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(reader.Bytes(), &message); err != nil {
			continue
		}
		switch message.Method {
		case "echo":
			var params map[string]any
			_ = json.Unmarshal(message.Params, &params)
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(message.ID), "result": map[string]any{"input": params["input"], "unknown": true}})
		case "delay":
			time.Sleep(100 * time.Millisecond)
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(message.ID), "result": map[string]any{}})
		case "burst":
			for i := 0; i < 256; i++ {
				_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "notice", "params": map[string]any{"index": i}})
			}
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "burst-complete", "params": map[string]any{}})
		case "burst-response":
			for i := 0; i < 256; i++ {
				_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "notice", "params": map[string]any{"index": i}})
			}
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(message.ID), "result": map[string]any{"ok": true}})
		case "burst-exit":
			for i := 0; i < 256; i++ {
				_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "notice", "params": map[string]any{"index": i}})
			}
			os.Exit(0)
		}
	}
	os.Exit(0)
}

type partialWriter struct{ limit int }

func (w *partialWriter) Write(data []byte) (int, error) {
	if len(data) <= w.limit {
		return len(data), io.ErrClosedPipe
	}
	return w.limit, io.ErrClosedPipe
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }
