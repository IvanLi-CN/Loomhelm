// Package codex owns Host-scoped Codex source snapshots and the explicit
// boundary between source history, Loomhelm conversations and Task bindings.
package codex

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid               = errors.New("invalid Codex source request")
	ErrNotFound              = errors.New("Codex source conversation not found")
	ErrForbidden             = errors.New("Codex source operation is not authorized")
	ErrConflict              = errors.New("Codex source state conflicts with the request")
	ErrIncompleteHistory     = errors.New("Codex conversation history is incomplete")
	ErrCapabilityUnsupported = errors.New("Codex capability is unsupported")
	ErrSourceUnavailable     = errors.New("Codex source is unavailable")
)

const (
	defaultPageSize      = 50
	maxPageSize          = 200
	maxTitleLength       = 300
	defaultFileChunkSize = 64 << 10
	maxFileChunkSize     = 1 << 20
)

type Config struct {
	Now         func() time.Time
	TitleWriter TitleWriter
	SyncRunner  SyncRunner
}

// TitleWriter is implemented by the Connector bridge. A nil writer is
// intentional: the server still persists a pending operation and exposes it
// to the caller instead of claiming a remote Codex write succeeded.
type TitleWriter interface {
	SetTitle(context.Context, string, string, string) error
}

type operationTitleWriter interface {
	SetTitleWithOperation(context.Context, string, string, string, string) error
}

type Service struct {
	pool        *pgxpool.Pool
	principal   auth.PrincipalResolver
	hosts       *hosts.Service
	projects    *projects.Service
	now         func() time.Time
	titleWriter TitleWriter
	syncRunner  SyncRunner
}

func NewService(pool *pgxpool.Pool, principal auth.PrincipalResolver, registry *hosts.Service, projectService *projects.Service, configs ...Config) *Service {
	cfg := Config{Now: time.Now}
	if len(configs) > 0 {
		if configs[0].Now != nil {
			cfg.Now = configs[0].Now
		}
		cfg.TitleWriter = configs[0].TitleWriter
		cfg.SyncRunner = configs[0].SyncRunner
	}
	return &Service{pool: pool, principal: principal, hosts: registry, projects: projectService, now: cfg.Now, titleWriter: cfg.TitleWriter, syncRunner: cfg.SyncRunner}
}

// SetTitleWriter is called during application composition, after the
// authenticated Host gateway is ready. Keeping this setter at the boundary
// avoids giving the REST service direct access to Connector internals.
func (s *Service) SetTitleWriter(writer TitleWriter) {
	if s != nil {
		s.titleWriter = writer
	}
}

type sourceAccess struct {
	host       hosts.Host
	owner      bool
	restricted bool
	principal  auth.Principal
}

func (s *Service) defaultHost(ctx context.Context, principal auth.Principal, hostID string) (sourceAccess, error) {
	if principal.UserID == "" {
		return sourceAccess{}, auth.ErrUnauthenticated
	}
	if s == nil || s.pool == nil || s.hosts == nil {
		return sourceAccess{}, auth.ErrUnavailable
	}
	if strings.TrimSpace(hostID) == "" {
		host, err := s.hosts.ConfiguredHostForUser(ctx, principal.UserID)
		if errors.Is(err, hosts.ErrNotFound) {
			return sourceAccess{}, auth.ErrNotFound
		}
		if err != nil {
			return sourceAccess{}, fmt.Errorf("resolve default Host: %w", err)
		}
		owner := host.OwnerUserID == principal.UserID && len(principal.ProjectScope) == 0
		return sourceAccess{host: host, owner: owner, restricted: len(principal.ProjectScope) > 0, principal: principal}, nil
	}
	host, err := s.hosts.GetHost(ctx, strings.TrimSpace(hostID))
	if errors.Is(err, hosts.ErrNotFound) {
		return sourceAccess{}, auth.ErrNotFound
	}
	if err != nil {
		return sourceAccess{}, fmt.Errorf("read Codex Host: %w", err)
	}
	if err := s.hosts.AuthorizeUser(ctx, principal.UserID, host.ID); err != nil {
		if errors.Is(err, hosts.ErrForbidden) || errors.Is(err, hosts.ErrNotFound) {
			return sourceAccess{}, auth.ErrNotFound
		}
		return sourceAccess{}, fmt.Errorf("authorize Codex Host: %w", err)
	}
	owner := host.OwnerUserID == principal.UserID && len(principal.ProjectScope) == 0
	return sourceAccess{host: host, owner: owner, restricted: len(principal.ProjectScope) > 0, principal: principal}, nil
}

func (s *Service) principalForRequest(request *http.Request) (auth.Principal, error) {
	if s == nil || s.principal == nil {
		return auth.Principal{}, auth.ErrUnavailable
	}
	principal, err := s.principal.ResolvePrincipal(request.Context(), request)
	if err != nil {
		return auth.Principal{}, err
	}
	if principal.UserID == "" {
		return auth.Principal{}, auth.ErrUnauthenticated
	}
	return principal, nil
}

func (s *Service) Mount(router chi.Router) {
	router.Get("/codex/sources", s.handleListSources)
	router.Get("/codex/projects", s.handleListProjects)
	router.Get("/codex/conversations", s.handleListConversations)
	router.Get("/codex/conversations/{host_id}/{thread_id}", s.handleGetConversation)
	router.Get("/codex/conversations/{host_id}/{thread_id}/file", s.handleGetConversationFile)
	router.Patch("/codex/conversations/{host_id}/{thread_id}/title", s.handleUpdateTitle)
	router.Post("/codex/projects/{host_id}/{project_id}/mapping", s.handleMapProject)
	router.Post("/codex/conversations/{host_id}/{thread_id}/bind", s.handleBind)
	router.Post("/codex/sync", s.handleSync)
}

type UpsertSourceInput struct {
	HostID           string
	State            protocol.CodexSourceState
	SyncState        protocol.CodexSyncState
	Build            string
	ProtocolVersion  string
	Capabilities     []string
	CapabilityStates map[string]string
	LastError        string
}

func (s *Service) UpsertSource(ctx context.Context, input UpsertSourceInput) error {
	if strings.TrimSpace(input.HostID) == "" {
		return ErrInvalid
	}
	capabilities, err := json.Marshal(uniqueStrings(input.Capabilities))
	if err != nil {
		return fmt.Errorf("encode Codex capabilities: %w", err)
	}
	capabilityStates, err := json.Marshal(input.CapabilityStates)
	if err != nil {
		return fmt.Errorf("encode Codex capability states: %w", err)
	}
	if input.CapabilityStates == nil {
		capabilityStates = []byte(`{}`)
	}
	if input.State == "" {
		input.State = protocol.CodexSourceStateOffline
	}
	input.State = sourceStateOrDefault(input.State)
	if input.SyncState == "" {
		input.SyncState = protocol.CodexSyncStateNever
	}
	if !validSyncState(input.SyncState) {
		input.SyncState = protocol.CodexSyncStatePartial
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO codex_sync_sources (host_id, state, sync_state, build, protocol_version, capabilities, capability_states, as_of, last_error, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $8)
		ON CONFLICT (host_id) DO UPDATE SET
			state = EXCLUDED.state,
			sync_state = EXCLUDED.sync_state,
			build = EXCLUDED.build,
			protocol_version = EXCLUDED.protocol_version,
			capabilities = EXCLUDED.capabilities,
			capability_states = EXCLUDED.capability_states,
			as_of = EXCLUDED.as_of,
			last_error = EXCLUDED.last_error,
			updated_at = EXCLUDED.updated_at
	`, input.HostID, input.State, input.SyncState, strings.TrimSpace(input.Build), strings.TrimSpace(input.ProtocolVersion), capabilities, capabilityStates, s.now(), strings.TrimSpace(input.LastError))
	return err
}

type UpsertProjectInput struct {
	HostID          string
	ProjectID       string
	Name            string
	CWD             string
	SnapshotState   protocol.CodexSyncState
	LoomhelmProject *string
}

func (s *Service) UpsertProject(ctx context.Context, input UpsertProjectInput) error {
	if strings.TrimSpace(input.HostID) == "" || strings.TrimSpace(input.ProjectID) == "" {
		return ErrInvalid
	}
	if input.SnapshotState == "" {
		input.SnapshotState = protocol.CodexSyncStateComplete
	}
	if !validSyncState(input.SnapshotState) {
		input.SnapshotState = protocol.CodexSyncStatePartial
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO codex_projects (host_id, project_id, name, cwd, loomhelm_project_id, snapshot_state, as_of, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
		ON CONFLICT (host_id, project_id) DO UPDATE SET
			name = EXCLUDED.name,
			cwd = EXCLUDED.cwd,
			loomhelm_project_id = COALESCE(EXCLUDED.loomhelm_project_id, codex_projects.loomhelm_project_id),
			snapshot_state = EXCLUDED.snapshot_state,
			as_of = EXCLUDED.as_of,
			updated_at = EXCLUDED.updated_at
	`, input.HostID, input.ProjectID, strings.TrimSpace(input.Name), strings.TrimSpace(input.CWD), input.LoomhelmProject, input.SnapshotState, s.now())
	return err
}

type UpsertThreadInput struct {
	HostID         string
	ThreadID       string
	ProjectID      *string
	ParentThreadID *string
	SourceKind     protocol.CodexThreadSourceKind
	CodexTitle     *string
	Preview        string
	CWD            string
	SourceStatus   protocol.CodexSourceStatus
	HistoryState   protocol.CodexHistoryState
	FilesComplete  bool
	ImportedBy     string
	LastActivityAt time.Time
}

func (s *Service) UpsertThread(ctx context.Context, input UpsertThreadInput) error {
	if strings.TrimSpace(input.HostID) == "" || strings.TrimSpace(input.ThreadID) == "" {
		return ErrInvalid
	}
	normalizedSourceKind, err := normalizeSourceKind(input.SourceKind)
	if err != nil {
		return err
	}
	input.SourceKind = normalizedSourceKind
	if input.SourceStatus == "" {
		input.SourceStatus = protocol.CodexSourceStatusActive
	}
	input.SourceStatus = sourceStatusOrDefault(input.SourceStatus)
	if input.HistoryState == "" {
		input.HistoryState = protocol.CodexHistoryStatePending
	}
	if !validHistoryState(input.HistoryState) {
		input.HistoryState = protocol.CodexHistoryStatePartial
	}
	if input.LastActivityAt.IsZero() {
		input.LastActivityAt = s.now()
	}
	importedBy := strings.TrimSpace(input.ImportedBy)
	if importedBy == "" {
		if err := s.pool.QueryRow(ctx, `SELECT COALESCE(owner_user_id, '') FROM host_registrations WHERE id = $1`, input.HostID).Scan(&importedBy); err != nil {
			return fmt.Errorf("resolve Codex importer: %w", err)
		}
	}
	conversationTitle := strings.TrimSpace(valueOrEmpty(input.CodexTitle))
	if conversationTitle == "" {
		conversationTitle = strings.TrimSpace(input.Preview)
	}
	if conversationTitle == "" {
		conversationTitle = "自动标题"
	}
	titleState := protocol.CodexTitleSyncStateUnsupported
	if input.CodexTitle != nil && strings.TrimSpace(*input.CodexTitle) != "" {
		titleState = protocol.CodexTitleSyncStateSynced
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO codex_threads (
			host_id, thread_id, project_id, parent_thread_id, source_kind, codex_title,
			conversation_title, preview, cwd, source_status, history_state, files_complete,
			title_sync_state, imported_by, as_of, last_activity_at, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $15)
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
			updated_at = EXCLUDED.updated_at
	`, input.HostID, input.ThreadID, nullableString(input.ProjectID), nullableString(input.ParentThreadID), input.SourceKind, nullableString(input.CodexTitle), conversationTitle, strings.TrimSpace(input.Preview), strings.TrimSpace(input.CWD), input.SourceStatus, input.HistoryState, input.FilesComplete, titleState, nullableString(&importedBy), s.now(), input.LastActivityAt)
	return err
}

func (s *Service) AppendHistory(ctx context.Context, hostID, threadID, eventID string, sequence int64, eventType string, rawPayload json.RawMessage, readableFallback string, occurredAt time.Time) error {
	if strings.TrimSpace(hostID) == "" || strings.TrimSpace(threadID) == "" || strings.TrimSpace(eventID) == "" || sequence < 1 {
		return ErrInvalid
	}
	if occurredAt.IsZero() {
		occurredAt = s.now()
	}
	if len(rawPayload) == 0 {
		rawPayload = json.RawMessage(`null`)
	}
	if strings.TrimSpace(readableFallback) == "" {
		readableFallback = strings.TrimSpace(eventType)
		if readableFallback == "" {
			readableFallback = "未知 Codex 事件"
		}
	}
	inserted, err := s.pool.Exec(ctx, `
		INSERT INTO codex_thread_history (host_id, thread_id, event_id, sequence, event_type, raw_payload, readable_fallback, occurred_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (host_id, thread_id, event_id) DO NOTHING
	`, hostID, threadID, eventID, sequence, strings.TrimSpace(eventType), string(rawPayload), strings.TrimSpace(readableFallback), occurredAt)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrConflict
		}
		return fmt.Errorf("persist Codex history event: %w", err)
	}
	if inserted.RowsAffected() == 0 {
		var existingSequence int64
		var existingType, existingRaw, existingFallback string
		var existingOccurredAt time.Time
		if err := s.pool.QueryRow(ctx, `
			SELECT sequence, event_type, raw_payload, readable_fallback, occurred_at
			FROM codex_thread_history WHERE host_id = $1 AND thread_id = $2 AND event_id = $3
		`, hostID, threadID, eventID).Scan(&existingSequence, &existingType, &existingRaw, &existingFallback, &existingOccurredAt); err != nil {
			return fmt.Errorf("read existing Codex history event: %w", err)
		}
		if existingType != strings.TrimSpace(eventType) || existingRaw != string(rawPayload) || existingFallback != strings.TrimSpace(readableFallback) || !existingOccurredAt.Equal(occurredAt) {
			return ErrConflict
		}
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE codex_threads
		SET as_of = $3, updated_at = $3
		WHERE host_id = $1 AND thread_id = $2
	`, hostID, threadID, s.now())
	return err
}

// MarkHistoryState is called by the source adapter after the complete history
// transfer has been observed. Individual events must never make a snapshot
// projectable because a later transfer can still be interrupted.
func (s *Service) MarkHistoryState(ctx context.Context, hostID, threadID string, state protocol.CodexHistoryState, reason string) error {
	if strings.TrimSpace(hostID) == "" || strings.TrimSpace(threadID) == "" {
		return ErrInvalid
	}
	switch state {
	case protocol.CodexHistoryStatePending, protocol.CodexHistoryStatePartial, protocol.CodexHistoryStateComplete, protocol.CodexHistoryStateFailed:
	default:
		return ErrInvalid
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE codex_threads
		SET history_state = $3,
		    title_sync_error = CASE WHEN $3 IN ('failed', 'partial') AND NULLIF(trim($4), '') IS NOT NULL THEN $4 ELSE title_sync_error END,
		    updated_at = $5
		WHERE host_id = $1 AND thread_id = $2
	`, hostID, threadID, state, strings.TrimSpace(reason), s.now())
	return err
}

type FileInput struct {
	HostID      string
	ThreadID    string
	Path        string
	ContentType string
	Size        int64
	Sha256      string
	Content     []byte
	ContentRef  string
	Complete    bool
}

func (s *Service) UpsertFile(ctx context.Context, input FileInput) error {
	if strings.TrimSpace(input.HostID) == "" || strings.TrimSpace(input.ThreadID) == "" || strings.TrimSpace(input.Path) == "" || input.Size < 0 {
		return ErrInvalid
	}
	if strings.TrimSpace(input.Sha256) == "" && len(input.Content) > 0 {
		digest := sha256.Sum256(input.Content)
		input.Sha256 = hex.EncodeToString(digest[:])
	}
	if input.ContentType == "" {
		input.ContentType = "application/octet-stream"
	}
	path := strings.TrimSpace(input.Path)
	var existingType, existingSHA, existingRef string
	var existingSize int64
	var existingContent []byte
	var existingComplete bool
	readErr := s.pool.QueryRow(ctx, `
		SELECT content_type, size, sha256, content_bytes, content_ref, complete
		FROM codex_thread_files WHERE host_id = $1 AND thread_id = $2 AND path = $3
	`, input.HostID, input.ThreadID, path).Scan(&existingType, &existingSize, &existingSHA, &existingContent, &existingRef, &existingComplete)
	if readErr != nil && !errors.Is(readErr, pgx.ErrNoRows) {
		return fmt.Errorf("read existing Codex file material: %w", readErr)
	}
	if readErr == nil && existingComplete {
		if input.Complete && (existingType != input.ContentType || existingSize != input.Size || !strings.EqualFold(strings.TrimSpace(existingSHA), strings.TrimSpace(input.Sha256)) || !bytes.Equal(existingContent, input.Content) || strings.TrimSpace(existingRef) != strings.TrimSpace(input.ContentRef)) {
			return ErrConflict
		}
	} else {
		_, err := s.pool.Exec(ctx, `
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
		`, input.HostID, input.ThreadID, path, input.ContentType, input.Size, strings.TrimSpace(input.Sha256), input.Content, strings.TrimSpace(input.ContentRef), input.Complete, s.now())
		if err != nil {
			if isUniqueViolation(err) {
				return ErrConflict
			}
			return fmt.Errorf("persist Codex file material: %w", err)
		}
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE codex_threads
		SET files_complete = NOT EXISTS (
			SELECT 1 FROM codex_thread_files WHERE host_id = $1 AND thread_id = $2 AND complete = FALSE
		), updated_at = $3
		WHERE host_id = $1 AND thread_id = $2
	`, input.HostID, input.ThreadID, s.now())
	return err
}

func (s *Service) ApplyCodexTitle(ctx context.Context, hostID, threadID string, title string) error {
	title = strings.TrimSpace(title)
	if title == "" {
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Codex title notification: %w", err)
	}
	defer tx.Rollback(ctx)
	var localTitle, state, sourceStatus, titleOperationID string
	if err := tx.QueryRow(ctx, `SELECT conversation_title, title_sync_state, source_status, title_operation_id FROM codex_threads WHERE host_id = $1 AND thread_id = $2 FOR UPDATE`, hostID, threadID).Scan(&localTitle, &state, &sourceStatus, &titleOperationID); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return fmt.Errorf("read Codex title state: %w", err)
	}
	now := s.now()
	if localTitle == title {
		nextState := "synced"
		if sourceStatus != string(protocol.CodexSourceStatusActive) {
			nextState = "paused"
		}
		_, err = tx.Exec(ctx, `UPDATE codex_threads SET codex_title = $3, title_sync_state = $4, title_sync_error = CASE WHEN $4 = 'paused' THEN title_sync_error ELSE '' END, title_conflict_codex_title = NULL, title_conflict_detected_at = NULL, title_operation_id = CASE WHEN $4 = 'synced' THEN '' ELSE title_operation_id END, updated_at = $5 WHERE host_id = $1 AND thread_id = $2`, hostID, threadID, title, nextState, now)
		if err == nil && titleOperationID != "" {
			operationState := "title_sync_complete"
			if nextState == "paused" {
				operationState = "title_sync_paused"
			}
			_, err = tx.Exec(ctx, `UPDATE codex_title_operations SET state = $2, attempts = attempts + 1, updated_at = $3 WHERE operation_id = $1 AND state = 'title_sync_pending' AND desired_title = $4`, titleOperationID, operationState, now, title)
		}
	} else if state == string(protocol.CodexTitleSyncStatePending) || state == string(protocol.CodexTitleSyncStateFailed) || state == string(protocol.CodexTitleSyncStateConflict) {
		_, err = tx.Exec(ctx, `UPDATE codex_threads SET codex_title = $3, title_sync_state = 'conflict', title_conflict_codex_title = $3, title_conflict_detected_at = $4, updated_at = $4 WHERE host_id = $1 AND thread_id = $2`, hostID, threadID, title, now)
		if err == nil && titleOperationID != "" {
			_, err = tx.Exec(ctx, `UPDATE codex_title_operations SET state = 'title_sync_conflict', last_error = 'Codex title changed before local acknowledgement', updated_at = $2 WHERE operation_id = $1 AND state = 'title_sync_pending'`, titleOperationID, now)
		}
	} else {
		_, err = tx.Exec(ctx, `UPDATE codex_threads SET codex_title = $3, title_sync_state = 'conflict', title_conflict_codex_title = $3, title_conflict_detected_at = $4, updated_at = $4 WHERE host_id = $1 AND thread_id = $2`, hostID, threadID, title, now)
	}
	if err != nil {
		return fmt.Errorf("apply Codex title notification: %w", err)
	}
	return tx.Commit(ctx)
}

func (s *Service) MarkSourceStatus(ctx context.Context, hostID, threadID string, status protocol.CodexSourceStatus, reason string) error {
	if strings.TrimSpace(hostID) == "" || strings.TrimSpace(threadID) == "" {
		return ErrInvalid
	}
	switch status {
	case protocol.CodexSourceStatusActive, protocol.CodexSourceStatusArchived, protocol.CodexSourceStatusDeleted, protocol.CodexSourceStatusUnavailable:
	default:
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Codex source status update: %w", err)
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `
		UPDATE codex_threads
		SET source_status = $3,
		    title_sync_state = CASE WHEN $3 = 'active' THEN title_sync_state ELSE 'paused' END,
		    title_sync_error = CASE WHEN $3 = 'active' THEN title_sync_error ELSE $4 END,
		    updated_at = $5
		WHERE host_id = $1 AND thread_id = $2
	`, hostID, threadID, status, strings.TrimSpace(reason), s.now())
	if err == nil && result.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if status != protocol.CodexSourceStatusActive {
		if _, err := tx.Exec(ctx, `
			UPDATE codex_title_operations
			SET state = 'title_sync_paused', last_error = $3, updated_at = $4
			WHERE host_id = $1 AND thread_id = $2 AND state = 'title_sync_pending'
		`, hostID, threadID, strings.TrimSpace(reason), s.now()); err != nil {
			return fmt.Errorf("pause Codex title operation: %w", err)
		}
	}
	return tx.Commit(ctx)
}

func (s *Service) ListSources(ctx context.Context, principal auth.Principal) (protocol.CodexSourceListResponse, error) {
	access, err := s.defaultHost(ctx, principal, "")
	if errors.Is(err, auth.ErrNotFound) {
		return protocol.CodexSourceListResponse{Items: []protocol.CodexSource{}}, nil
	}
	if err != nil {
		return protocol.CodexSourceListResponse{}, err
	}
	var source protocol.CodexSource
	var state, syncState, build, version, lastError string
	var capabilities, capabilityStates []byte
	var asOf time.Time
	err = s.pool.QueryRow(ctx, `
		SELECT COALESCE(s.state, CASE WHEN h.status = 'online' THEN 'online' ELSE 'offline' END),
		       COALESCE(s.sync_state, 'never'), COALESCE(s.build, ''), COALESCE(s.protocol_version, ''),
		       COALESCE(s.capabilities, '[]'::jsonb), COALESCE(s.capability_states, '{}'::jsonb), COALESCE(s.as_of, h.updated_at), COALESCE(s.last_error, '')
		FROM host_registrations h
		LEFT JOIN codex_sync_sources s ON s.host_id = h.id
		WHERE h.id = $1
	`, access.host.ID).Scan(&state, &syncState, &build, &version, &capabilities, &capabilityStates, &asOf, &lastError)
	if err != nil {
		return protocol.CodexSourceListResponse{}, fmt.Errorf("read Codex source: %w", err)
	}
	_ = json.Unmarshal(capabilities, &source.Capabilities)
	if source.CapabilityStates == nil {
		source.CapabilityStates = make(map[string]any)
	}
	_ = json.Unmarshal(capabilityStates, &source.CapabilityStates)
	source.HostID = access.host.ID
	source.HostName = access.host.Name
	source.State = protocol.CodexSourceState(state)
	source.SyncState = protocol.CodexSyncState(syncState)
	source.Build = build
	source.ProtocolVersion = nullableStringValue(version)
	source.AsOf = formatTime(asOf)
	source.LastError = nullableStringValue(lastError)
	return protocol.CodexSourceListResponse{Items: []protocol.CodexSource{source}}, nil
}

func (s *Service) ListProjects(ctx context.Context, principal auth.Principal, query protocol.ListCodexProjectsQuery) (protocol.CodexProjectListResponse, error) {
	access, err := s.defaultHost(ctx, principal, valueOrEmpty(query.HostID))
	if err != nil {
		return protocol.CodexProjectListResponse{}, err
	}
	limit := normalizeLimit(query.Limit)
	args := []any{access.host.ID}
	where := "WHERE p.host_id = $1"
	if !access.owner {
		args = append(args, principal.UserID)
		where += " AND p.loomhelm_project_id IS NOT NULL AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.loomhelm_project_id AND pm.user_id = $2)"
	}
	if len(principal.ProjectScope) > 0 {
		args = append(args, sortedProjectScopeValues(principal.ProjectScope))
		where += fmt.Sprintf(" AND p.loomhelm_project_id = ANY($%d::text[])", len(args))
	}
	if cursor := valueOrEmpty(query.AfterCursor); cursor != "" {
		args = append(args, cursor)
		where += fmt.Sprintf(" AND p.project_id > $%d", len(args))
	}
	args = append(args, limit+1)
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT p.host_id, p.project_id, p.name, p.cwd, p.loomhelm_project_id, p.snapshot_state, p.as_of
		FROM codex_projects p %s ORDER BY p.project_id LIMIT $%d
	`, where, len(args)), args...)
	if err != nil {
		return protocol.CodexProjectListResponse{}, fmt.Errorf("list Codex projects: %w", err)
	}
	defer rows.Close()
	items := make([]protocol.CodexProject, 0, limit)
	var next *string
	for rows.Next() {
		var item protocol.CodexProject
		var cwd, mapping *string
		if err := rows.Scan(&item.HostID, &item.ProjectID, &item.Name, &cwd, &mapping, &item.SnapshotState, &item.AsOf); err != nil {
			return protocol.CodexProjectListResponse{}, fmt.Errorf("scan Codex project: %w", err)
		}
		item.Cwd, item.LoomhelmProjectID = cwd, mapping
		if !access.owner {
			if item.LoomhelmProjectID == nil {
				continue
			}
			allowed, authorizeErr := s.projects.CanReadProject(ctx, principal, *item.LoomhelmProjectID)
			if authorizeErr != nil {
				return protocol.CodexProjectListResponse{}, authorizeErr
			}
			if !allowed {
				continue
			}
		}
		if len(items) == limit {
			cursor := item.ProjectID
			next = &cursor
			break
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return protocol.CodexProjectListResponse{}, fmt.Errorf("read Codex projects: %w", err)
	}
	return protocol.CodexProjectListResponse{Items: items, HasMore: next != nil, NextCursor: next}, nil
}

func (s *Service) ListConversations(ctx context.Context, principal auth.Principal, query protocol.ListCodexConversationsQuery) (protocol.CodexConversationListResponse, error) {
	access, err := s.defaultHost(ctx, principal, valueOrEmpty(query.HostID))
	if err != nil {
		return protocol.CodexConversationListResponse{}, err
	}
	limit := normalizeLimit(query.Limit)
	var asOf time.Time
	var sourceAvailability, syncState string
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(state, 'offline'), COALESCE(sync_state, 'never'), COALESCE(as_of, CURRENT_TIMESTAMP)
		FROM codex_sync_sources WHERE host_id = $1
	`, access.host.ID).Scan(&sourceAvailability, &syncState, &asOf); errors.Is(err, pgx.ErrNoRows) {
		sourceAvailability = string(protocol.CodexSourceStateOffline)
		syncState = string(protocol.CodexSyncStateNever)
		asOf = s.now()
	} else if err != nil {
		return protocol.CodexConversationListResponse{}, fmt.Errorf("read Codex source snapshot: %w", err)
	}
	args := []any{access.host.ID, principal.UserID}
	sessionProjectVisibility := `session.project_id IS NOT NULL`
	if len(principal.ProjectScope) > 0 {
		args = append(args, sortedProjectScopeValues(principal.ProjectScope))
		sessionProjectVisibility = fmt.Sprintf("session.project_id = ANY($%d::text[])", len(args))
	}
	taskVisibility := `t.bound_task_id IS NOT NULL AND t.history_state = 'complete' AND t.files_complete AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = task.project_id AND pm.user_id = $2)`
	if len(principal.ProjectScope) > 0 {
		taskVisibility += fmt.Sprintf(" AND task.project_id = ANY($%d::text[])", len(args))
	}
	sessionMembership := fmt.Sprintf(`%s AND EXISTS (
		SELECT 1 FROM project_members session_member
		WHERE session_member.project_id = session.project_id
		  AND session_member.user_id = $2
		  AND t.bound_session_id = session.id
		  AND t.history_state = 'complete'
		  AND t.files_complete
	)`, sessionProjectVisibility)
	sessionVisibility := fmt.Sprintf(`EXISTS (
		SELECT 1
		FROM execution_sessions AS session
		WHERE session.host_id = t.host_id
		  AND session.external_thread_ref = t.thread_id
		  AND session.creation_state = 'confirmed'
		  AND ((session.project_id IS NULL AND session.creator_user_id = $2) OR (%s))
	)`, sessionMembership)
	restrictedSessionVisibility := fmt.Sprintf(`EXISTS (
		SELECT 1
		FROM execution_sessions AS session
		WHERE session.host_id = t.host_id
		  AND session.external_thread_ref = t.thread_id
		  AND session.creation_state = 'confirmed'
		  AND %s
		  AND EXISTS (
			SELECT 1 FROM project_members session_member
			WHERE session_member.project_id = session.project_id
			  AND session_member.user_id = $2
			  AND t.bound_session_id = session.id
			  AND t.history_state = 'complete'
			  AND t.files_complete
		  )
	)`, sessionProjectVisibility)
	privateSessionVisibility := `NOT EXISTS (
		SELECT 1
		FROM execution_sessions AS private_session
		WHERE private_session.host_id = t.host_id
		  AND private_session.external_thread_ref = t.thread_id
		  AND private_session.creation_state = 'confirmed'
		  AND private_session.project_id IS NULL
		  AND private_session.creator_user_id IS DISTINCT FROM $2
	)`
	importedVisibility := `t.imported_by = $2 AND t.bound_task_id IS NULL AND NOT EXISTS (
		SELECT 1
		FROM execution_sessions AS imported_session
		WHERE imported_session.host_id = t.host_id
		  AND imported_session.external_thread_ref = t.thread_id
		  AND imported_session.creation_state = 'confirmed'
		  AND (imported_session.project_id IS NOT NULL OR imported_session.creator_user_id IS DISTINCT FROM $2)
	)`
	where := fmt.Sprintf(`WHERE t.host_id = $1 AND %s AND (%s OR %s)`, privateSessionVisibility, taskVisibility, restrictedSessionVisibility)
	if !access.restricted {
		where = fmt.Sprintf(`WHERE t.host_id = $1 AND %s AND (%s OR %s OR %s)`, privateSessionVisibility, importedVisibility, taskVisibility, sessionVisibility)
	}
	if !boolValue(query.IncludeArchived) {
		where += " AND t.source_status = 'active'"
	}
	if query.Bound != nil {
		if *query.Bound {
			where += " AND (t.bound_task_id IS NOT NULL OR t.bound_session_id IS NOT NULL)"
		} else {
			where += " AND t.source_kind = 'main' AND t.bound_task_id IS NULL AND t.bound_session_id IS NULL AND NOT EXISTS (SELECT 1 FROM execution_sessions session WHERE session.host_id = t.host_id AND session.external_thread_ref = t.thread_id)"
		}
	}
	if value := strings.TrimSpace(valueOrEmpty(query.ProjectID)); value != "" {
		args = append(args, value)
		where += fmt.Sprintf(" AND t.project_id = $%d", len(args))
	}
	if value := strings.TrimSpace(valueOrEmpty(query.LoomhelmProjectID)); value != "" {
		args = append(args, value)
		where += fmt.Sprintf(" AND cp.loomhelm_project_id = $%d", len(args))
	}
	if value := strings.TrimSpace(valueOrEmpty(query.Search)); value != "" {
		args = append(args, "%"+value+"%")
		where += fmt.Sprintf(" AND (t.conversation_title ILIKE $%d OR t.preview ILIKE $%d OR t.cwd ILIKE $%d)", len(args), len(args), len(args))
	}
	afterCursor := valueOrEmpty(query.AfterCursor)
	var cursor *conversationCursor
	if afterCursor != "" {
		cursor = decodeConversationCursor(afterCursor)
	}
	if afterCursor != "" && cursor == nil {
		return protocol.CodexConversationListResponse{}, ErrInvalid
	}
	snapshotAsOf := asOf
	if cursor != nil {
		if !cursor.SnapshotAsOf.IsZero() {
			snapshotAsOf = cursor.SnapshotAsOf
		}
	}
	items := make([]protocol.CodexConversation, 0, limit)
	var next *string
	var pageCursor = cursor
	var pageBoundary *conversationCursor
	for {
		pageArgs := append([]any(nil), args...)
		pageWhere := where
		if pageCursor != nil {
			pageArgs = append(pageArgs, pageCursor.UpdatedAt, pageCursor.ThreadID)
			pageWhere += fmt.Sprintf(" AND (t.last_activity_at, t.thread_id) < ($%d, $%d)", len(pageArgs)-1, len(pageArgs))
		}
		pageArgs = append(pageArgs, snapshotAsOf)
		pageWhere += fmt.Sprintf(" AND t.as_of <= $%d", len(pageArgs))
		pageArgs = append(pageArgs, limit+1)
		rows, queryErr := s.pool.Query(ctx, fmt.Sprintf(`
			SELECT t.host_id, t.thread_id, t.project_id, cp.name, t.conversation_title, t.codex_title,
			       t.preview, t.cwd, t.source_kind, t.source_status, t.history_state, t.files_complete,
			       t.title_sync_state, t.title_sync_error, t.title_conflict_codex_title, t.title_conflict_detected_at,
			       t.bound_task_id, t.bound_session_id, t.as_of, t.updated_at, t.last_activity_at,
			       COALESCE(src.capabilities, '[]'::jsonb), task.project_id, COALESCE(src.state, 'offline')
			FROM codex_threads t
			LEFT JOIN codex_projects cp ON cp.host_id = t.host_id AND cp.project_id = t.project_id
			LEFT JOIN tasks task ON task.id = t.bound_task_id
			LEFT JOIN codex_sync_sources src ON src.host_id = t.host_id
			%s
			ORDER BY t.last_activity_at DESC, t.thread_id DESC
			LIMIT $%d
		`, pageWhere, len(pageArgs)), pageArgs...)
		if queryErr != nil {
			return protocol.CodexConversationListResponse{}, fmt.Errorf("list Codex conversations: %w", queryErr)
		}
		candidateCount := 0
		var lastCandidate *conversationCursor
		foundVisibleAfterBoundary := false
		for rows.Next() {
			candidateCount++
			item, capabilities, taskProjectID, activity, threadSourceState, scanErr := scanConversation(rows)
			if scanErr != nil {
				rows.Close()
				return protocol.CodexConversationListResponse{}, scanErr
			}
			candidateCursor := &conversationCursor{UpdatedAt: activity, ThreadID: item.ThreadID, SnapshotAsOf: snapshotAsOf}
			lastCandidate = candidateCursor
			if taskProjectID != nil {
				allowed, authorizeErr := s.projects.CanReadProject(ctx, principal, *taskProjectID)
				if authorizeErr != nil {
					rows.Close()
					return protocol.CodexConversationListResponse{}, authorizeErr
				}
				if !allowed {
					continue
				}
			}
			if len(items) == limit {
				foundVisibleAfterBoundary = true
				break
			}
			item.ReadOnly, item.CanEditTitle = true, boolPointer(false)
			if item.BoundTaskID != nil && item.SourceKind == protocol.CodexThreadSourceKindMain && sourceAvailability == string(protocol.CodexSourceStateOnline) && threadSourceState == string(protocol.CodexSourceStateOnline) && item.SourceStatus == protocol.CodexSourceStatusActive && item.HistoryState == protocol.CodexHistoryStateComplete && item.FilesComplete && taskProjectID != nil && capabilityContains(capabilities, "thread/name/set") {
				allowed, authorizeErr := s.projects.CanWriteProject(ctx, principal, *taskProjectID)
				if authorizeErr != nil {
					rows.Close()
					return protocol.CodexConversationListResponse{}, authorizeErr
				}
				item.ReadOnly = !allowed
				item.CanEditTitle = boolPointer(allowed)
			}
			items = append(items, item)
			if len(items) == limit {
				boundary := *candidateCursor
				pageBoundary = &boundary
			}
		}
		rowsErr := rows.Err()
		rows.Close()
		if rowsErr != nil {
			return protocol.CodexConversationListResponse{}, fmt.Errorf("read Codex conversations: %w", rowsErr)
		}
		if foundVisibleAfterBoundary {
			if pageBoundary == nil {
				return protocol.CodexConversationListResponse{}, fmt.Errorf("list Codex conversations cursor boundary is missing")
			}
			encoded := encodeConversationCursor(*pageBoundary)
			next = &encoded
			break
		}
		if candidateCount < limit+1 || lastCandidate == nil {
			break
		}
		if pageCursor != nil && pageCursor.UpdatedAt.Equal(lastCandidate.UpdatedAt) && pageCursor.ThreadID == lastCandidate.ThreadID {
			return protocol.CodexConversationListResponse{}, fmt.Errorf("list Codex conversations cursor did not advance")
		}
		pageCursor = lastCandidate
	}
	if asOf.IsZero() {
		asOf = s.now()
	}
	state := protocol.CodexSyncState(syncState)
	if state == "" {
		state = protocol.CodexSyncStateNever
	}
	asOfText := formatTime(asOf)
	return protocol.CodexConversationListResponse{Items: items, HasMore: next != nil, NextCursor: next, AsOf: &asOfText, SnapshotState: &state}, nil
}

func (s *Service) GetConversation(ctx context.Context, principal auth.Principal, hostID, threadID string) (protocol.CodexConversationDetail, error) {
	access, err := s.defaultHost(ctx, principal, hostID)
	if err != nil {
		return protocol.CodexConversationDetail{}, err
	}
	item, capabilities, taskProjectID, _, sourceState, err := s.readConversation(ctx, access, principal, threadID)
	if err != nil {
		return protocol.CodexConversationDetail{}, err
	}
	if taskProjectID != nil {
		allowed, authorizeErr := s.projects.CanReadProject(ctx, principal, *taskProjectID)
		if authorizeErr != nil || !allowed {
			return protocol.CodexConversationDetail{}, auth.ErrNotFound
		}
	}
	item.ReadOnly, item.CanEditTitle = true, boolPointer(false)
	if item.SourceKind == protocol.CodexThreadSourceKindMain && item.BoundTaskID != nil && taskProjectID != nil && sourceState == string(protocol.CodexSourceStateOnline) && item.SourceStatus == protocol.CodexSourceStatusActive && item.HistoryState == protocol.CodexHistoryStateComplete && item.FilesComplete && capabilityContains(capabilities, "thread/name/set") {
		allowed, authorizeErr := s.projects.CanWriteProject(ctx, principal, *taskProjectID)
		if authorizeErr != nil {
			return protocol.CodexConversationDetail{}, authorizeErr
		}
		item.ReadOnly = !allowed
		item.CanEditTitle = boolPointer(allowed)
	}
	history, err := s.readHistory(ctx, access.host.ID, threadID)
	if err != nil {
		return protocol.CodexConversationDetail{}, err
	}
	files, err := s.readFiles(ctx, access.host.ID, threadID)
	if err != nil {
		return protocol.CodexConversationDetail{}, err
	}
	return protocol.CodexConversationDetail{Conversation: item, History: history, Files: files}, nil
}

// ReconcileSessionTaskBinding keeps a Codex identity aligned when a generic
// Session is activated or associated with a Task after the Codex snapshot was
// imported. An empty taskID reconciles a standalone Session. The caller
// supplies the Session/Task transaction so the visibility change cannot commit
// without the corresponding platform binding.
func (s *Service) ReconcileSessionTaskBinding(ctx context.Context, tx pgx.Tx, sessionID, taskID string) error {
	sessionID = strings.TrimSpace(sessionID)
	taskID = strings.TrimSpace(taskID)
	if s == nil || tx == nil || sessionID == "" {
		return ErrInvalid
	}
	if taskID == "" {
		_, err := tx.Exec(ctx, `
			UPDATE codex_threads AS codex
			SET bound_session_id = session.id,
			    updated_at = GREATEST(codex.updated_at, session.updated_at)
			FROM execution_sessions AS session
			WHERE session.id = $1
			  AND session.creation_state = 'confirmed'
			  AND session.external_thread_ref IS NOT NULL
			  AND codex.host_id = session.host_id
			  AND codex.thread_id = session.external_thread_ref
			  AND codex.source_kind = 'main'
			  AND codex.source_status = 'active'
			  AND codex.history_state = 'complete'
			  AND codex.files_complete
			  AND (codex.bound_session_id IS NULL OR codex.bound_session_id = session.id)
			  AND (codex.bound_task_id IS NULL OR EXISTS (
				  SELECT 1 FROM tasks task
				  WHERE task.id = codex.bound_task_id AND task.session_id = session.id
			  ))
			  AND NOT EXISTS (
				  SELECT 1 FROM codex_threads AS other
				  WHERE other.bound_session_id = session.id
				    AND (other.host_id <> codex.host_id OR other.thread_id <> codex.thread_id)
			  )
		`, sessionID)
		if err != nil {
			return fmt.Errorf("reconcile Codex Session identity: %w", err)
		}
		return nil
	}
	_, err := tx.Exec(ctx, `
		UPDATE codex_threads AS codex
		SET bound_task_id = task.id,
			bound_session_id = session.id,
			updated_at = GREATEST(codex.updated_at, session.updated_at, task.updated_at)
		FROM execution_sessions AS session
		JOIN tasks AS task ON task.session_id = session.id
		WHERE session.id = $1
		  AND task.id = $2
		  AND session.creation_state = 'confirmed'
		  AND session.external_thread_ref IS NOT NULL
		  AND codex.host_id = session.host_id
		  AND codex.thread_id = session.external_thread_ref
		  AND codex.source_kind = 'main'
		  AND codex.source_status = 'active'
		  AND codex.history_state = 'complete'
		  AND codex.files_complete
		  AND (codex.bound_session_id IS NULL OR codex.bound_session_id = session.id)
		  AND (codex.bound_task_id IS NULL OR codex.bound_task_id = task.id)
		  AND NOT EXISTS (
			SELECT 1 FROM codex_threads AS other
			WHERE other.bound_task_id = task.id
			  AND (other.host_id <> codex.host_id OR other.thread_id <> codex.thread_id)
		  )
		  AND NOT EXISTS (
			SELECT 1 FROM codex_threads AS other
			WHERE other.bound_session_id = session.id
			  AND (other.host_id <> codex.host_id OR other.thread_id <> codex.thread_id)
		  )
	`, sessionID, taskID)
	if err != nil {
		return fmt.Errorf("reconcile Codex Session/Task identity: %w", err)
	}
	return nil
}

func (s *Service) GetConversationFile(ctx context.Context, principal auth.Principal, hostID, threadID string, query protocol.GetCodexConversationFileQuery) (protocol.CodexFileContentResponse, error) {
	access, err := s.defaultHost(ctx, principal, hostID)
	if err != nil {
		return protocol.CodexFileContentResponse{}, err
	}
	if strings.TrimSpace(query.Path) == "" {
		return protocol.CodexFileContentResponse{}, ErrInvalid
	}
	if _, _, _, _, _, err := s.readConversation(ctx, access, principal, threadID); err != nil {
		return protocol.CodexFileContentResponse{}, err
	}
	offset := int64(0)
	if query.Offset != nil {
		offset = *query.Offset
	}
	limit := int64(defaultFileChunkSize)
	if query.Limit != nil {
		limit = *query.Limit
	}
	if offset < 0 || limit <= 0 {
		return protocol.CodexFileContentResponse{}, ErrInvalid
	}
	if offset > int64(1<<31-1) {
		return protocol.CodexFileContentResponse{}, ErrInvalid
	}
	if limit > maxFileChunkSize {
		limit = maxFileChunkSize
	}
	var file protocol.CodexFileMaterial
	var contentRef sql.NullString
	var content []byte
	var contentLength int64
	if err := s.pool.QueryRow(ctx, `
		SELECT path, content_type, size, sha256, content_ref,
		       COALESCE(octet_length(content_bytes), 0),
		       substring(content_bytes FROM $4::integer FOR $5::integer), complete
		FROM codex_thread_files WHERE host_id = $1 AND thread_id = $2 AND path = $3
	`, access.host.ID, threadID, strings.TrimSpace(query.Path), offset+1, limit).Scan(&file.Path, &file.ContentType, &file.Size, &file.Sha256, &contentRef, &contentLength, &content, &file.Complete); errors.Is(err, pgx.ErrNoRows) {
		return protocol.CodexFileContentResponse{}, ErrNotFound
	} else if err != nil {
		return protocol.CodexFileContentResponse{}, fmt.Errorf("read Codex file content: %w", err)
	}
	if contentRef.Valid && strings.TrimSpace(contentRef.String) != "" {
		file.ContentRef = &contentRef.String
	}
	version := strings.TrimSpace(file.Sha256)
	if version == "" {
		if contentRef.Valid && strings.TrimSpace(contentRef.String) != "" {
			version = strings.TrimSpace(contentRef.String)
		} else {
			digest := sha256.Sum256(content)
			version = hex.EncodeToString(digest[:])
		}
	}
	if expected := strings.TrimSpace(valueOrEmpty(query.ContentVersion)); expected != "" && expected != version {
		return protocol.CodexFileContentResponse{}, ErrConflict
	}
	if offset > file.Size || (contentLength > 0 && offset > contentLength) {
		return protocol.CodexFileContentResponse{}, ErrInvalid
	}
	end := offset + int64(len(content))
	bytesAvailable := file.Size == 0 || contentLength > 0
	return protocol.CodexFileContentResponse{
		File:           file,
		ContentBase64:  base64.StdEncoding.EncodeToString(content),
		ContentVersion: version,
		Offset:         offset,
		NextOffset:     end,
		TotalSize:      file.Size,
		Complete:       bytesAvailable && file.Complete && end >= file.Size,
		BytesAvailable: bytesAvailable,
	}, nil
}

type titleOperationRecord struct {
	OperationID        string
	HostID             string
	ThreadID           string
	DesiredTitle       string
	ExpectedCodexTitle *string
	State              string
}

func (s *Service) readTitleOperation(ctx context.Context, requestID string) (titleOperationRecord, bool, error) {
	var record titleOperationRecord
	err := s.pool.QueryRow(ctx, `
		SELECT operation_id, host_id, thread_id, desired_title, expected_codex_title, state
		FROM codex_title_operations WHERE request_id = $1
	`, requestID).Scan(&record.OperationID, &record.HostID, &record.ThreadID, &record.DesiredTitle, &record.ExpectedCodexTitle, &record.State)
	if errors.Is(err, pgx.ErrNoRows) {
		return titleOperationRecord{}, false, nil
	}
	if err != nil {
		return titleOperationRecord{}, false, fmt.Errorf("read Codex title operation: %w", err)
	}
	return record, true, nil
}

// persistTitlePreflightFailure keeps the attempted local title and its retry
// identity even when the remote write cannot be started. This is deliberately
// after both application permission checks, so an unauthorized caller cannot
// create or alter a title operation.
func (s *Service) persistTitlePreflightFailure(ctx context.Context, access sourceAccess, principal auth.Principal, threadID string, request protocol.CodexTitleUpdateRequest, cause error, threadState, operationState, reason string) (protocol.CodexConversation, error) {
	now := s.now()
	desiredTitle := strings.TrimSpace(request.Title)
	operationID := newID("codex-title")
	insertTag, err := s.pool.Exec(ctx, `
		INSERT INTO codex_title_operations (operation_id, request_id, host_id, thread_id, desired_title, expected_codex_title, state, last_error, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
		ON CONFLICT (request_id) DO NOTHING
	`, operationID, request.RequestID, access.host.ID, threadID, desiredTitle, nullableString(request.ExpectedCodexTitle), operationState, reason, now)
	if err != nil {
		return protocol.CodexConversation{}, errors.Join(cause, fmt.Errorf("persist Codex title preflight failure: %w", err))
	}
	record, found, err := s.readTitleOperation(ctx, request.RequestID)
	if err != nil {
		return protocol.CodexConversation{}, errors.Join(cause, err)
	}
	if !found || record.HostID != access.host.ID || record.ThreadID != threadID || record.DesiredTitle != desiredTitle || valueOrEmpty(record.ExpectedCodexTitle) != valueOrEmpty(request.ExpectedCodexTitle) {
		return protocol.CodexConversation{}, errors.Join(cause, ErrConflict)
	}
	operationID = record.OperationID
	if insertTag.RowsAffected() == 0 && request.Resolution != nil && *request.Resolution == "retry" {
		if _, err := s.pool.Exec(ctx, `
			UPDATE codex_title_operations
			SET state = $2, attempts = attempts + 1, last_error = $3, next_retry_at = NULL, updated_at = $4
			WHERE operation_id = $1 AND state <> 'title_sync_complete'
		`, operationID, operationState, reason, now); err != nil {
			return protocol.CodexConversation{}, errors.Join(cause, fmt.Errorf("refresh Codex title retry state: %w", err))
		}
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE codex_threads
		SET conversation_title = $3, title_sync_state = $4, title_sync_error = $5,
			title_conflict_codex_title = NULL, title_conflict_detected_at = NULL,
			title_operation_id = $6, updated_at = $7
		WHERE host_id = $1 AND thread_id = $2
	`, access.host.ID, threadID, desiredTitle, threadState, reason, operationID, now); err != nil {
		return protocol.CodexConversation{}, errors.Join(cause, fmt.Errorf("persist failed Loomhelm conversation title: %w", err))
	}
	projected, readErr := s.readProjectedConversation(ctx, access, principal, threadID)
	if readErr != nil {
		return protocol.CodexConversation{}, errors.Join(cause, readErr)
	}
	return projected, cause
}

func (s *Service) UpdateTitle(ctx context.Context, principal auth.Principal, hostID, threadID string, request protocol.CodexTitleUpdateRequest) (protocol.CodexConversation, error) {
	access, err := s.defaultHost(ctx, principal, hostID)
	if err != nil {
		return protocol.CodexConversation{}, err
	}
	request.RequestID = strings.TrimSpace(request.RequestID)
	request.Title = strings.TrimSpace(request.Title)
	if request.RequestID == "" || request.Title == "" || len([]rune(request.Title)) > maxTitleLength {
		return protocol.CodexConversation{}, ErrInvalid
	}
	item, capabilities, taskProjectID, _, sourceState, err := s.readConversation(ctx, access, principal, threadID)
	if err != nil {
		return protocol.CodexConversation{}, err
	}
	if item.SourceKind != protocol.CodexThreadSourceKindMain {
		return protocol.CodexConversation{}, ErrInvalid
	}
	if item.BoundTaskID == nil || taskProjectID == nil {
		return protocol.CodexConversation{}, ErrForbidden
	}
	allowed, err := s.projects.CanWriteProject(ctx, principal, *taskProjectID)
	if err != nil {
		return protocol.CodexConversation{}, err
	}
	if !allowed {
		return protocol.CodexConversation{}, auth.ErrForbidden
	}
	if request.Resolution != nil {
		switch *request.Resolution {
		case "use_codex":
			if strings.TrimSpace(valueOrEmpty(item.CodexTitle)) == "" {
				return item, ErrInvalid
			}
			request.Title = strings.TrimSpace(valueOrEmpty(item.CodexTitle))
		case "use_loomhelm", "retry":
		default:
			return item, ErrInvalid
		}
		if request.Title == "" || len([]rune(request.Title)) > maxTitleLength {
			return item, ErrInvalid
		}
	}
	existingOperation, found, err := s.readTitleOperation(ctx, request.RequestID)
	if err != nil {
		return protocol.CodexConversation{}, err
	}
	if found {
		if existingOperation.HostID != hostID || existingOperation.ThreadID != threadID || existingOperation.DesiredTitle != request.Title || valueOrEmpty(existingOperation.ExpectedCodexTitle) != valueOrEmpty(request.ExpectedCodexTitle) {
			return item, ErrConflict
		}
		if existingOperation.State == "title_sync_complete" || request.Resolution == nil || *request.Resolution != "retry" {
			return s.readProjectedConversation(ctx, access, principal, threadID)
		}
	}
	if sourceState != string(protocol.CodexSourceStateOnline) || item.SourceStatus != protocol.CodexSourceStatusActive {
		return s.persistTitlePreflightFailure(ctx, access, principal, threadID, request, ErrSourceUnavailable, "paused", "title_sync_paused", "Codex source is unavailable; title writeback is paused")
	}
	if item.HistoryState != protocol.CodexHistoryStateComplete || !item.FilesComplete {
		return s.persistTitlePreflightFailure(ctx, access, principal, threadID, request, ErrIncompleteHistory, "failed", "title_sync_failed", "Codex conversation materials are incomplete; title writeback is waiting for a complete snapshot")
	}
	if !capabilityContains(capabilities, "thread/name/set") {
		return s.persistTitlePreflightFailure(ctx, access, principal, threadID, request, ErrCapabilityUnsupported, "unsupported", "title_sync_failed", "Codex source does not support thread/name/set")
	}
	if request.ExpectedCodexTitle != nil && valueOrEmpty(request.ExpectedCodexTitle) != valueOrEmpty(item.CodexTitle) && (request.Resolution == nil || *request.Resolution == "retry") {
		return item, ErrConflict
	}
	now := s.now()
	operationID := newID("codex-title")
	insertTag, err := s.pool.Exec(ctx, `
		INSERT INTO codex_title_operations (operation_id, request_id, host_id, thread_id, desired_title, expected_codex_title, state, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'title_sync_pending', $7, $7)
		ON CONFLICT (request_id) DO NOTHING
	`, operationID, request.RequestID, hostID, threadID, strings.TrimSpace(request.Title), nullableString(request.ExpectedCodexTitle), now)
	if err != nil {
		return protocol.CodexConversation{}, fmt.Errorf("persist Codex title operation: %w", err)
	}
	var operationHost, operationThread, operationDesired string
	var operationExpected *string
	var operationState string
	err = s.pool.QueryRow(ctx, `SELECT operation_id, host_id, thread_id, desired_title, expected_codex_title, state FROM codex_title_operations WHERE request_id = $1`, request.RequestID).Scan(&operationID, &operationHost, &operationThread, &operationDesired, &operationExpected, &operationState)
	if err != nil {
		return protocol.CodexConversation{}, fmt.Errorf("read Codex title operation: %w", err)
	}
	if operationHost != hostID || operationThread != threadID || operationDesired != strings.TrimSpace(request.Title) || valueOrEmpty(operationExpected) != valueOrEmpty(request.ExpectedCodexTitle) {
		return protocol.CodexConversation{}, ErrConflict
	}
	if insertTag.RowsAffected() == 0 {
		if (operationState == "title_sync_failed" || operationState == "title_sync_paused") && request.Resolution != nil && *request.Resolution == "retry" {
			if _, err := s.pool.Exec(ctx, `UPDATE codex_title_operations SET state = 'title_sync_pending', last_error = '', next_retry_at = NULL, updated_at = $2 WHERE request_id = $1`, request.RequestID, now); err != nil {
				return protocol.CodexConversation{}, fmt.Errorf("reopen Codex title operation: %w", err)
			}
		} else {
			return s.readProjectedConversation(ctx, access, principal, threadID)
		}
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE codex_threads
		SET conversation_title = $3, title_sync_state = 'pending', title_sync_error = '',
		    title_conflict_codex_title = NULL, title_conflict_detected_at = NULL, title_operation_id = $4, updated_at = $5
		WHERE host_id = $1 AND thread_id = $2
	`, hostID, threadID, operationDesired, operationID, now)
	if err != nil {
		return protocol.CodexConversation{}, fmt.Errorf("persist Loomhelm conversation title: %w", err)
	}
	if s.titleWriter != nil {
		var writeErr error
		if writer, ok := s.titleWriter.(operationTitleWriter); ok {
			writeErr = writer.SetTitleWithOperation(ctx, operationID, hostID, threadID, operationDesired)
		} else {
			writeErr = s.titleWriter.SetTitle(ctx, hostID, threadID, operationDesired)
		}
		titleTx, txErr := s.pool.Begin(ctx)
		if txErr != nil {
			err = errors.Join(writeErr, fmt.Errorf("begin Codex title result: %w", txErr))
		} else {
			defer titleTx.Rollback(ctx)
			resultNow := s.now()
			var currentTitle, currentState, currentSourceStatus, currentOperationID string
			readErr := titleTx.QueryRow(ctx, `
				SELECT conversation_title, title_sync_state, source_status, title_operation_id
				FROM codex_threads WHERE host_id = $1 AND thread_id = $2 FOR UPDATE
			`, hostID, threadID).Scan(&currentTitle, &currentState, &currentSourceStatus, &currentOperationID)
			if readErr != nil {
				err = errors.Join(writeErr, fmt.Errorf("read Codex title result state: %w", readErr))
			} else if writeErr != nil {
				safeError := safeCodexError(writeErr.Error())
				_, operationErr := titleTx.Exec(ctx, `
					UPDATE codex_title_operations
					SET state = 'title_sync_failed', attempts = attempts + 1, last_error = $2, updated_at = $3
					WHERE operation_id = $1 AND state = 'title_sync_pending'
					`, operationID, safeError, resultNow)
				_, threadErr := titleTx.Exec(ctx, `
					UPDATE codex_threads
					SET title_sync_state = 'failed', title_sync_error = $3, updated_at = $4
					WHERE host_id = $1 AND thread_id = $2 AND title_sync_state = 'pending' AND title_operation_id = $5
					`, hostID, threadID, safeError, resultNow, operationID)
				err = errors.Join(writeErr, operationErr, threadErr)
			} else if currentOperationID != operationID || currentTitle != operationDesired || currentState != "pending" {
				var operationState string
				if opErr := titleTx.QueryRow(ctx, `SELECT state FROM codex_title_operations WHERE operation_id = $1 FOR UPDATE`, operationID).Scan(&operationState); opErr != nil {
					err = errors.Join(ErrConflict, fmt.Errorf("read Codex title operation state: %w", opErr))
				} else if operationState == "title_sync_complete" {
					err = nil
				} else {
					_, conflictErr := titleTx.Exec(ctx, `
						UPDATE codex_title_operations
						SET state = 'title_sync_conflict', last_error = 'local title changed before remote acknowledgement', updated_at = $2
						WHERE operation_id = $1 AND state = 'title_sync_pending'
					`, operationID, resultNow)
					err = errors.Join(ErrConflict, conflictErr)
				}
			} else if currentSourceStatus != string(protocol.CodexSourceStatusActive) {
				_, threadErr := titleTx.Exec(ctx, `
					UPDATE codex_threads SET title_sync_state = 'paused', title_sync_error = 'Codex source became unavailable before title acknowledgement', updated_at = $4
					WHERE host_id = $1 AND thread_id = $2 AND title_operation_id = $3
				`, hostID, threadID, operationID, resultNow)
				_, operationErr := titleTx.Exec(ctx, `
					UPDATE codex_title_operations SET state = 'title_sync_paused', attempts = attempts + 1, last_error = 'Codex source became unavailable before title acknowledgement', updated_at = $2
					WHERE operation_id = $1 AND state = 'title_sync_pending'
				`, operationID, resultNow)
				err = errors.Join(ErrSourceUnavailable, threadErr, operationErr)
			} else {
				_, threadErr := titleTx.Exec(ctx, `
					UPDATE codex_threads SET codex_title = $3, title_sync_state = 'synced', title_sync_error = '', title_conflict_codex_title = NULL, title_conflict_detected_at = NULL, title_operation_id = '', updated_at = $4
					WHERE host_id = $1 AND thread_id = $2 AND title_sync_state = 'pending' AND title_operation_id = $5 AND conversation_title = $3
				`, hostID, threadID, operationDesired, resultNow, operationID)
				_, operationErr := titleTx.Exec(ctx, `
					UPDATE codex_title_operations SET state = 'title_sync_complete', attempts = attempts + 1, last_error = '', updated_at = $2
					WHERE operation_id = $1 AND state = 'title_sync_pending'
				`, operationID, resultNow)
				err = errors.Join(threadErr, operationErr)
			}
			if commitErr := titleTx.Commit(ctx); commitErr != nil {
				err = errors.Join(err, fmt.Errorf("commit Codex title result: %w", commitErr))
			}
		}
	}
	if err != nil {
		return protocol.CodexConversation{}, err
	}
	return s.readProjectedConversation(ctx, access, principal, threadID)
}

func (s *Service) MapProject(ctx context.Context, principal auth.Principal, hostID, projectID string, request protocol.CodexMappingRequest) (protocol.CodexProject, error) {
	access, err := s.defaultHost(ctx, principal, hostID)
	if err != nil {
		return protocol.CodexProject{}, err
	}
	if strings.TrimSpace(projectID) == "" || strings.TrimSpace(request.LoomhelmProjectID) == "" {
		return protocol.CodexProject{}, ErrInvalid
	}
	if !access.owner {
		return protocol.CodexProject{}, auth.ErrForbidden
	}
	allowed, err := s.projects.CanWriteProject(ctx, principal, request.LoomhelmProjectID)
	if err != nil {
		return protocol.CodexProject{}, err
	}
	if !allowed {
		return protocol.CodexProject{}, auth.ErrForbidden
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return protocol.CodexProject{}, fmt.Errorf("begin Codex project mapping: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `
		INSERT INTO codex_project_mappings (host_id, project_id, loomhelm_project_id, created_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $5)
		ON CONFLICT (host_id, project_id) DO UPDATE SET loomhelm_project_id = EXCLUDED.loomhelm_project_id, updated_at = EXCLUDED.updated_at
	`, access.host.ID, projectID, request.LoomhelmProjectID, principal.UserID, s.now()); err != nil {
		return protocol.CodexProject{}, fmt.Errorf("map Codex project: %w", err)
	}
	result, err := tx.Exec(ctx, `UPDATE codex_projects SET loomhelm_project_id = $3, updated_at = $4 WHERE host_id = $1 AND project_id = $2`, access.host.ID, projectID, request.LoomhelmProjectID, s.now())
	if err != nil {
		return protocol.CodexProject{}, err
	}
	if result.RowsAffected() == 0 {
		return protocol.CodexProject{}, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return protocol.CodexProject{}, fmt.Errorf("commit Codex project mapping: %w", err)
	}
	return s.readProject(ctx, access.host.ID, projectID)
}

func (s *Service) Bind(ctx context.Context, principal auth.Principal, hostID, threadID string, request protocol.CodexBindRequest) (protocol.CodexConversation, error) {
	access, err := s.defaultHost(ctx, principal, hostID)
	if err != nil {
		return protocol.CodexConversation{}, err
	}
	if strings.TrimSpace(request.RequestID) == "" || strings.TrimSpace(request.TaskID) == "" {
		return protocol.CodexConversation{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return protocol.CodexConversation{}, fmt.Errorf("begin Codex binding: %w", err)
	}
	defer tx.Rollback(ctx)
	var conversationTitle, sourceKind, sourceStatus, historyState string
	var codexProjectID *string
	var filesComplete bool
	var existingTask, existingSession *string
	var importedBy *string
	var snapshotAsOf time.Time
	if err := tx.QueryRow(ctx, `
		SELECT 1 FROM codex_threads WHERE host_id = $1 AND thread_id = $2
	`, access.host.ID, threadID).Scan(new(int)); errors.Is(err, pgx.ErrNoRows) {
		return protocol.CodexConversation{}, ErrNotFound
	} else if err != nil {
		return protocol.CodexConversation{}, fmt.Errorf("read Codex conversation: %w", err)
	}
	var existingSessionID string
	var sessionTaskID *string
	var sessionProjectID, sessionCreatorUserID *string
	sessionLookupErr := tx.QueryRow(ctx, `
		SELECT session.id, session.project_id, session.creator_user_id, task.id
		FROM execution_sessions AS session
		LEFT JOIN tasks AS task ON task.session_id = session.id
		WHERE session.host_id = $1 AND session.external_thread_ref = $2
		  AND session.creation_state = 'confirmed'
		FOR UPDATE OF session
	`, access.host.ID, threadID).Scan(&existingSessionID, &sessionProjectID, &sessionCreatorUserID, &sessionTaskID)
	if sessionLookupErr != nil && !errors.Is(sessionLookupErr, pgx.ErrNoRows) {
		return protocol.CodexConversation{}, fmt.Errorf("read existing Codex Session: %w", sessionLookupErr)
	}
	var taskProjectID string
	var taskSessionID *string
	if err := tx.QueryRow(ctx, `SELECT project_id, session_id FROM tasks WHERE id = $1 FOR UPDATE`, request.TaskID).Scan(&taskProjectID, &taskSessionID); errors.Is(err, pgx.ErrNoRows) {
		return protocol.CodexConversation{}, auth.ErrNotFound
	} else if err != nil {
		return protocol.CodexConversation{}, fmt.Errorf("lock binding Task: %w", err)
	}
	var lockedHostID string
	if err := tx.QueryRow(ctx, `
		SELECT id FROM host_registrations WHERE id = $1 FOR UPDATE
	`, access.host.ID).Scan(&lockedHostID); errors.Is(err, pgx.ErrNoRows) {
		return protocol.CodexConversation{}, ErrNotFound
	} else if err != nil {
		return protocol.CodexConversation{}, fmt.Errorf("lock Codex Host for binding: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT conversation_title, project_id, source_kind, source_status, history_state, files_complete, bound_task_id, bound_session_id, imported_by, as_of
		FROM codex_threads WHERE host_id = $1 AND thread_id = $2 FOR UPDATE
	`, access.host.ID, threadID).Scan(&conversationTitle, &codexProjectID, &sourceKind, &sourceStatus, &historyState, &filesComplete, &existingTask, &existingSession, &importedBy, &snapshotAsOf); errors.Is(err, pgx.ErrNoRows) {
		return protocol.CodexConversation{}, ErrNotFound
	} else if err != nil {
		return protocol.CodexConversation{}, fmt.Errorf("lock Codex conversation: %w", err)
	}
	if sourceKind != string(protocol.CodexThreadSourceKindMain) {
		return protocol.CodexConversation{}, ErrInvalid
	}
	allowed, err := s.projects.CanWriteProjectTx(ctx, tx, principal, taskProjectID)
	if err != nil {
		return protocol.CodexConversation{}, err
	}
	if !allowed {
		return protocol.CodexConversation{}, auth.ErrNotFound
	}
	if codexProjectID != nil && strings.TrimSpace(*codexProjectID) != "" {
		var mappedProjectID *string
		if err := tx.QueryRow(ctx, `SELECT loomhelm_project_id FROM codex_projects WHERE host_id = $1 AND project_id = $2`, access.host.ID, *codexProjectID).Scan(&mappedProjectID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return protocol.CodexConversation{}, fmt.Errorf("read Codex project mapping: %w", err)
		}
		if mappedProjectID != nil && *mappedProjectID != taskProjectID {
			return protocol.CodexConversation{}, ErrConflict
		}
	}
	if existingTask != nil {
		if *existingTask != request.TaskID {
			return protocol.CodexConversation{}, ErrConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return protocol.CodexConversation{}, fmt.Errorf("commit idempotent Codex binding: %w", err)
		}
		return s.readProjectedConversation(ctx, access, principal, threadID)
	}
	if request.ExpectedAsOf != nil {
		expectedAsOf, parseErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(*request.ExpectedAsOf))
		if parseErr != nil {
			return protocol.CodexConversation{}, ErrInvalid
		}
		if !snapshotAsOf.Equal(expectedAsOf) {
			return protocol.CodexConversation{}, ErrConflict
		}
	}
	if sourceStatus != string(protocol.CodexSourceStatusActive) {
		return protocol.CodexConversation{}, ErrSourceUnavailable
	}
	if historyState != string(protocol.CodexHistoryStateComplete) || !filesComplete {
		return protocol.CodexConversation{}, ErrIncompleteHistory
	}
	confirmShare := request.ConfirmShare != nil && *request.ConfirmShare
	if sessionLookupErr == nil && sessionProjectID == nil {
		if sessionCreatorUserID == nil || *sessionCreatorUserID != principal.UserID || !confirmShare {
			return protocol.CodexConversation{}, ErrForbidden
		}
	} else if importedBy == nil || *importedBy != principal.UserID || !confirmShare {
		return protocol.CodexConversation{}, ErrForbidden
	}
	var linkedTask, linkedSession string
	var linkedHost, linkedThread string
	if err := tx.QueryRow(ctx, `SELECT host_id, thread_id, task_id, session_id FROM codex_thread_links WHERE request_id = $1`, request.RequestID).Scan(&linkedHost, &linkedThread, &linkedTask, &linkedSession); err == nil {
		if linkedHost != access.host.ID || linkedThread != threadID || linkedTask != request.TaskID || linkedSession == "" {
			return protocol.CodexConversation{}, ErrConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return protocol.CodexConversation{}, err
		}
		return s.readProjectedConversation(ctx, access, principal, threadID)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return protocol.CodexConversation{}, fmt.Errorf("read binding idempotency record: %w", err)
	}
	if existingSession != nil {
		if errors.Is(sessionLookupErr, pgx.ErrNoRows) || *existingSession != existingSessionID {
			return protocol.CodexConversation{}, ErrConflict
		}
	}
	if sessionLookupErr == nil && sessionTaskID != nil && *sessionTaskID != request.TaskID {
		return protocol.CodexConversation{}, ErrConflict
	}
	if sessionLookupErr == nil && sessionProjectID != nil && *sessionProjectID != taskProjectID {
		return protocol.CodexConversation{}, ErrConflict
	}
	if taskSessionID != nil {
		if errors.Is(sessionLookupErr, pgx.ErrNoRows) || *taskSessionID != existingSessionID {
			return protocol.CodexConversation{}, ErrConflict
		}
	}
	sessionID := existingSessionID
	if errors.Is(sessionLookupErr, pgx.ErrNoRows) {
		sessionID = newID("session")
		generation := newID("codex-source")
		if _, err := tx.Exec(ctx, `
			INSERT INTO execution_sessions (id, host_id, external_thread_ref, path, state, project_id, generation, creator_user_id, terminal_reason)
			VALUES ($1, $2, $3, 'existing_active', 'unsupported', $4, $5, $6, 'Codex source binding is read-only until execution control is separately verified')
		`, sessionID, access.host.ID, threadID, taskProjectID, generation, principal.UserID); err != nil {
			if isUniqueViolation(err) {
				return protocol.CodexConversation{}, ErrConflict
			}
			return protocol.CodexConversation{}, fmt.Errorf("create bound Codex Session: %w", err)
		}
	} else if sessionProjectID == nil {
		if _, err := tx.Exec(ctx, `UPDATE execution_sessions SET project_id = $2, updated_at = $3 WHERE id = $1 AND project_id IS NULL`, sessionID, taskProjectID, s.now()); err != nil {
			return protocol.CodexConversation{}, fmt.Errorf("assign Codex Session project: %w", err)
		}
	}
	if taskSessionID == nil {
		result, err := tx.Exec(ctx, `UPDATE tasks SET session_id = $2, updated_at = $3 WHERE id = $1 AND session_id IS NULL`, request.TaskID, sessionID, s.now())
		if err != nil {
			return protocol.CodexConversation{}, fmt.Errorf("bind Task Session: %w", err)
		}
		if result.RowsAffected() != 1 {
			return protocol.CodexConversation{}, ErrConflict
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO codex_thread_links (host_id, thread_id, task_id, session_id, request_id, linked_by)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, access.host.ID, threadID, request.TaskID, sessionID, request.RequestID, principal.UserID); err != nil {
		if isUniqueViolation(err) {
			return protocol.CodexConversation{}, ErrConflict
		}
		return protocol.CodexConversation{}, fmt.Errorf("persist Codex binding: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE codex_threads SET bound_task_id = $3, bound_session_id = $4, updated_at = $5 WHERE host_id = $1 AND thread_id = $2`, access.host.ID, threadID, request.TaskID, sessionID, s.now()); err != nil {
		return protocol.CodexConversation{}, fmt.Errorf("project Codex binding: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return protocol.CodexConversation{}, fmt.Errorf("commit Codex binding: %w", err)
	}
	return s.readProjectedConversation(ctx, access, principal, threadID)
}

func (s *Service) RequestSync(ctx context.Context, principal auth.Principal, request protocol.CodexSyncRequest) (protocol.CodexSyncResponse, error) {
	hostID := valueOrEmpty(request.HostID)
	access, err := s.defaultHost(ctx, principal, hostID)
	if err != nil {
		return protocol.CodexSyncResponse{}, err
	}
	if !access.owner {
		return protocol.CodexSyncResponse{}, auth.ErrForbidden
	}
	operationID := strings.TrimSpace(valueOrEmpty(request.RequestID))
	if strings.HasPrefix(operationID, "reconnect-") {
		return protocol.CodexSyncResponse{}, ErrInvalid
	}
	if operationID == "" {
		operationID = newID("codex-sync")
	}
	now := s.now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return protocol.CodexSyncResponse{}, fmt.Errorf("begin Codex sync request: %w", err)
	}
	defer tx.Rollback(ctx)
	var existingHost, existingState string
	var existingAsOf time.Time
	existingErr := tx.QueryRow(ctx, `SELECT host_id, state, as_of FROM codex_sync_snapshots WHERE id = $1 FOR UPDATE`, operationID).Scan(&existingHost, &existingState, &existingAsOf)
	if existingErr == nil {
		if existingHost != access.host.ID {
			return protocol.CodexSyncResponse{}, ErrConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return protocol.CodexSyncResponse{}, fmt.Errorf("commit existing Codex sync request: %w", err)
		}
		asOf := formatTime(existingAsOf)
		return protocol.CodexSyncResponse{OperationID: operationID, State: protocol.CodexSyncState(existingState), AsOf: &asOf}, nil
	}
	if !errors.Is(existingErr, pgx.ErrNoRows) {
		return protocol.CodexSyncResponse{}, fmt.Errorf("read existing Codex sync request: %w", existingErr)
	}
	var connectionGeneration int64
	if err := tx.QueryRow(ctx, `
		SELECT connection_generation FROM host_registrations WHERE id = $1
	`, access.host.ID).Scan(&connectionGeneration); err != nil {
		return protocol.CodexSyncResponse{}, fmt.Errorf("read Codex Host connection generation: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO codex_sync_sources (host_id, state, sync_state, sync_operation_id, as_of, updated_at)
		VALUES ($1, CASE WHEN (SELECT status FROM host_registrations WHERE id = $1) = 'online' THEN 'online' ELSE 'offline' END, 'syncing', $2, $3, $3)
		ON CONFLICT (host_id) DO UPDATE SET sync_state = 'syncing', sync_operation_id = EXCLUDED.sync_operation_id, as_of = GREATEST(codex_sync_sources.as_of, EXCLUDED.as_of), updated_at = EXCLUDED.updated_at
	`, access.host.ID, operationID, now)
	if err != nil {
		return protocol.CodexSyncResponse{}, fmt.Errorf("record Codex sync request: %w", err)
	}
	insertTag, err := tx.Exec(ctx, `
		INSERT INTO codex_sync_snapshots (id, host_id, scope, state, complete, as_of, cursor, error, created_at, updated_at)
		VALUES ($1, $2, 'source', 'syncing', FALSE, $3, '', '', $3, $3)
		ON CONFLICT (id) DO NOTHING
	`, operationID, access.host.ID, now)
	if err != nil {
		return protocol.CodexSyncResponse{}, fmt.Errorf("record Codex sync snapshot: %w", err)
	}
	if insertTag.RowsAffected() == 0 {
		if err := tx.QueryRow(ctx, `SELECT host_id, state, as_of FROM codex_sync_snapshots WHERE id = $1 FOR UPDATE`, operationID).Scan(&existingHost, &existingState, &existingAsOf); err != nil {
			return protocol.CodexSyncResponse{}, fmt.Errorf("read existing Codex sync request: %w", err)
		}
		if existingHost != access.host.ID {
			return protocol.CodexSyncResponse{}, ErrConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return protocol.CodexSyncResponse{}, fmt.Errorf("commit existing Codex sync request: %w", err)
		}
		asOf := formatTime(existingAsOf)
		return protocol.CodexSyncResponse{OperationID: operationID, State: protocol.CodexSyncState(existingState), AsOf: &asOf}, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return protocol.CodexSyncResponse{}, fmt.Errorf("commit Codex sync request: %w", err)
	}
	if runner := s.syncRunner; runner != nil {
		hostID := access.host.ID
		expectedGeneration := connectionGeneration
		go func() {
			syncCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
			defer cancel()
			snapshot, syncErr := runner.Sync(syncCtx, hostID, operationID)
			if syncErr != nil {
				_ = s.FailSync(context.Background(), hostID, operationID, syncErr)
				return
			}
			snapshot.HostID = hostID
			snapshot.OperationID = operationID
			snapshot.ConnectionGeneration = expectedGeneration
			if importErr := s.ImportSnapshot(syncCtx, snapshot); importErr != nil {
				_ = s.FailSync(context.Background(), hostID, operationID, importErr)
			}
		}()
	}
	asOf := formatTime(now)
	return protocol.CodexSyncResponse{OperationID: operationID, State: protocol.CodexSyncStateSyncing, AsOf: &asOf}, nil
}

type conversationCursor struct {
	UpdatedAt    time.Time
	ThreadID     string
	SnapshotAsOf time.Time
}

func encodeConversationCursor(cursor conversationCursor) string {
	data, _ := json.Marshal(struct {
		UpdatedAt    string `json:"updated_at"`
		ThreadID     string `json:"thread_id"`
		SnapshotAsOf string `json:"snapshot_as_of,omitempty"`
	}{cursor.UpdatedAt.UTC().Format(time.RFC3339Nano), cursor.ThreadID, formatOptionalTime(cursor.SnapshotAsOf)})
	return base64.RawURLEncoding.EncodeToString(data)
}

func decodeConversationCursor(value string) *conversationCursor {
	if value == "" {
		return nil
	}
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil
	}
	var decoded struct {
		UpdatedAt    string `json:"updated_at"`
		ThreadID     string `json:"thread_id"`
		SnapshotAsOf string `json:"snapshot_as_of"`
	}
	if json.Unmarshal(data, &decoded) != nil || decoded.ThreadID == "" {
		return nil
	}
	updated, err := time.Parse(time.RFC3339Nano, decoded.UpdatedAt)
	if err != nil {
		return nil
	}
	var snapshotAsOf time.Time
	if decoded.SnapshotAsOf == "" {
		return nil
	}
	snapshotAsOf, err = time.Parse(time.RFC3339Nano, decoded.SnapshotAsOf)
	if err != nil {
		return nil
	}
	return &conversationCursor{UpdatedAt: updated, ThreadID: decoded.ThreadID, SnapshotAsOf: snapshotAsOf}
}

func normalizeLimit(value *int64) int {
	if value == nil || *value <= 0 {
		return defaultPageSize
	}
	if *value > maxPageSize {
		return maxPageSize
	}
	return int(*value)
}

func boolValue(value *bool) bool { return value != nil && *value }

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableString(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return strings.TrimSpace(*value)
}

func nullableStringValue(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	value = strings.TrimSpace(value)
	return &value
}

func boolPointer(value bool) *bool { return &value }

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func formatOptionalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return formatTime(value)
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func sortedProjectScopeValues(scope map[string]struct{}) []string {
	values := make([]string, 0, len(scope))
	for projectID := range scope {
		if strings.TrimSpace(projectID) != "" {
			values = append(values, projectID)
		}
	}
	sort.Strings(values)
	return values
}

func capabilityContains(raw []byte, capability string) bool {
	var values []string
	if json.Unmarshal(raw, &values) != nil {
		return false
	}
	for _, value := range values {
		if value == capability {
			return true
		}
	}
	return false
}

func newID(prefix string) string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return prefix + "-fallback"
	}
	return prefix + "_" + hex.EncodeToString(bytes[:])
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
