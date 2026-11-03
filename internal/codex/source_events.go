package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

// ApplySourceEvent records the source identity before applying its side effect.
// The gateway acknowledgement is emitted only after this method returns nil.
func (s *Service) ApplySourceEvent(ctx context.Context, hostID, eventID, kind, threadID string, title *string, raw json.RawMessage) error {
	hostID, eventID, kind, threadID = strings.TrimSpace(hostID), strings.TrimSpace(eventID), strings.TrimSpace(kind), strings.TrimSpace(threadID)
	if hostID == "" || eventID == "" || kind == "" || threadID == "" {
		return ErrInvalid
	}
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	if !json.Valid(raw) {
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Codex source event: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO codex_sync_sources (host_id, state, sync_state, sync_operation_id, as_of, updated_at)
		SELECT id, CASE WHEN status = 'online' THEN 'online' ELSE 'offline' END, 'never', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		FROM host_registrations WHERE id = $1
		ON CONFLICT (host_id) DO NOTHING
	`, hostID); err != nil {
		return fmt.Errorf("ensure Codex source for event: %w", err)
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO codex_source_events (host_id, event_id, kind, thread_id, raw_payload, state, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'processing', CURRENT_TIMESTAMP)
		ON CONFLICT (host_id, event_id) DO NOTHING
	`, hostID, eventID, kind, threadID, string(raw))
	if err != nil {
		return fmt.Errorf("reserve Codex source event: %w", err)
	}
	if tag.RowsAffected() == 0 {
		var storedKind, storedThread, storedRaw, state string
		if err := tx.QueryRow(ctx, `
			SELECT kind, thread_id, raw_payload, state
			FROM codex_source_events WHERE host_id = $1 AND event_id = $2 FOR UPDATE
		`, hostID, eventID).Scan(&storedKind, &storedThread, &storedRaw, &state); err != nil {
			return fmt.Errorf("read Codex source event: %w", err)
		}
		if storedKind != kind || storedThread != threadID || storedRaw != string(raw) {
			return ErrConflict
		}
		if state == "applied" {
			return tx.Commit(ctx)
		}
		if state == "processing" {
			return ErrConflict
		}
		if _, err := tx.Exec(ctx, `UPDATE codex_source_events SET state = 'processing', last_error = '', updated_at = CURRENT_TIMESTAMP WHERE host_id = $1 AND event_id = $2`, hostID, eventID); err != nil {
			return fmt.Errorf("reopen Codex source event: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Codex source event reservation: %w", err)
	}

	var applyErr error
	switch kind {
	case "title_updated":
		if title == nil || strings.TrimSpace(*title) == "" {
			applyErr = ErrInvalid
		} else {
			applyErr = s.ApplyCodexTitle(ctx, hostID, threadID, *title)
		}
	case "archived":
		applyErr = s.MarkSourceStatus(ctx, hostID, threadID, protocol.CodexSourceStatusArchived, "Codex source marked archived")
	case "deleted":
		applyErr = s.MarkSourceStatus(ctx, hostID, threadID, protocol.CodexSourceStatusDeleted, "Codex source marked deleted")
	case "unavailable":
		applyErr = s.MarkSourceStatus(ctx, hostID, threadID, protocol.CodexSourceStatusUnavailable, "Codex source marked unavailable")
	default:
		applyErr = ErrInvalid
	}
	if applyErr != nil {
		stateErr := s.updateSourceEventState(hostID, eventID, "failed", applyErr.Error())
		return errors.Join(applyErr, stateErr)
	}
	if err := s.updateSourceEventState(hostID, eventID, "applied", ""); err != nil {
		return fmt.Errorf("mark Codex source event applied: %w", err)
	}
	return nil
}

func (s *Service) updateSourceEventState(hostID, eventID, state, lastError string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := s.pool.Exec(ctx, `
		UPDATE codex_source_events
		SET state = $3, last_error = $4, updated_at = CURRENT_TIMESTAMP
		WHERE host_id = $1 AND event_id = $2
	`, hostID, eventID, state, strings.TrimSpace(lastError))
	return err
}
