package auth

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type pgxStore struct {
	pool *pgxpool.Pool
}

func (s *pgxStore) Find(token string) ([]byte, bool, error) {
	data, _, err := s.FindCtx(context.Background(), token)
	return data, data != nil && err == nil, err
}

func (s *pgxStore) FindCtx(ctx context.Context, token string) ([]byte, bool, error) {
	var data []byte
	var expiry time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT data, expiry
		FROM auth_sessions
		WHERE token = $1 AND expiry > CURRENT_TIMESTAMP
	`, token).Scan(&data, &expiry)
	if err == pgx.ErrNoRows {
		return nil, false, nil
	}
	return data, err == nil, err
}

func (s *pgxStore) Commit(token string, data []byte, expiry time.Time) error {
	return s.CommitCtx(context.Background(), token, data, expiry)
}

func (s *pgxStore) CommitCtx(ctx context.Context, token string, data []byte, expiry time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO auth_sessions (token, data, expiry)
		VALUES ($1, $2, $3)
		ON CONFLICT (token) DO UPDATE SET data = EXCLUDED.data, expiry = EXCLUDED.expiry
	`, token, data, expiry)
	return err
}

func (s *pgxStore) Delete(token string) error {
	return s.DeleteCtx(context.Background(), token)
}

func (s *pgxStore) DeleteCtx(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM auth_sessions WHERE token = $1`, token)
	return err
}
