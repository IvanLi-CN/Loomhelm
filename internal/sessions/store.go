package sessions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrSessionNotFound = errors.New("session is not present in persistence")
	ErrSessionConflict = errors.New("session identity conflicts with persisted state")
)

type StoreConfig struct {
	Now func() time.Time
}

// Store is the durable Session boundary. All lifecycle transitions lock the
// row before applying the pure state machine so a replacement generation
// cannot race a disconnect or reconciliation update.
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

func (s *Store) Create(ctx context.Context, input NewInput) (Session, error) {
	if err := s.ready(ctx); err != nil {
		return Session{}, err
	}
	if strings.TrimSpace(input.ExternalThreadRef) == "" {
		return Session{}, fmt.Errorf("%w: external thread reference is required", ErrInvalidSession)
	}
	if input.CreatedAt == "" {
		input.CreatedAt = s.now().UTC().Format(time.RFC3339Nano)
	}
	if input.UpdatedAt == "" {
		input.UpdatedAt = input.CreatedAt
	}
	candidate, err := New(input)
	if err != nil {
		return Session{}, err
	}

	var existing Session
	err = s.pool.QueryRow(ctx, `
		INSERT INTO execution_sessions (
			id, external_thread_ref, path, state, project_id, generation,
			created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7::timestamptz, $8::timestamptz)
		ON CONFLICT (id) DO UPDATE SET id = execution_sessions.id
		RETURNING id, external_thread_ref, path, state, project_id, generation,
		          created_at, updated_at
	`, input.ID, input.ExternalThreadRef, input.Path, candidate.State, input.ProjectID, input.Generation, input.CreatedAt, input.UpdatedAt).Scan(
		&existing.ID, &existing.ExternalThreadRef, &existing.Path, &existing.State,
		&existing.ProjectID, &existing.Generation, new(time.Time), new(time.Time),
	)
	if err != nil {
		return Session{}, fmt.Errorf("persist session: %w", err)
	}

	// The no-op conflict branch returns the existing row. Re-read the complete
	// joined view so task binding and timestamps are never lost at this boundary.
	stored, err := s.Get(ctx, existing.ID)
	if err != nil {
		return Session{}, err
	}
	if stored.ExternalThreadRef != input.ExternalThreadRef || stored.Path != input.Path || stored.Generation != input.Generation || optionalStringValue(stored.ProjectID) != input.ProjectID {
		return Session{}, fmt.Errorf("%w: session %q", ErrSessionConflict, input.ID)
	}
	return stored, nil
}

func (s *Store) Get(ctx context.Context, sessionID string) (Session, error) {
	if err := s.ready(ctx); err != nil {
		return Session{}, err
	}
	if strings.TrimSpace(sessionID) == "" {
		return Session{}, fmt.Errorf("%w: session id is required", ErrInvalidSession)
	}
	stored, err := scanSession(s.pool.QueryRow(ctx, sessionQuery+` WHERE session.id = $1`, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrSessionNotFound
	}
	return stored, err
}

func (s *Store) Activate(ctx context.Context, sessionID, generation, externalThreadRef, updatedAt string) (Session, error) {
	return s.transition(ctx, sessionID, func(current Session) (Session, error) {
		return current.Activate(generation, externalThreadRef, s.timestamp(updatedAt))
	})
}

func (s *Store) Disconnect(ctx context.Context, sessionID, generation, updatedAt string) (Session, error) {
	return s.transition(ctx, sessionID, func(current Session) (Session, error) {
		return current.Disconnect(generation, s.timestamp(updatedAt))
	})
}

func (s *Store) BeginReconciliation(ctx context.Context, sessionID, generation, updatedAt string) (Session, error) {
	return s.transition(ctx, sessionID, func(current Session) (Session, error) {
		return current.BeginReconciliation(generation, s.timestamp(updatedAt))
	})
}

func (s *Store) Reconcile(ctx context.Context, sessionID, generation string, state protocol.ReconciliationState, externalThreadRef, updatedAt string) (Session, error) {
	return s.transition(ctx, sessionID, func(current Session) (Session, error) {
		return current.Reconcile(generation, state, externalThreadRef, s.timestamp(updatedAt))
	})
}

func (s *Store) MarkUnsupported(ctx context.Context, sessionID, updatedAt string) (Session, error) {
	return s.transition(ctx, sessionID, func(current Session) (Session, error) {
		return current.MarkUnsupported(s.timestamp(updatedAt))
	})
}

func (s *Store) Close(ctx context.Context, sessionID, generation, updatedAt string) (Session, error) {
	return s.transition(ctx, sessionID, func(current Session) (Session, error) {
		return current.Close(generation, s.timestamp(updatedAt))
	})
}

// RecordCursor persists the last acknowledged host cursor without changing
// lifecycle state. The generation predicate is the session-side execution
// fence; host cursor durability remains owned by hosts.Service as well.
func (s *Store) RecordCursor(ctx context.Context, sessionID, generation, cursor string) error {
	if err := s.ready(ctx); err != nil {
		return err
	}
	if strings.TrimSpace(sessionID) == "" || strings.TrimSpace(generation) == "" || strings.TrimSpace(cursor) == "" {
		return fmt.Errorf("%w: session, generation and cursor are required", ErrInvalidSession)
	}
	result, err := s.pool.Exec(ctx, `
		UPDATE execution_sessions
		SET last_cursor = $3, updated_at = CURRENT_TIMESTAMP
		WHERE id = $1 AND generation = $2
	`, sessionID, generation, cursor)
	if err != nil {
		return fmt.Errorf("record session cursor: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ErrStaleGeneration
	}
	return nil
}

// BindTask performs the Session/Task association as one database transaction.
// The existing tasks.session_id unique index remains the final database race
// guard; this transaction also checks project sharing and keeps both rows in
// one committed state.
func (s *Store) BindTask(ctx context.Context, sessionID string, request BindRequest) (Session, error) {
	if err := s.ready(ctx); err != nil {
		return Session{}, err
	}
	if strings.TrimSpace(sessionID) == "" {
		return Session{}, fmt.Errorf("%w: session id is required", ErrInvalidSession)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, fmt.Errorf("begin session binding: %w", err)
	}
	defer tx.Rollback(ctx)

	current, err := scanSession(tx.QueryRow(ctx, sessionQuery+` WHERE session.id = $1 FOR UPDATE OF session`, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrSessionNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("lock session for binding: %w", err)
	}
	var taskProjectID string
	var taskSessionID *string
	err = tx.QueryRow(ctx, `
		SELECT project_id, session_id
		FROM tasks
		WHERE id = $1
		FOR UPDATE
	`, request.TaskID).Scan(&taskProjectID, &taskSessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrTaskBound
	}
	if err != nil {
		return Session{}, fmt.Errorf("lock task for session binding: %w", err)
	}
	request.TaskProjectID = taskProjectID
	if taskSessionID != nil {
		request.CurrentTaskSessionID = *taskSessionID
	}
	if _, err := current.BindTask(request); err != nil {
		return Session{}, err
	}
	if optionalStringValue(current.ProjectID) == "" {
		if _, err := tx.Exec(ctx, `
			UPDATE execution_sessions
			SET project_id = $2, updated_at = CURRENT_TIMESTAMP
			WHERE id = $1
		`, sessionID, taskProjectID); err != nil {
			return Session{}, fmt.Errorf("assign session project during binding: %w", err)
		}
	}
	if optionalStringValue(current.TaskID) == "" {
		if _, err := tx.Exec(ctx, `UPDATE tasks SET session_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, request.TaskID, sessionID); err != nil {
			return Session{}, fmt.Errorf("assign task session during binding: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, fmt.Errorf("commit session binding: %w", err)
	}
	return s.Get(ctx, sessionID)
}

func (s *Store) transition(ctx context.Context, sessionID string, apply func(Session) (Session, error)) (Session, error) {
	if err := s.ready(ctx); err != nil {
		return Session{}, err
	}
	if apply == nil {
		return Session{}, fmt.Errorf("%w: transition callback is required", ErrInvalidSession)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, fmt.Errorf("begin session transition: %w", err)
	}
	defer tx.Rollback(ctx)
	current, err := scanSession(tx.QueryRow(ctx, sessionQuery+` WHERE session.id = $1 FOR UPDATE OF session`, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrSessionNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("lock session for transition: %w", err)
	}
	updated, err := apply(current)
	if err != nil {
		return Session{}, err
	}
	closedAt := any(nil)
	if updated.State == protocol.SessionStateClosed {
		closedAt = s.now()
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_sessions
		SET external_thread_ref = $2,
		    state = $3,
		    generation = $4,
		    last_cursor = $5,
		    terminal_reason = $6,
		    updated_at = $7::timestamptz,
		    closed_at = $8
		WHERE id = $1
		`, updated.ID, updated.ExternalThreadRef, updated.State, updated.Generation, updated.LastCursor, updated.TerminalReason, updated.UpdatedAt, closedAt); err != nil {
		return Session{}, fmt.Errorf("persist session transition: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, fmt.Errorf("commit session transition: %w", err)
	}
	return updated, nil
}

const sessionQuery = `
	SELECT session.id,
	       session.external_thread_ref,
	       session.path,
	       session.state,
	       session.project_id,
	       session.generation,
	       task.id,
	       session.last_cursor,
	       session.terminal_reason,
	       session.created_at,
	       session.updated_at
	FROM execution_sessions AS session
	LEFT JOIN tasks AS task ON task.session_id = session.id
`

func scanSession(row pgx.Row) (Session, error) {
	var session Session
	var projectID, taskID *string
	var lastCursor, terminalReason *string
	var createdAt, updatedAt time.Time
	if err := row.Scan(
		&session.ID, &session.ExternalThreadRef, &session.Path, &session.State,
		&projectID, &session.Generation, &taskID, &lastCursor, &terminalReason,
		&createdAt, &updatedAt,
	); err != nil {
		return Session{}, err
	}
	session.ProjectID = projectID
	session.TaskID = taskID
	session.LastCursor = optionalStringValue(lastCursor)
	session.TerminalReason = optionalStringValue(terminalReason)
	session.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	session.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	return session, nil
}

func (s *Store) timestamp(value string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return s.now().UTC().Format(time.RFC3339Nano)
}

func (s *Store) ready(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("session store database is not configured")
	}
	if ctx == nil {
		return errors.New("session context must not be nil")
	}
	return nil
}
