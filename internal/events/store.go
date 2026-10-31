package events

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrEventSessionNotFound = errors.New("event session is not present in persistence")
)

type StoreConfig struct {
	Now func() time.Time
}

// Store persists the ordered event stream. The Session row is the per-stream
// serialization point, so concurrent Connector deliveries cannot allocate the
// same sequence or acknowledge an event before its durable append commits.
type Store struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewStore(pool *pgxpool.Pool, configs ...StoreConfig) *Store {
	now := time.Now
	if len(configs) > 0 && configs[0].Now != nil {
		now = configs[0].Now
	}
	return &Store{pool: pool, now: now}
}

func (s *Store) Append(ctx context.Context, input protocol.Event) (AppendResult, error) {
	if err := s.ready(ctx); err != nil {
		return AppendResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AppendResult{}, fmt.Errorf("begin event append: %w", err)
	}
	defer tx.Rollback(ctx)
	result, err := AppendTx(ctx, tx, input, s.now)
	if err != nil {
		return AppendResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AppendResult{}, fmt.Errorf("commit event append: %w", err)
	}
	return result, nil
}

// AppendTx is the transaction-aware event append used by the Run event
// handler. It commits no transaction itself; callers may update Run and
// Approval state before committing the same transaction.
func AppendTx(ctx context.Context, tx pgx.Tx, input protocol.Event, now func() time.Time) (AppendResult, error) {
	if ctx == nil {
		return AppendResult{}, errors.New("event context must not be nil")
	}
	if tx == nil {
		return AppendResult{}, errors.New("event transaction must not be nil")
	}
	if now == nil {
		now = time.Now
	}
	if strings.TrimSpace(input.SessionID) == "" {
		return AppendResult{}, fmt.Errorf("%w: session id is required", ErrInvalidEvent)
	}
	if err := validateEvent(input, input.SessionID); err != nil {
		return AppendResult{}, err
	}

	var sessionID string
	if err := tx.QueryRow(ctx, `SELECT id FROM execution_sessions WHERE id = $1 FOR UPDATE`, input.SessionID).Scan(&sessionID); errors.Is(err, pgx.ErrNoRows) {
		return AppendResult{}, ErrEventSessionNotFound
	} else if err != nil {
		return AppendResult{}, fmt.Errorf("lock event session: %w", err)
	}

	if existing, found, err := findByEventID(ctx, tx, input.EventID); err != nil {
		return AppendResult{}, err
	} else if found {
		if compatibleRetry(existing, input) {
			return AppendResult{Event: cloneEvent(existing), Deduplicated: true}, nil
		}
		return AppendResult{}, fmt.Errorf("%w: event id %q", ErrEventConflict, input.EventID)
	}
	if existing, found, err := findByCursor(ctx, tx, input.SessionID, input.Cursor); err != nil {
		return AppendResult{}, err
	} else if found {
		if compatibleRetry(existing, input) {
			return AppendResult{Event: cloneEvent(existing), Deduplicated: true}, nil
		}
		return AppendResult{}, fmt.Errorf("%w: cursor %q", ErrEventConflict, input.Cursor)
	}

	var lastSequence int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sequence), 0) FROM execution_events WHERE session_id = $1`, input.SessionID).Scan(&lastSequence); err != nil {
		return AppendResult{}, fmt.Errorf("read event sequence: %w", err)
	}
	if input.Sequence <= 0 {
		input.Sequence = lastSequence + 1
	}
	if input.Sequence != lastSequence+1 {
		return AppendResult{}, fmt.Errorf("%w: got %d, want %d", ErrEventOutOfOrder, input.Sequence, lastSequence+1)
	}
	if input.Cursor == "" {
		input.Cursor = fmt.Sprintf("%s:%d", input.SessionID, input.Sequence)
	}
	if input.EventID == "" {
		input.EventID = eventID(input)
	}
	if existing, found, err := findByEventID(ctx, tx, input.EventID); err != nil {
		return AppendResult{}, err
	} else if found {
		if compatibleRetry(existing, input) {
			return AppendResult{Event: cloneEvent(existing), Deduplicated: true}, nil
		}
		return AppendResult{}, fmt.Errorf("%w: event id %q", ErrEventConflict, input.EventID)
	}
	if existing, found, err := findByCursor(ctx, tx, input.SessionID, input.Cursor); err != nil {
		return AppendResult{}, err
	} else if found {
		if compatibleRetry(existing, input) {
			return AppendResult{Event: cloneEvent(existing), Deduplicated: true}, nil
		}
		return AppendResult{}, fmt.Errorf("%w: cursor %q", ErrEventConflict, input.Cursor)
	}
	if input.OccurredAt == "" {
		input.OccurredAt = now().UTC().Format(time.RFC3339Nano)
	}
	digest := persistedEventDigest(input)
	if _, err := tx.Exec(ctx, `
		INSERT INTO execution_events (
			event_id, session_id, run_id, sequence, cursor, type, source,
			occurred_at, payload, digest
		)
		VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, $9, $10)
	`, input.EventID, input.SessionID, optionalRunID(input.RunID), input.Sequence, input.Cursor, input.Type, input.Source, input.OccurredAt, []byte(input.Payload), digest); err != nil {
		return AppendResult{}, fmt.Errorf("persist event: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_sessions
		SET last_cursor = $2, updated_at = CURRENT_TIMESTAMP
		WHERE id = $1
	`, input.SessionID, input.Cursor); err != nil {
		return AppendResult{}, fmt.Errorf("update event session cursor: %w", err)
	}
	return AppendResult{Event: cloneEvent(input)}, nil
}

func (s *Store) Read(ctx context.Context, query protocol.EventQuery) (protocol.EventPage, error) {
	if err := s.ready(ctx); err != nil {
		return protocol.EventPage{}, err
	}
	if strings.TrimSpace(query.SessionID) == "" {
		return protocol.EventPage{}, fmt.Errorf("%w: session id is required", ErrInvalidEvent)
	}
	limit := query.Limit
	if limit <= 0 || limit > MaxPageSize {
		limit = MaxPageSize
	}
	startSequence := int64(0)
	if query.AfterCursor != "" {
		var boundary protocol.Event
		if err := scanEvent(s.pool.QueryRow(ctx, eventQuery+` WHERE session_id = $1 AND cursor = $2`, query.SessionID, query.AfterCursor), &boundary); errors.Is(err, pgx.ErrNoRows) {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		} else if err != nil {
			return protocol.EventPage{}, fmt.Errorf("read event cursor: %w", err)
		}
		if query.RunID != "" && optionalRunID(boundary.RunID) != query.RunID {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		}
		startSequence = boundary.Sequence
	}
	args := []any{query.SessionID, startSequence}
	where := "session_id = $1 AND sequence > $2"
	if query.RunID != "" {
		args = append(args, query.RunID)
		where += fmt.Sprintf(" AND run_id = $%d", len(args))
	}
	args = append(args, limit+1)
	rows, err := s.pool.Query(ctx, eventQuery+fmt.Sprintf(" WHERE %s ORDER BY sequence, event_id LIMIT $%d", where, len(args)), args...)
	if err != nil {
		return protocol.EventPage{}, fmt.Errorf("read events: %w", err)
	}
	defer rows.Close()
	page := protocol.EventPage{Events: make([]protocol.Event, 0, limit)}
	for rows.Next() {
		var event protocol.Event
		if err := scanEvent(rows, &event); err != nil {
			return protocol.EventPage{}, fmt.Errorf("scan event: %w", err)
		}
		page.Events = append(page.Events, event)
	}
	if err := rows.Err(); err != nil {
		return protocol.EventPage{}, fmt.Errorf("read events: %w", err)
	}
	if int64(len(page.Events)) > limit {
		page.HasMore = true
		page.Events = page.Events[:limit]
		cursor := page.Events[len(page.Events)-1].Cursor
		page.NextCursor = &cursor
	}
	return page, nil
}

const eventQuery = `
	SELECT event_id, session_id, run_id, sequence, cursor, type, source,
	       occurred_at, payload
	FROM execution_events
`

func findByEventID(ctx context.Context, tx pgx.Tx, eventIDValue string) (protocol.Event, bool, error) {
	if eventIDValue == "" {
		return protocol.Event{}, false, nil
	}
	var event protocol.Event
	if err := scanEvent(tx.QueryRow(ctx, eventQuery+` WHERE event_id = $1`, eventIDValue), &event); errors.Is(err, pgx.ErrNoRows) {
		return protocol.Event{}, false, nil
	} else if err != nil {
		return protocol.Event{}, false, fmt.Errorf("read event identity: %w", err)
	}
	return event, true, nil
}

func findByCursor(ctx context.Context, tx pgx.Tx, sessionID, cursor string) (protocol.Event, bool, error) {
	if cursor == "" {
		return protocol.Event{}, false, nil
	}
	var event protocol.Event
	if err := scanEvent(tx.QueryRow(ctx, eventQuery+` WHERE session_id = $1 AND cursor = $2`, sessionID, cursor), &event); errors.Is(err, pgx.ErrNoRows) {
		return protocol.Event{}, false, nil
	} else if err != nil {
		return protocol.Event{}, false, fmt.Errorf("read event cursor: %w", err)
	}
	return event, true, nil
}

func scanEvent(row interface{ Scan(...any) error }, event *protocol.Event) error {
	var runID *string
	var eventType, source string
	var payload []byte
	if err := row.Scan(&event.EventID, &event.SessionID, &runID, &event.Sequence, &event.Cursor, &eventType, &source, &event.OccurredAt, &payload); err != nil {
		return err
	}
	event.Type = protocol.EventType(eventType)
	event.Source = protocol.EventSource(source)
	event.RunID = runID
	event.Payload = append(json.RawMessage(nil), payload...)
	return nil
}

func persistedEventDigest(event protocol.Event) string {
	value := struct {
		EventID    string               `json:"event_id"`
		SessionID  string               `json:"session_id"`
		RunID      string               `json:"run_id,omitempty"`
		Sequence   int64                `json:"sequence"`
		Cursor     string               `json:"cursor"`
		Type       protocol.EventType   `json:"type"`
		Source     protocol.EventSource `json:"source"`
		OccurredAt string               `json:"occurred_at"`
		Payload    json.RawMessage      `json:"payload"`
	}{event.EventID, event.SessionID, optionalRunID(event.RunID), event.Sequence, event.Cursor, event.Type, event.Source, event.OccurredAt, event.Payload}
	encoded, _ := json.Marshal(value)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func (s *Store) ready(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("event store database is not configured")
	}
	if ctx == nil {
		return errors.New("event context must not be nil")
	}
	return nil
}
