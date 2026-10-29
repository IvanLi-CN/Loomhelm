// Package events owns ordered event validation, idempotent append semantics,
// and exclusive cursor reads. It does not persist events; callers must commit
// the returned event through a durable repository before acknowledging it.
package events

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

var (
	ErrInvalidEvent    = errors.New("event is invalid")
	ErrEventConflict   = errors.New("event identity conflicts with existing event")
	ErrEventOutOfOrder = errors.New("event sequence is out of order")
)

const MaxPageSize int64 = 1000

type AppendResult struct {
	Event        protocol.Event
	Deduplicated bool
}

type Stream struct {
	mu        sync.RWMutex
	sessionID string
	events    []protocol.Event
	byID      map[string]int
	byCursor  map[string]int
	next      int64
}

func NewStream(sessionID string) (*Stream, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("%w: session id is required", ErrInvalidEvent)
	}
	return &Stream{
		sessionID: sessionID,
		byID:      make(map[string]int),
		byCursor:  make(map[string]int),
	}, nil
}

func (s *Stream) Append(input protocol.Event) (AppendResult, error) {
	if s == nil {
		return AppendResult{}, ErrInvalidEvent
	}
	if err := validateEvent(input, s.sessionID); err != nil {
		return AppendResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if input.EventID != "" {
		if index, ok := s.byID[input.EventID]; ok {
			existing := s.events[index]
			if compatibleRetry(existing, input) {
				return AppendResult{Event: cloneEvent(existing), Deduplicated: true}, nil
			}
			return AppendResult{}, fmt.Errorf("%w: event id %q", ErrEventConflict, input.EventID)
		}
	}
	if input.Cursor != "" {
		if index, ok := s.byCursor[input.Cursor]; ok {
			existing := s.events[index]
			if compatibleRetry(existing, input) {
				return AppendResult{Event: cloneEvent(existing), Deduplicated: true}, nil
			}
			return AppendResult{}, fmt.Errorf("%w: cursor %q", ErrEventConflict, input.Cursor)
		}
	}
	if input.Sequence <= 0 {
		input.Sequence = s.next + 1
	}
	if input.Sequence != s.next+1 {
		return AppendResult{}, fmt.Errorf("%w: got %d, want %d", ErrEventOutOfOrder, input.Sequence, s.next+1)
	}
	if input.Cursor == "" {
		input.Cursor = fmt.Sprintf("%s:%d", s.sessionID, input.Sequence)
	}
	if input.EventID == "" {
		input.EventID = eventID(input)
	}
	if _, exists := s.byCursor[input.Cursor]; exists {
		return AppendResult{}, fmt.Errorf("%w: cursor %q", ErrEventConflict, input.Cursor)
	}
	if _, exists := s.byID[input.EventID]; exists {
		return AppendResult{}, fmt.Errorf("%w: event id %q", ErrEventConflict, input.EventID)
	}
	index := len(s.events)
	s.events = append(s.events, cloneEvent(input))
	s.byID[input.EventID] = index
	s.byCursor[input.Cursor] = index
	s.next = input.Sequence
	return AppendResult{Event: cloneEvent(input)}, nil
}

func (s *Stream) Read(query protocol.EventQuery) (protocol.EventPage, error) {
	if s == nil {
		return protocol.EventPage{}, ErrInvalidEvent
	}
	if strings.TrimSpace(query.SessionID) == "" || query.SessionID != s.sessionID {
		return protocol.EventPage{}, fmt.Errorf("%w: event session id does not match stream", ErrInvalidEvent)
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	start := 0
	if query.AfterCursor != "" {
		index, ok := s.byCursor[query.AfterCursor]
		if !ok {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		}
		boundary := s.events[index]
		if query.RunID != "" && optionalRunID(boundary.RunID) != query.RunID {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		}
		start = index + 1
	}
	limit := query.Limit
	if limit <= 0 || limit > MaxPageSize {
		limit = MaxPageSize
	}
	page := protocol.EventPage{Events: make([]protocol.Event, 0)}
	for _, event := range s.events[start:] {
		if query.RunID != "" && optionalRunID(event.RunID) != query.RunID {
			continue
		}
		if int64(len(page.Events)) >= limit {
			page.HasMore = true
			break
		}
		page.Events = append(page.Events, cloneEvent(event))
	}
	if page.HasMore && len(page.Events) > 0 {
		cursor := page.Events[len(page.Events)-1].Cursor
		page.NextCursor = &cursor
	}
	return page, nil
}

func (s *Stream) Snapshot() []protocol.Event {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]protocol.Event, 0, len(s.events))
	for _, event := range s.events {
		result = append(result, cloneEvent(event))
	}
	return result
}

func validateEvent(event protocol.Event, sessionID string) error {
	if event.SessionID != sessionID || strings.TrimSpace(event.SessionID) == "" {
		return fmt.Errorf("%w: session id is required and must match stream", ErrInvalidEvent)
	}
	if strings.TrimSpace(string(event.Type)) == "" || strings.TrimSpace(string(event.Source)) == "" {
		return fmt.Errorf("%w: type and source are required", ErrInvalidEvent)
	}
	if len(bytes.TrimSpace(event.Payload)) == 0 || !json.Valid(event.Payload) {
		return fmt.Errorf("%w: payload must be valid JSON", ErrInvalidEvent)
	}
	if event.Sequence < 0 {
		return fmt.Errorf("%w: sequence must not be negative", ErrInvalidEvent)
	}
	return nil
}

func eventID(event protocol.Event) string {
	value := struct {
		SessionID string               `json:"session_id"`
		RunID     *string              `json:"run_id,omitempty"`
		Sequence  int64                `json:"sequence"`
		Type      protocol.EventType   `json:"type"`
		Source    protocol.EventSource `json:"source"`
		Payload   json.RawMessage      `json:"payload"`
	}{event.SessionID, event.RunID, event.Sequence, event.Type, event.Source, event.Payload}
	encoded, _ := json.Marshal(value)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func compatibleRetry(existing, retry protocol.Event) bool {
	if existing.SessionID != retry.SessionID || existing.Source != retry.Source || existing.Type != retry.Type || optionalRunID(existing.RunID) != optionalRunID(retry.RunID) || !bytes.Equal(existing.Payload, retry.Payload) {
		return false
	}
	if retry.EventID != "" && retry.EventID != existing.EventID {
		return false
	}
	if retry.Cursor != "" && retry.Cursor != existing.Cursor {
		return false
	}
	if retry.Sequence > 0 && retry.Sequence != existing.Sequence {
		return false
	}
	if retry.OccurredAt != "" && existing.OccurredAt != "" && retry.OccurredAt != existing.OccurredAt {
		return false
	}
	return true
}

func cloneEvent(event protocol.Event) protocol.Event {
	event.Payload = append(json.RawMessage(nil), event.Payload...)
	event.RunID = cloneStringPointer(event.RunID)
	return event
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func optionalRunID(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
