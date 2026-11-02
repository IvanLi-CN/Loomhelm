package connector

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

type sourceTestTransport struct {
	mu        sync.Mutex
	responses map[string]RPCMessage
	calls     []string
	events    chan RPCMessage
	closed    bool
}

func newSourceTestTransport() *sourceTestTransport {
	return &sourceTestTransport{responses: make(map[string]RPCMessage), events: make(chan RPCMessage, 8)}
}

func (t *sourceTestTransport) Call(_ context.Context, method string, _ json.RawMessage) (RPCMessage, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.calls = append(t.calls, method)
	if response, ok := t.responses[method]; ok {
		return response, nil
	}
	return RPCMessage{Result: json.RawMessage(`{}`)}, nil
}

func (t *sourceTestTransport) Notify(_ context.Context, _ string, _ json.RawMessage) error {
	return nil
}
func (t *sourceTestTransport) Respond(context.Context, json.RawMessage, json.RawMessage) error {
	return nil
}
func (t *sourceTestTransport) Events() <-chan RPCMessage { return t.events }
func (t *sourceTestTransport) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.closed {
		t.closed = true
		close(t.events)
	}
	return nil
}

func sourceInitializeResult() json.RawMessage {
	return json.RawMessage(`{"protocolVersion":"v2","serverInfo":{"name":"codex","version":"0.163.0","build":"codex-cli 0.163.0"},"capabilities":{"experimentalApi":true}}`)
}

func TestSourceClientNegotiatesExactBuildAndWritesTitle(t *testing.T) {
	transport := newSourceTestTransport()
	transport.responses["initialize"] = RPCMessage{Result: sourceInitializeResult()}
	transport.responses[SourceMethodSetThreadName] = RPCMessage{Result: json.RawMessage(`{}`)}
	source, err := NewSourceClient(context.Background(), transport, ClientInfo{Name: "test", Title: "Test", Version: "1"})
	if err != nil {
		t.Fatal(err)
	}
	if got := source.Handshake(); got.Build != "codex-cli 0.163.0" || !got.ExperimentalAPI {
		t.Fatalf("handshake = %+v", got)
	}
	if got := source.Capability(SourceMethodSetThreadName); got != CapabilityUnknown {
		t.Fatalf("initial title capability = %q, want unknown", got)
	}
	if err := source.SetTitle(context.Background(), "thread-1", "新的标题"); err != nil {
		t.Fatal(err)
	}
	if got := source.Capability(SourceMethodSetThreadName); got != CapabilitySupported {
		t.Fatalf("title capability after success = %q", got)
	}
}

func TestSourceClientDeduplicatesRepeatedTitleNotifications(t *testing.T) {
	transport := newSourceTestTransport()
	transport.responses["initialize"] = RPCMessage{Result: sourceInitializeResult()}
	source, err := NewSourceClient(context.Background(), transport, ClientInfo{})
	if err != nil {
		t.Fatal(err)
	}
	message := RPCMessage{Method: SourceNotificationName, Params: json.RawMessage(`{"threadId":"thread-1","name":"Codex 标题"}`), Raw: json.RawMessage(`{"method":"thread/name/updated","params":{"threadId":"thread-1","name":"Codex 标题"}}`)}
	transport.events <- message
	transport.events <- message
	notification, err := source.NextNotification(context.Background())
	if err != nil || notification.ThreadID != "thread-1" || notification.Title == nil || *notification.Title != "Codex 标题" {
		t.Fatalf("notification = %+v, error = %v", notification, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := source.NextNotification(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("duplicate notification error = %v, want deadline", err)
	}
}

func TestSourceClientReportsUnsupportedHistoryMaterialWithoutProjectingItAsUnknown(t *testing.T) {
	transport := newSourceTestTransport()
	transport.responses["initialize"] = RPCMessage{Result: sourceInitializeResult()}
	transport.responses[SourceMethodThreadRead] = RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-1","name":"历史","preview":"预览"}}`)}
	transport.responses[SourceMethodThreadTurnsList] = RPCMessage{Result: json.RawMessage(`{"data":[{"id":"turn-1","type":"agentMessage"}]}`)}
	transport.responses[SourceMethodThreadItemsList] = RPCMessage{Error: &RPCError{Code: -32601, Message: "method unsupported"}}
	transport.responses[SourceMethodAttachmentList] = RPCMessage{Result: json.RawMessage(`{"data":[]}`)}
	source, err := NewSourceClient(context.Background(), transport, ClientInfo{})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := source.ReadHistory(context.Background(), "thread-1")
	if err != nil {
		t.Fatalf("ReadHistory() error = %v", err)
	}
	if !snapshot.HistoryComplete || !snapshot.FilesComplete || len(snapshot.Events) != 1 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if len(snapshot.UnsupportedMethods) != 1 || snapshot.UnsupportedMethods[0] != SourceMethodThreadItemsList {
		t.Fatalf("unsupported methods = %#v", snapshot.UnsupportedMethods)
	}
}

func TestSourceClientSyncBuildsCompleteHostSnapshot(t *testing.T) {
	transport := newSourceTestTransport()
	transport.responses["initialize"] = RPCMessage{Result: sourceInitializeResult()}
	transport.responses[SourceMethodProjectList] = RPCMessage{Result: json.RawMessage(`{"data":[{"id":"project-1","name":"来源项目","cwd":"/tmp/source"}]}`)}
	transport.responses[SourceMethodThreadList] = RPCMessage{Result: json.RawMessage(`{"data":[{"id":"thread-1","name":"Codex 标题","preview":"历史预览","projectId":"project-1","cwd":"/tmp/source","updatedAt":"2026-11-02T10:00:00Z"}]}`)}
	transport.responses[SourceMethodThreadRead] = RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-1","name":"Codex 标题","preview":"历史预览","projectId":"project-1","cwd":"/tmp/source","updatedAt":"2026-11-02T10:00:00Z"}}`)}
	transport.responses[SourceMethodThreadTurnsList] = RPCMessage{Result: json.RawMessage(`{"data":[{"id":"turn-1","type":"agentMessage","text":"完成"}]}`)}
	transport.responses[SourceMethodThreadItemsList] = RPCMessage{Error: &RPCError{Code: -32601, Message: "method unsupported"}}
	transport.responses[SourceMethodAttachmentList] = RPCMessage{Result: json.RawMessage(`{"data":[{"path":"notes.txt","contentType":"text/plain","contentBytes":"aGVsbG8=","complete":true}]}`)}
	source, err := NewSourceClient(context.Background(), transport, ClientInfo{})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := source.Sync(context.Background(), "sync-1")
	if err != nil {
		t.Fatalf("Sync() error = %v", err)
	}
	if snapshot.Build != "codex-cli 0.163.0" || snapshot.SyncState != protocol.CodexSyncStateComplete {
		t.Fatalf("snapshot identity/state = (%q, %q)", snapshot.Build, snapshot.SyncState)
	}
	if len(snapshot.Projects) != 1 || len(snapshot.Threads) != 1 {
		t.Fatalf("snapshot sizes = (%d, %d)", len(snapshot.Projects), len(snapshot.Threads))
	}
	thread := snapshot.Threads[0]
	if thread.HistoryState != protocol.CodexHistoryStateComplete || !thread.FilesComplete || len(thread.Events) != 1 || len(thread.Files) != 1 {
		t.Fatalf("thread readiness/material = %+v", thread)
	}
	if snapshot.CapabilityStates[SourceMethodThreadItemsList] != "unsupported" {
		t.Fatalf("capability states = %#v", snapshot.CapabilityStates)
	}
}

func TestSourceClientMarksHistoryIncompleteWhenAllHistoryMethodsAreUnsupported(t *testing.T) {
	transport := newSourceTestTransport()
	transport.responses["initialize"] = RPCMessage{Result: sourceInitializeResult()}
	transport.responses[SourceMethodThreadRead] = RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-1"}}`)}
	transport.responses[SourceMethodThreadTurnsList] = RPCMessage{Error: &RPCError{Code: -32601, Message: "method unsupported"}}
	transport.responses[SourceMethodThreadItemsList] = RPCMessage{Error: &RPCError{Code: -32601, Message: "method unsupported"}}
	transport.responses[SourceMethodAttachmentList] = RPCMessage{Result: json.RawMessage(`{"data":[]}`)}
	source, err := NewSourceClient(context.Background(), transport, ClientInfo{})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := source.ReadHistory(context.Background(), "thread-1")
	if !errors.Is(err, ErrSourceHistoryIncomplete) || snapshot.HistoryComplete {
		t.Fatalf("ReadHistory() = %+v, error = %v", snapshot, err)
	}
}

func TestSourceClientAcceptsItemsAsTheCompleteHistorySource(t *testing.T) {
	transport := newSourceTestTransport()
	transport.responses["initialize"] = RPCMessage{Result: sourceInitializeResult()}
	transport.responses[SourceMethodThreadRead] = RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-1"}}`)}
	transport.responses[SourceMethodThreadTurnsList] = RPCMessage{Error: &RPCError{Code: -32601, Message: "method unsupported"}}
	transport.responses[SourceMethodThreadItemsList] = RPCMessage{Result: json.RawMessage(`{"data":[{"id":"item-1","type":"userMessage"}]}`)}
	transport.responses[SourceMethodAttachmentList] = RPCMessage{Result: json.RawMessage(`{"data":[]}`)}
	source, err := NewSourceClient(context.Background(), transport, ClientInfo{})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := source.ReadHistory(context.Background(), "thread-1")
	if err != nil || !snapshot.HistoryComplete || len(snapshot.Events) != 1 {
		t.Fatalf("ReadHistory() = %+v, error = %v", snapshot, err)
	}
}

func TestSourceClientParsesCurrentProtocolShapes(t *testing.T) {
	handshake := parseAppServerHandshake(json.RawMessage(`{"userAgent":"Codex Desktop/0.166.0 (Mac OS 27.2.0; arm64)"}`))
	if handshake.Build != "Codex Desktop/0.166.0" || handshake.ServerVersion != "0.166.0" {
		t.Fatalf("handshake identity = (%q, %q)", handshake.Build, handshake.ServerVersion)
	}

	thread, err := decodeThread(json.RawMessage(`{"id":"thread-1","name":"标题","createdAt":1793628559,"updatedAt":1793628560,"status":{"type":"idle"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if thread.UpdatedAt == "" || sourceThreadStatus(thread) != protocol.CodexSourceStatusActive {
		t.Fatalf("thread = %+v", thread)
	}

	notification, ok := parseSourceNotification(RPCMessage{
		Method: SourceNotificationName,
		Params: json.RawMessage(`{"threadId":"thread-1","threadName":"更新后的标题"}`),
		Raw:    json.RawMessage(`{"method":"thread/name/updated","params":{"threadId":"thread-1","threadName":"更新后的标题"}}`),
	})
	if !ok || notification.Title == nil || *notification.Title != "更新后的标题" {
		t.Fatalf("notification = %+v, ok = %t", notification, ok)
	}
}
