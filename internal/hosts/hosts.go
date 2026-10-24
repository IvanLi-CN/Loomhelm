// Package hosts owns the single configured execution environment's enrollment
// state, Connector credentials and durable connection checkpoints. It does not
// expose a user-facing host resource or decide how public requests are routed.
package hosts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid                = errors.New("invalid host request")
	ErrNotFound               = errors.New("host resource not found")
	ErrCredentialRevoked      = errors.New("host credential is revoked")
	ErrUnauthenticated        = errors.New("host credential is not valid")
	ErrConnectionStale        = errors.New("host connection generation is stale")
	ErrCursorExpired          = errors.New("host reconnect cursor is expired")
	ErrCursorLimit            = errors.New("host reconnect cursor limit exceeded")
	ErrCursorRecoveryTooLarge = errors.New("host reconnect recovery payload is too large")
	ErrCursorStateInvalid     = errors.New("host reconnect cursor state is invalid")
	ErrAlreadyRegistered      = errors.New("the configured host is already registered")
	ErrCommandNotDelivered    = errors.New("host command was not delivered")
)

type Status string

const (
	StatusOffline Status = "offline"
	StatusOnline  Status = "online"
)

const (
	defaultCursorRetention  = 24 * time.Hour
	MaxCursorIDBytes        = 256
	MaxCursorValueBytes     = 2048
	MaxResumeCursorCount    = 1024
	MaxRecoveryPayloadBytes = 1 << 20
	maxHostNameLength       = 128
	maxCredentialName       = 128
)

type Config struct {
	CursorRetention time.Duration
	Now             func() time.Time
}

type Service struct {
	pool            *pgxpool.Pool
	cursorRetention time.Duration
	now             func() time.Time
}

type RegisterRequest struct {
	Name           string
	CredentialName string
}

type Registration struct {
	Host       Host
	Credential Credential
	Token      string
}

type Host struct {
	ID                   string    `json:"id"`
	Name                 string    `json:"name"`
	Status               Status    `json:"status"`
	ConnectionGeneration int64     `json:"connection_generation"`
	LastCursors          []Cursor  `json:"last_cursors,omitempty"`
	CreatedAt            time.Time `json:"created_at"`
	UpdatedAt            time.Time `json:"updated_at"`
}

type Credential struct {
	ID         string     `json:"id"`
	HostID     string     `json:"host_id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

type Cursor struct {
	SessionID     string    `json:"session_id"`
	RunID         string    `json:"run_id,omitempty"`
	Value         string    `json:"value"`
	ObservedAt    time.Time `json:"observed_at"`
	RetainedUntil time.Time `json:"retained_until"`
}

type Connection struct {
	HostID        string    `json:"host_id"`
	CredentialID  string    `json:"credential_id"`
	Generation    int64     `json:"generation"`
	ConnectedAt   time.Time `json:"connected_at"`
	ResumeCursors []Cursor  `json:"resume_cursors,omitempty"`
}

// ConnectionPreflight runs while the host row is locked and before the
// connection generation is committed. It must be side-effect free.
type ConnectionPreflight func(Connection) error

func NewService(pool *pgxpool.Pool, configs ...Config) *Service {
	cfg := Config{CursorRetention: defaultCursorRetention, Now: time.Now}
	if len(configs) > 0 {
		if configs[0].CursorRetention != 0 {
			cfg.CursorRetention = configs[0].CursorRetention
		}
		if configs[0].Now != nil {
			cfg.Now = configs[0].Now
		}
	}
	if cfg.CursorRetention <= 0 {
		cfg.CursorRetention = defaultCursorRetention
	}
	return &Service{pool: pool, cursorRetention: cfg.CursorRetention, now: cfg.Now}
}

func (s *Service) Register(ctx context.Context, request RegisterRequest) (Registration, error) {
	if err := s.ready(ctx); err != nil {
		return Registration{}, err
	}
	name := strings.TrimSpace(request.Name)
	if name == "" || len(name) > maxHostNameLength {
		return Registration{}, fmt.Errorf("%w: host name must be between 1 and %d characters", ErrInvalid, maxHostNameLength)
	}
	credentialName := strings.TrimSpace(request.CredentialName)
	if credentialName == "" {
		credentialName = "connector"
	}
	if len(credentialName) > maxCredentialName {
		return Registration{}, fmt.Errorf("%w: credential name must be at most %d characters", ErrInvalid, maxCredentialName)
	}
	hostID, err := newID("host")
	if err != nil {
		return Registration{}, err
	}
	credentialID, err := newID("hcred")
	if err != nil {
		return Registration{}, err
	}
	token, err := newToken(credentialID)
	if err != nil {
		return Registration{}, err
	}
	tokenHash := hashToken(token)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Registration{}, fmt.Errorf("begin host registration: %w", err)
	}
	defer tx.Rollback(ctx)

	var host Host
	if err := tx.QueryRow(ctx, `
		INSERT INTO host_registrations (id, name)
		VALUES ($1, $2)
		ON CONFLICT (singleton_key) DO NOTHING
		RETURNING id, name, status, connection_generation, created_at, updated_at
	`, hostID, name).Scan(
		&host.ID, &host.Name, &host.Status, &host.ConnectionGeneration, &host.CreatedAt, &host.UpdatedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return Registration{}, ErrAlreadyRegistered
	} else if err != nil {
		return Registration{}, fmt.Errorf("insert host registration: %w", err)
	}

	var credential Credential
	if err := tx.QueryRow(ctx, `
		INSERT INTO host_credentials (id, host_id, name, token_hash)
		VALUES ($1, $2, $3, $4)
		RETURNING id, host_id, name, created_at, last_used_at, revoked_at
	`, credentialID, hostID, credentialName, tokenHash[:]).Scan(
		&credential.ID, &credential.HostID, &credential.Name, &credential.CreatedAt, &credential.LastUsedAt, &credential.RevokedAt,
	); err != nil {
		return Registration{}, fmt.Errorf("insert host credential: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Registration{}, fmt.Errorf("commit host registration: %w", err)
	}
	return Registration{Host: host, Credential: credential, Token: token}, nil
}

func (s *Service) Authenticate(ctx context.Context, token string) (Credential, error) {
	if err := s.ready(ctx); err != nil {
		return Credential{}, err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return Credential{}, ErrUnauthenticated
	}
	hash := hashToken(token)
	var credential Credential
	if err := s.pool.QueryRow(ctx, `
		SELECT id, host_id, name, created_at, last_used_at, revoked_at
		FROM host_credentials
		WHERE token_hash = $1
	`, hash[:]).Scan(
		&credential.ID, &credential.HostID, &credential.Name, &credential.CreatedAt, &credential.LastUsedAt, &credential.RevokedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return Credential{}, ErrUnauthenticated
	} else if err != nil {
		return Credential{}, fmt.Errorf("authenticate host credential: %w", err)
	}
	if credential.RevokedAt != nil {
		return Credential{}, ErrCredentialRevoked
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE host_credentials SET last_used_at = $2 WHERE id = $1 AND revoked_at IS NULL
	`, credential.ID, s.now()); err != nil {
		return Credential{}, fmt.Errorf("record host credential use: %w", err)
	}
	return credential, nil
}

func (s *Service) OpenConnection(ctx context.Context, credential Credential) (Connection, error) {
	return s.openConnection(ctx, credential, nil)
}

func (s *Service) OpenConnectionWithPreflight(ctx context.Context, credential Credential, preflight ConnectionPreflight) (Connection, error) {
	return s.openConnection(ctx, credential, preflight)
}

func (s *Service) openConnection(ctx context.Context, credential Credential, preflight ConnectionPreflight) (Connection, error) {
	if err := s.ready(ctx); err != nil {
		return Connection{}, err
	}
	if strings.TrimSpace(credential.ID) == "" || strings.TrimSpace(credential.HostID) == "" {
		return Connection{}, ErrUnauthenticated
	}
	now := s.now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connection{}, fmt.Errorf("begin host connection: %w", err)
	}
	defer tx.Rollback(ctx)

	var host Host
	var credentialRevoked *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT h.id, h.name, h.status, h.connection_generation,
		       h.created_at, h.updated_at, c.revoked_at
		FROM host_registrations AS h
		JOIN host_credentials AS c ON c.host_id = h.id
		WHERE h.id = $1 AND c.id = $2
		FOR UPDATE OF h
	`, credential.HostID, credential.ID).Scan(
		&host.ID, &host.Name, &host.Status, &host.ConnectionGeneration,
		&host.CreatedAt, &host.UpdatedAt, &credentialRevoked,
	); errors.Is(err, pgx.ErrNoRows) {
		return Connection{}, ErrNotFound
	} else if err != nil {
		return Connection{}, fmt.Errorf("lock host connection: %w", err)
	}
	if credentialRevoked != nil {
		return Connection{}, ErrCredentialRevoked
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM host_cursors
		WHERE host_id = $1 AND cursor_retained_until <= $2
	`, host.ID, now); err != nil {
		return Connection{}, fmt.Errorf("expire host cursors: %w", err)
	}
	resumeCursors, err := loadCursors(ctx, tx, host.ID, now)
	if err != nil {
		return Connection{}, fmt.Errorf("load host cursors: %w", err)
	}
	if host.ConnectionGeneration == int64(^uint64(0)>>1) {
		return Connection{}, fmt.Errorf("%w: host connection generation is exhausted", ErrInvalid)
	}
	generation := host.ConnectionGeneration + 1
	if _, err := tx.Exec(ctx, `
		UPDATE host_registrations
		SET status = 'online', connection_generation = $2, updated_at = $3
		WHERE id = $1
	`, host.ID, generation, now); err != nil {
		return Connection{}, fmt.Errorf("advance host connection generation: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO host_connections (host_id, credential_id, generation, connected_at, last_seen_at)
		VALUES ($1, $2, $3, $4, $4)
		ON CONFLICT (host_id) DO UPDATE
		SET credential_id = EXCLUDED.credential_id,
		    generation = EXCLUDED.generation,
		    connected_at = EXCLUDED.connected_at,
		    last_seen_at = EXCLUDED.last_seen_at
	`, host.ID, credential.ID, generation, now); err != nil {
		return Connection{}, fmt.Errorf("record host connection: %w", err)
	}
	result, err := tx.Exec(ctx, `
		UPDATE host_credentials SET last_used_at = $2 WHERE id = $1 AND revoked_at IS NULL
	`, credential.ID, now)
	if err != nil {
		return Connection{}, fmt.Errorf("record host connection credential use: %w", err)
	}
	if result.RowsAffected() != 1 {
		return Connection{}, ErrCredentialRevoked
	}
	connection := Connection{
		HostID:        host.ID,
		CredentialID:  credential.ID,
		Generation:    generation,
		ConnectedAt:   now,
		ResumeCursors: resumeCursors,
	}
	if preflight != nil {
		if err := preflight(connection); err != nil {
			return Connection{}, fmt.Errorf("preflight host connection: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Connection{}, fmt.Errorf("commit host connection: %w", err)
	}
	return connection, nil
}

func (s *Service) Touch(ctx context.Context, connection Connection) error {
	if err := s.ready(ctx); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin host connection touch: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockActiveConnection(ctx, tx, connection); err != nil {
		return err
	}
	now := s.now()
	result, err := tx.Exec(ctx, `
		UPDATE host_connections AS active
		SET last_seen_at = $4
		FROM host_credentials AS credential
		WHERE active.host_id = $1
		  AND active.credential_id = $2
		  AND active.generation = $3
		  AND credential.id = active.credential_id
		  AND credential.revoked_at IS NULL
	`, connection.HostID, connection.CredentialID, connection.Generation, now)
	if err != nil {
		return fmt.Errorf("touch host connection: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ErrConnectionStale
	}
	if _, err := tx.Exec(ctx, `
		UPDATE host_registrations
		SET status = 'online', updated_at = $2
		WHERE id = $1 AND connection_generation = $3
	`, connection.HostID, now, connection.Generation); err != nil {
		return fmt.Errorf("touch host registration: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit host connection touch: %w", err)
	}
	return nil
}

// AuthorizeCommand serializes command admission with credential revocation and
// the replacement-generation fence. The callback is executed while the host
// row is locked, so a revocation either precedes command delivery or follows
// an already admitted write.
func (s *Service) AuthorizeCommand(ctx context.Context, connection Connection, deliver func() error) error {
	if err := s.ready(ctx); err != nil {
		return commandNotDelivered(err)
	}
	if deliver == nil {
		return commandNotDelivered(fmt.Errorf("%w: command delivery callback is required", ErrInvalid))
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return commandNotDelivered(fmt.Errorf("begin host command authorization: %w", err))
	}
	defer tx.Rollback(ctx)
	if err := lockActiveConnection(ctx, tx, connection); err != nil {
		return commandNotDelivered(err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE host_connections
		SET last_seen_at = $2
		WHERE host_id = $1 AND credential_id = $3 AND generation = $4
	`, connection.HostID, s.now(), connection.CredentialID, connection.Generation); err != nil {
		return commandNotDelivered(fmt.Errorf("touch host command connection: %w", err))
	}
	if err := deliver(); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit host command authorization: %w", err)
	}
	return nil
}

func commandNotDelivered(err error) error {
	if err == nil {
		return ErrCommandNotDelivered
	}
	return fmt.Errorf("%w: %w", ErrCommandNotDelivered, err)
}

// ProcessEvent validates and checkpoints one observed event under the same
// host-generation lock as credential revocation and command admission. The
// handler runs before the cursor is committed, so failed processing remains
// replayable after reconnect.
func (s *Service) ProcessEvent(ctx context.Context, connection Connection, cursor Cursor, handler func(context.Context) error) error {
	if err := s.ready(ctx); err != nil {
		return err
	}
	if err := validateCursor(cursor); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin host event processing: %w", err)
	}
	defer tx.Rollback(ctx)
	admission, err := s.admitCursor(ctx, tx, connection, cursor)
	if err != nil {
		return err
	}
	if handler != nil {
		if err := handler(ctx); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE host_connections
		SET last_seen_at = $2
		WHERE host_id = $1 AND credential_id = $3 AND generation = $4
	`, connection.HostID, admission.now, connection.CredentialID, connection.Generation); err != nil {
		return fmt.Errorf("touch host event connection: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO host_cursors (host_id, session_id, run_id, cursor, observed_at, cursor_retained_until)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (host_id, session_id, run_id) DO UPDATE
		SET cursor = EXCLUDED.cursor,
		    observed_at = EXCLUDED.observed_at,
		    cursor_retained_until = EXCLUDED.cursor_retained_until
	`, connection.HostID, cursor.SessionID, cursor.RunID, cursor.Value, admission.now, admission.retainedUntil); err != nil {
		return fmt.Errorf("store host event cursor: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit host event processing: %w", err)
	}
	return nil
}

func (s *Service) Checkpoint(ctx context.Context, connection Connection, cursor Cursor) error {
	if err := s.ready(ctx); err != nil {
		return err
	}
	if err := validateCursor(cursor); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin host cursor checkpoint: %w", err)
	}
	defer tx.Rollback(ctx)
	admission, err := s.admitCursor(ctx, tx, connection, cursor)
	if err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `
		UPDATE host_connections AS active
		SET last_seen_at = $4
		FROM host_credentials AS credential
		WHERE active.host_id = $1
		  AND active.credential_id = $2
		  AND active.generation = $3
		  AND credential.id = active.credential_id
		  AND credential.revoked_at IS NULL
	`, connection.HostID, connection.CredentialID, connection.Generation, admission.now)
	if err != nil {
		return fmt.Errorf("validate host cursor connection: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ErrConnectionStale
	}
	result, err = tx.Exec(ctx, `
		INSERT INTO host_cursors (host_id, session_id, run_id, cursor, observed_at, cursor_retained_until)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (host_id, session_id, run_id) DO UPDATE
		SET cursor = EXCLUDED.cursor,
		    observed_at = EXCLUDED.observed_at,
		    cursor_retained_until = EXCLUDED.cursor_retained_until
	`, connection.HostID, cursor.SessionID, cursor.RunID, cursor.Value, admission.now, admission.retainedUntil)
	if err != nil {
		return fmt.Errorf("store host cursor checkpoint: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit host cursor checkpoint: %w", err)
	}
	return nil
}

func (s *Service) CloseConnection(ctx context.Context, connection Connection) error {
	if err := s.ready(ctx); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin host connection close: %w", err)
	}
	defer tx.Rollback(ctx)
	generation, err := lockHost(ctx, tx, connection.HostID)
	if err != nil {
		return err
	}
	if generation != connection.Generation {
		return nil
	}
	result, err := tx.Exec(ctx, `
		DELETE FROM host_connections
		WHERE host_id = $1 AND credential_id = $2 AND generation = $3
	`, connection.HostID, connection.CredentialID, connection.Generation)
	if err != nil {
		return fmt.Errorf("delete host connection: %w", err)
	}
	if result.RowsAffected() == 1 {
		if _, err := tx.Exec(ctx, `
			UPDATE host_registrations
			SET status = 'offline', updated_at = $2
			WHERE id = $1 AND connection_generation = $3
		`, connection.HostID, s.now(), connection.Generation); err != nil {
			return fmt.Errorf("mark host offline: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit host connection close: %w", err)
	}
	return nil
}

func (s *Service) GetHost(ctx context.Context, hostID string) (Host, error) {
	if err := s.ready(ctx); err != nil {
		return Host{}, err
	}
	hostID = strings.TrimSpace(hostID)
	if hostID == "" {
		return Host{}, ErrInvalid
	}
	var host Host
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, status, connection_generation, created_at, updated_at
		FROM host_registrations
		WHERE id = $1
	`, hostID).Scan(
		&host.ID, &host.Name, &host.Status, &host.ConnectionGeneration, &host.CreatedAt, &host.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Host{}, ErrNotFound
	}
	if err != nil {
		return Host{}, fmt.Errorf("get host: %w", err)
	}
	host.LastCursors, err = loadCursors(ctx, s.pool, hostID, s.now())
	if err != nil {
		return Host{}, fmt.Errorf("get host cursors: %w", err)
	}
	return host, nil
}

func (s *Service) RevokeCredential(ctx context.Context, credentialID string) error {
	if err := s.ready(ctx); err != nil {
		return err
	}
	credentialID = strings.TrimSpace(credentialID)
	if credentialID == "" {
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin host credential revocation: %w", err)
	}
	defer tx.Rollback(ctx)
	var hostID string
	if err := tx.QueryRow(ctx, `
		SELECT host_id
		FROM host_credentials
		WHERE id = $1
	`, credentialID).Scan(&hostID); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return fmt.Errorf("find host credential: %w", err)
	}
	generation, err := lockHost(ctx, tx, hostID)
	if err != nil {
		return err
	}
	now := s.now()
	if _, err := tx.Exec(ctx, `
		UPDATE host_credentials
		SET revoked_at = COALESCE(revoked_at, $2)
		WHERE id = $1
	`, credentialID, now); err != nil {
		return fmt.Errorf("revoke host credential: %w", err)
	}
	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM host_connections
			WHERE host_id = $1 AND credential_id = $2
		)
	`, hostID, credentialID).Scan(&active); err != nil {
		return fmt.Errorf("check revoked host connection: %w", err)
	}
	if active {
		if generation == int64(^uint64(0)>>1) {
			return fmt.Errorf("%w: host connection generation is exhausted", ErrInvalid)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE host_registrations
			SET status = 'offline', connection_generation = $2, updated_at = $3
			WHERE id = $1
		`, hostID, generation+1, now); err != nil {
			return fmt.Errorf("invalidate revoked host connection: %w", err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM host_connections WHERE host_id = $1`, hostID); err != nil {
			return fmt.Errorf("remove revoked host connection: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit host credential revocation: %w", err)
	}
	return nil
}

type cursorQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

type cursorAdmission struct {
	now           time.Time
	retainedUntil time.Time
}

// admitCursor holds the host row lock while it removes expired positions and
// checks the complete post-write recovery payload. ProcessEvent calls this
// before its handler so a rejected cursor cannot trigger an external effect.
func (s *Service) admitCursor(ctx context.Context, tx pgx.Tx, connection Connection, cursor Cursor) (cursorAdmission, error) {
	if err := lockActiveConnection(ctx, tx, connection); err != nil {
		return cursorAdmission{}, err
	}
	now := s.now()
	if _, err := tx.Exec(ctx, `
		DELETE FROM host_cursors
		WHERE host_id = $1 AND cursor_retained_until <= $2
	`, connection.HostID, now); err != nil {
		return cursorAdmission{}, fmt.Errorf("expire host cursors: %w", err)
	}
	current, err := loadCursors(ctx, tx, connection.HostID, now)
	if err != nil {
		return cursorAdmission{}, err
	}
	retainedUntil := now.Add(s.cursorRetention)
	candidate := cursor
	candidate.ObservedAt = now
	candidate.RetainedUntil = retainedUntil
	next := make([]Cursor, 0, len(current)+1)
	replaced := false
	for _, existing := range current {
		if existing.SessionID == cursor.SessionID && existing.RunID == cursor.RunID {
			next = append(next, candidate)
			replaced = true
			continue
		}
		next = append(next, existing)
	}
	if !replaced {
		if len(current) >= MaxResumeCursorCount {
			return cursorAdmission{}, cursorStateError(ErrCursorLimit, "host %s already has %d unexpired recovery positions", connection.HostID, MaxResumeCursorCount)
		}
		next = append(next, candidate)
	}
	if size, err := recoveryPayloadSize(next); err != nil {
		return cursorAdmission{}, fmt.Errorf("encode host cursor recovery payload: %w", err)
	} else if size > MaxRecoveryPayloadBytes {
		return cursorAdmission{}, cursorStateError(ErrCursorRecoveryTooLarge, "host %s recovery payload is %d bytes, maximum is %d", connection.HostID, size, MaxRecoveryPayloadBytes)
	}
	return cursorAdmission{now: now, retainedUntil: retainedUntil}, nil
}

func loadCursors(ctx context.Context, queryer cursorQueryer, hostID string, now time.Time) ([]Cursor, error) {
	invalid, err := cursorStateHasRow(ctx, queryer, `
		SELECT 1
		FROM host_cursors
		WHERE host_id = $1 AND cursor_retained_until > $2
		  AND (octet_length(session_id) > $3
		       OR octet_length(run_id) > $3
		       OR octet_length(cursor) > $4)
		LIMIT 1
	`, hostID, now, MaxCursorIDBytes, MaxCursorValueBytes)
	if err != nil {
		return nil, fmt.Errorf("check stored cursor bounds: %w", err)
	}
	if invalid {
		return nil, cursorStateError(ErrCursorStateInvalid, "host %s contains a recovery position exceeding the stored field limits", hostID)
	}
	overfull, err := cursorStateHasRow(ctx, queryer, `
		SELECT 1
		FROM host_cursors
		WHERE host_id = $1 AND cursor_retained_until > $2
		OFFSET $3 LIMIT 1
	`, hostID, now, MaxResumeCursorCount)
	if err != nil {
		return nil, fmt.Errorf("count stored cursors: %w", err)
	}
	if overfull {
		return nil, cursorStateError(ErrCursorLimit, "host %s has more than %d unexpired recovery positions", hostID, MaxResumeCursorCount)
	}
	rows, err := queryer.Query(ctx, `
		SELECT CASE WHEN octet_length(session_id) <= $3 THEN session_id ELSE repeat('x', $3 + 1) END,
		       CASE WHEN octet_length(run_id) <= $3 THEN run_id ELSE repeat('x', $3 + 1) END,
		       CASE WHEN octet_length(cursor) <= $4 THEN cursor ELSE repeat('x', $4 + 1) END,
		       observed_at, cursor_retained_until
		FROM host_cursors
		WHERE host_id = $1 AND cursor_retained_until > $2
		ORDER BY session_id, run_id
		LIMIT $5
	`, hostID, now, MaxCursorIDBytes, MaxCursorValueBytes, MaxResumeCursorCount+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cursors []Cursor
	for rows.Next() {
		var cursor Cursor
		if err := rows.Scan(&cursor.SessionID, &cursor.RunID, &cursor.Value, &cursor.ObservedAt, &cursor.RetainedUntil); err != nil {
			return nil, err
		}
		cursors = append(cursors, cursor)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(cursors) > MaxResumeCursorCount {
		return nil, cursorStateError(ErrCursorLimit, "host %s has more than %d unexpired recovery positions", hostID, MaxResumeCursorCount)
	}
	for _, cursor := range cursors {
		if err := validateCursor(cursor); err != nil {
			return nil, cursorStateError(ErrCursorStateInvalid, "host %s contains an invalid stored recovery position: %v", hostID, err)
		}
	}
	if size, err := recoveryPayloadSize(cursors); err != nil {
		return nil, fmt.Errorf("encode host cursor recovery payload: %w", err)
	} else if size > MaxRecoveryPayloadBytes {
		return nil, cursorStateError(ErrCursorRecoveryTooLarge, "host %s recovery payload is %d bytes, maximum is %d", hostID, size, MaxRecoveryPayloadBytes)
	}
	return cursors, nil
}

func cursorStateHasRow(ctx context.Context, queryer cursorQueryer, query string, args ...any) (bool, error) {
	rows, err := queryer.Query(ctx, query, args...)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return false, rows.Err()
	}
	var marker int
	if err := rows.Scan(&marker); err != nil {
		return false, err
	}
	return true, nil
}

func validateCursor(cursor Cursor) error {
	if strings.IndexByte(cursor.SessionID, 0) >= 0 {
		return fmt.Errorf("%w: cursor session id must not contain NUL", ErrInvalid)
	}
	if strings.IndexByte(cursor.RunID, 0) >= 0 {
		return fmt.Errorf("%w: cursor run id must not contain NUL", ErrInvalid)
	}
	if strings.IndexByte(cursor.Value, 0) >= 0 {
		return fmt.Errorf("%w: cursor value must not contain NUL", ErrInvalid)
	}
	if strings.TrimSpace(cursor.SessionID) == "" {
		return fmt.Errorf("%w: cursor session id is required", ErrInvalid)
	}
	if len(cursor.SessionID) > MaxCursorIDBytes {
		return fmt.Errorf("%w: cursor session id must be at most %d bytes", ErrInvalid, MaxCursorIDBytes)
	}
	if len(cursor.RunID) > MaxCursorIDBytes {
		return fmt.Errorf("%w: cursor run id must be at most %d bytes", ErrInvalid, MaxCursorIDBytes)
	}
	if strings.TrimSpace(cursor.Value) == "" || len(cursor.Value) > MaxCursorValueBytes {
		return fmt.Errorf("%w: reconnect cursor must be between 1 and %d bytes", ErrInvalid, MaxCursorValueBytes)
	}
	return nil
}

type encodedRecoveryCursor struct {
	SessionID     string `json:"session_id"`
	RunID         string `json:"run_id,omitempty"`
	Value         string `json:"value"`
	ObservedAt    string `json:"observed_at"`
	RetainedUntil string `json:"retained_until"`
}

func recoveryPayloadSize(cursors []Cursor) (int, error) {
	wire := make([]encodedRecoveryCursor, 0, len(cursors))
	for _, cursor := range cursors {
		wire = append(wire, encodedRecoveryCursor{
			SessionID:     cursor.SessionID,
			RunID:         cursor.RunID,
			Value:         cursor.Value,
			ObservedAt:    cursor.ObservedAt.UTC().Format(time.RFC3339Nano),
			RetainedUntil: cursor.RetainedUntil.UTC().Format(time.RFC3339Nano),
		})
	}
	data, err := json.Marshal(wire)
	if err != nil {
		return 0, err
	}
	return len(data), nil
}

func cursorStateError(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: %w: %s", ErrInvalid, kind, fmt.Sprintf(format, args...))
}

func lockHost(ctx context.Context, tx pgx.Tx, hostID string) (int64, error) {
	var generation int64
	if err := tx.QueryRow(ctx, `
		SELECT connection_generation
		FROM host_registrations
		WHERE id = $1
		FOR UPDATE
	`, hostID).Scan(&generation); errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	} else if err != nil {
		return 0, fmt.Errorf("lock host: %w", err)
	}
	return generation, nil
}

func lockActiveConnection(ctx context.Context, tx pgx.Tx, connection Connection) error {
	generation, err := lockHost(ctx, tx, connection.HostID)
	if err != nil {
		return err
	}
	if generation != connection.Generation {
		return ErrConnectionStale
	}
	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM host_connections AS active
			JOIN host_credentials AS credential ON credential.id = active.credential_id
			WHERE active.host_id = $1
			  AND active.credential_id = $2
			  AND active.generation = $3
			  AND credential.revoked_at IS NULL
		)
	`, connection.HostID, connection.CredentialID, connection.Generation).Scan(&active); err != nil {
		return fmt.Errorf("check active host connection: %w", err)
	}
	if !active {
		return ErrConnectionStale
	}
	return nil
}

func (s *Service) ready(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("host service database is not configured")
	}
	if ctx == nil {
		return errors.New("host context must not be nil")
	}
	return nil
}

func hashToken(token string) [32]byte { return sha256.Sum256([]byte(token)) }

func newID(prefix string) (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("generate %s identity: %w", prefix, err)
	}
	return prefix + "_" + hex.EncodeToString(data), nil
}

func newToken(credentialID string) (string, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("generate host credential: %w", err)
	}
	return "lhc_" + credentialID + "_" + base64.RawURLEncoding.EncodeToString(data), nil
}
