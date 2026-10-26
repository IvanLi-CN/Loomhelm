package approvals

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrApprovalNotFound = errors.New("approval is not present in persistence")

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
	if err := s.ready(ctx); err != nil {
		return Approval{}, err
	}
	if tx == nil {
		return Approval{}, errors.New("approval transaction is required")
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
	if _, err := tx.Exec(ctx, `
		INSERT INTO execution_approvals (
			id, session_id, run_id, generation, kind, requested_at, revision,
			status, summary, context, requested_event_id
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (id) DO NOTHING
	`, candidate.ID, candidate.SessionID, candidate.RunID, candidate.Generation, candidate.Kind, candidate.RequestedAt, candidate.Revision, candidate.Status, candidate.Summary, []byte(contextPayload), request.RequestedEventID); err != nil {
		return Approval{}, fmt.Errorf("persist approval: %w", err)
	}
	stored, err := scanApproval(tx.QueryRow(ctx, approvalQuery+` WHERE approval.id = $1 FOR UPDATE`, candidate.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Approval{}, ErrApprovalNotFound
	}
	if err != nil {
		return Approval{}, err
	}
	if !sameCreateIdentity(candidate, stored) {
		return Approval{}, fmt.Errorf("%w: approval %q", ErrApprovalContext, candidate.ID)
	}
	return stored, nil
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

	args := []any{runID}
	where := "approval.run_id = $1"
	if after != nil {
		args = append(args, after.CreatedAt, after.ID)
		where += fmt.Sprintf(" AND (approval.created_at, approval.id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query := approvalListQuery + fmt.Sprintf(" WHERE %s ORDER BY approval.created_at, approval.id LIMIT $%d", where, len(args))
	rows, err := s.pool.Query(ctx, query, args...)
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
		last = Cursor{RunID: runID, CreatedAt: createdAt, ID: approval.ID}
	}
	if err := rows.Err(); err != nil {
		return ListPage{}, fmt.Errorf("read approval list: %w", err)
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
	if err := s.ready(ctx); err != nil {
		return Resolution{}, err
	}
	if tx == nil {
		return Resolution{}, errors.New("approval transaction is required")
	}
	current, err := scanApproval(tx.QueryRow(ctx, approvalQuery+` WHERE approval.id = $1 FOR UPDATE`, request.ApprovalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Resolution{}, ErrApprovalNotFound
	}
	if err != nil {
		return Resolution{}, fmt.Errorf("lock approval for resolution: %w", err)
	}
	if request.Generation != current.Generation {
		return Resolution{}, fmt.Errorf("%w: got %q, approval belongs to %q", ErrApprovalGeneration, request.Generation, current.Generation)
	}
	resolution, err := current.Resolve(request)
	if err != nil {
		return Resolution{}, err
	}
	if !resolution.Deduplicated {
		if _, err := tx.Exec(ctx, `
			UPDATE execution_approvals
			SET status = $2,
			    resolved_by_command_id = $3,
			    resolved_at = CURRENT_TIMESTAMP,
			    updated_at = CURRENT_TIMESTAMP
			WHERE id = $1 AND status = 'pending' AND revision = $4 AND generation = $5
		`, current.ID, resolution.Approval.Status, resolution.Approval.ResolvedByCommandID, current.Revision, current.Generation); err != nil {
			return Resolution{}, fmt.Errorf("persist approval resolution: %w", err)
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
	current, err := scanApproval(tx.QueryRow(ctx, approvalQuery+` WHERE approval.id = $1 FOR UPDATE`, approvalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Approval{}, ErrApprovalNotFound
	}
	if err != nil {
		return Approval{}, fmt.Errorf("lock approval for transition: %w", err)
	}
	updated, err := apply(current)
	if err != nil {
		return Approval{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_approvals
		SET revision = $2, summary = $3, requested_at = $4,
			status = $5,
			resolved_at = CASE WHEN $5 = 'expired' AND resolved_at IS NULL THEN CURRENT_TIMESTAMP ELSE resolved_at END,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = $1
	`, updated.ID, updated.Revision, updated.Summary, updated.RequestedAt, updated.Status); err != nil {
		return Approval{}, fmt.Errorf("persist approval transition: %w", err)
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

func findByRequestedEventIDTx(ctx context.Context, tx pgx.Tx, requestedEventID string) (Approval, bool, error) {
	approval, err := scanApproval(tx.QueryRow(ctx, approvalQuery+` WHERE approval.requested_event_id = $1 LIMIT 1 FOR UPDATE`, requestedEventID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Approval{}, false, nil
	} else if err != nil {
		return Approval{}, false, fmt.Errorf("read approval requested event: %w", err)
	}
	return approval, true, nil
}

func sameCreateIdentity(candidate, stored Approval) bool {
	if candidate.ID != stored.ID || candidate.SessionID != stored.SessionID || candidate.RunID != stored.RunID || candidate.Generation != stored.Generation || candidate.Revision != stored.Revision || candidate.Kind != stored.Kind {
		return false
	}
	return candidate.RequestedEventID == "" || candidate.RequestedEventID == stored.RequestedEventID
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

func (s *Store) ready(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("approval store database is not configured")
	}
	if ctx == nil {
		return errors.New("approval context must not be nil")
	}
	return nil
}
