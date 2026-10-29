package drafts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type StoreConfig struct {
	Now func() time.Time
}

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

// Get returns the caller's current projection. A session with no persisted
// draft has the canonical empty revision zero; the first update creates the
// durable projection at revision one.
func (s *Store) Get(ctx context.Context, sessionID, ownerUserID string) (Draft, error) {
	if err := s.ready(ctx); err != nil {
		return Draft{}, err
	}
	if err := validateIdentity(sessionID, "session id"); err != nil {
		return Draft{}, err
	}
	if err := validateIdentity(ownerUserID, "owner user id"); err != nil {
		return Draft{}, err
	}
	if err := s.ensureSessionOwner(ctx, sessionID, ownerUserID); err != nil {
		return Draft{}, err
	}
	draft, err := scanDraft(s.pool.QueryRow(ctx, draftQuery+` WHERE session_id = $1`, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Draft{SessionID: sessionID, OwnerUserID: ownerUserID, UpdatedAt: s.now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)}, nil
	}
	if err != nil {
		return Draft{}, fmt.Errorf("read draft: %w", err)
	}
	if draft.OwnerUserID != ownerUserID {
		return Draft{}, ErrDraftOwnerConflict
	}
	return draft, nil
}

// Apply accepts one complete replacement. Session serialization makes the
// database commit order the deterministic last-writer-wins order. The
// mutation ledger makes retries durable even after a newer update exists.
func (s *Store) Apply(ctx context.Context, input UpdateInput) (Draft, error) {
	if err := s.ready(ctx); err != nil {
		return Draft{}, err
	}
	if err := input.validate(); err != nil {
		return Draft{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Draft{}, fmt.Errorf("begin draft update: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := ensureSessionOwnerTx(ctx, tx, input.SessionID, input.OwnerUserID); err != nil {
		return Draft{}, err
	}

	current, found, err := lockDraftTx(ctx, tx, input.SessionID)
	if err != nil {
		return Draft{}, err
	}
	if found && current.OwnerUserID != input.OwnerUserID {
		return Draft{}, ErrDraftOwnerConflict
	}
	mutation, foundMutation, err := lockMutationTx(ctx, tx, input.SessionID, input.MutationID)
	if err != nil {
		return Draft{}, err
	}
	if foundMutation {
		if mutation.OwnerUserID != input.OwnerUserID || mutation.Kind != mutationKindUpdate || mutation.ClientID != input.ClientID || mutation.ClientSequence != input.ClientSequence {
			return Draft{}, ErrDraftMutation
		}
		if !found {
			return Draft{}, fmt.Errorf("%w: mutation has no current projection", ErrDraftMutation)
		}
		if err := tx.Commit(ctx); err != nil {
			return Draft{}, fmt.Errorf("commit duplicate draft update: %w", err)
		}
		return current, nil
	}

	var lastClientSequence int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(client_sequence), 0)
		FROM conversation_draft_mutations
		WHERE session_id = $1 AND owner_user_id = $2 AND client_id = $3 AND kind = $4
	`, input.SessionID, input.OwnerUserID, input.ClientID, mutationKindUpdate).Scan(&lastClientSequence); err != nil {
		return Draft{}, fmt.Errorf("read draft client sequence: %w", err)
	}
	if lastClientSequence > 0 && input.ClientSequence <= lastClientSequence {
		return Draft{}, fmt.Errorf("%w: client sequence %d is not after %d", ErrDraftStaleMutation, input.ClientSequence, lastClientSequence)
	}

	now := s.now().UTC().Truncate(time.Microsecond)
	draft, err := applyProjection(current, found, input, now)
	if err != nil {
		return Draft{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_draft_mutations (
			session_id, owner_user_id, mutation_id, kind, client_id,
			client_sequence, revision, created_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, input.SessionID, input.OwnerUserID, input.MutationID, mutationKindUpdate, input.ClientID, input.ClientSequence, draft.Revision, now); err != nil {
		return Draft{}, fmt.Errorf("record draft update: %w", err)
	}

	if found {
		if _, err := tx.Exec(ctx, `
			UPDATE conversation_drafts
			SET content = $2, revision = $3, mutation_id = $4,
			    client_id = $5, client_sequence = $6, updated_at = $7
			WHERE session_id = $1
		`, input.SessionID, draft.Content, draft.Revision, draft.MutationID, draft.ClientID, draft.ClientSequence, now); err != nil {
			return Draft{}, fmt.Errorf("update draft projection: %w", err)
		}
	} else {
		if _, err := tx.Exec(ctx, `
			INSERT INTO conversation_drafts (
				session_id, owner_user_id, content, revision, mutation_id,
				client_id, client_sequence, updated_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		`, draft.SessionID, draft.OwnerUserID, draft.Content, draft.Revision, draft.MutationID, draft.ClientID, draft.ClientSequence, now); err != nil {
			return Draft{}, fmt.Errorf("create draft projection: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Draft{}, fmt.Errorf("commit draft update: %w", err)
	}
	return draft, nil
}

// ConsumeIfCurrent clears only the exact revision sent by the caller. If a
// newer draft arrived after the command payload was read, the projection is
// left untouched and Consumed is false. The command ID makes a successful
// clear retry-safe for the surrounding command transaction.
func (s *Store) ConsumeIfCurrent(ctx context.Context, input ConsumeInput) (ConsumeResult, error) {
	if err := s.ready(ctx); err != nil {
		return ConsumeResult{}, err
	}
	if err := input.validate(); err != nil {
		return ConsumeResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ConsumeResult{}, fmt.Errorf("begin draft consume: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := ensureSessionOwnerTx(ctx, tx, input.SessionID, input.OwnerUserID); err != nil {
		return ConsumeResult{}, err
	}
	current, found, err := lockDraftTx(ctx, tx, input.SessionID)
	if err != nil {
		return ConsumeResult{}, err
	}
	if found && current.OwnerUserID != input.OwnerUserID {
		return ConsumeResult{}, ErrDraftOwnerConflict
	}
	if !found {
		current = Draft{SessionID: input.SessionID, OwnerUserID: input.OwnerUserID}
	}
	mutationID := consumeMutationID(input.CommandID)
	mutation, foundMutation, err := lockMutationTx(ctx, tx, input.SessionID, mutationID)
	if err != nil {
		return ConsumeResult{}, err
	}
	if foundMutation {
		if mutation.OwnerUserID != input.OwnerUserID || mutation.Kind != mutationKindConsume || mutation.ClientID != "loomhelm" || mutation.ClientSequence != 0 || mutation.Revision != input.ExpectedRevision+1 {
			return ConsumeResult{}, ErrDraftMutation
		}
		if err := tx.Commit(ctx); err != nil {
			return ConsumeResult{}, fmt.Errorf("commit duplicate draft consume: %w", err)
		}
		return ConsumeResult{Draft: current, Consumed: true}, nil
	}
	now := s.now().UTC().Truncate(time.Microsecond)
	draft, consumed, err := consumeProjection(current, found, input, now)
	if err != nil {
		return ConsumeResult{}, err
	}
	if !consumed {
		if err := tx.Commit(ctx); err != nil {
			return ConsumeResult{}, fmt.Errorf("commit unchanged draft consume: %w", err)
		}
		return ConsumeResult{Draft: draft, Consumed: false}, nil
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_draft_mutations (
			session_id, owner_user_id, mutation_id, kind, client_id,
			client_sequence, revision, created_at
		)
		VALUES ($1, $2, $3, $4, $5, 0, $6, $7)
	`, input.SessionID, input.OwnerUserID, mutationID, mutationKindConsume, draft.ClientID, draft.Revision, now); err != nil {
		return ConsumeResult{}, fmt.Errorf("record draft consume: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversation_drafts
		SET content = '', revision = $2, mutation_id = $3,
		    client_id = $4, client_sequence = 0, updated_at = $5
		WHERE session_id = $1
	`, input.SessionID, draft.Revision, draft.MutationID, draft.ClientID, now); err != nil {
		return ConsumeResult{}, fmt.Errorf("clear draft projection: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ConsumeResult{}, fmt.Errorf("commit draft consume: %w", err)
	}
	return ConsumeResult{Draft: draft, Consumed: true}, nil
}

func (s *Store) ensureSessionOwner(ctx context.Context, sessionID, ownerUserID string) error {
	if err := s.ready(ctx); err != nil {
		return err
	}
	var creatorUserID string
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(creator_user_id, '') FROM execution_sessions WHERE id = $1`, sessionID).Scan(&creatorUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrDraftSession
	}
	if err != nil {
		return fmt.Errorf("read draft session owner: %w", err)
	}
	if creatorUserID != "" && creatorUserID != ownerUserID {
		return ErrDraftOwnerConflict
	}
	return nil
}

func ensureSessionOwnerTx(ctx context.Context, tx pgx.Tx, sessionID, ownerUserID string) error {
	var creatorUserID string
	err := tx.QueryRow(ctx, `SELECT COALESCE(creator_user_id, '') FROM execution_sessions WHERE id = $1 FOR UPDATE`, sessionID).Scan(&creatorUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrDraftSession
	}
	if err != nil {
		return fmt.Errorf("lock draft session owner: %w", err)
	}
	if creatorUserID != "" && creatorUserID != ownerUserID {
		return ErrDraftOwnerConflict
	}
	return nil
}

type mutationRecord struct {
	OwnerUserID    string
	Kind           string
	ClientID       string
	ClientSequence int64
	Revision       int64
}

const (
	mutationKindUpdate  = "update"
	mutationKindConsume = "consume"
)

func lockMutationTx(ctx context.Context, tx pgx.Tx, sessionID, mutationID string) (mutationRecord, bool, error) {
	var record mutationRecord
	err := tx.QueryRow(ctx, `
		SELECT owner_user_id, kind, client_id, client_sequence, revision
		FROM conversation_draft_mutations
		WHERE session_id = $1 AND mutation_id = $2
		FOR UPDATE
	`, sessionID, mutationID).Scan(&record.OwnerUserID, &record.Kind, &record.ClientID, &record.ClientSequence, &record.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return mutationRecord{}, false, nil
	}
	if err != nil {
		return mutationRecord{}, false, fmt.Errorf("lock draft mutation: %w", err)
	}
	return record, true, nil
}

func lockDraftTx(ctx context.Context, tx pgx.Tx, sessionID string) (Draft, bool, error) {
	draft, err := scanDraft(tx.QueryRow(ctx, draftQuery+` WHERE session_id = $1 FOR UPDATE`, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Draft{}, false, nil
	}
	if err != nil {
		return Draft{}, false, fmt.Errorf("lock draft projection: %w", err)
	}
	return draft, true, nil
}

const draftQuery = `
	SELECT session_id, owner_user_id, content, revision, mutation_id,
	       client_id, client_sequence, updated_at
	FROM conversation_drafts
`

func scanDraft(row interface{ Scan(...any) error }) (Draft, error) {
	var draft Draft
	var updatedAt time.Time
	if err := row.Scan(&draft.SessionID, &draft.OwnerUserID, &draft.Content, &draft.Revision, &draft.MutationID, &draft.ClientID, &draft.ClientSequence, &updatedAt); err != nil {
		return Draft{}, err
	}
	draft.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	return draft, nil
}

func (s *Store) ready(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("draft store database is not configured")
	}
	if ctx == nil {
		return errors.New("draft context must not be nil")
	}
	return nil
}
