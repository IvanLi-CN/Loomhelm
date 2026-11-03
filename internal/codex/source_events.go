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

const sourceEventProcessingLease = time.Minute

// ErrSourceEventInProgress tells the gateway that another delivery still owns
// the processing lease. It must not be acknowledged as applied: the Connector
// keeps the notification pending and retries after the original delivery
// reaches a terminal state.
var ErrSourceEventInProgress = errors.New("Codex source event is already being applied")

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
		var updatedAt time.Time
		if err := tx.QueryRow(ctx, `
			SELECT kind, thread_id, raw_payload, state, updated_at
			FROM codex_source_events WHERE host_id = $1 AND event_id = $2 FOR UPDATE
		`, hostID, eventID).Scan(&storedKind, &storedThread, &storedRaw, &state, &updatedAt); err != nil {
			return fmt.Errorf("read Codex source event: %w", err)
		}
		if storedKind != kind || storedThread != threadID || storedRaw != string(raw) {
			return ErrConflict
		}
		if state == "applied" {
			return tx.Commit(ctx)
		}
		if state == "processing" && time.Since(updatedAt) < sourceEventProcessingLease {
			// Another delivery still owns the short processing lease. Returning a
			// retryable error prevents the duplicate from being acknowledged while
			// the original side effect is still unresolved.
			return ErrSourceEventInProgress
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
	if errors.Is(applyErr, ErrNotFound) {
		stateErr := s.updateSourceEventState(hostID, eventID, "pending", "Codex thread is not materialized; awaiting source snapshot reconciliation")
		return stateErr
	}
	if applyErr != nil {
		stateErr := s.updateSourceEventState(hostID, eventID, "failed", safeCodexError(applyErr.Error()))
		return errors.Join(applyErr, stateErr)
	}
	if err := s.updateSourceEventState(hostID, eventID, "applied", ""); err != nil {
		return fmt.Errorf("mark Codex source event applied: %w", err)
	}
	return nil
}

// replayPendingSourceEvents closes the ordering gap where a notification is
// durably received before its thread appears in a source snapshot. The event
// remains pending when the thread is still absent, so the raw notification is
// retained without blocking delivery of later source events.
func (s *Service) replayPendingSourceEvents(hostID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	rows, err := s.pool.Query(ctx, `
		SELECT event_id, kind, thread_id, raw_payload
		FROM codex_source_events
		WHERE host_id = $1 AND state = 'pending'
		ORDER BY created_at, event_id
	`, strings.TrimSpace(hostID))
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var eventID, kind, threadID, raw string
		if err := rows.Scan(&eventID, &kind, &threadID, &raw); err != nil {
			return
		}
		var title *string
		if kind == "title_updated" {
			title = sourceEventTitle(json.RawMessage(raw))
		}
		_ = s.ApplySourceEvent(ctx, hostID, eventID, kind, threadID, title, json.RawMessage(raw))
	}
}

func sourceEventTitle(raw json.RawMessage) *string {
	var envelope struct {
		Params struct {
			Name       *string `json:"name"`
			ThreadName *string `json:"threadName"`
		} `json:"params"`
		Name       *string `json:"name"`
		ThreadName *string `json:"threadName"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return nil
	}
	if envelope.Params.ThreadName != nil && strings.TrimSpace(*envelope.Params.ThreadName) != "" {
		return envelope.Params.ThreadName
	}
	if envelope.Params.Name != nil && strings.TrimSpace(*envelope.Params.Name) != "" {
		return envelope.Params.Name
	}
	if envelope.ThreadName != nil && strings.TrimSpace(*envelope.ThreadName) != "" {
		return envelope.ThreadName
	}
	if envelope.Name != nil && strings.TrimSpace(*envelope.Name) != "" {
		return envelope.Name
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
