package connector

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
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
