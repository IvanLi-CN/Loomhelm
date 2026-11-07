package codex

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
)

var errStaleSnapshot = errors.New("Codex source snapshot is stale")

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

func safeCodexError(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	lower := strings.ToLower(value)
	switch {
	case strings.Contains(lower, "capability") || strings.Contains(lower, "unsupported"):
		return "Codex source capability is unsupported"
	case strings.Contains(lower, "history") || strings.Contains(lower, "turn") || strings.Contains(lower, "item"):
		return "Codex source history is incomplete"
	case strings.Contains(lower, "attachment") || strings.Contains(lower, "file"):
		return "Codex source file material is incomplete"
	case strings.Contains(lower, "permission") || strings.Contains(lower, "unauthor"):
		return "Codex source permission was rejected"
	default:
		return "Codex source synchronization failed"
	}
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
	var hostStatus string
	var hostGeneration int64
	if err := tx.QueryRow(ctx, `
		SELECT status, connection_generation FROM host_registrations WHERE id = $1
	`, hostID).Scan(&hostStatus, &hostGeneration); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("read Codex Host state: %w", err)
	}
	var currentAsOf time.Time
	var currentOperationID, currentSyncState, currentSourceState string
	if err := tx.QueryRow(ctx, `
		SELECT as_of, sync_operation_id, sync_state, state FROM codex_sync_sources WHERE host_id = $1 FOR UPDATE
	`, hostID).Scan(&currentAsOf, &currentOperationID, &currentSyncState, &currentSourceState); err == nil {
		incomingOperationID := strings.TrimSpace(snapshot.OperationID)
		currentOperationID = strings.TrimSpace(currentOperationID)
		// A Server restart marks an in-flight source sync stale while the Host
		// connection may remain online. A recovery snapshot must be able to
		// replace that interrupted operation without allowing it to overwrite a
		// currently active sync.
		recoveryAllowed := recoverySnapshotAllowed(snapshot.Recovery, hostStatus, currentSyncState)
		if currentOperationID != "" && currentOperationID != incomingOperationID && (currentSyncState == "syncing" || !recoveryAllowed) {
			if _, staleErr := tx.Exec(ctx, `
				UPDATE codex_sync_snapshots
				SET state = 'stale', complete = FALSE, error = 'superseded by a newer Codex source snapshot', updated_at = $3
				WHERE id = $1 AND host_id = $2 AND state = 'syncing'
			`, snapshot.OperationID, hostID, currentAsOf); staleErr != nil {
				return fmt.Errorf("mark stale Codex snapshot: %w", staleErr)
			}
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			if snapshot.ConnectionGeneration > 0 {
				return errStaleSnapshot
			}
			return nil
		}
		if currentAsOf.After(snapshot.AsOf) {
			snapshot.AsOf = currentAsOf
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("read current Codex source snapshot: %w", err)
	}

	// Import coordinates with Host lifecycle and Session activation through a
	// single lock order: source -> Session -> Task -> Host -> Codex. Per-thread
	// reconciliation runs after the Codex row upsert, so an activation that
	// starts before the Codex row exists is resolved by whichever transaction
	// reaches the Host lock second.
	threadIDs := make([]string, 0, len(snapshot.Threads))
	for _, thread := range snapshot.Threads {
		threadID := strings.TrimSpace(thread.ThreadID)
		if threadID == "" {
			return ErrInvalid
		}
		threadIDs = append(threadIDs, threadID)
	}
	sort.Strings(threadIDs)
	if err := lockImportBindingRows(ctx, tx, hostID, threadIDs); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `
		SELECT status, connection_generation FROM host_registrations WHERE id = $1 FOR UPDATE
	`, hostID).Scan(&hostStatus, &hostGeneration); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("lock Codex Host state: %w", err)
	}
	if snapshot.ConnectionGeneration > 0 && (hostStatus != "online" || snapshot.ConnectionGeneration != hostGeneration) {
		if _, staleErr := tx.Exec(ctx, `
			UPDATE codex_sync_snapshots
			SET state = 'stale', complete = FALSE, error = 'superseded by a newer Host connection generation', updated_at = CURRENT_TIMESTAMP
			WHERE id = $1 AND host_id = $2 AND state = 'syncing'
		`, snapshot.OperationID, hostID); staleErr != nil {
			return fmt.Errorf("mark stale Host-generation Codex snapshot: %w", staleErr)
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return errStaleSnapshot
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

	for _, thread := range snapshot.Threads {
		threadID := strings.TrimSpace(thread.ThreadID)
		if threadID == "" {
			return ErrInvalid
		}
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
		sourceKind, sourceKindErr := normalizeSourceKind(thread.SourceKind)
		if sourceKindErr != nil {
			return sourceKindErr
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
				codex_title = CASE WHEN codex_threads.updated_at > EXCLUDED.updated_at THEN codex_threads.codex_title ELSE COALESCE(EXCLUDED.codex_title, codex_threads.codex_title) END,
				conversation_title = CASE
					WHEN codex_threads.title_sync_state IN ('pending', 'failed', 'conflict', 'paused') THEN codex_threads.conversation_title
					WHEN EXCLUDED.codex_title IS NOT NULL AND length(trim(EXCLUDED.codex_title)) > 0 THEN EXCLUDED.codex_title
					ELSE codex_threads.conversation_title
				END,
				preview = EXCLUDED.preview,
				cwd = EXCLUDED.cwd,
				source_status = CASE WHEN codex_threads.updated_at > EXCLUDED.updated_at THEN codex_threads.source_status ELSE EXCLUDED.source_status END,
				history_state = CASE WHEN codex_threads.updated_at > EXCLUDED.updated_at THEN codex_threads.history_state ELSE EXCLUDED.history_state END,
				files_complete = CASE WHEN codex_threads.updated_at > EXCLUDED.updated_at THEN codex_threads.files_complete ELSE EXCLUDED.files_complete END,
				as_of = GREATEST(codex_threads.as_of, EXCLUDED.as_of),
				last_activity_at = GREATEST(codex_threads.last_activity_at, EXCLUDED.last_activity_at),
				updated_at = GREATEST(codex_threads.updated_at, EXCLUDED.updated_at),
				metadata = CASE WHEN EXCLUDED.metadata <> '{}'::jsonb THEN EXCLUDED.metadata ELSE codex_threads.metadata END
			`, hostID, threadID, projectIDValue, nullableString(thread.ParentThreadID), sourceKind, nullableString(thread.CodexTitle), conversationTitle, strings.TrimSpace(thread.Preview), strings.TrimSpace(thread.CWD), sourceStatusOrDefault(thread.SourceStatus), threadHistoryState(thread, threadStatus), threadStatus.Complete && filesCompleteForThread(thread), titleState, snapshot.AsOf, lastActivity, metadata); err != nil {
			return fmt.Errorf("persist Codex thread snapshot: %w", err)
		}

		for index, event := range thread.Events {
			eventID := strings.TrimSpace(event.EventID)
			sequence := event.Sequence
			if sequence < 1 {
				sequence = int64(index + 1)
			}
			if eventID == "" {
				// The raw payload is the stable logical identity across the
				// connector's turns/items collection paths.
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
			var existingEventType, existingEventRaw, existingEventFallback string
			var existingEventSequence int64
			var existingEventAt time.Time
			existingEventErr := tx.QueryRow(ctx, `
				SELECT sequence, event_type, raw_payload, readable_fallback, occurred_at
				FROM codex_thread_history WHERE host_id = $1 AND thread_id = $2 AND event_id = $3
			`, hostID, threadID, eventID).Scan(&existingEventSequence, &existingEventType, &existingEventRaw, &existingEventFallback, &existingEventAt)
			if existingEventErr == nil {
				if existingEventType != strings.TrimSpace(event.EventType) || existingEventRaw != string(rawPayload) || existingEventFallback != fallback || !existingEventAt.Equal(occurredAt) {
					return ErrConflict
				}
				continue
			}
			if !errors.Is(existingEventErr, pgx.ErrNoRows) {
				return fmt.Errorf("read existing Codex history snapshot: %w", existingEventErr)
			}
			var occupiedEventID string
			if err := tx.QueryRow(ctx, `SELECT event_id FROM codex_thread_history WHERE host_id = $1 AND thread_id = $2 AND sequence = $3`, hostID, threadID, sequence).Scan(&occupiedEventID); err == nil {
				if occupiedEventID != eventID {
					if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sequence), 0) + 1 FROM codex_thread_history WHERE host_id = $1 AND thread_id = $2`, hostID, threadID).Scan(&sequence); err != nil {
						return fmt.Errorf("allocate Codex history sequence: %w", err)
					}
				}
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("read Codex history sequence: %w", err)
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
			if strings.TrimSpace(file.SHA256) == "" && len(file.Content) > 0 {
				digest := sha256.Sum256(file.Content)
				file.SHA256 = hex.EncodeToString(digest[:])
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
			var existingContentType, existingSHA, existingRef string
			var existingContent []byte
			existingErr := tx.QueryRow(ctx, `
				SELECT content_type, size, sha256, content_bytes, content_ref, complete
				FROM codex_thread_files WHERE host_id = $1 AND thread_id = $2 AND path = $3
			`, hostID, threadID, strings.TrimSpace(file.Path)).Scan(&existingContentType, &existingSize, &existingSHA, &existingContent, &existingRef, &existingComplete)
			if existingErr != nil && !errors.Is(existingErr, pgx.ErrNoRows) {
				return fmt.Errorf("read existing Codex file material: %w", existingErr)
			}
			if existingErr == nil && existingComplete && file.Complete && !sameFileMaterial(existingContentType, existingSize, existingSHA, existingContent, existingRef, file) {
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
		if allFilesComplete {
			filePaths := make([]string, 0, len(thread.Files))
			for _, file := range thread.Files {
				filePaths = append(filePaths, strings.TrimSpace(file.Path))
			}
			if _, err := tx.Exec(ctx, `
				DELETE FROM codex_thread_files
				WHERE host_id = $1 AND thread_id = $2 AND NOT complete
				  AND NOT (path = ANY($3::text[]))
			`, hostID, threadID, filePaths); err != nil {
				return fmt.Errorf("remove superseded incomplete Codex files: %w", err)
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE codex_threads
			SET history_state = $3,
				files_complete = $4,
				title_sync_error = CASE WHEN NULLIF(trim($5), '') IS NOT NULL THEN $5 ELSE title_sync_error END,
				updated_at = $6
			WHERE host_id = $1 AND thread_id = $2 AND updated_at <= $6
		`, hostID, threadID, threadHistoryState(thread, threadStatus), allFilesComplete, safeCodexError(thread.Error), snapshot.AsOf); err != nil {
			return fmt.Errorf("finalize Codex thread snapshot: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE codex_threads AS codex
			SET bound_task_id = task.id,
				bound_session_id = session.id,
				updated_at = GREATEST(codex.updated_at, session.updated_at)
			FROM execution_sessions AS session
			LEFT JOIN tasks AS task ON task.session_id = session.id
			WHERE codex.host_id = $1
			  AND codex.thread_id = $2
			  AND session.host_id = $1
			  AND session.external_thread_ref = $2
			  AND session.creation_state = 'confirmed'
			  AND codex.source_kind = 'main'
			  AND codex.source_status = 'active'
			  AND codex.history_state = 'complete'
			  AND codex.files_complete
			  AND (codex.bound_task_id IS NULL OR codex.bound_task_id = task.id)
			  AND (codex.bound_session_id IS NULL OR codex.bound_session_id = session.id)
			  AND (task.id IS NULL OR NOT EXISTS (
				  SELECT 1 FROM codex_threads AS other
				  WHERE other.bound_task_id = task.id
					AND (other.host_id <> codex.host_id OR other.thread_id <> codex.thread_id)
			  ))
			  AND NOT EXISTS (
				  SELECT 1 FROM codex_thread_links AS link WHERE link.session_id = session.id
			  )
			  AND NOT EXISTS (
				  SELECT 1 FROM codex_threads AS other
				  WHERE other.bound_session_id = session.id
					AND (other.host_id <> codex.host_id OR other.thread_id <> codex.thread_id)
			  )
		`, hostID, threadID); err != nil {
			return fmt.Errorf("reconcile Codex thread identity with Session: %w", err)
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
		`, threadSnapshotID, hostID, threadID, threadStatus.State, threadComplete, snapshot.AsOf, safeCodexError(thread.Error)); err != nil {
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
		UPDATE codex_title_operations
		SET state = 'title_sync_paused', last_error = CASE WHEN NULLIF(trim($2), '') IS NOT NULL THEN $2 ELSE last_error END, updated_at = $3
		WHERE host_id = $1 AND state = 'title_sync_pending'
		  AND EXISTS (
			SELECT 1 FROM codex_threads t
			WHERE t.host_id = codex_title_operations.host_id
			  AND t.thread_id = codex_title_operations.thread_id
			  AND t.source_status <> 'active'
		  )
	`, hostID, safeCodexError(snapshot.Error), snapshot.AsOf); err != nil {
		return fmt.Errorf("pause unavailable Codex title operations: %w", err)
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
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.replayPendingSourceEvents(hostID)
	return nil
}

// recoverySnapshotAllowed accepts a verified recovery snapshot after a Server
// restart even when the Host connection itself stayed online. The active sync
// operation remains fenced; only a source that is not currently syncing may be
// replaced by the new Connector generation.
func recoverySnapshotAllowed(recovery bool, hostStatus, syncState string) bool {
	return recovery && hostStatus == "online" && syncState != string(protocol.CodexSyncStateSyncing)
}

func (s *Service) FailSync(ctx context.Context, hostID, operationID string, syncErr error) error {
	hostID = strings.TrimSpace(hostID)
	operationID = strings.TrimSpace(operationID)
	if hostID == "" || operationID == "" {
		return ErrInvalid
	}
	reason := "Codex source synchronization failed"
	if syncErr != nil && strings.TrimSpace(syncErr.Error()) != "" {
		reason = safeCodexError(syncErr.Error())
	}
	now := s.now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `
		UPDATE codex_sync_sources
		SET sync_state = 'failed', sync_operation_id = $2, last_error = $3, as_of = $4, updated_at = $4
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

// lockImportBindingRows follows the Session -> Task lock order used by Bind
// and Session activation before the import takes the Host and Codex locks. All
// Sessions are locked before any Task so a multi-thread import cannot form a
// Session/Task wait cycle with a concurrent single-thread binding.
func lockImportBindingRows(ctx context.Context, tx pgx.Tx, hostID string, threadIDs []string) error {
	sessionIDs := make([]string, 0, len(threadIDs))
	for _, threadID := range threadIDs {
		var sessionID string
		if err := tx.QueryRow(ctx, `
			SELECT session.id
			FROM execution_sessions AS session
			WHERE session.host_id = $1 AND session.external_thread_ref = $2
			ORDER BY session.id
			FOR UPDATE OF session
		`, hostID, threadID).Scan(&sessionID); errors.Is(err, pgx.ErrNoRows) {
			continue
		} else if err != nil {
			return fmt.Errorf("lock Codex binding Session: %w", err)
		}
		sessionIDs = append(sessionIDs, sessionID)
	}
	sort.Strings(sessionIDs)
	for _, sessionID := range sessionIDs {
		var taskID string
		if err := tx.QueryRow(ctx, `
			SELECT task.id
			FROM tasks AS task
			WHERE task.session_id = $1
			ORDER BY task.id
			FOR UPDATE OF task
		`, sessionID).Scan(&taskID); errors.Is(err, pgx.ErrNoRows) {
			continue
		} else if err != nil {
			return fmt.Errorf("lock Codex binding Task: %w", err)
		}
	}
	return nil
}

// ReconcileSyncOperations closes the in-memory runner gap after a Server
// restart. A process cannot resume a goroutine that owned a syncing snapshot,
// so those rows become explicitly stale and can be requested again.
func (s *Service) ReconcileSyncOperations(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return ErrInvalid
	}
	now := s.now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Codex sync recovery: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		UPDATE codex_sync_snapshots
		SET state = 'stale', complete = FALSE, error = 'Codex synchronization was interrupted by a Server restart', updated_at = $1
		WHERE state = 'syncing'
	`, now); err != nil {
		return fmt.Errorf("stale Codex sync snapshots: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE codex_sync_sources
		SET sync_state = 'stale', last_error = 'Codex synchronization was interrupted by a Server restart', updated_at = $1
		WHERE sync_state = 'syncing'
	`, now); err != nil {
		return fmt.Errorf("stale Codex sync sources: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE codex_title_operations
		SET state = 'title_sync_failed', attempts = attempts + 1,
			last_error = 'Codex title synchronization was interrupted by a Server restart',
			next_retry_at = NULL, updated_at = $1
		WHERE state = 'title_sync_pending'
	`, now); err != nil {
		return fmt.Errorf("fail interrupted Codex title operations: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE codex_threads
		SET title_sync_state = 'failed',
			title_sync_error = 'Codex title synchronization was interrupted by a Server restart',
			updated_at = $1
		WHERE title_sync_state = 'pending'
		  AND title_operation_id <> ''
		  AND NOT EXISTS (
			SELECT 1 FROM codex_title_operations o
			WHERE o.operation_id = codex_threads.title_operation_id
			  AND o.state = 'title_sync_pending'
		  )
	`, now); err != nil {
		return fmt.Errorf("fail interrupted Codex thread titles: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE codex_source_events
		SET state = 'pending', last_error = 'Codex source event processing was interrupted by a Server restart', updated_at = $1
		WHERE state = 'processing'
	`, now); err != nil {
		return fmt.Errorf("reopen Codex source events: %w", err)
	}
	return tx.Commit(ctx)
}

func sameFileMaterial(existingContentType string, existingSize int64, existingSHA string, existingContent []byte, existingRef string, incoming protocol.CodexSourceFileMaterial) bool {
	contentType := strings.TrimSpace(incoming.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return existingContentType == contentType &&
		existingSize == incoming.Size &&
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
	return snapshotStatus{State: state, Complete: complete, Error: safeCodexError(snapshot.Error)}
}

func threadSnapshotStatus(thread protocol.CodexSourceThreadSnapshot) snapshotStatus {
	state := protocol.CodexSyncStateComplete
	if thread.HistoryState != protocol.CodexHistoryStateComplete || !filesCompleteForThread(thread) {
		state = protocol.CodexSyncStatePartial
	}
	if strings.TrimSpace(thread.Error) != "" {
		state = protocol.CodexSyncStateFailed
	}
	return snapshotStatus{State: state, Complete: state == protocol.CodexSyncStateComplete, Error: safeCodexError(thread.Error)}
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
	if status.State == protocol.CodexSyncStateFailed {
		return protocol.CodexHistoryStateFailed
	}
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

func normalizeSourceKind(value protocol.CodexThreadSourceKind) (protocol.CodexThreadSourceKind, error) {
	if value == "" || value == protocol.CodexThreadSourceKindMain {
		return protocol.CodexThreadSourceKindMain, nil
	}
	if value == protocol.CodexThreadSourceKindSubagent {
		return value, nil
	}
	return "", ErrInvalid
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
