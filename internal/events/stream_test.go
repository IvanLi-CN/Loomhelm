package events

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestStreamAssignsOrderAndDeduplicatesEvents(t *testing.T) {
	stream, err := NewStream("session-1")
	if err != nil {
		t.Fatal(err)
	}
	first, err := stream.Append(testEvent("session-1", "run-1", protocol.EventTypeRunStarted, `{"status":"running"}`))
	if err != nil {
		t.Fatal(err)
	}
	if first.Event.Sequence != 1 || first.Event.Cursor != "session-1:1" || first.Event.EventID == "" {
		t.Fatalf("first event = %+v", first.Event)
	}
	retry, err := stream.Append(first.Event)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Deduplicated || retry.Event.Sequence != first.Event.Sequence {
		t.Fatalf("duplicate event = %+v", retry)
	}
	serverRetry := first.Event
	serverRetry.Cursor = ""
	serverRetry.Sequence = 0
	if retry, err := stream.Append(serverRetry); err != nil || !retry.Deduplicated {
		t.Fatalf("event retry without server cursor = %+v, error %v", retry, err)
	}
	conflict := first.Event
	conflict.Payload = []byte(`{"status":"failed"}`)
	if _, err := stream.Append(conflict); !errors.Is(err, ErrEventConflict) {
		t.Fatalf("event conflict = %v, want %v", err, ErrEventConflict)
	}
	if _, err := stream.Append(protocol.Event{SessionID: "session-1", Sequence: 4, Type: protocol.EventTypeRunCompleted, Source: protocol.EventSourceAppServer, Payload: []byte(`{}`)}); !errors.Is(err, ErrEventOutOfOrder) {
		t.Fatalf("out-of-order event = %v, want %v", err, ErrEventOutOfOrder)
	}
}

func TestStreamReadUsesExclusiveScopedCursors(t *testing.T) {
	stream, err := NewStream("session-1")
	if err != nil {
		t.Fatal(err)
	}
	started, err := stream.Append(testEvent("session-1", "run-1", protocol.EventTypeRunStarted, `{"status":"running"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Append(testEvent("session-1", "run-2", protocol.EventTypeRunStarted, `{"status":"running"}`)); err != nil {
		t.Fatal(err)
	}
	completed, err := stream.Append(testEvent("session-1", "run-1", protocol.EventTypeRunCompleted, `{"status":"completed"}`))
	if err != nil {
		t.Fatal(err)
	}
	page, err := stream.Read(protocol.EventQuery{SessionID: "session-1", RunID: "run-1", AfterCursor: started.Event.Cursor, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 1 || page.Events[0].Cursor != completed.Event.Cursor || page.HasMore || page.NextCursor != nil {
		t.Fatalf("exclusive run page = %+v", page)
	}
	if _, err := stream.Read(protocol.EventQuery{SessionID: "session-1", RunID: "run-2", AfterCursor: started.Event.Cursor}); !errors.Is(err, protocol.ErrCursorExpired) {
		t.Fatalf("cross-run cursor = %v, want %v", err, protocol.ErrCursorExpired)
	}
	if _, err := stream.Read(protocol.EventQuery{SessionID: "session-1", AfterCursor: "expired-cursor"}); !errors.Is(err, protocol.ErrCursorExpired) {
		t.Fatalf("unknown cursor = %v, want %v", err, protocol.ErrCursorExpired)
	}
}

func TestStreamConcurrentAppendKeepsStrictSequence(t *testing.T) {
	stream, err := NewStream("session-race")
	if err != nil {
		t.Fatal(err)
	}
	const callers = 64
	var group sync.WaitGroup
	errorsSeen := make(chan error, callers)
	for i := 0; i < callers; i++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			_, appendErr := stream.Append(protocol.Event{
				SessionID: "session-race",
				EventID:   fmt.Sprintf("event-%d", index),
				Type:      protocol.EventTypeUnknown,
				Source:    protocol.EventSourceHostObservation,
				Payload:   []byte(fmt.Sprintf(`{"index":%d}`, index)),
			})
			if appendErr != nil {
				errorsSeen <- appendErr
			}
		}(i)
	}
	group.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Fatal(err)
	}
	events := stream.Snapshot()
	if len(events) != callers {
		t.Fatalf("concurrent event count = %d, want %d", len(events), callers)
	}
	for index, event := range events {
		if event.Sequence != int64(index+1) {
			t.Fatalf("event %d sequence = %d, want %d", index, event.Sequence, index+1)
		}
	}
}

func testEvent(sessionID, runID string, eventType protocol.EventType, payload string) protocol.Event {
	return protocol.Event{
		SessionID: sessionID,
		RunID:     &runID,
		Type:      eventType,
		Source:    protocol.EventSourceAppServer,
		Payload:   []byte(payload),
	}
}
