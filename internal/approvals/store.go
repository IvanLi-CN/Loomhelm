package approvals

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrApprovalNotFound           = errors.New("approval is not present in persistence")
	ErrApprovalHistoryUnavailable = errors.New("approval revision history is unavailable or inconsistent")
)

const approvalWriterCapability = "revision-history-v1"

type StoreConfig struct {
	Now func() time.Time
}

// Store owns durable approval CAS. The database row lock is deliberately
// stronger than the process-local Resolver so competing Server instances
// cannot both authorize the same app-server request.
type Store struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

type CreateRequest struct {
	NewInput
	Context          json.RawMessage
	RequestedEventID string
}

type ListPage struct {
	Items      []Approval
	NextCursor *Cursor
	HasMore    bool
}

func NewStore(pool *pgxpool.Pool, configs ...StoreConfig) *Store {
	now := time.Now
	if len(configs) > 0 && configs[0].Now != nil {
		now = configs[0].Now
	}
	return &Store{pool: pool, now: now}
}

func (s *Store) Create(ctx context.Context, request CreateRequest) (Approval, error) {
	if err := s.ready(ctx); err != nil {
		return Approval{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Approval{}, fmt.Errorf("begin approval creation: %w", err)
	}
	defer tx.Rollback(ctx)
	created, err := s.CreateTx(ctx, tx, request)
	if err != nil {
		return Approval{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Approval{}, fmt.Errorf("commit approval creation: %w", err)
	}
	return created, nil
}

// CreateTx persists or idempotently reads an approval in a caller-owned
// transaction. A non-empty RequestedEventID is also an idempotency key for
// the approval.requested event, so retries cannot create a second approval
// with a different approval ID.
func (s *Store) CreateTx(ctx context.Context, tx pgx.Tx, request CreateRequest) (Approval, error) {
	if err := s.readyBase(ctx); err != nil {
		return Approval{}, err
	}
	if tx == nil {
		return Approval{}, errors.New("approval transaction is required")
	}
	if err := ensureHistoryReadyTx(ctx, tx); err != nil {
		return Approval{}, err
	}
	if err := setApprovalWriterCapabilityTx(ctx, tx); err != nil {
		return Approval{}, err
	}
	if request.RequestedAt == "" {
		request.RequestedAt = s.now().UTC().Format(time.RFC3339Nano)
	}
	candidate, err := New(request.NewInput)
	if err != nil {
		return Approval{}, err
	}
	contextPayload := request.Context
	if len(strings.TrimSpace(string(contextPayload))) == 0 {
		contextPayload = json.RawMessage(`{}`)
	}
	if !json.Valid(contextPayload) {
		return Approval{}, fmt.Errorf("%w: context must be valid JSON", ErrInvalidApproval)
	}
	candidate.Context = append(json.RawMessage(nil), contextPayload...)
	candidate.RequestedEventID = request.RequestedEventID
	if strings.TrimSpace(request.RequestedEventID) != "" {
		if existing, found, err := findByRequestedEventIDTx(ctx, tx, request.RequestedEventID); err != nil {
			return Approval{}, err
		} else if found {
			if !sameCreateIdentity(candidate, existing) {
				return Approval{}, fmt.Errorf("%w: approval requested event %q", ErrApprovalContext, request.RequestedEventID)
			}
			return existing, nil
		}
	}
	inserted, err := tx.Exec(ctx, `
		INSERT INTO execution_approvals (
			id, session_id, run_id, generation, kind, requested_at, revision,
			status, summary, context, requested_event_id
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (id) DO NOTHING
	`, candidate.ID, candidate.SessionID, candidate.RunID, candidate.Generation, candidate.Kind, candidate.RequestedAt, candidate.Revision, candidate.Status, candidate.Summary, []byte(contextPayload), request.RequestedEventID)
	if err != nil {
		return Approval{}, fmt.Errorf("persist approval: %w", err)
	}
	stored, err := scanApproval(tx.QueryRow(ctx, approvalQuery+` WHERE approval.id = $1 FOR UPDATE`, candidate.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Approval{}, ErrApprovalNotFound
	}
	if err != nil {
		return Approval{}, err
	}
	if inserted.RowsAffected() == 1 {
		if err := insertApprovalHistoryTx(ctx, tx, candidate); err != nil {
			return Approval{}, err
		}
		return candidate, nil
	}
	if err := verifyCurrentHistoryTx(ctx, tx, stored); err != nil {
		return Approval{}, err
	}
	if stored.SessionID != candidate.SessionID || stored.RunID != candidate.RunID || stored.Generation != candidate.Generation || stored.Kind != candidate.Kind {
		return Approval{}, fmt.Errorf("%w: approval %q", ErrApprovalContext, candidate.ID)
	}
	if candidate.Revision == stored.Revision {
		if !sameCreateIdentity(candidate, stored) {
			return Approval{}, fmt.Errorf("%w: approval %q", ErrApprovalContext, candidate.ID)
		}
		return stored, nil
	}
	if candidate.Revision < stored.Revision {
		return Approval{}, fmt.Errorf("%w: got %d, current is %d", ErrRevisionStale, candidate.Revision, stored.Revision)
	}
	if stored.Status != protocol.ApprovalStatusPending {
		return Approval{}, ErrApprovalNotPending
	}
	if candidate.RequestedEventID != "" && candidate.RequestedEventID == stored.RequestedEventID {
		return Approval{}, fmt.Errorf("%w: approval requested event %q", ErrApprovalContext, candidate.RequestedEventID)
	}
	updated := stored
	updated.Revision = candidate.Revision
	updated.Summary = candidate.Summary
	updated.RequestedAt = candidate.RequestedAt
	updated.Context = append(json.RawMessage(nil), candidate.Context...)
	updated.RequestedEventID = candidate.RequestedEventID
	updated.ResolvedByCommandID = ""
	updated.ResolvedAt = ""
	updated.Status = protocol.ApprovalStatusPending
	if err := updateApprovalProjectionRevisionTx(ctx, tx, updated); err != nil {
		return Approval{}, err
	}
	if err := insertApprovalHistoryTx(ctx, tx, updated); err != nil {
		return Approval{}, err
	}
	return updated, nil
}

func (s *Store) Get(ctx context.Context, approvalID string) (Approval, error) {
	if err := s.ready(ctx); err != nil {
		return Approval{}, err
	}
	if strings.TrimSpace(approvalID) == "" {
		return Approval{}, fmt.Errorf("%w: approval id is required", ErrInvalidApproval)
	}
	stored, err := scanApproval(s.pool.QueryRow(ctx, approvalQuery+` WHERE approval.id = $1`, approvalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Approval{}, ErrApprovalNotFound
	}
	return stored, err
}

func (s *Store) Pending(ctx context.Context, sessionID, runID, generation string) ([]Approval, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("%w: session id is required", ErrInvalidApproval)
	}
	args := []any{sessionID}
	where := "approval.session_id = $1 AND approval.status = 'pending'"
	if runID != "" {
		args = append(args, runID)
		where += fmt.Sprintf(" AND approval.run_id = $%d", len(args))
	}
	if generation != "" {
		args = append(args, generation)
		where += fmt.Sprintf(" AND approval.generation = $%d", len(args))
	}
	rows, err := s.pool.Query(ctx, approvalQuery+fmt.Sprintf(" WHERE %s ORDER BY approval.id", where), args...)
	if err != nil {
		return nil, fmt.Errorf("list pending approvals: %w", err)
	}
	defer rows.Close()
	result := make([]Approval, 0)
	for rows.Next() {
		approval, err := scanApproval(rows)
		if err != nil {
			return nil, fmt.Errorf("scan pending approval: %w", err)
		}
		result = append(result, approval)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read pending approvals: %w", err)
	}
	return result, nil
}

// ListByRun reads every durable approval revision for one run. It deliberately
// does not filter by status or current session generation: historical approval
// rows remain readable while Resolve keeps the write-side generation fence.
func (s *Store) ListByRun(ctx context.Context, runID string, after *Cursor, limit int) (ListPage, error) {
	if err := s.ready(ctx); err != nil {
		return ListPage{}, err
	}
	if strings.TrimSpace(runID) == "" {
		return ListPage{}, fmt.Errorf("%w: run id is required", ErrInvalidApproval)
	}
	if limit <= 0 {
		limit = DefaultPageSize
	}
	if limit > MaxPageSize {
		limit = MaxPageSize
	}
	if after != nil && after.RunID != runID {
		return ListPage{}, fmt.Errorf("%w: approval cursor belongs to another run", auth.ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ListPage{}, fmt.Errorf("begin approval list: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := ensureHistoryReadyTx(ctx, tx); err != nil {
		return ListPage{}, err
	}
	if err := verifyHistoryProjectionForRunTx(ctx, tx, runID); err != nil {
		return ListPage{}, err
	}
	position, err := normalizeCursorTx(ctx, tx, runID, after)
	if err != nil {
		return ListPage{}, err
	}

	args := []any{runID}
	where := "history.run_id = $1"
	if position != nil {
		args = append(args, position.CreatedAt, position.ID, position.Revision)
		where += fmt.Sprintf(" AND (history.created_at, history.id, history.revision) > ($%d, $%d, $%d)", len(args)-2, len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query := approvalHistoryListQuery + fmt.Sprintf(" WHERE %s ORDER BY history.created_at, history.id, history.revision LIMIT $%d", where, len(args))
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return ListPage{}, fmt.Errorf("list approvals by run: %w", err)
	}
	defer rows.Close()

	page := ListPage{Items: make([]Approval, 0, limit)}
	var last Cursor
	for rows.Next() {
		approval, createdAt, err := scanApprovalWithCreatedAt(rows)
		if err != nil {
			return ListPage{}, fmt.Errorf("scan approval list: %w", err)
		}
		if len(page.Items) == limit {
			page.HasMore = true
			page.NextCursor = &last
			break
		}
		page.Items = append(page.Items, approval)
		last = Cursor{Version: 2, RunID: runID, CreatedAt: createdAt, ID: approval.ID, Revision: approval.Revision}
	}
	if err := rows.Err(); err != nil {
		return ListPage{}, fmt.Errorf("read approval list: %w", err)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return ListPage{}, fmt.Errorf("commit approval list: %w", err)
	}
	return page, nil
}

func (s *Store) AdvanceRevision(ctx context.Context, approvalID, generation string, revision int64, summary, requestedAt string) (Approval, error) {
	return s.transition(ctx, approvalID, func(current Approval) (Approval, error) {
		if current.Generation != generation {
			return Approval{}, fmt.Errorf("%w: got %q, approval belongs to %q", ErrApprovalGeneration, generation, current.Generation)
		}
		if requestedAt == "" {
			requestedAt = s.now().UTC().Format(time.RFC3339Nano)
		}
		return current.AdvanceRevision(revision, summary, requestedAt)
	})
}

func (s *Store) Expire(ctx context.Context, approvalID, generation string) (Approval, error) {
	return s.transition(ctx, approvalID, func(current Approval) (Approval, error) {
		if generation != "" && current.Generation != generation {
			return Approval{}, fmt.Errorf("%w: got %q, approval belongs to %q", ErrApprovalGeneration, generation, current.Generation)
		}
		return current.Expire()
	})
}

func (s *Store) Resolve(ctx context.Context, request ResolveRequest) (Resolution, error) {
	if err := s.ready(ctx); err != nil {
		return Resolution{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Resolution{}, fmt.Errorf("begin approval resolution: %w", err)
	}
	defer tx.Rollback(ctx)
	resolution, err := s.ResolveTx(ctx, tx, request)
	if err != nil {
		return Resolution{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Resolution{}, fmt.Errorf("commit approval resolution: %w", err)
	}
	return resolution, nil
}

// ResolveTx applies the approval lock and pending+revision CAS inside a
// caller-owned transaction. The caller must commit only after every related
// durable intent has been admitted, and must roll back on any later failure.
func (s *Store) ResolveTx(ctx context.Context, tx pgx.Tx, request ResolveRequest) (Resolution, error) {
	if err := s.readyBase(ctx); err != nil {
		return Resolution{}, err
	}
	if tx == nil {
		return Resolution{}, errors.New("approval transaction is required")
	}
	if err := ensureHistoryReadyTx(ctx, tx); err != nil {
		return Resolution{}, err
	}
	if err := setApprovalWriterCapabilityTx(ctx, tx); err != nil {
		return Resolution{}, err
	}
	current, err := scanApproval(tx.QueryRow(ctx, approvalQuery+` WHERE approval.id = $1 FOR UPDATE`, request.ApprovalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Resolution{}, ErrApprovalNotFound
	}
	if err != nil {
		return Resolution{}, fmt.Errorf("lock approval for resolution: %w", err)
	}
	if err := verifyCurrentHistoryTx(ctx, tx, current); err != nil {
		return Resolution{}, err
	}
	if request.Generation != current.Generation {
		return Resolution{}, fmt.Errorf("%w: got %q, approval belongs to %q", ErrApprovalGeneration, request.Generation, current.Generation)
	}
	resolution, err := current.Resolve(request)
	if err != nil {
		return Resolution{}, err
	}
	if !resolution.Deduplicated {
		updated, err := tx.Exec(ctx, `
			UPDATE execution_approvals
			SET status = $2,
			    resolved_by_command_id = $3,
			    resolved_at = CURRENT_TIMESTAMP,
			    updated_at = CURRENT_TIMESTAMP
			WHERE id = $1 AND status = 'pending' AND revision = $4 AND generation = $5
		`, current.ID, resolution.Approval.Status, resolution.Approval.ResolvedByCommandID, current.Revision, current.Generation)
		if err != nil {
			return Resolution{}, fmt.Errorf("persist approval resolution: %w", err)
		}
		if updated.RowsAffected() != 1 {
			return Resolution{}, fmt.Errorf("%w: approval %q resolution CAS did not update", ErrApprovalHistoryUnavailable, current.ID)
		}
		if err := updateApprovalHistoryResolutionTx(ctx, tx, current, resolution.Approval); err != nil {
			return Resolution{}, err
		}
		resolution.Approval.ResolvedAt = s.now().UTC().Format(time.RFC3339Nano)
	}
	return resolution, nil
}

func (s *Store) transition(ctx context.Context, approvalID string, apply func(Approval) (Approval, error)) (Approval, error) {
	if err := s.ready(ctx); err != nil {
		return Approval{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Approval{}, fmt.Errorf("begin approval transition: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := ensureHistoryReadyTx(ctx, tx); err != nil {
		return Approval{}, err
	}
	if err := setApprovalWriterCapabilityTx(ctx, tx); err != nil {
		return Approval{}, err
	}
	current, err := scanApproval(tx.QueryRow(ctx, approvalQuery+` WHERE approval.id = $1 FOR UPDATE`, approvalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Approval{}, ErrApprovalNotFound
	}
	if err != nil {
		return Approval{}, fmt.Errorf("lock approval for transition: %w", err)
	}
	if err := verifyCurrentHistoryTx(ctx, tx, current); err != nil {
		return Approval{}, err
	}
	updated, err := apply(current)
	if err != nil {
		return Approval{}, err
	}
	if updated.Revision != current.Revision {
		// AdvanceRevision creates a new logical snapshot without a new
		// approval.requested event. Do not let one event identify two revisions.
		updated.RequestedEventID = ""
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_approvals
		SET revision = $2, summary = $3, requested_at = $4, context = $5,
			requested_event_id = $6,
			status = $7,
			resolved_by_command_id = CASE WHEN $7 = 'pending' THEN '' ELSE resolved_by_command_id END,
			resolved_at = CASE WHEN $7 = 'expired' AND resolved_at IS NULL THEN CURRENT_TIMESTAMP ELSE resolved_at END,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = $1
	`, updated.ID, updated.Revision, updated.Summary, updated.RequestedAt, []byte(updated.Context), updated.RequestedEventID, updated.Status); err != nil {
		return Approval{}, fmt.Errorf("persist approval transition: %w", err)
	}
	if err := syncApprovalHistoryTransitionTx(ctx, tx, current, updated); err != nil {
		return Approval{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Approval{}, fmt.Errorf("commit approval transition: %w", err)
	}
	return updated, nil
}

const approvalColumns = `
	approval.id, approval.session_id, approval.run_id, approval.generation,
	approval.kind, approval.requested_at, approval.revision, approval.status,
	approval.summary, approval.context, approval.resolved_by_command_id,
	approval.requested_event_id, approval.resolved_at
`

const approvalQuery = `SELECT` + approvalColumns + `FROM execution_approvals AS approval
`

const approvalListQuery = `SELECT` + approvalColumns + `, approval.created_at
FROM execution_approvals AS approval
`

const approvalHistoryColumns = `
	history.id, history.session_id, history.run_id, history.generation,
	history.kind, history.requested_at, history.revision, history.status,
	history.summary, history.context, history.resolved_by_command_id,
	history.requested_event_id, history.resolved_at
`

const approvalHistoryQuery = `SELECT` + approvalHistoryColumns + `FROM execution_approval_revisions AS history
`

const approvalHistoryListQuery = `SELECT` + approvalHistoryColumns + `, history.created_at
FROM execution_approval_revisions AS history
`

func findByRequestedEventIDTx(ctx context.Context, tx pgx.Tx, requestedEventID string) (Approval, bool, error) {
	rows, err := tx.Query(ctx, approvalHistoryQuery+` WHERE history.requested_event_id = $1 ORDER BY history.id, history.revision LIMIT 2 FOR UPDATE`, requestedEventID)
	if err != nil {
		return Approval{}, false, fmt.Errorf("read approval requested event: %w", err)
	}
	defer rows.Close()
	var found Approval
	count := 0
	for rows.Next() {
		approval, err := scanApproval(rows)
		if err != nil {
			return Approval{}, false, fmt.Errorf("scan approval requested event: %w", err)
		}
		count++
		found = approval
	}
	if err := rows.Err(); err != nil {
		return Approval{}, false, fmt.Errorf("read approval requested event: %w", err)
	}
	if count == 0 {
		return Approval{}, false, nil
	}
	if count > 1 {
		return Approval{}, false, fmt.Errorf("%w: requested event %q maps to multiple revisions", ErrApprovalHistoryUnavailable, requestedEventID)
	}
	return found, true, nil
}

func sameCreateIdentity(candidate, stored Approval) bool {
	if candidate.ID != stored.ID || candidate.SessionID != stored.SessionID || candidate.RunID != stored.RunID || candidate.Generation != stored.Generation || candidate.Revision != stored.Revision || candidate.Kind != stored.Kind {
		return false
	}
	if candidate.Summary != stored.Summary || !bytes.Equal(candidate.Context, stored.Context) {
		return false
	}
	return candidate.RequestedEventID == "" || candidate.RequestedEventID == stored.RequestedEventID
}

func insertApprovalHistoryTx(ctx context.Context, tx pgx.Tx, approval Approval) error {
	contextPayload := approval.Context
	if len(strings.TrimSpace(string(contextPayload))) == 0 {
		contextPayload = json.RawMessage(`{}`)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO execution_approval_revisions (
			id, revision, session_id, run_id, generation, kind, requested_at,
			status, summary, context, resolved_by_command_id, requested_event_id,
			resolved_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULLIF($13, '')::timestamptz)
		ON CONFLICT (id, revision) DO NOTHING
	`, approval.ID, approval.Revision, approval.SessionID, approval.RunID, approval.Generation, approval.Kind, approval.RequestedAt, approval.Status, approval.Summary, []byte(contextPayload), approval.ResolvedByCommandID, approval.RequestedEventID, approval.ResolvedAt); err != nil {
		return fmt.Errorf("persist approval revision history: %w", err)
	}
	stored, err := scanApproval(tx.QueryRow(ctx, approvalHistoryQuery+` WHERE history.id = $1 AND history.revision = $2 FOR UPDATE`, approval.ID, approval.Revision))
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: approval %q revision %d was not stored", ErrApprovalHistoryUnavailable, approval.ID, approval.Revision)
	}
	if err != nil {
		return fmt.Errorf("read approval revision history: %w", err)
	}
	if !sameApprovalSnapshot(approval, stored) {
		return fmt.Errorf("%w: approval %q revision %d differs from the requested snapshot", ErrApprovalHistoryUnavailable, approval.ID, approval.Revision)
	}
	return nil
}

func updateApprovalProjectionRevisionTx(ctx context.Context, tx pgx.Tx, approval Approval) error {
	result, err := tx.Exec(ctx, `
		UPDATE execution_approvals
		SET revision = $2,
		    requested_at = $3,
		    summary = $4,
		    context = $5,
		    requested_event_id = $6,
		    status = 'pending',
		    resolved_by_command_id = '',
		    resolved_at = NULL,
		    updated_at = CURRENT_TIMESTAMP
		WHERE id = $1 AND generation = $7
	`, approval.ID, approval.Revision, approval.RequestedAt, approval.Summary, []byte(approval.Context), approval.RequestedEventID, approval.Generation)
	if err != nil {
		return fmt.Errorf("persist approval revision projection: %w", err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("%w: approval %q revision projection was not updated", ErrApprovalHistoryUnavailable, approval.ID)
	}
	return nil
}

func verifyCurrentHistoryTx(ctx context.Context, tx pgx.Tx, approval Approval) error {
	history, err := scanApproval(tx.QueryRow(ctx, approvalHistoryQuery+` WHERE history.id = $1 AND history.revision = $2 FOR UPDATE`, approval.ID, approval.Revision))
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: approval %q revision %d is missing", ErrApprovalHistoryUnavailable, approval.ID, approval.Revision)
	}
	if err != nil {
		return fmt.Errorf("read current approval history: %w", err)
	}
	if !sameApprovalSnapshot(approval, history) {
		return fmt.Errorf("%w: approval %q revision %d disagrees with current projection", ErrApprovalHistoryUnavailable, approval.ID, approval.Revision)
	}
	return nil
}

func syncApprovalHistoryTransitionTx(ctx context.Context, tx pgx.Tx, before, after Approval) error {
	if before.Revision != after.Revision {
		return insertApprovalHistoryTx(ctx, tx, after)
	}
	result, err := tx.Exec(ctx, `
		UPDATE execution_approval_revisions AS history
		SET status = $3,
		    summary = $4,
		    requested_at = $5,
		    context = $6,
		    resolved_by_command_id = $7,
		    requested_event_id = $8,
		    resolved_at = CASE
		        WHEN $9 <> '' THEN $9::timestamptz
		        WHEN $3 = 'expired' THEN COALESCE(history.resolved_at, CURRENT_TIMESTAMP)
		        ELSE history.resolved_at
		    END,
		    updated_at = CURRENT_TIMESTAMP
		WHERE history.id = $1 AND history.revision = $2
	`, after.ID, after.Revision, after.Status, after.Summary, after.RequestedAt, []byte(after.Context), after.ResolvedByCommandID, after.RequestedEventID, after.ResolvedAt)
	if err != nil {
		return fmt.Errorf("persist approval history transition: %w", err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("%w: approval %q revision %d was not updated", ErrApprovalHistoryUnavailable, after.ID, after.Revision)
	}
	return nil
}

func updateApprovalHistoryResolutionTx(ctx context.Context, tx pgx.Tx, current, resolved Approval) error {
	result, err := tx.Exec(ctx, `
		UPDATE execution_approval_revisions
		SET status = $3,
		    resolved_by_command_id = $4,
		    resolved_at = CURRENT_TIMESTAMP,
		    updated_at = CURRENT_TIMESTAMP
		WHERE id = $1 AND revision = $2 AND status = 'pending'
	`, current.ID, current.Revision, resolved.Status, resolved.ResolvedByCommandID)
	if err != nil {
		return fmt.Errorf("persist approval resolution history: %w", err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("%w: approval %q revision %d resolution history was not updated", ErrApprovalHistoryUnavailable, current.ID, current.Revision)
	}
	return nil
}

func verifyHistoryProjectionForRunTx(ctx context.Context, tx pgx.Tx, runID string) error {
	var marker int
	err := tx.QueryRow(ctx, `
		SELECT 1
		FROM execution_approvals AS current
		LEFT JOIN execution_approval_revisions AS history
		  ON history.id = current.id AND history.revision = current.revision
		WHERE current.run_id = $1
		  AND (
			 history.id IS NULL
			 OR history.session_id IS DISTINCT FROM current.session_id
			 OR history.run_id IS DISTINCT FROM current.run_id
			 OR history.generation IS DISTINCT FROM current.generation
			 OR history.kind IS DISTINCT FROM current.kind
			 OR history.requested_at IS DISTINCT FROM current.requested_at
			 OR history.status IS DISTINCT FROM current.status
			 OR history.summary IS DISTINCT FROM current.summary
			 OR history.context IS DISTINCT FROM current.context
			 OR history.resolved_by_command_id IS DISTINCT FROM current.resolved_by_command_id
			 OR history.requested_event_id IS DISTINCT FROM current.requested_event_id
			 OR history.resolved_at IS DISTINCT FROM current.resolved_at
		  )
		LIMIT 1
	`, runID).Scan(&marker)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("verify approval projection history: %w", err)
	}
	return fmt.Errorf("%w: run %q has projection/history drift", ErrApprovalHistoryUnavailable, runID)
}

func normalizeCursorTx(ctx context.Context, tx pgx.Tx, runID string, after *Cursor) (*Cursor, error) {
	if after == nil {
		return nil, nil
	}
	if after.RunID != runID {
		return nil, fmt.Errorf("%w: approval cursor belongs to another run", auth.ErrInvalid)
	}
	position := *after
	version := position.Version
	if version == 0 {
		if position.Revision > 0 {
			version = 2
		} else {
			version = 1
		}
	}
	switch version {
	case 2:
		if position.Revision <= 0 {
			return nil, fmt.Errorf("%w: approval cursor revision is required", auth.ErrInvalid)
		}
		position.Version = 2
		return &position, nil
	case 1:
		var count int
		var revision int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*), COALESCE(min(revision), 0)
			FROM execution_approval_revisions
			WHERE run_id = $1 AND created_at = $2 AND id = $3
		`, runID, position.CreatedAt, position.ID).Scan(&count, &revision); err != nil {
			return nil, fmt.Errorf("resolve legacy approval cursor: %w", err)
		}
		if count != 1 || revision <= 0 {
			return nil, fmt.Errorf("%w: legacy approval cursor position is missing or ambiguous", auth.ErrInvalid)
		}
		position.Version = 2
		position.Revision = revision
		return &position, nil
	default:
		return nil, fmt.Errorf("%w: unsupported approval cursor version %d", auth.ErrInvalid, version)
	}
}

func sameApprovalSnapshot(left, right Approval) bool {
	return left.ID == right.ID &&
		left.Revision == right.Revision &&
		left.SessionID == right.SessionID &&
		left.RunID == right.RunID &&
		left.Generation == right.Generation &&
		left.Kind == right.Kind &&
		left.RequestedAt == right.RequestedAt &&
		left.Status == right.Status &&
		left.Summary == right.Summary &&
		bytes.Equal(left.Context, right.Context) &&
		left.ResolvedByCommandID == right.ResolvedByCommandID &&
		left.RequestedEventID == right.RequestedEventID &&
		left.ResolvedAt == right.ResolvedAt
}

func scanApproval(row interface{ Scan(...any) error }) (Approval, error) {
	var approval Approval
	var contextPayload []byte
	var resolvedAt *time.Time
	if err := row.Scan(
		&approval.ID, &approval.SessionID, &approval.RunID, &approval.Generation,
		&approval.Kind, &approval.RequestedAt, &approval.Revision, &approval.Status,
		&approval.Summary, &contextPayload, &approval.ResolvedByCommandID,
		&approval.RequestedEventID, &resolvedAt,
	); err != nil {
		return Approval{}, err
	}
	approval.Context = append(json.RawMessage(nil), contextPayload...)
	if resolvedAt != nil {
		approval.ResolvedAt = resolvedAt.UTC().Format(time.RFC3339Nano)
	}
	return approval, nil
}

func scanApprovalWithCreatedAt(row interface{ Scan(...any) error }) (Approval, time.Time, error) {
	var approval Approval
	var contextPayload []byte
	var resolvedAt *time.Time
	var createdAt time.Time
	if err := row.Scan(
		&approval.ID, &approval.SessionID, &approval.RunID, &approval.Generation,
		&approval.Kind, &approval.RequestedAt, &approval.Revision, &approval.Status,
		&approval.Summary, &contextPayload, &approval.ResolvedByCommandID,
		&approval.RequestedEventID, &resolvedAt, &createdAt,
	); err != nil {
		return Approval{}, time.Time{}, err
	}
	approval.Context = append(json.RawMessage(nil), contextPayload...)
	if resolvedAt != nil {
		approval.ResolvedAt = resolvedAt.UTC().Format(time.RFC3339Nano)
	}
	return approval, createdAt, nil
}

type approvalReadinessQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (s *Store) readyBase(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("approval store database is not configured")
	}
	if ctx == nil {
		return errors.New("approval context must not be nil")
	}
	return nil
}

func (s *Store) ready(ctx context.Context) error {
	if err := s.readyBase(ctx); err != nil {
		return err
	}
	return ensureHistoryReady(ctx, s.pool)
}

// CheckHistoryReadiness verifies durable cutover facts without scanning the
// history volume. Full projection/history validation belongs to the explicit
// migration operation.
func (s *Store) CheckHistoryReadiness(ctx context.Context) error {
	if err := s.readyBase(ctx); err != nil {
		return err
	}
	return ensureHistoryReady(ctx, s.pool)
}

// CheckHistoryConsistency performs the history-volume audit used by the
// migration operator and targeted repair checks. It is deliberately separate
// from startup readiness.
func (s *Store) CheckHistoryConsistency(ctx context.Context) error {
	if err := s.readyBase(ctx); err != nil {
		return err
	}
	return ensureHistoryConsistency(ctx, s.pool)
}

func ensureHistoryReadyTx(ctx context.Context, tx pgx.Tx) error {
	if tx == nil {
		return errors.New("approval transaction is required")
	}
	return ensureHistoryReady(ctx, tx)
}

func ensureHistoryReady(ctx context.Context, queryer approvalReadinessQuerier) error {
	var projectionExists, historyExists, schemaComplete, indexesComplete, writerGuardExists, cutoverComplete, dirtyEmpty bool
	err := queryer.QueryRow(ctx, `
		WITH required_columns(table_name, column_name) AS (
			VALUES
				('execution_approvals', 'id'),
				('execution_approvals', 'session_id'),
				('execution_approvals', 'run_id'),
				('execution_approvals', 'generation'),
				('execution_approvals', 'kind'),
				('execution_approvals', 'requested_at'),
				('execution_approvals', 'revision'),
				('execution_approvals', 'status'),
				('execution_approvals', 'summary'),
				('execution_approvals', 'context'),
				('execution_approvals', 'resolved_by_command_id'),
				('execution_approvals', 'requested_event_id'),
				('execution_approvals', 'resolved_at'),
				('execution_approvals', 'created_at'),
				('execution_approvals', 'updated_at'),
				('execution_approval_revisions', 'id'),
				('execution_approval_revisions', 'session_id'),
				('execution_approval_revisions', 'run_id'),
				('execution_approval_revisions', 'generation'),
				('execution_approval_revisions', 'kind'),
				('execution_approval_revisions', 'requested_at'),
				('execution_approval_revisions', 'revision'),
				('execution_approval_revisions', 'status'),
				('execution_approval_revisions', 'summary'),
				('execution_approval_revisions', 'context'),
				('execution_approval_revisions', 'resolved_by_command_id'),
				('execution_approval_revisions', 'requested_event_id'),
				('execution_approval_revisions', 'resolved_at'),
				('execution_approval_revisions', 'created_at'),
				('execution_approval_revisions', 'updated_at')
		)
		SELECT
			EXISTS (
				SELECT 1
				FROM pg_class AS relation
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				WHERE namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approvals'
				  AND relation.relkind IN ('r', 'p')
			),
			EXISTS (
				SELECT 1
				FROM pg_class AS relation
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				WHERE namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approval_revisions'
				  AND relation.relkind IN ('r', 'p')
			),
			NOT EXISTS (
				SELECT 1
				FROM required_columns AS required
				WHERE NOT EXISTS (
					SELECT 1
					FROM pg_attribute AS attribute
					JOIN pg_class AS relation ON relation.oid = attribute.attrelid
					JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
					WHERE namespace.nspname = current_schema()
					  AND relation.relname = required.table_name
					  AND relation.relkind IN ('r', 'p')
					  AND attribute.attname = required.column_name
					  AND attribute.attnum > 0
					  AND NOT attribute.attisdropped
				)
			),
			NOT EXISTS (
				SELECT 1
				FROM unnest(ARRAY[
					'execution_approval_revisions_pkey',
					'execution_approval_revisions_run_cursor_idx',
					'execution_approval_revisions_requested_event_idx'
				]) AS required(index_name)
				WHERE NOT EXISTS (
					SELECT 1
					FROM pg_class AS relation
					JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
					JOIN pg_index AS index_row ON index_row.indexrelid = relation.oid
					WHERE namespace.nspname = current_schema()
					  AND relation.relname = required.index_name
					  AND relation.relkind = 'i'
					  AND index_row.indisvalid
					  AND index_row.indisready
				)
			),
			EXISTS (
				SELECT 1
				FROM pg_trigger AS trigger_row
				JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
				JOIN pg_namespace AS function_namespace ON function_namespace.oid = function_row.pronamespace
				WHERE namespace.nspname = current_schema()
				  AND function_namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approvals'
				  AND trigger_row.tgname = 'execution_approvals_history_writer_guard'
				  AND NOT trigger_row.tgisinternal
				  AND trigger_row.tgenabled = 'O'
				  AND function_row.proname = 'loomhelm_require_approval_history_writer'
				  AND pg_get_functiondef(function_row.oid) LIKE '%loomhelm.approval_writer_capability%'
				  AND pg_get_functiondef(function_row.oid) LIKE '%revision-history-v1%'
			),
			EXISTS (
				SELECT 1
				FROM execution_approval_history_migrations
				WHERE migration_key = 'approval-revision-history'
				  AND phase = 'cutover_complete'
			),
			NOT EXISTS (SELECT 1 FROM execution_approval_history_dirty)
	`).Scan(&projectionExists, &historyExists, &schemaComplete, &indexesComplete, &writerGuardExists, &cutoverComplete, &dirtyEmpty)
	if err != nil {
		return fmt.Errorf("%w: inspect approval history readiness: %v", ErrApprovalHistoryUnavailable, err)
	}
	if !projectionExists || !historyExists || !schemaComplete || !indexesComplete || !writerGuardExists || !cutoverComplete || !dirtyEmpty {
		return fmt.Errorf("%w: approval history cutover is incomplete", ErrApprovalHistoryUnavailable)
	}
	return nil
}

func ensureHistoryConsistency(ctx context.Context, queryer approvalReadinessQuerier) error {
	var projectionExists, historyExists, schemaComplete, indexesComplete, writerGuardExists bool
	err := queryer.QueryRow(ctx, `
		WITH required_columns(table_name, column_name) AS (
			VALUES
				('execution_approvals', 'id'),
				('execution_approvals', 'session_id'),
				('execution_approvals', 'run_id'),
				('execution_approvals', 'generation'),
				('execution_approvals', 'kind'),
				('execution_approvals', 'requested_at'),
				('execution_approvals', 'revision'),
				('execution_approvals', 'status'),
				('execution_approvals', 'summary'),
				('execution_approvals', 'context'),
				('execution_approvals', 'resolved_by_command_id'),
				('execution_approvals', 'requested_event_id'),
				('execution_approvals', 'resolved_at'),
				('execution_approvals', 'created_at'),
				('execution_approvals', 'updated_at'),
				('execution_approval_revisions', 'id'),
				('execution_approval_revisions', 'session_id'),
				('execution_approval_revisions', 'run_id'),
				('execution_approval_revisions', 'generation'),
				('execution_approval_revisions', 'kind'),
				('execution_approval_revisions', 'requested_at'),
				('execution_approval_revisions', 'revision'),
				('execution_approval_revisions', 'status'),
				('execution_approval_revisions', 'summary'),
				('execution_approval_revisions', 'context'),
				('execution_approval_revisions', 'resolved_by_command_id'),
				('execution_approval_revisions', 'requested_event_id'),
				('execution_approval_revisions', 'resolved_at'),
				('execution_approval_revisions', 'created_at'),
				('execution_approval_revisions', 'updated_at')
		)
		SELECT
			EXISTS (
				SELECT 1
				FROM pg_class AS relation
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				WHERE namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approvals'
				  AND relation.relkind IN ('r', 'p')
			),
			EXISTS (
				SELECT 1
				FROM pg_class AS relation
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				WHERE namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approval_revisions'
				  AND relation.relkind IN ('r', 'p')
			),
			NOT EXISTS (
				SELECT 1
				FROM required_columns AS required
				WHERE NOT EXISTS (
					SELECT 1
					FROM pg_attribute AS attribute
					JOIN pg_class AS relation ON relation.oid = attribute.attrelid
					JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
					WHERE namespace.nspname = current_schema()
					  AND relation.relname = required.table_name
					  AND relation.relkind IN ('r', 'p')
					  AND attribute.attname = required.column_name
					  AND attribute.attnum > 0
					  AND NOT attribute.attisdropped
				)
			),
			NOT EXISTS (
				SELECT 1
				FROM unnest(ARRAY[
					'execution_approval_revisions_pkey',
					'execution_approval_revisions_run_cursor_idx',
					'execution_approval_revisions_requested_event_idx'
				]) AS required(index_name)
				WHERE NOT EXISTS (
					SELECT 1
					FROM pg_class AS relation
					JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
					WHERE namespace.nspname = current_schema()
					  AND relation.relname = required.index_name
					  AND relation.relkind = 'i'
				)
			),
			EXISTS (
				SELECT 1
				FROM pg_trigger AS trigger_row
				JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
				JOIN pg_namespace AS function_namespace ON function_namespace.oid = function_row.pronamespace
				WHERE namespace.nspname = current_schema()
				  AND function_namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approvals'
				  AND trigger_row.tgname = 'execution_approvals_history_writer_guard'
				  AND NOT trigger_row.tgisinternal
				  AND trigger_row.tgenabled = 'O'
				  AND function_row.proname = 'loomhelm_require_approval_history_writer'
				  AND pg_get_functiondef(function_row.oid) LIKE '%loomhelm.approval_writer_capability%'
				  AND pg_get_functiondef(function_row.oid) LIKE '%revision-history-v1%'
				  AND (trigger_row.tgtype & 1) <> 0
				  AND (trigger_row.tgtype & 2) <> 0
				  AND (trigger_row.tgtype & 4) <> 0
				  AND (trigger_row.tgtype & 8) <> 0
				  AND (trigger_row.tgtype & 16) <> 0
			)
	`).Scan(&projectionExists, &historyExists, &schemaComplete, &indexesComplete, &writerGuardExists)
	if err != nil {
		return fmt.Errorf("%w: inspect approval history cutover: %v", ErrApprovalHistoryUnavailable, err)
	}
	if !projectionExists || !historyExists || !schemaComplete || !indexesComplete || !writerGuardExists {
		return fmt.Errorf("%w: approval history cutover is incomplete", ErrApprovalHistoryUnavailable)
	}
	var drift bool
	if err := queryer.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM execution_approvals AS current
			LEFT JOIN execution_approval_revisions AS history
			  ON history.id = current.id AND history.revision = current.revision
			WHERE history.id IS NULL
			   OR history.session_id IS DISTINCT FROM current.session_id
			   OR history.run_id IS DISTINCT FROM current.run_id
			   OR history.generation IS DISTINCT FROM current.generation
			   OR history.kind IS DISTINCT FROM current.kind
			   OR history.requested_at IS DISTINCT FROM current.requested_at
			   OR history.status IS DISTINCT FROM current.status
			   OR history.summary IS DISTINCT FROM current.summary
			   OR history.context IS DISTINCT FROM current.context
			   OR history.resolved_by_command_id IS DISTINCT FROM current.resolved_by_command_id
			   OR history.requested_event_id IS DISTINCT FROM current.requested_event_id
			   OR history.resolved_at IS DISTINCT FROM current.resolved_at
		)
	`).Scan(&drift); err != nil {
		return fmt.Errorf("%w: verify approval projection/history: %v", ErrApprovalHistoryUnavailable, err)
	}
	if drift {
		return ErrApprovalHistoryUnavailable
	}
	return nil
}

func setApprovalWriterCapabilityTx(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, `SET LOCAL loomhelm.approval_writer_capability = 'revision-history-v1'`); err != nil {
		return fmt.Errorf("%w: set approval writer capability: %v", ErrApprovalHistoryUnavailable, err)
	}
	return nil
}
