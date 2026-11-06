package runs

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
)

const (
	DefaultRunListPageSize = 50
	MaxRunListPageSize     = 200
)

// SessionRunPage is the durable, keyset-paginated Run history for one
// Session. The application boundary performs Session authorization before
// exposing this page through REST or MCP.
type SessionRunPage struct {
	Items      []Run
	HasMore    bool
	NextCursor *Cursor
}

func (s *Store) ListBySession(ctx context.Context, sessionID string, after *Cursor, limit int) (SessionRunPage, error) {
	if err := s.ready(ctx); err != nil {
		return SessionRunPage{}, err
	}
	if strings.TrimSpace(sessionID) == "" {
		return SessionRunPage{}, fmt.Errorf("%w: session id is required", ErrInvalidRun)
	}
	if after != nil {
		if after.Version != 1 || after.SessionID != sessionID || after.ID == "" || after.CreatedAt.IsZero() {
			return SessionRunPage{}, fmt.Errorf("%w: run cursor does not belong to session", auth.ErrInvalid)
		}
	}
	if limit <= 0 {
		limit = DefaultRunListPageSize
	}
	if limit > MaxRunListPageSize {
		limit = MaxRunListPageSize
	}

	args := []any{sessionID}
	where := "run.session_id = $1"
	if after != nil {
		args = append(args, after.CreatedAt, after.ID)
		where += fmt.Sprintf(" AND (run.created_at, run.id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query := runQuery + fmt.Sprintf(" WHERE %s ORDER BY run.created_at, run.id LIMIT $%d", where, len(args))
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return SessionRunPage{}, fmt.Errorf("list runs by session: %w", err)
	}
	defer rows.Close()

	page := SessionRunPage{Items: make([]Run, 0, limit)}
	var last Cursor
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return SessionRunPage{}, fmt.Errorf("scan session run list: %w", err)
		}
		createdAt, err := time.Parse(time.RFC3339Nano, run.CreatedAt)
		if err != nil {
			return SessionRunPage{}, fmt.Errorf("parse session run list cursor: %w", err)
		}
		if len(page.Items) == limit {
			page.HasMore = true
			page.NextCursor = &last
			break
		}
		page.Items = append(page.Items, run)
		last = Cursor{Version: 1, SessionID: sessionID, CreatedAt: createdAt, ID: run.ID}
	}
	if err := rows.Err(); err != nil {
		return SessionRunPage{}, fmt.Errorf("read session run list: %w", err)
	}
	return page, nil
}
