package runs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const defaultControlLeaseTTL = 30 * time.Second

// RunLeaseKey is stable across Server and Worker processes while keeping the
// persisted lease key independent from user-supplied identifiers.
func RunLeaseKey(runID string) string {
	sum := sha256.Sum256([]byte(runID))
	return "loomhelm-run:" + hex.EncodeToString(sum[:16])
}

type DurableLeaseIdentity struct {
	LeaseKey           string
	SessionID          string
	RunID              string
	Generation         string
	OwnerID            string
	CandidateSourceSHA string
	ArtifactDigest     string
}

type ControlLease struct {
	DurableLeaseIdentity
	AcquiredAt  time.Time
	HeartbeatAt time.Time
	ExpiresAt   time.Time
}

type LeaseStoreConfig struct {
	TTL time.Duration
}

// AcquireLease serializes replacement decisions on the lease row. The
// execution generation is opaque and must belong to the persisted Session and
// Run. An expired lease may be replaced; an active lease can only be reacquired
// by the exact same execution identity.
func (s *Store) AcquireLease(ctx context.Context, identity DurableLeaseIdentity, configs ...LeaseStoreConfig) (ControlLease, error) {
	if err := s.ready(ctx); err != nil {
		return ControlLease{}, err
	}
	if err := validateLeaseIdentity(identity); err != nil {
		return ControlLease{}, err
	}
	ttl := defaultControlLeaseTTL
	if len(configs) > 0 && configs[0].TTL != 0 {
		ttl = configs[0].TTL
	}
	if ttl <= 0 {
		return ControlLease{}, fmt.Errorf("%w: lease TTL must be positive", ErrInvalidLease)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ControlLease{}, fmt.Errorf("begin control lease acquisition: %w", err)
	}
	defer tx.Rollback(ctx)
	lease, err := acquireLeaseTx(ctx, tx, identity, ttl)
	if err != nil {
		return ControlLease{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ControlLease{}, fmt.Errorf("commit control lease acquisition: %w", err)
	}
	return lease, nil
}

func acquireLeaseTx(ctx context.Context, tx pgx.Tx, identity DurableLeaseIdentity, ttl time.Duration) (ControlLease, error) {
	if tx == nil {
		return ControlLease{}, fmt.Errorf("%w: transaction is required", ErrInvalidLease)
	}
	if err := validateLeaseIdentity(identity); err != nil {
		return ControlLease{}, err
	}
	if ttl <= 0 {
		return ControlLease{}, fmt.Errorf("%w: lease TTL must be positive", ErrInvalidLease)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, identity.LeaseKey); err != nil {
		return ControlLease{}, fmt.Errorf("serialize control lease acquisition: %w", err)
	}
	if err := lockLeaseBinding(ctx, tx, identity); err != nil {
		return ControlLease{}, err
	}
	current, found, err := lockLease(ctx, tx, identity.LeaseKey)
	if err != nil {
		return ControlLease{}, err
	}
	now, err := databaseClock(ctx, tx)
	if err != nil {
		return ControlLease{}, err
	}
	if found && current.ExpiresAt.After(now) && !sameLeaseIdentity(current.DurableLeaseIdentity, identity) {
		return ControlLease{}, fmt.Errorf("%w: lease %q is owned by another identity", ErrLeaseHeld, identity.LeaseKey)
	}
	return writeLease(ctx, tx, identity, ttl, now)
}

func (s *Store) RenewLease(ctx context.Context, identity DurableLeaseIdentity, configs ...LeaseStoreConfig) (ControlLease, error) {
	if err := s.ready(ctx); err != nil {
		return ControlLease{}, err
	}
	if err := validateLeaseIdentity(identity); err != nil {
		return ControlLease{}, err
	}
	ttl := defaultControlLeaseTTL
	if len(configs) > 0 && configs[0].TTL != 0 {
		ttl = configs[0].TTL
	}
	if ttl <= 0 {
		return ControlLease{}, fmt.Errorf("%w: lease TTL must be positive", ErrInvalidLease)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ControlLease{}, fmt.Errorf("begin control lease renewal: %w", err)
	}
	defer tx.Rollback(ctx)
	current, err := lockLeaseForIdentity(ctx, tx, identity, "FOR UPDATE")
	if err != nil {
		return ControlLease{}, err
	}
	now, err := databaseClock(ctx, tx)
	if err != nil {
		return ControlLease{}, err
	}
	if !current.ExpiresAt.After(now) {
		return ControlLease{}, ErrLeaseLost
	}
	var lease ControlLease
	err = tx.QueryRow(ctx, `
		UPDATE execution_control_leases
		SET heartbeat_at = $8::timestamptz,
			expires_at = $8::timestamptz + $9 * INTERVAL '1 second'
		WHERE lease_key = $1
		  AND session_id = $2
		  AND run_id = $3
		  AND generation = $4
		  AND owner_id = $5
		  AND candidate_source_sha = $6
		  AND artifact_digest = $7
		RETURNING lease_key, session_id, run_id, generation, owner_id,
		          candidate_source_sha, artifact_digest, acquired_at,
		          heartbeat_at, expires_at
	`, identity.LeaseKey, identity.SessionID, identity.RunID, identity.Generation, identity.OwnerID, identity.CandidateSourceSHA, identity.ArtifactDigest, now, ttl.Seconds()).Scan(
		&lease.LeaseKey, &lease.SessionID, &lease.RunID, &lease.Generation,
		&lease.OwnerID, &lease.CandidateSourceSHA, &lease.ArtifactDigest,
		&lease.AcquiredAt, &lease.HeartbeatAt, &lease.ExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ControlLease{}, ErrLeaseLost
	}
	if err != nil {
		return ControlLease{}, fmt.Errorf("renew control lease: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ControlLease{}, fmt.Errorf("commit control lease renewal: %w", err)
	}
	return lease, nil
}

func (s *Store) CheckLease(ctx context.Context, identity DurableLeaseIdentity) (ControlLease, error) {
	if err := s.ready(ctx); err != nil {
		return ControlLease{}, err
	}
	if err := validateLeaseIdentity(identity); err != nil {
		return ControlLease{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ControlLease{}, fmt.Errorf("begin control lease check: %w", err)
	}
	defer tx.Rollback(ctx)
	lease, err := lockLeaseForIdentity(ctx, tx, identity, "FOR SHARE")
	if errors.Is(err, pgx.ErrNoRows) {
		return ControlLease{}, ErrLeaseLost
	}
	if err != nil {
		return ControlLease{}, err
	}
	now, err := databaseClock(ctx, tx)
	if err != nil {
		return ControlLease{}, err
	}
	if !lease.ExpiresAt.After(now) {
		return ControlLease{}, ErrLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return ControlLease{}, fmt.Errorf("commit control lease check: %w", err)
	}
	return lease, nil
}

func (s *Store) ReleaseLease(ctx context.Context, identity DurableLeaseIdentity) error {
	if err := s.ready(ctx); err != nil {
		return err
	}
	if err := validateLeaseIdentity(identity); err != nil {
		return err
	}
	result, err := s.pool.Exec(ctx, `
		DELETE FROM execution_control_leases
		WHERE lease_key = $1
		  AND session_id = $2
		  AND run_id = $3
		  AND generation = $4
		  AND owner_id = $5
		  AND candidate_source_sha = $6
		  AND artifact_digest = $7
	`, identity.LeaseKey, identity.SessionID, identity.RunID, identity.Generation, identity.OwnerID, identity.CandidateSourceSHA, identity.ArtifactDigest)
	if err != nil {
		return fmt.Errorf("release control lease: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return nil
}

var ErrInvalidLease = errors.New("control lease is invalid")

func validateLeaseIdentity(identity DurableLeaseIdentity) error {
	fields := []struct {
		name  string
		value string
	}{
		{"lease key", identity.LeaseKey},
		{"session id", identity.SessionID},
		{"run id", identity.RunID},
		{"generation", identity.Generation},
		{"owner id", identity.OwnerID},
		{"candidate source SHA", identity.CandidateSourceSHA},
		{"artifact digest", identity.ArtifactDigest},
	}
	for _, field := range fields {
		if strings.TrimSpace(field.value) == "" || field.value != strings.TrimSpace(field.value) {
			return fmt.Errorf("%w: %s is required and must not have surrounding whitespace", ErrInvalidLease, field.name)
		}
	}
	return nil
}

func sameLeaseIdentity(left, right DurableLeaseIdentity) bool {
	return left == right
}

// lockLeaseBinding establishes the durable identity boundary before the lease
// row is inspected or written. The row locks intentionally follow
// session -> run -> lease, matching ApplyEvent and the suffix of transitionRun.
func lockLeaseBinding(ctx context.Context, tx pgx.Tx, identity DurableLeaseIdentity) error {
	var sessionGeneration string
	err := tx.QueryRow(ctx, `
		SELECT generation
		FROM execution_sessions
		WHERE id = $1
		FOR UPDATE
	`, identity.SessionID).Scan(&sessionGeneration)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: session %q is not persisted", ErrLeaseLost, identity.SessionID)
	}
	if err != nil {
		return fmt.Errorf("lock session for control lease: %w", err)
	}
	if sessionGeneration != identity.Generation {
		return fmt.Errorf("%w: session %q belongs to generation %q", ErrStaleGeneration, identity.SessionID, sessionGeneration)
	}

	var runSessionID, runGeneration string
	err = tx.QueryRow(ctx, `
		SELECT session_id, generation
		FROM execution_runs
		WHERE id = $1
		FOR UPDATE
	`, identity.RunID).Scan(&runSessionID, &runGeneration)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: run %q is not persisted", ErrRunNotFound, identity.RunID)
	}
	if err != nil {
		return fmt.Errorf("lock run for control lease: %w", err)
	}
	if runSessionID != identity.SessionID {
		return fmt.Errorf("%w: run %q belongs to session %q", ErrInvalidLease, identity.RunID, runSessionID)
	}
	if runGeneration != identity.Generation {
		return fmt.Errorf("%w: run %q belongs to generation %q", ErrStaleGeneration, identity.RunID, runGeneration)
	}
	return nil
}

func lockLease(ctx context.Context, tx pgx.Tx, key string) (ControlLease, bool, error) {
	var lease ControlLease
	err := tx.QueryRow(ctx, `
		SELECT lease_key, session_id, run_id, generation, owner_id,
		       candidate_source_sha, artifact_digest, acquired_at,
		       heartbeat_at, expires_at
		FROM execution_control_leases
		WHERE lease_key = $1
		FOR UPDATE
	`, key).Scan(
		&lease.LeaseKey, &lease.SessionID, &lease.RunID, &lease.Generation,
		&lease.OwnerID, &lease.CandidateSourceSHA, &lease.ArtifactDigest,
		&lease.AcquiredAt, &lease.HeartbeatAt, &lease.ExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ControlLease{}, false, nil
	}
	if err != nil {
		return ControlLease{}, false, fmt.Errorf("lock control lease: %w", err)
	}
	return lease, true, nil
}

func databaseClock(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return time.Time{}, fmt.Errorf("read database clock for control lease: %w", err)
	}
	return now.UTC(), nil
}

func lockLeaseForIdentity(ctx context.Context, tx pgx.Tx, identity DurableLeaseIdentity, lockClause string) (ControlLease, error) {
	var lease ControlLease
	err := tx.QueryRow(ctx, `
		SELECT lease_key, session_id, run_id, generation, owner_id,
		       candidate_source_sha, artifact_digest, acquired_at,
		       heartbeat_at, expires_at
		FROM execution_control_leases
		WHERE lease_key = $1
		  AND session_id = $2
		  AND run_id = $3
		  AND generation = $4
		  AND owner_id = $5
		  AND candidate_source_sha = $6
		  AND artifact_digest = $7
		`+lockClause, identity.LeaseKey, identity.SessionID, identity.RunID, identity.Generation, identity.OwnerID, identity.CandidateSourceSHA, identity.ArtifactDigest).Scan(
		&lease.LeaseKey, &lease.SessionID, &lease.RunID, &lease.Generation,
		&lease.OwnerID, &lease.CandidateSourceSHA, &lease.ArtifactDigest,
		&lease.AcquiredAt, &lease.HeartbeatAt, &lease.ExpiresAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ControlLease{}, ErrLeaseLost
		}
		return ControlLease{}, fmt.Errorf("lock control lease identity: %w", err)
	}
	return lease, nil
}

func writeLease(ctx context.Context, tx pgx.Tx, identity DurableLeaseIdentity, ttl time.Duration, now time.Time) (ControlLease, error) {
	var lease ControlLease
	query := `
		INSERT INTO execution_control_leases (
			lease_key, session_id, run_id, generation, owner_id,
			candidate_source_sha, artifact_digest, acquired_at,
			heartbeat_at, expires_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz,
		        $8::timestamptz, $8::timestamptz + $9 * INTERVAL '1 second')
		ON CONFLICT (lease_key) DO UPDATE SET
			session_id = EXCLUDED.session_id,
			run_id = EXCLUDED.run_id,
			generation = EXCLUDED.generation,
			owner_id = EXCLUDED.owner_id,
			candidate_source_sha = EXCLUDED.candidate_source_sha,
			artifact_digest = EXCLUDED.artifact_digest,
			acquired_at = EXCLUDED.acquired_at,
			heartbeat_at = EXCLUDED.heartbeat_at,
			expires_at = EXCLUDED.expires_at
		RETURNING lease_key, session_id, run_id, generation, owner_id,
		          candidate_source_sha, artifact_digest, acquired_at,
		          heartbeat_at, expires_at
	`
	err := tx.QueryRow(ctx, query, identity.LeaseKey, identity.SessionID, identity.RunID, identity.Generation, identity.OwnerID, identity.CandidateSourceSHA, identity.ArtifactDigest, now, ttl.Seconds()).Scan(
		&lease.LeaseKey, &lease.SessionID, &lease.RunID, &lease.Generation,
		&lease.OwnerID, &lease.CandidateSourceSHA, &lease.ArtifactDigest,
		&lease.AcquiredAt, &lease.HeartbeatAt, &lease.ExpiresAt,
	)
	if err != nil {
		return ControlLease{}, fmt.Errorf("persist control lease: %w", err)
	}
	return lease, nil
}
