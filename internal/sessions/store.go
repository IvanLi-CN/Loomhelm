package sessions

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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

	var existingID string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO execution_sessions (
			id, external_thread_ref, path, state, project_id, generation,
			created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7::timestamptz, $8::timestamptz)
		ON CONFLICT (id) DO UPDATE SET id = execution_sessions.id
		RETURNING id
	`, input.ID, input.ExternalThreadRef, input.Path, candidate.State, input.ProjectID, input.Generation, input.CreatedAt, input.UpdatedAt).Scan(&existingID)
	if err != nil {
		return Session{}, fmt.Errorf("persist session: %w", err)
	}

	// The no-op conflict branch returns the existing row. Re-read the complete
	// joined view so task binding and timestamps are never lost at this boundary.
	stored, err := s.Get(ctx, existingID)
	if err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			return Session{}, fmt.Errorf("%w: session %q is an unconfirmed creation intent", ErrSessionConflict, input.ID)
		}
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
	stored, err := scanSession(s.pool.QueryRow(ctx, sessionQuery+` WHERE session.id = $1 AND session.external_thread_ref IS NOT NULL AND session.generation IS NOT NULL`, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrSessionNotFound
	}
	return stored, err
}

// CreateIntent persists the creation identity and all inputs that define its
// idempotency before any Gateway or Connector side effect. The unique command
// key is scoped to the authenticated creator, so command IDs from separate
// owner namespaces cannot disclose or merge one another's sessions.
func (s *Store) CreateIntent(ctx context.Context, input CreationIntentInput) (CreationIntent, error) {
	if err := s.ready(ctx); err != nil {
		return CreationIntent{}, err
	}
	normalized, digest, err := normalizeCreationIntent(input)
	if err != nil {
		return CreationIntent{}, err
	}
	if normalized.CreatedAt == "" {
		normalized.CreatedAt = s.now().UTC().Format(time.RFC3339Nano)
	}
	if normalized.UpdatedAt == "" {
		normalized.UpdatedAt = normalized.CreatedAt
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CreationIntent{}, fmt.Errorf("begin session creation intent: %w", err)
	}
	defer tx.Rollback(ctx)

	if existing, found, err := lockIntentByID(ctx, tx, normalized.SessionID); err != nil {
		return CreationIntent{}, err
	} else if found {
		if err := compareCreationIntent(existing, normalized, digest, true); err != nil {
			return CreationIntent{}, err
		}
		if err := validateExistingCreationIntentTarget(ctx, tx, existing); err != nil {
			return CreationIntent{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return CreationIntent{}, fmt.Errorf("commit existing session creation intent: %w", err)
		}
		return existing.Intent, nil
	}

	if existing, found, err := lockIntentByCommand(ctx, tx, normalized.CreatorUserID, normalized.CommandID); err != nil {
		return CreationIntent{}, err
	} else if found {
		if err := compareCreationIntent(existing, normalized, digest, false); err != nil {
			return CreationIntent{}, err
		}
		if err := validateExistingCreationIntentTarget(ctx, tx, existing); err != nil {
			return CreationIntent{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return CreationIntent{}, fmt.Errorf("commit existing session creation intent: %w", err)
		}
		return existing.Intent, nil
	}

	if normalized.TaskID != "" {
		if err := validateCreationTask(ctx, tx, normalized.ProjectID, normalized.TaskID); err != nil {
			return CreationIntent{}, err
		}
	}

	var insertedID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO execution_sessions (
			id, path, state, project_id, creation_state,
			creation_command_id, creation_payload, creation_digest, creation_summary,
			creator_user_id, host_id, creation_task_id, created_at, updated_at
		)
		VALUES (
			$1, $2, 'starting', NULLIF($3, ''), 'pending',
			$4, $5, $6, $7, $8, $9, NULLIF($10, ''), $11::timestamptz, $12::timestamptz
		)
		ON CONFLICT DO NOTHING
		RETURNING id
	`, normalized.SessionID, normalized.Path, normalized.ProjectID,
		normalized.CommandID, normalized.Parameters, digest, normalized.Summary,
		normalized.CreatorUserID, normalized.HostID, normalized.TaskID,
		normalized.CreatedAt, normalized.UpdatedAt).Scan(&insertedID); errors.Is(err, pgx.ErrNoRows) {
		existing, found, lookupErr := lockIntentByCommand(ctx, tx, normalized.CreatorUserID, normalized.CommandID)
		if lookupErr != nil {
			return CreationIntent{}, lookupErr
		}
		if !found {
			return CreationIntent{}, fmt.Errorf("%w: creation command %q", ErrSessionConflict, normalized.CommandID)
		}
		if err := compareCreationIntent(existing, normalized, digest, false); err != nil {
			return CreationIntent{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return CreationIntent{}, fmt.Errorf("commit existing session creation intent: %w", err)
		}
		return existing.Intent, nil
	} else if err != nil {
		return CreationIntent{}, fmt.Errorf("persist session creation intent: %w", err)
	}

	existing, found, err := lockIntentByID(ctx, tx, insertedID)
	if err != nil {
		return CreationIntent{}, err
	}
	if !found {
		return CreationIntent{}, fmt.Errorf("%w: inserted session %q disappeared", ErrSessionConflict, insertedID)
	}
	if err := tx.Commit(ctx); err != nil {
		return CreationIntent{}, fmt.Errorf("commit session creation intent: %w", err)
	}
	return existing.Intent, nil
}

func (s *Store) GetIntent(ctx context.Context, sessionID string) (CreationIntent, error) {
	if err := s.ready(ctx); err != nil {
		return CreationIntent{}, err
	}
	if strings.TrimSpace(sessionID) == "" {
		return CreationIntent{}, fmt.Errorf("%w: session id is required", ErrInvalidSession)
	}
	record, err := scanIntent(s.pool.QueryRow(ctx, intentQuery+` WHERE session.id = $1`, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CreationIntent{}, ErrSessionNotFound
	}
	if err != nil {
		return CreationIntent{}, fmt.Errorf("read session creation intent: %w", err)
	}
	return record.Intent, nil
}

// GetIntentByCommand resolves the existing session-creation identity without
// inventing a platform execution command row for a still-unconfirmed session.
func (s *Store) GetIntentByCommand(ctx context.Context, commandID string) (CreationIntent, error) {
	if err := s.ready(ctx); err != nil {
		return CreationIntent{}, err
	}
	if strings.TrimSpace(commandID) == "" {
		return CreationIntent{}, fmt.Errorf("%w: command id is required", ErrInvalidSession)
	}
	record, err := scanIntent(s.pool.QueryRow(ctx, intentQuery+` WHERE session.creation_command_id = $1`, commandID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CreationIntent{}, ErrSessionNotFound
	}
	if err != nil {
		return CreationIntent{}, fmt.Errorf("read session creation command intent: %w", err)
	}
	return record.Intent, nil
}

// GetIntentBySessionAndCommand resolves a creation identity only inside the
// caller-provided platform session namespace.
func (s *Store) GetIntentBySessionAndCommand(ctx context.Context, sessionID, commandID string) (CreationIntent, error) {
	if err := s.ready(ctx); err != nil {
		return CreationIntent{}, err
	}
	if strings.TrimSpace(sessionID) == "" || strings.TrimSpace(commandID) == "" {
		return CreationIntent{}, fmt.Errorf("%w: session and command ids are required", ErrInvalidSession)
	}
	record, err := scanIntent(s.pool.QueryRow(ctx, intentQuery+` WHERE session.id = $1 AND session.creation_command_id = $2`, sessionID, commandID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CreationIntent{}, ErrSessionNotFound
	}
	if err != nil {
		return CreationIntent{}, fmt.Errorf("read session creation intent by session and command: %w", err)
	}
	return record.Intent, nil
}

// MarkIntentUnknown records an ambiguous external outcome. An unknown intent
// remains tied to its original command identity and cannot be replaced by a
// fresh creation request.
func (s *Store) MarkIntentUnknown(ctx context.Context, input UnknownIntentInput) (CreationIntent, error) {
	if err := s.ready(ctx); err != nil {
		return CreationIntent{}, err
	}
	if strings.TrimSpace(input.SessionID) == "" {
		return CreationIntent{}, fmt.Errorf("%w: session id is required", ErrInvalidSession)
	}
	reason := strings.TrimSpace(input.Reason)
	if reason == "" {
		return CreationIntent{}, fmt.Errorf("%w: unknown reason is required", ErrInvalidSession)
	}
	if len(reason) > 4096 {
		return CreationIntent{}, fmt.Errorf("%w: unknown reason is too long", ErrInvalidSession)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CreationIntent{}, fmt.Errorf("begin unknown session intent: %w", err)
	}
	defer tx.Rollback(ctx)
	record, found, err := lockIntentByID(ctx, tx, input.SessionID)
	if err != nil {
		return CreationIntent{}, err
	}
	if !found {
		return CreationIntent{}, ErrSessionNotFound
	}
	if record.Intent.State == IntentStateConfirmed {
		if err := tx.Commit(ctx); err != nil {
			return CreationIntent{}, fmt.Errorf("commit confirmed session intent: %w", err)
		}
		return record.Intent, nil
	}
	if record.Intent.State == IntentStatePending {
		if _, err := tx.Exec(ctx, `
			UPDATE execution_sessions
			SET creation_state = 'unknown',
			    creation_unknown_reason = $2,
			    updated_at = $3::timestamptz
			WHERE id = $1
		`, input.SessionID, reason, s.timestamp(input.UpdatedAt)); err != nil {
			return CreationIntent{}, fmt.Errorf("mark session creation unknown: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return CreationIntent{}, fmt.Errorf("commit unknown session intent: %w", err)
	}
	return s.GetIntent(ctx, input.SessionID)
}

// ActivateIntent atomically turns an intent into a confirmed Session. A
// pending or unknown intent may only be activated with a real external thread
// and explicit Codex execution generation. The optional task target is locked
// and bound in the same transaction.
func (s *Store) ActivateIntent(ctx context.Context, input ActivationInput) (Session, error) {
	if err := s.ready(ctx); err != nil {
		return Session{}, err
	}
	if strings.TrimSpace(input.SessionID) == "" {
		return Session{}, fmt.Errorf("%w: session id is required", ErrInvalidSession)
	}
	if strings.TrimSpace(input.ExternalThreadRef) == "" || strings.TrimSpace(input.ExecutionGeneration) == "" {
		return Session{}, fmt.Errorf("%w: external thread reference and execution generation are required", ErrInvalidSession)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, fmt.Errorf("begin session activation: %w", err)
	}
	defer tx.Rollback(ctx)
	record, found, err := lockIntentByID(ctx, tx, input.SessionID)
	if err != nil {
		return Session{}, err
	}
	if !found {
		return Session{}, ErrSessionNotFound
	}
	if record.Intent.State == IntentStateConfirmed {
		if record.Intent.ExternalThreadRef != input.ExternalThreadRef || record.Intent.ExecutionGeneration != input.ExecutionGeneration {
			return Session{}, fmt.Errorf("%w: session %q was activated with a different execution identity", protocol.ErrIdempotencyConflict, input.SessionID)
		}
		if err := tx.Commit(ctx); err != nil {
			return Session{}, fmt.Errorf("commit repeated session activation: %w", err)
		}
		return s.Get(ctx, input.SessionID)
	}
	if record.Intent.State != IntentStatePending && record.Intent.State != IntentStateUnknown {
		return Session{}, fmt.Errorf("%w: unsupported creation intent state %q", ErrSessionTransition, record.Intent.State)
	}

	current := record.Session
	updated, err := current.Activate(input.ExecutionGeneration, input.ExternalThreadRef, s.timestamp(input.UpdatedAt))
	if err != nil {
		return Session{}, err
	}
	if taskID := strings.TrimSpace(record.Intent.TaskID); taskID != "" {
		var taskProjectID string
		var taskSessionID *string
		err := tx.QueryRow(ctx, `
			SELECT project_id, session_id
			FROM tasks
			WHERE id = $1
			FOR UPDATE
		`, taskID).Scan(&taskProjectID, &taskSessionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return Session{}, fmt.Errorf("%w: task %q is no longer present", ErrInvalidSession, taskID)
		}
		if err != nil {
			return Session{}, fmt.Errorf("lock task for session activation: %w", err)
		}
		currentTaskSessionID := ""
		if taskSessionID != nil {
			currentTaskSessionID = *taskSessionID
		}
		if currentTaskSessionID != "" && currentTaskSessionID != input.SessionID {
			return Session{}, ErrTaskBound
		}
		if optionalStringValue(updated.ProjectID) != taskProjectID {
			return Session{}, ErrProjectMismatch
		}
		updated, err = updated.BindTask(BindRequest{
			TaskID:               taskID,
			TaskProjectID:        taskProjectID,
			CurrentTaskSessionID: currentTaskSessionID,
			ConfirmShare:         true,
		})
		if err != nil {
			return Session{}, err
		}
		if currentTaskSessionID == "" {
			if _, err := tx.Exec(ctx, `
				UPDATE tasks
				SET session_id = $2, updated_at = CURRENT_TIMESTAMP
				WHERE id = $1
			`, taskID, input.SessionID); err != nil {
				return Session{}, fmt.Errorf("bind task during session activation: %w", err)
			}
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_sessions
		SET external_thread_ref = $2,
		    generation = $3,
		    state = $4,
		    project_id = NULLIF($5, ''),
		    creation_state = 'confirmed',
		    creation_unknown_reason = '',
		    updated_at = $6::timestamptz
		WHERE id = $1
	`, input.SessionID, updated.ExternalThreadRef, updated.Generation, updated.State, optionalStringValue(updated.ProjectID), updated.UpdatedAt); err != nil {
		return Session{}, fmt.Errorf("activate session intent: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, fmt.Errorf("commit session activation: %w", err)
	}
	return s.Get(ctx, input.SessionID)
}

func (s *Store) GetAccess(ctx context.Context, sessionID string) (SessionAccess, error) {
	if err := s.ready(ctx); err != nil {
		return SessionAccess{}, err
	}
	if strings.TrimSpace(sessionID) == "" {
		return SessionAccess{}, fmt.Errorf("%w: session id is required", ErrInvalidSession)
	}
	var access SessionAccess
	var creatorUserID, hostID, projectID *string
	var state string
	var externalThreadRef, executionGeneration *string
	err := s.pool.QueryRow(ctx, `
		SELECT id, creator_user_id, host_id, project_id, creation_state,
		       external_thread_ref, generation
		FROM execution_sessions
		WHERE id = $1
	`, sessionID).Scan(
		&access.SessionID, &creatorUserID, &hostID, &projectID, &state,
		&externalThreadRef, &executionGeneration,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionAccess{}, ErrSessionNotFound
	}
	if err != nil {
		return SessionAccess{}, fmt.Errorf("read session access facts: %w", err)
	}
	access.CreatorUserID = optionalStringValue(creatorUserID)
	access.HostID = optionalStringValue(hostID)
	access.ProjectID = optionalStringValue(projectID)
	access.IntentState = IntentState(state)
	access.Confirmed = access.IntentState == IntentStateConfirmed && externalThreadRef != nil && executionGeneration != nil
	return access, nil
}

type intentRecord struct {
	Intent         CreationIntent
	Session        Session
	CreationTaskID string
}

func normalizeCreationIntent(input CreationIntentInput) (CreationIntentInput, string, error) {
	input.SessionID = strings.TrimSpace(input.SessionID)
	input.CommandID = strings.TrimSpace(input.CommandID)
	input.CreatorUserID = strings.TrimSpace(input.CreatorUserID)
	input.HostID = strings.TrimSpace(input.HostID)
	input.ProjectID = strings.TrimSpace(input.ProjectID)
	input.TaskID = strings.TrimSpace(input.TaskID)
	input.Summary = strings.TrimSpace(input.Summary)
	input.Parameters = append([]byte(nil), input.Parameters...)
	switch {
	case input.SessionID == "":
		return CreationIntentInput{}, "", fmt.Errorf("%w: session id is required", ErrInvalidSession)
	case input.CommandID == "":
		return CreationIntentInput{}, "", fmt.Errorf("%w: creation command id is required", ErrInvalidSession)
	case input.CreatorUserID == "":
		return CreationIntentInput{}, "", fmt.Errorf("%w: creator user id is required", ErrInvalidSession)
	case input.HostID == "":
		return CreationIntentInput{}, "", fmt.Errorf("%w: selected host id is required", ErrInvalidSession)
	case input.Path != protocol.SessionPathNew && input.Path != protocol.SessionPathExistingActive:
		return CreationIntentInput{}, "", fmt.Errorf("%w: unsupported session path %q", ErrInvalidSession, input.Path)
	case input.TaskID != "" && input.ProjectID == "":
		return CreationIntentInput{}, "", fmt.Errorf("%w: a task-bound session requires a project", ErrInvalidSession)
	case len(input.Parameters) == 0:
		return CreationIntentInput{}, "", fmt.Errorf("%w: creation parameters are required", ErrInvalidSession)
	case len(input.Parameters) > 4<<20:
		return CreationIntentInput{}, "", fmt.Errorf("%w: creation parameters are too large", ErrInvalidSession)
	case len(input.Summary) > 4096:
		return CreationIntentInput{}, "", fmt.Errorf("%w: creation summary is too long", ErrInvalidSession)
	}
	digest := sha256.Sum256(input.Parameters)
	return input, hex.EncodeToString(digest[:]), nil
}

func compareCreationIntent(existing intentRecord, input CreationIntentInput, digest string, sameID bool) error {
	if sameID && existing.Intent.SessionID != input.SessionID {
		return fmt.Errorf("%w: session id %q", ErrSessionConflict, input.SessionID)
	}
	if existing.Intent.CommandID != input.CommandID || existing.Intent.CreatorUserID != input.CreatorUserID {
		return fmt.Errorf("%w: session %q uses another creation identity", ErrSessionConflict, input.SessionID)
	}
	if existing.Intent.HostID != input.HostID ||
		existing.Intent.Path != input.Path ||
		existing.Intent.ProjectID != input.ProjectID ||
		existing.Intent.TaskID != input.TaskID ||
		existing.Intent.Digest != digest ||
		existing.Intent.Summary != input.Summary ||
		!bytes.Equal(existing.Intent.Parameters, input.Parameters) {
		return fmt.Errorf("%w: creation command %q was reused with different parameters", protocol.ErrIdempotencyConflict, input.CommandID)
	}
	return nil
}

func validateCreationTask(ctx context.Context, tx pgx.Tx, projectID, taskID string) error {
	return validateCreationTaskForSession(ctx, tx, projectID, taskID, "")
}

func validateExistingCreationIntentTarget(ctx context.Context, tx pgx.Tx, record intentRecord) error {
	taskID := strings.TrimSpace(record.Intent.TaskID)
	if taskID == "" {
		return nil
	}
	allowedSessionID := ""
	if record.Intent.State == IntentStateConfirmed {
		allowedSessionID = record.Intent.SessionID
	}
	return validateCreationTaskForSession(ctx, tx, record.Intent.ProjectID, taskID, allowedSessionID)
}

func validateCreationTaskForSession(ctx context.Context, tx pgx.Tx, projectID, taskID, allowedSessionID string) error {
	var taskProjectID string
	var taskSessionID *string
	err := tx.QueryRow(ctx, `
		SELECT project_id, session_id
		FROM tasks
		WHERE id = $1
		FOR SHARE
	`, taskID).Scan(&taskProjectID, &taskSessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: task %q is not present", ErrInvalidSession, taskID)
	}
	if err != nil {
		return fmt.Errorf("validate session creation task: %w", err)
	}
	if taskProjectID != projectID {
		return ErrProjectMismatch
	}
	if taskSessionID != nil && strings.TrimSpace(*taskSessionID) != "" {
		if strings.TrimSpace(*taskSessionID) == allowedSessionID && allowedSessionID != "" {
			return nil
		}
		return ErrTaskBound
	}
	return nil
}

func lockIntentByID(ctx context.Context, tx pgx.Tx, sessionID string) (intentRecord, bool, error) {
	record, err := scanIntent(tx.QueryRow(ctx, intentQuery+` WHERE session.id = $1 FOR UPDATE OF session`, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return intentRecord{}, false, nil
	}
	if err != nil {
		return intentRecord{}, false, fmt.Errorf("lock session creation intent: %w", err)
	}
	return record, true, nil
}

func lockIntentByCommand(ctx context.Context, tx pgx.Tx, creatorUserID, commandID string) (intentRecord, bool, error) {
	record, err := scanIntent(tx.QueryRow(ctx, intentQuery+` WHERE session.creator_user_id = $1 AND session.creation_command_id = $2 FOR UPDATE OF session`, creatorUserID, commandID))
	if errors.Is(err, pgx.ErrNoRows) {
		return intentRecord{}, false, nil
	}
	if err != nil {
		return intentRecord{}, false, fmt.Errorf("lock session creation command: %w", err)
	}
	return record, true, nil
}

func scanIntent(row pgx.Row) (intentRecord, error) {
	var record intentRecord
	var externalThreadRef, projectID, executionGeneration, taskID *string
	var lastCursor, terminalReason *string
	var creationState, summary, unknownReason string
	var commandID, digest *string
	var payload []byte
	var creatorUserID, hostID, creationTaskID *string
	var createdAt, updatedAt time.Time
	if err := row.Scan(
		&record.Session.ID,
		&externalThreadRef,
		&record.Session.Path,
		&record.Session.State,
		&projectID,
		&executionGeneration,
		&taskID,
		&lastCursor,
		&terminalReason,
		&createdAt,
		&updatedAt,
		&creationState,
		&commandID,
		&payload,
		&digest,
		&summary,
		&unknownReason,
		&creatorUserID,
		&hostID,
		&creationTaskID,
	); err != nil {
		return intentRecord{}, err
	}
	record.Session.ExternalThreadRef = optionalStringValue(externalThreadRef)
	record.Session.ProjectID = projectID
	record.Session.Generation = optionalStringValue(executionGeneration)
	record.Session.TaskID = taskID
	record.Session.LastCursor = optionalStringValue(lastCursor)
	record.Session.TerminalReason = optionalStringValue(terminalReason)
	record.Session.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	record.Session.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	record.CreationTaskID = optionalStringValue(creationTaskID)
	record.Intent = CreationIntent{
		SessionID:           record.Session.ID,
		CommandID:           optionalStringValue(commandID),
		CreatorUserID:       optionalStringValue(creatorUserID),
		HostID:              optionalStringValue(hostID),
		Path:                record.Session.Path,
		ProjectID:           optionalStringValue(projectID),
		TaskID:              optionalStringValue(creationTaskID),
		Parameters:          append([]byte(nil), payload...),
		Digest:              optionalStringValue(digest),
		Summary:             summary,
		UnknownReason:       unknownReason,
		ExternalThreadRef:   optionalStringValue(externalThreadRef),
		ExecutionGeneration: optionalStringValue(executionGeneration),
		State:               IntentState(creationState),
		CreatedAt:           record.Session.CreatedAt,
		UpdatedAt:           record.Session.UpdatedAt,
	}
	return record, nil
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
	return s.bindTask(ctx, sessionID, request, nil)
}

// BindTaskAuthorized performs the association and invokes authorize after the
// Session and Task rows are locked. The callback must re-check the caller's
// authorization using the supplied transaction before returning success.
func (s *Store) BindTaskAuthorized(ctx context.Context, sessionID string, request BindRequest, authorize BindingAuthorizer) (Session, error) {
	return s.bindTask(ctx, sessionID, request, authorize)
}

func (s *Store) bindTask(ctx context.Context, sessionID string, request BindRequest, authorize BindingAuthorizer) (Session, error) {
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

	current, err := scanSession(tx.QueryRow(ctx, sessionQuery+` WHERE session.id = $1 AND session.external_thread_ref IS NOT NULL AND session.generation IS NOT NULL FOR UPDATE OF session`, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrSessionNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("lock session for binding: %w", err)
	}
	var creatorUserID, hostID, projectID *string
	var creationState string
	if err := tx.QueryRow(ctx, `
		SELECT creator_user_id, host_id, project_id, creation_state
		FROM execution_sessions
		WHERE id = $1
	`, sessionID).Scan(&creatorUserID, &hostID, &projectID, &creationState); err != nil {
		return Session{}, fmt.Errorf("read session authorization facts: %w", err)
	}
	access := SessionAccess{
		SessionID:     sessionID,
		CreatorUserID: optionalStringValue(creatorUserID),
		HostID:        optionalStringValue(hostID),
		ProjectID:     optionalStringValue(projectID),
		IntentState:   IntentState(creationState),
		Confirmed:     current.ExternalThreadRef != "" && current.Generation != "" && IntentState(creationState) == IntentStateConfirmed,
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
		return Session{}, ErrTaskNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("lock task for session binding: %w", err)
	}
	request.TaskProjectID = taskProjectID
	if taskSessionID != nil {
		request.CurrentTaskSessionID = *taskSessionID
	}
	if authorize != nil {
		if err := authorize(ctx, tx, BindingFacts{
			Session: current, Access: access, TaskProjectID: taskProjectID,
			CurrentTaskSessionID: request.CurrentTaskSessionID,
		}); err != nil {
			return Session{}, err
		}
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
	current, err := scanSession(tx.QueryRow(ctx, sessionQuery+` WHERE session.id = $1 AND session.external_thread_ref IS NOT NULL AND session.generation IS NOT NULL FOR UPDATE OF session`, sessionID))
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

const intentQuery = "SELECT session.id, session.external_thread_ref, session.path, session.state, " +
	"session.project_id, session.generation, task.id, session.last_cursor, " +
	"session.terminal_reason, session.created_at, session.updated_at, " +
	"session.creation_state, session.creation_command_id, session.creation_payload, " +
	"session.creation_digest, session.creation_summary, session.creation_unknown_reason, " +
	"session.creator_user_id, session.host_id, session.creation_task_id " +
	"FROM execution_sessions AS session " +
	"LEFT JOIN tasks AS task ON task.session_id = session.id "

func scanSession(row pgx.Row) (Session, error) {
	var session Session
	var externalThreadRef, generation *string
	var projectID, taskID *string
	var lastCursor, terminalReason *string
	var createdAt, updatedAt time.Time
	if err := row.Scan(
		&session.ID, &externalThreadRef, &session.Path, &session.State,
		&projectID, &generation, &taskID, &lastCursor, &terminalReason,
		&createdAt, &updatedAt,
	); err != nil {
		return Session{}, err
	}
	if externalThreadRef == nil || generation == nil {
		return Session{}, ErrSessionUnconfirmed
	}
	session.ExternalThreadRef = *externalThreadRef
	session.Generation = *generation
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
