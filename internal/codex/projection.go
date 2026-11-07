package codex

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type conversationScanner interface {
	Scan(dest ...any) error
}

func scanConversation(rows conversationScanner) (protocol.CodexConversation, []byte, *string, time.Time, string, error) {
	var item protocol.CodexConversation
	var projectID, projectName, cwd, codexTitle, titleError, conflictCodex, boundTask, boundSession, taskProjectID *string
	var sourceKind, sourceStatus, historyState, titleState string
	var conflictAt *time.Time
	var asOf, updatedAt, activity time.Time
	var capabilities []byte
	var sourceState string
	if err := rows.Scan(
		&item.HostID, &item.ThreadID, &projectID, &projectName, &item.ConversationTitle, &codexTitle,
		&item.Preview, &cwd, &sourceKind, &sourceStatus, &historyState, &item.FilesComplete,
		&titleState, &titleError, &conflictCodex, &conflictAt, &boundTask, &boundSession,
		&asOf, &updatedAt, &activity, &capabilities, &taskProjectID, &sourceState,
	); err != nil {
		return protocol.CodexConversation{}, nil, nil, time.Time{}, "", fmt.Errorf("scan Codex conversation: %w", err)
	}
	item.ProjectID = projectID
	item.ProjectName = projectName
	item.Cwd = cwd
	item.CodexTitle = codexTitle
	item.SourceKind = protocol.CodexThreadSourceKind(sourceKind)
	item.SourceStatus = protocol.CodexSourceStatus(sourceStatus)
	item.HistoryState = protocol.CodexHistoryState(historyState)
	item.TitleSyncState = protocol.CodexTitleSyncState(titleState)
	item.TitleSyncError = titleError
	item.BoundTaskID = boundTask
	item.BoundSessionID = boundSession
	item.AsOf = formatTime(asOf)
	item.UpdatedAt = formatTime(updatedAt)
	if conflictCodex != nil && conflictAt != nil {
		item.TitleConflict = &protocol.CodexTitleConflict{
			CodexTitle:    *conflictCodex,
			LoomhelmTitle: item.ConversationTitle,
			DetectedAt:    formatTime(*conflictAt),
		}
	}
	return item, capabilities, taskProjectID, activity, sourceState, nil
}

func (s *Service) readConversation(ctx context.Context, access sourceAccess, principal auth.Principal, threadID string) (protocol.CodexConversation, []byte, *string, time.Time, string, error) {
	var item protocol.CodexConversation
	var projectID, projectName, cwd, codexTitle, titleError, conflictCodex, boundTask, boundSession, taskProjectID, importedBy *string
	var sourceKind, sourceStatus, historyState, titleState string
	var conflictAt *time.Time
	var asOf, updatedAt, activity time.Time
	var capabilities []byte
	var sourceState string
	err := s.pool.QueryRow(ctx, `
		SELECT t.host_id, t.thread_id, t.project_id, cp.name, t.conversation_title, t.codex_title,
		       t.preview, t.cwd, t.source_kind, t.source_status, t.history_state, t.files_complete,
		       t.title_sync_state, t.title_sync_error, t.title_conflict_codex_title, t.title_conflict_detected_at,
		       t.bound_task_id, t.bound_session_id, t.imported_by, t.as_of, t.updated_at, t.last_activity_at,
		       COALESCE(src.capabilities, '[]'::jsonb), task.project_id, COALESCE(src.state, 'offline')
		FROM codex_threads t
		LEFT JOIN codex_projects cp ON cp.host_id = t.host_id AND cp.project_id = t.project_id
		LEFT JOIN tasks task ON task.id = t.bound_task_id
		LEFT JOIN codex_sync_sources src ON src.host_id = t.host_id
		WHERE t.host_id = $1 AND t.thread_id = $2
	`, access.host.ID, threadID).Scan(
		&item.HostID, &item.ThreadID, &projectID, &projectName, &item.ConversationTitle, &codexTitle,
		&item.Preview, &cwd, &sourceKind, &sourceStatus, &historyState, &item.FilesComplete,
		&titleState, &titleError, &conflictCodex, &conflictAt, &boundTask, &boundSession, &importedBy,
		&asOf, &updatedAt, &activity, &capabilities, &taskProjectID, &sourceState,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return protocol.CodexConversation{}, nil, nil, time.Time{}, "", ErrNotFound
	}
	if err != nil {
		return protocol.CodexConversation{}, nil, nil, time.Time{}, "", fmt.Errorf("read Codex conversation: %w", err)
	}
	if importedBy == nil {
		return protocol.CodexConversation{}, nil, nil, time.Time{}, "", auth.ErrNotFound
	}
	if *importedBy != principal.UserID || access.restricted {
		if boundTask == nil || taskProjectID == nil {
			return protocol.CodexConversation{}, nil, nil, time.Time{}, "", auth.ErrNotFound
		}
		allowed, authorizeErr := s.projects.CanReadProject(ctx, principal, *taskProjectID)
		if authorizeErr != nil {
			return protocol.CodexConversation{}, nil, nil, time.Time{}, "", authorizeErr
		}
		if !allowed {
			return protocol.CodexConversation{}, nil, nil, time.Time{}, "", auth.ErrNotFound
		}
	}
	item.ProjectID = projectID
	item.ProjectName = projectName
	item.Cwd = cwd
	item.CodexTitle = codexTitle
	item.SourceKind = protocol.CodexThreadSourceKind(sourceKind)
	item.SourceStatus = protocol.CodexSourceStatus(sourceStatus)
	item.HistoryState = protocol.CodexHistoryState(historyState)
	item.TitleSyncState = protocol.CodexTitleSyncState(titleState)
	item.TitleSyncError = titleError
	item.BoundTaskID = boundTask
	item.BoundSessionID = boundSession
	item.AsOf = formatTime(asOf)
	item.UpdatedAt = formatTime(updatedAt)
	if conflictCodex != nil && conflictAt != nil {
		item.TitleConflict = &protocol.CodexTitleConflict{CodexTitle: *conflictCodex, LoomhelmTitle: item.ConversationTitle, DetectedAt: formatTime(*conflictAt)}
	}
	return item, capabilities, taskProjectID, activity, sourceState, nil
}

func (s *Service) readProjectedConversation(ctx context.Context, access sourceAccess, principal auth.Principal, threadID string) (protocol.CodexConversation, error) {
	item, capabilities, taskProjectID, _, sourceState, err := s.readConversation(ctx, access, principal, threadID)
	if err != nil {
		return protocol.CodexConversation{}, err
	}
	item.ReadOnly = true
	item.CanEditTitle = boolPointer(false)
	if item.SourceKind == protocol.CodexThreadSourceKindMain && item.BoundTaskID != nil && taskProjectID != nil && sourceState == string(protocol.CodexSourceStateOnline) && item.SourceStatus == protocol.CodexSourceStatusActive && item.HistoryState == protocol.CodexHistoryStateComplete && item.FilesComplete && capabilityContains(capabilities, "thread/name/set") {
		allowed, authorizeErr := s.projects.CanWriteProject(ctx, principal, *taskProjectID)
		if authorizeErr != nil {
			return protocol.CodexConversation{}, authorizeErr
		}
		item.ReadOnly = !allowed
		item.CanEditTitle = boolPointer(allowed)
	}
	return item, nil
}

func (s *Service) readProject(ctx context.Context, hostID, projectID string) (protocol.CodexProject, error) {
	var project protocol.CodexProject
	var cwd, mapping *string
	if err := s.pool.QueryRow(ctx, `
		SELECT host_id, project_id, name, cwd, loomhelm_project_id, snapshot_state, as_of
		FROM codex_projects WHERE host_id = $1 AND project_id = $2
	`, hostID, projectID).Scan(&project.HostID, &project.ProjectID, &project.Name, &cwd, &mapping, &project.SnapshotState, &project.AsOf); errors.Is(err, pgx.ErrNoRows) {
		return protocol.CodexProject{}, ErrNotFound
	} else if err != nil {
		return protocol.CodexProject{}, err
	}
	project.Cwd, project.LoomhelmProjectID = cwd, mapping
	return project, nil
}

func (s *Service) readHistory(ctx context.Context, hostID, threadID string) ([]protocol.CodexHistoryEvent, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT event_id, sequence, event_type, raw_payload, readable_fallback, occurred_at
		FROM codex_thread_history WHERE host_id = $1 AND thread_id = $2 ORDER BY sequence, event_id
	`, hostID, threadID)
	if err != nil {
		return nil, fmt.Errorf("read Codex history: %w", err)
	}
	defer rows.Close()
	items := make([]protocol.CodexHistoryEvent, 0)
	for rows.Next() {
		var event protocol.CodexHistoryEvent
		var raw string
		var occurredAt time.Time
		if err := rows.Scan(&event.EventID, &event.Sequence, &event.EventType, &raw, &event.ReadableFallback, &occurredAt); err != nil {
			return nil, fmt.Errorf("scan Codex history: %w", err)
		}
		event.OccurredAt = formatTime(occurredAt)
		if json.Valid([]byte(raw)) {
			event.RawPayload = json.RawMessage(raw)
		} else {
			encoded, _ := json.Marshal(raw)
			event.RawPayload = json.RawMessage(encoded)
		}
		items = append(items, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read Codex history rows: %w", err)
	}
	return items, nil
}

func (s *Service) readFiles(ctx context.Context, hostID, threadID string) ([]protocol.CodexFileMaterial, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT path, content_type, size, sha256, content_ref, complete
		FROM codex_thread_files WHERE host_id = $1 AND thread_id = $2 ORDER BY path
	`, hostID, threadID)
	if err != nil {
		return nil, fmt.Errorf("read Codex files: %w", err)
	}
	defer rows.Close()
	items := make([]protocol.CodexFileMaterial, 0)
	for rows.Next() {
		var item protocol.CodexFileMaterial
		var contentRef sql.NullString
		if err := rows.Scan(&item.Path, &item.ContentType, &item.Size, &item.Sha256, &contentRef, &item.Complete); err != nil {
			return nil, fmt.Errorf("scan Codex file: %w", err)
		}
		if contentRef.Valid && contentRef.String != "" {
			item.ContentRef = &contentRef.String
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read Codex file rows: %w", err)
	}
	return items, nil
}
