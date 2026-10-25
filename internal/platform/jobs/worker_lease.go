package jobs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/jackc/pgx/v5"
)

var (
	ErrWorkerLeaseLost = errors.New("worker lease was fenced by a newer generation")
	ErrWorkerLeaseHeld = errors.New("worker generation is not newer than the durable lease")
)

type workerLease struct {
	db          *database.DB
	key         string
	generation  int64
	candidate   string
	digest      string
	valid       atomic.Bool
	lastFailure atomic.Value
}

func newWorkerLease(db *database.DB, key string, generation uint64, candidate, digest string) (*workerLease, error) {
	if db == nil || db.Pool() == nil {
		return nil, errors.New("worker lease database must be open")
	}
	if err := validateGeneration(generation); err != nil {
		return nil, err
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, errors.New("worker lease key must not be empty")
	}
	if strings.ContainsAny(key, " \t\r\n") {
		return nil, errors.New("worker lease key must not contain whitespace")
	}
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		candidate = "unknown"
	}
	digest = strings.TrimSpace(digest)
	if digest == "" {
		digest = "unknown"
	}
	return &workerLease{
		db:         db,
		key:        key,
		generation: int64(generation),
		candidate:  candidate,
		digest:     digest,
	}, nil
}

func (l *workerLease) Acquire(ctx context.Context) error {
	if l == nil || l.db == nil || l.db.Pool() == nil {
		return errors.New("worker lease is not initialized")
	}
	if ctx == nil {
		return errors.New("worker lease context must not be nil")
	}
	var generation int64
	err := l.db.Pool().QueryRow(ctx, `
		INSERT INTO platform_worker_leases (
			lease_key,
			generation,
			candidate_source_sha,
			artifact_digest,
			acquired_at,
			heartbeat_at
		)
		VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT (lease_key) DO UPDATE SET
			generation = EXCLUDED.generation,
			candidate_source_sha = EXCLUDED.candidate_source_sha,
			artifact_digest = EXCLUDED.artifact_digest,
			acquired_at = CURRENT_TIMESTAMP,
			heartbeat_at = CURRENT_TIMESTAMP
		WHERE platform_worker_leases.generation < EXCLUDED.generation
		RETURNING generation
	`, l.key, l.generation, l.candidate, l.digest).Scan(&generation)
	if err == nil {
		l.valid.Store(true)
		l.lastFailure.Store("")
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("acquire worker lease: %w", err)
	}
	var current int64
	if err := l.db.Pool().QueryRow(ctx, `
		SELECT generation
		FROM platform_worker_leases
		WHERE lease_key = $1
	`, l.key).Scan(&current); err != nil {
		return fmt.Errorf("read current worker lease: %w", err)
	}
	return fmt.Errorf("%w: lease %q is at generation %d", ErrWorkerLeaseHeld, l.key, current)
}

func (l *workerLease) Renew(ctx context.Context) error {
	if l == nil || l.db == nil || l.db.Pool() == nil {
		return errors.New("worker lease is not initialized")
	}
	if ctx == nil {
		return errors.New("worker lease context must not be nil")
	}
	var generation int64
	err := l.db.Pool().QueryRow(ctx, `
		UPDATE platform_worker_leases
		SET heartbeat_at = CURRENT_TIMESTAMP
		WHERE lease_key = $1
		  AND generation = $2
		  AND candidate_source_sha = $3
		  AND artifact_digest = $4
		RETURNING generation
	`, l.key, l.generation, l.candidate, l.digest).Scan(&generation)
	if err == nil {
		l.valid.Store(true)
		l.lastFailure.Store("")
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		l.lastFailure.Store(ErrWorkerLeaseLost.Error())
		l.valid.Store(false)
		return ErrWorkerLeaseLost
	}
	l.lastFailure.Store(err.Error())
	l.valid.Store(false)
	return fmt.Errorf("renew worker lease: %w", err)
}

func (l *workerLease) Release(ctx context.Context) error {
	if l == nil || l.db == nil || l.db.Pool() == nil {
		return errors.New("worker lease is not initialized")
	}
	if ctx == nil {
		return errors.New("worker lease context must not be nil")
	}
	if _, err := l.db.Pool().Exec(ctx, `
		DELETE FROM platform_worker_leases
		WHERE lease_key = $1
		  AND generation = $2
		  AND candidate_source_sha = $3
		  AND artifact_digest = $4
	`, l.key, l.generation, l.candidate, l.digest); err != nil {
		return fmt.Errorf("release worker lease: %w", err)
	}
	l.lastFailure.Store("")
	l.valid.Store(false)
	return nil
}

func (l *workerLease) Check(ctx context.Context) error {
	if l == nil || l.db == nil || l.db.Pool() == nil {
		return errors.New("worker lease is not initialized")
	}
	if ctx == nil {
		return errors.New("worker lease context must not be nil")
	}
	if !l.valid.Load() {
		if failure := l.lastFailure.Load(); failure != nil && failure.(string) == ErrWorkerLeaseLost.Error() {
			return ErrWorkerLeaseLost
		}
		return errors.New("worker lease is not currently valid")
	}
	var current int64
	err := l.db.Pool().QueryRow(ctx, `
		SELECT generation
		FROM platform_worker_leases
		WHERE lease_key = $1
		  AND generation = $2
		  AND candidate_source_sha = $3
		  AND artifact_digest = $4
	`, l.key, l.generation, l.candidate, l.digest).Scan(&current)
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		l.lastFailure.Store(ErrWorkerLeaseLost.Error())
		l.valid.Store(false)
		return ErrWorkerLeaseLost
	}
	return fmt.Errorf("check worker lease: %w", err)
}

func (l *workerLease) Valid() bool {
	return l != nil && l.valid.Load()
}
