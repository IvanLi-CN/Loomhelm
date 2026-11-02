package codex

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// SyncRunner is the Host-local connector boundary. The runner returns a
// complete or explicitly partial snapshot; persistence decides what becomes
// project-visible and records the same operation state for later inspection.
type SyncRunner interface {
	Sync(context.Context, string, string) (protocol.CodexSourceSnapshot, error)
}

func (s *Service) SetSyncRunner(runner SyncRunner) {
	if s != nil {
		s.syncRunner = runner
	}
}

type snapshotStatus struct {
	State    protocol.CodexSyncState
	Complete bool
	Error    string
}

func (s *Service) ImportSnapshot(ctx context.Context, snapshot protocol.CodexSourceSnapshot) error {
	hostID := strings.TrimSpace(snapshot.HostID)
	if s == nil || s.pool == nil || hostID == "" {
		return ErrInvalid
	}
	if snapshot.AsOf.IsZero() {
		snapshot.AsOf = s.now()
	}
	if snapshot.State == "" {
		snapshot.State = protocol.CodexSourceStateOnline
	}
	snapshot.State = sourceStateOrDefault(snapshot.State)
	status := sourceSnapshotStatus(snapshot)
	if snapshot.OperationID == "" {
		snapshot.OperationID = newID("codex-sync")
	}
	capabilities, err := json.Marshal(uniqueStrings(snapshot.Capabilities))
	if err != nil {
		return fmt.Errorf("encode Codex source capabilities: %w", err)
	}
	capabilityStates, err := json.Marshal(snapshot.CapabilityStates)
	if err != nil {
		return fmt.Errorf("encode Codex capability states: %w", err)
	}
	if snapshot.CapabilityStates == nil {
		capabilityStates = []byte(`{}`)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Codex snapshot import: %w", err)
	}
	defer tx.Rollback(ctx)
	var currentAsOf time.Time
	var currentOperationID string
	if err := tx.QueryRow(ctx, `
		SELECT as_of, sync_operation_id FROM codex_sync_sources WHERE host_id = $1 FOR UPDATE
	`, hostID).Scan(&currentAsOf, &currentOperationID); err == nil {
		if !snapshot.AsOf.After(currentAsOf) && currentOperationID != strings.TrimSpace(snapshot.OperationID) {
			if _, staleErr := tx.Exec(ctx, `
				UPDATE codex_sync_snapshots
				SET state = 'stale', complete = FALSE, error = 'superseded by a newer Codex source snapshot', updated_at = $3
				WHERE id = $1 AND host_id = $2 AND state = 'syncing'
			`, snapshot.OperationID, hostID, currentAsOf); staleErr != nil {
				return fmt.Errorf("mark stale Codex snapshot: %w", staleErr)
			}
			return tx.Commit(ctx)
		}
		if currentAsOf.After(snapshot.AsOf) {
			snapshot.AsOf = currentAsOf
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("read current Codex source snapshot: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO codex_sync_sources (host_id, state, sync_state, build, protocol_version, capabilities, capability_states, sync_operation_id, as_of, last_error, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $9)
		ON CONFLICT (host_id) DO UPDATE SET
			state = EXCLUDED.state,
			sync_state = EXCLUDED.sync_state,
			build = EXCLUDED.build,
			protocol_version = EXCLUDED.protocol_version,
			capabilities = EXCLUDED.capabilities,
			capability_states = EXCLUDED.capability_states,
			sync_operation_id = EXCLUDED.sync_operation_id,
			last_error = EXCLUDED.last_error,
			as_of = EXCLUDED.as_of,
			updated_at = EXCLUDED.updated_at
	`, hostID, snapshot.State, status.State, strings.TrimSpace(snapshot.Build), strings.TrimSpace(snapshot.ProtocolVersion), capabilities, capabilityStates, snapshot.OperationID, snapshot.AsOf, strings.TrimSpace(status.Error)); err != nil {
		return fmt.Errorf("persist Codex source snapshot: %w", err)
	}

	for _, project := range snapshot.Projects {
		if strings.TrimSpace(project.ProjectID) == "" {
			return ErrInvalid
		}
		projectAsOf := project.AsOf
		if projectAsOf.IsZero() {
			projectAsOf = snapshot.AsOf
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO codex_projects (host_id, project_id, name, cwd, snapshot_state, as_of, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6)
			ON CONFLICT (host_id, project_id) DO UPDATE SET
				name = EXCLUDED.name,
				cwd = EXCLUDED.cwd,
				snapshot_state = EXCLUDED.snapshot_state,
				as_of = EXCLUDED.as_of,
				updated_at = EXCLUDED.updated_at
		`, hostID, strings.TrimSpace(project.ProjectID), strings.TrimSpace(project.Name), strings.TrimSpace(project.CWD), status.State, projectAsOf); err != nil {
			return fmt.Errorf("persist Codex project snapshot: %w", err)
		}
	}

	threadIDs := make([]string, 0, len(snapshot.Threads))
	for _, thread := range snapshot.Threads {
		threadID := strings.TrimSpace(thread.ThreadID)
		if threadID == "" {
			return ErrInvalid
		}
		threadIDs = append(threadIDs, threadID)
		projectID := strings.TrimSpace(valueOrEmpty(thread.ProjectID))
		projectIDValue := nullableStringValue(projectID)
		if projectID != "" {
			// A partial project discovery must not make the thread disappear or
			// violate the composite foreign key. The placeholder remains clearly
			// partial and can be enriched by the next project snapshot.
			if _, err := tx.Exec(ctx, `
				INSERT INTO codex_projects (host_id, project_id, name, cwd, snapshot_state, as_of, updated_at)
				VALUES ($1, $2, '', '', 'partial', $3, $3)
				ON CONFLICT (host_id, project_id) DO NOTHING
			`, hostID, projectID, snapshot.AsOf); err != nil {
				return fmt.Errorf("persist Codex project placeholder: %w", err)
			}
		}
		threadStatus := threadSnapshotStatus(thread)
		conversationTitle := strings.TrimSpace(valueOrEmpty(thread.CodexTitle))
		if conversationTitle == "" {
			conversationTitle = strings.TrimSpace(thread.Preview)
		}
		if conversationTitle == "" {
			conversationTitle = "自动标题"
		}
		titleState := protocol.CodexTitleSyncStateUnsupported
		if thread.CodexTitle != nil && strings.TrimSpace(*thread.CodexTitle) != "" {
			titleState = protocol.CodexTitleSyncStateSynced
		}
		lastActivity := thread.LastActivityAt
		if lastActivity.IsZero() {
			lastActivity = snapshot.AsOf
		}
		metadata := json.RawMessage(`{}`)
		if json.Valid(thread.RawThread) && len(thread.RawThread) > 0 {
			metadata = thread.RawThread
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO codex_threads (
				host_id, thread_id, project_id, parent_thread_id, source_kind, codex_title,
				conversation_title, preview, cwd, source_status, history_state, files_complete,
				title_sync_state, imported_by, as_of, last_activity_at, updated_at, metadata
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
				(SELECT NULLIF(owner_user_id, '') FROM host_registrations WHERE id = $1), $14, $15, $14, $16::jsonb)
			ON CONFLICT (host_id, thread_id) DO UPDATE SET
				project_id = COALESCE(EXCLUDED.project_id, codex_threads.project_id),
				parent_thread_id = COALESCE(EXCLUDED.parent_thread_id, codex_threads.parent_thread_id),
				source_kind = EXCLUDED.source_kind,
				codex_title = COALESCE(EXCLUDED.codex_title, codex_threads.codex_title),
				conversation_title = CASE
					WHEN codex_threads.title_sync_state IN ('pending', 'failed', 'conflict') THEN codex_threads.conversation_title
					WHEN EXCLUDED.codex_title IS NOT NULL AND length(trim(EXCLUDED.codex_title)) > 0 THEN EXCLUDED.codex_title
					ELSE codex_threads.conversation_title
				END,
				preview = EXCLUDED.preview,
				cwd = EXCLUDED.cwd,
				source_status = EXCLUDED.source_status,
				history_state = EXCLUDED.history_state,
				files_complete = EXCLUDED.files_complete,
				as_of = EXCLUDED.as_of,
				last_activity_at = EXCLUDED.last_activity_at,
				updated_at = EXCLUDED.updated_at,
				metadata = CASE WHEN EXCLUDED.metadata <> '{}'::jsonb THEN EXCLUDED.metadata ELSE codex_threads.metadata END
			`, hostID, threadID, projectIDValue, nullableString(thread.ParentThreadID), sourceKindOrDefault(thread.SourceKind), nullableString(thread.CodexTitle), conversationTitle, strings.TrimSpace(thread.Preview), strings.TrimSpace(thread.CWD), sourceStatusOrDefault(thread.SourceStatus), threadHistoryState(thread, threadStatus), threadStatus.Complete && filesCompleteForThread(thread), titleState, snapshot.AsOf, lastActivity, metadata); err != nil {
			return fmt.Errorf("persist Codex thread snapshot: %w", err)
		}

		for index, event := range thread.Events {
			eventID := strings.TrimSpace(event.EventID)
			sequence := event.Sequence
			if sequence < 1 {
				sequence = int64(index + 1)
			}
			if eventID == "" {
				digest := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%s", strings.TrimSpace(event.EventType), sequence, event.RawPayload)))
				eventID = "codex-" + hex.EncodeToString(digest[:12])
			}
			rawPayload := event.RawPayload
			if len(rawPayload) == 0 {
				rawPayload = json.RawMessage(`null`)
			}
			occurredAt := event.OccurredAt
			if occurredAt.IsZero() {
				occurredAt = snapshot.AsOf
			}
			fallback := strings.TrimSpace(event.ReadableFallback)
			if fallback == "" {
				fallback = strings.TrimSpace(event.EventType)
			}
			if fallback == "" {
				fallback = "未知 Codex 事件"
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO codex_thread_history (host_id, thread_id, event_id, sequence, event_type, raw_payload, readable_fallback, occurred_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				ON CONFLICT (host_id, thread_id, event_id) DO NOTHING
			`, hostID, threadID, eventID, sequence, strings.TrimSpace(event.EventType), string(rawPayload), fallback, occurredAt); err != nil {
				return fmt.Errorf("persist Codex history snapshot: %w", err)
			}
		}

		allFilesComplete := filesCompleteForThread(thread)
		for _, file := range thread.Files {
			if strings.TrimSpace(file.Path) == "" || file.Size < 0 {
				return ErrInvalid
			}
			if len(file.Content) > 0 && file.Size == 0 {
				file.Size = int64(len(file.Content))
			}
			if len(file.Content) > 0 && file.Size != int64(len(file.Content)) {
				return ErrInvalid
			}
			if len(file.Content) > 0 && strings.TrimSpace(file.SHA256) != "" {
				digest := sha256.Sum256(file.Content)
				if !strings.EqualFold(strings.TrimSpace(file.SHA256), hex.EncodeToString(digest[:])) {
					return ErrInvalid
				}
			}
			if file.Complete && len(file.Content) == 0 && strings.TrimSpace(file.ContentRef) == "" {
				return ErrInvalid
			}
			if !file.Complete {
				allFilesComplete = false
			}
			contentType := strings.TrimSpace(file.ContentType)
			if contentType == "" {
				contentType = "application/octet-stream"
			}
			var existingComplete bool
			var existingSize int64
			var existingSHA, existingRef string
			var existingContent []byte
			existingErr := tx.QueryRow(ctx, `
				SELECT size, sha256, content_bytes, content_ref, complete
				FROM codex_thread_files WHERE host_id = $1 AND thread_id = $2 AND path = $3
			`, hostID, threadID, strings.TrimSpace(file.Path)).Scan(&existingSize, &existingSHA, &existingContent, &existingRef, &existingComplete)
			if existingErr != nil && !errors.Is(existingErr, pgx.ErrNoRows) {
				return fmt.Errorf("read existing Codex file material: %w", existingErr)
			}
			if existingErr == nil && existingComplete && file.Complete && !sameFileMaterial(existingSize, existingSHA, existingContent, existingRef, file) {
				return fmt.Errorf("Codex file material changed for %q: %w", strings.TrimSpace(file.Path), ErrConflict)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO codex_thread_files (host_id, thread_id, path, content_type, size, sha256, content_bytes, content_ref, complete, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				ON CONFLICT (host_id, thread_id, path) DO UPDATE SET
					content_type = EXCLUDED.content_type,
					size = EXCLUDED.size,
					sha256 = EXCLUDED.sha256,
					content_bytes = EXCLUDED.content_bytes,
					content_ref = EXCLUDED.content_ref,
					complete = EXCLUDED.complete,
					updated_at = EXCLUDED.updated_at
				WHERE NOT codex_thread_files.complete
			`, hostID, threadID, strings.TrimSpace(file.Path), contentType, file.Size, strings.TrimSpace(file.SHA256), file.Content, strings.TrimSpace(file.ContentRef), file.Complete, snapshot.AsOf); err != nil {
				return fmt.Errorf("persist Codex file snapshot: %w", err)
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE codex_threads
			SET history_state = $3,
				files_complete = $4,
				title_sync_error = CASE WHEN NULLIF(trim($5), '') IS NOT NULL THEN $5 ELSE title_sync_error END,
				updated_at = $6
			WHERE host_id = $1 AND thread_id = $2
		`, hostID, threadID, threadHistoryState(thread, threadStatus), allFilesComplete, strings.TrimSpace(thread.Error), snapshot.AsOf); err != nil {
			return fmt.Errorf("finalize Codex thread snapshot: %w", err)
		}

		threadComplete := allFilesComplete && threadHistoryComplete(thread, threadStatus)
		threadSnapshotID := snapshot.OperationID + ":thread:" + threadID
		if _, err := tx.Exec(ctx, `
			INSERT INTO codex_sync_snapshots (id, host_id, scope, thread_id, state, complete, as_of, cursor, error, created_at, updated_at)
			VALUES ($1, $2, 'thread', $3, $4, $5, $6, '', $7, $6, $6)
			ON CONFLICT (id) DO UPDATE SET
				state = EXCLUDED.state,
				complete = EXCLUDED.complete,
				as_of = EXCLUDED.as_of,
				error = EXCLUDED.error,
				updated_at = EXCLUDED.updated_at
		`, threadSnapshotID, hostID, threadID, threadStatus.State, threadComplete, snapshot.AsOf, strings.TrimSpace(thread.Error)); err != nil {
			return fmt.Errorf("persist Codex thread snapshot state: %w", err)
		}
	}
	if status.Complete {
		reason := "Codex source thread was not present in a complete snapshot"
		if _, err := tx.Exec(ctx, `
			UPDATE codex_threads
			SET source_status = 'unavailable', title_sync_state = 'paused', title_sync_error = $3, updated_at = $4
			WHERE host_id = $1 AND source_status = 'active' AND NOT (thread_id = ANY($2::text[]))
		`, hostID, threadIDs, reason, snapshot.AsOf); err != nil {
			return fmt.Errorf("mark missing Codex threads unavailable: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE codex_title_operations
			SET state = 'title_sync_paused', last_error = $2, updated_at = $3
			WHERE host_id = $1 AND state = 'title_sync_pending'
				AND EXISTS (
					SELECT 1 FROM codex_threads t
					WHERE t.host_id = codex_title_operations.host_id
					  AND t.thread_id = codex_title_operations.thread_id
					  AND t.source_status = 'unavailable'
				)
		`, hostID, reason, snapshot.AsOf); err != nil {
			return fmt.Errorf("pause missing Codex title operations: %w", err)
		}
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO codex_sync_snapshots (id, host_id, scope, state, complete, as_of, cursor, error, created_at, updated_at)
		VALUES ($1, $2, 'source', $3, $4, $5, $6, $7, $5, $5)
		ON CONFLICT (id) DO UPDATE SET
			state = EXCLUDED.state,
			complete = EXCLUDED.complete,
			as_of = EXCLUDED.as_of,
			cursor = EXCLUDED.cursor,
			error = EXCLUDED.error,
			updated_at = EXCLUDED.updated_at
	`, snapshot.OperationID, hostID, status.State, status.Complete, snapshot.AsOf, strings.TrimSpace(snapshot.Cursor), strings.TrimSpace(status.Error)); err != nil {
		return fmt.Errorf("persist Codex source snapshot state: %w", err)
	}
	return tx.Commit(ctx)
}

func (s *Service) FailSync(ctx context.Context, hostID, operationID string, syncErr error) error {
	hostID = strings.TrimSpace(hostID)
	operationID = strings.TrimSpace(operationID)
	if hostID == "" || operationID == "" {
		return ErrInvalid
	}
	reason := "Codex source synchronization failed"
	if syncErr != nil && strings.TrimSpace(syncErr.Error()) != "" {
		reason = syncErr.Error()
	}
	now := s.now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `
		UPDATE codex_sync_sources
		SET sync_state = 'failed', last_error = $3, as_of = $4, updated_at = $4
		WHERE host_id = $1 AND sync_operation_id = $2
	`, hostID, operationID, reason, now)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE codex_sync_snapshots
			SET state = 'stale', complete = FALSE, error = 'superseded by a newer Codex source snapshot', updated_at = $3
			WHERE id = $1 AND host_id = $2 AND state = 'syncing'
		`, operationID, hostID, now); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE codex_sync_snapshots
		SET state = 'failed', complete = FALSE, error = $3, as_of = $4, updated_at = $4
		WHERE id = $1 AND host_id = $2
	`, operationID, hostID, reason, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func sameFileMaterial(existingSize int64, existingSHA string, existingContent []byte, existingRef string, incoming protocol.CodexSourceFileMaterial) bool {
	return existingSize == incoming.Size &&
		strings.EqualFold(strings.TrimSpace(existingSHA), strings.TrimSpace(incoming.SHA256)) &&
		bytes.Equal(existingContent, incoming.Content) &&
		strings.TrimSpace(existingRef) == strings.TrimSpace(incoming.ContentRef)
}

func sourceSnapshotStatus(snapshot protocol.CodexSourceSnapshot) snapshotStatus {
	state := snapshot.SyncState
	if state == "" {
		state = protocol.CodexSyncStateComplete
		for _, thread := range snapshot.Threads {
			if threadHistoryState(thread, snapshotStatus{State: state, Complete: true}) != protocol.CodexHistoryStateComplete || !filesCompleteForThread(thread) {
				state = protocol.CodexSyncStatePartial
				break
			}
		}
	}
	if !validSyncState(state) {
		state = protocol.CodexSyncStatePartial
	}
	complete := state == protocol.CodexSyncStateComplete
	if snapshot.Error != "" {
		complete = false
		if state == protocol.CodexSyncStateComplete {
			state = protocol.CodexSyncStatePartial
		}
	}
	return snapshotStatus{State: state, Complete: complete, Error: strings.TrimSpace(snapshot.Error)}
}

func threadSnapshotStatus(thread protocol.CodexSourceThreadSnapshot) snapshotStatus {
	state := protocol.CodexSyncStateComplete
	if thread.HistoryState != protocol.CodexHistoryStateComplete || !filesCompleteForThread(thread) {
		state = protocol.CodexSyncStatePartial
	}
	if strings.TrimSpace(thread.Error) != "" {
		state = protocol.CodexSyncStateFailed
	}
	return snapshotStatus{State: state, Complete: state == protocol.CodexSyncStateComplete, Error: strings.TrimSpace(thread.Error)}
}

func filesCompleteForThread(thread protocol.CodexSourceThreadSnapshot) bool {
	if !thread.FilesComplete {
		return false
	}
	for _, file := range thread.Files {
		if !file.Complete {
			return false
		}
	}
	return true
}

func threadHistoryState(thread protocol.CodexSourceThreadSnapshot, status snapshotStatus) protocol.CodexHistoryState {
	if validHistoryState(thread.HistoryState) {
		return thread.HistoryState
	}
	if thread.HistoryState != "" {
		return protocol.CodexHistoryStatePartial
	}
	if status.State == protocol.CodexSyncStateComplete {
		return protocol.CodexHistoryStateComplete
	}
	if status.State == protocol.CodexSyncStateFailed {
		return protocol.CodexHistoryStateFailed
	}
	return protocol.CodexHistoryStatePartial
}

func threadHistoryComplete(thread protocol.CodexSourceThreadSnapshot, status snapshotStatus) bool {
	return threadHistoryState(thread, status) == protocol.CodexHistoryStateComplete
}

func sourceKindOrDefault(value protocol.CodexThreadSourceKind) protocol.CodexThreadSourceKind {
	if value == "" || value == protocol.CodexThreadSourceKindMain {
		return protocol.CodexThreadSourceKindMain
	}
	if value == protocol.CodexThreadSourceKindSubagent {
		return value
	}
	return protocol.CodexThreadSourceKindMain
}

func sourceStatusOrDefault(value protocol.CodexSourceStatus) protocol.CodexSourceStatus {
	if value == "" {
		return protocol.CodexSourceStatusActive
	}
	switch value {
	case protocol.CodexSourceStatusActive, protocol.CodexSourceStatusArchived, protocol.CodexSourceStatusDeleted, protocol.CodexSourceStatusUnavailable:
		return value
	default:
		return protocol.CodexSourceStatusUnavailable
	}
}

func sourceStateOrDefault(value protocol.CodexSourceState) protocol.CodexSourceState {
	switch value {
	case protocol.CodexSourceStateOnline, protocol.CodexSourceStateOffline, protocol.CodexSourceStateUnavailable:
		return value
	default:
		return protocol.CodexSourceStateUnavailable
	}
}

func validSyncState(value protocol.CodexSyncState) bool {
	switch value {
	case protocol.CodexSyncStateNever, protocol.CodexSyncStateSyncing, protocol.CodexSyncStateComplete, protocol.CodexSyncStatePartial, protocol.CodexSyncStateStale, protocol.CodexSyncStateFailed:
		return true
	default:
		return false
	}
}

func validHistoryState(value protocol.CodexHistoryState) bool {
	switch value {
	case protocol.CodexHistoryStatePending, protocol.CodexHistoryStateComplete, protocol.CodexHistoryStatePartial, protocol.CodexHistoryStateFailed:
		return true
	default:
		return false
	}
}
