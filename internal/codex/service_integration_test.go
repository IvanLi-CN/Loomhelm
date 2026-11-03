package codex_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/codex"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestImportSnapshotRetainsRawHistoryFilesAndReadiness(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatalf("load database configuration: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "codex-import-user-" + suffix
	hostID := "codex-import-host-" + suffix
	threadID := "codex-import-thread-" + suffix
	projectID := "codex-import-project-" + suffix
	operationID := "codex-import-operation-" + suffix
	_, err = db.Pool().Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject)
		VALUES ($1, 'test', $1)
	`, userID)
	if err == nil {
		_, err = db.Pool().Exec(ctx, `
			INSERT INTO host_registrations (id, singleton_key, name, status, owner_user_id)
			VALUES ($1, NULL, 'Codex import test', 'online', $2)
		`, hostID, userID)
	}
	if err != nil {
		t.Fatalf("seed Host: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM codex_sync_sources WHERE host_id = $1`, hostID)
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM host_registrations WHERE id = $1`, hostID)
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM auth_users WHERE id = $1`, userID)
	})

	service := codex.NewService(db.Pool(), nil, nil, nil)
	now := time.Now().UTC().Truncate(time.Microsecond)
	if err := service.ImportSnapshot(ctx, protocol.CodexSourceSnapshot{
		OperationID:     operationID,
		HostID:          hostID,
		State:           protocol.CodexSourceStateOnline,
		SyncState:       protocol.CodexSyncStateComplete,
		Build:           "codex-cli test-build",
		ProtocolVersion: "v2",
		Capabilities:    []string{"thread/list", "thread/name/set"},
		AsOf:            now,
		Projects: []protocol.CodexSourceProjectSnapshot{{
			ProjectID: projectID,
			Name:      "Codex project",
			CWD:       "/tmp/codex-project",
		}},
		Threads: []protocol.CodexSourceThreadSnapshot{{
			ThreadID:      threadID,
			ProjectID:     stringPointer(projectID),
			CodexTitle:    stringPointer("Codex 原始标题"),
			Preview:       "历史预览",
			CWD:           "/tmp/codex-project",
			SourceStatus:  protocol.CodexSourceStatusActive,
			HistoryState:  protocol.CodexHistoryStateComplete,
			FilesComplete: true,
			Events: []protocol.CodexSourceHistoryEvent{{
				EventID:          "event-1",
				Sequence:         1,
				EventType:        "malformed",
				RawPayload:       json.RawMessage(`{malformed`),
				ReadableFallback: "可读 fallback",
				OccurredAt:       now,
			}},
			Files: []protocol.CodexSourceFileMaterial{{
				Path:        "notes.txt",
				ContentType: "text/plain",
				Size:        5,
				Content:     []byte("hello"),
				Complete:    true,
			}},
			LastActivityAt: now,
		}},
	}); err != nil {
		t.Fatalf("ImportSnapshot() error = %v", err)
	}

	var historyRaw, fallback string
	if err := db.Pool().QueryRow(ctx, `
		SELECT raw_payload, readable_fallback
		FROM codex_thread_history WHERE host_id = $1 AND thread_id = $2 AND event_id = 'event-1'
	`, hostID, threadID).Scan(&historyRaw, &fallback); err != nil {
		t.Fatalf("read imported history: %v", err)
	}
	if historyRaw != "{malformed" || fallback != "可读 fallback" {
		t.Fatalf("imported history = (%q, %q)", historyRaw, fallback)
	}
	var fileBytes []byte
	if err := db.Pool().QueryRow(ctx, `
		SELECT content_bytes FROM codex_thread_files WHERE host_id = $1 AND thread_id = $2 AND path = 'notes.txt'
	`, hostID, threadID).Scan(&fileBytes); err != nil {
		t.Fatalf("read imported file: %v", err)
	}
	if string(fileBytes) != "hello" {
		t.Fatalf("imported file bytes = %q", fileBytes)
	}

	var historyState string
	var filesComplete bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT history_state, files_complete FROM codex_threads WHERE host_id = $1 AND thread_id = $2
	`, hostID, threadID).Scan(&historyState, &filesComplete); err != nil {
		t.Fatalf("read imported thread readiness: %v", err)
	}
	if historyState != "complete" || !filesComplete {
		t.Fatalf("imported thread readiness = (%q, %t)", historyState, filesComplete)
	}

	partialOperation := operationID + "-partial"
	if _, err := db.Pool().Exec(ctx, `
		UPDATE codex_sync_sources
		SET sync_state = 'syncing', sync_operation_id = $2, as_of = $3, updated_at = $3
		WHERE host_id = $1
	`, hostID, partialOperation, now.Add(time.Minute)); err != nil {
		t.Fatalf("admit partial snapshot operation: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO codex_sync_snapshots (id, host_id, scope, state, complete, as_of, cursor, error, created_at, updated_at)
		VALUES ($1, $2, 'source', 'syncing', FALSE, $3, '', '', $3, $3)
	`, partialOperation, hostID, now.Add(time.Minute)); err != nil {
		t.Fatalf("seed partial snapshot operation: %v", err)
	}
	if err := service.ImportSnapshot(ctx, protocol.CodexSourceSnapshot{
		OperationID: partialOperation,
		HostID:      hostID,
		State:       protocol.CodexSourceStateOnline,
		SyncState:   protocol.CodexSyncStatePartial,
		AsOf:        now.Add(time.Minute),
		Threads: []protocol.CodexSourceThreadSnapshot{{
			ThreadID:      threadID,
			HistoryState:  protocol.CodexHistoryStatePartial,
			FilesComplete: false,
			Error:         "history transfer interrupted",
		}},
	}); err != nil {
		t.Fatalf("ImportSnapshot(partial) error = %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT history_state, files_complete FROM codex_threads WHERE host_id = $1 AND thread_id = $2`, hostID, threadID).Scan(&historyState, &filesComplete); err != nil {
		t.Fatalf("read partial thread readiness: %v", err)
	}
	if historyState != "partial" || filesComplete {
		t.Fatalf("partial snapshot readiness = (%q, %t)", historyState, filesComplete)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT content_bytes FROM codex_thread_files WHERE host_id = $1 AND thread_id = $2 AND path = 'notes.txt'
	`, hostID, threadID).Scan(&fileBytes); err != nil {
		t.Fatalf("read retained partial file: %v", err)
	}
	if string(fileBytes) != "hello" {
		t.Fatalf("retained partial file bytes = %q", fileBytes)
	}
	var snapshotState string
	var complete bool
	if err := db.Pool().QueryRow(ctx, `SELECT state, complete FROM codex_sync_snapshots WHERE id = $1`, partialOperation).Scan(&snapshotState, &complete); err != nil {
		t.Fatalf("read partial snapshot state: %v", err)
	}
	if snapshotState != "partial" || complete {
		t.Fatalf("partial snapshot state = (%q, %t)", snapshotState, complete)
	}
	var currentOperation, currentSyncState string
	if err := db.Pool().QueryRow(ctx, `SELECT sync_operation_id, sync_state FROM codex_sync_sources WHERE host_id = $1`, hostID).Scan(&currentOperation, &currentSyncState); err != nil {
		t.Fatalf("read current Codex sync fence: %v", err)
	}
	if currentOperation != partialOperation || currentSyncState != "partial" {
		t.Fatalf("current Codex sync fence = (%q, %q)", currentOperation, currentSyncState)
	}
	if err := service.ImportSnapshot(ctx, protocol.CodexSourceSnapshot{
		OperationID: operationID,
		HostID:      hostID,
		State:       protocol.CodexSourceStateOnline,
		SyncState:   protocol.CodexSyncStateComplete,
		AsOf:        now.Add(2 * time.Minute),
	}); err != nil {
		t.Fatalf("late snapshot import error = %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT sync_operation_id, sync_state FROM codex_sync_sources WHERE host_id = $1`, hostID).Scan(&currentOperation, &currentSyncState); err != nil {
		t.Fatalf("read retained Codex sync fence: %v", err)
	}
	if currentOperation != partialOperation || currentSyncState != "partial" {
		t.Fatalf("late snapshot changed Codex sync fence = (%q, %q)", currentOperation, currentSyncState)
	}

}

func TestUpdateTitlePersistsPreflightFailuresForRetry(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatalf("load database configuration: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "codex-title-user-" + suffix
	hostID := "codex-title-host-" + suffix
	projectID := "codex-title-project-" + suffix
	taskID := "codex-title-task-" + suffix
	threadID := "codex-title-thread-" + suffix
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, err = db.Pool().Exec(ctx, `INSERT INTO auth_users (id, issuer, subject) VALUES ($1, 'test', $1)`, userID)
	if err == nil {
		_, err = db.Pool().Exec(ctx, `INSERT INTO host_registrations (id, singleton_key, name, status, owner_user_id) VALUES ($1, NULL, 'Codex title test', 'online', $2)`, hostID, userID)
	}
	if err == nil {
		_, err = db.Pool().Exec(ctx, `INSERT INTO projects (id, name, created_by) VALUES ($1, 'Codex title project', $2)`, projectID, userID)
	}
	if err == nil {
		_, err = db.Pool().Exec(ctx, `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`, projectID, userID)
	}
	if err == nil {
		_, err = db.Pool().Exec(ctx, `INSERT INTO tasks (id, project_id, title, goal) VALUES ($1, $2, 'Existing Task', 'Verify title synchronization')`, taskID, projectID)
	}
	if err == nil {
		_, err = db.Pool().Exec(ctx, `INSERT INTO codex_sync_sources (host_id, state, sync_state, as_of, updated_at) VALUES ($1, 'offline', 'complete', $2, $2)`, hostID, now)
	}
	if err == nil {
		_, err = db.Pool().Exec(ctx, `INSERT INTO codex_projects (host_id, project_id, name, cwd, snapshot_state, as_of, updated_at) VALUES ($1, 'codex-project', 'Codex Project', '/workspace', 'complete', $2, $2)`, hostID, now)
	}
	if err == nil {
		_, err = db.Pool().Exec(ctx, `
			INSERT INTO codex_threads (host_id, thread_id, project_id, codex_title, conversation_title, preview, cwd, source_status, history_state, files_complete, title_sync_state, bound_task_id, imported_by, as_of, last_activity_at, updated_at)
			VALUES ($1, $2, 'codex-project', 'Codex 原标题', '旧标题', 'preview', '/workspace', 'active', 'complete', TRUE, 'synced', $3, $4, $5, $5, $5)
		`, hostID, threadID, taskID, userID, now)
	}
	if err != nil {
		t.Fatalf("seed Codex title fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM codex_sync_sources WHERE host_id = $1`, hostID)
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM tasks WHERE id = $1`, taskID)
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM projects WHERE id = $1`, projectID)
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM host_registrations WHERE id = $1`, hostID)
		_, _ = db.Pool().Exec(cleanupCtx, `DELETE FROM auth_users WHERE id = $1`, userID)
	})

	service := codex.NewService(db.Pool(), nil, hosts.NewService(db.Pool()), projects.NewService(db.Pool(), nil))
	principal := auth.Principal{UserID: userID}
	first, firstErr := service.UpdateTitle(ctx, principal, hostID, threadID, protocol.CodexTitleUpdateRequest{RequestID: "title-request-offline-" + suffix, Title: "离线标题"})
	if !errors.Is(firstErr, codex.ErrSourceUnavailable) {
		t.Fatalf("offline UpdateTitle() error = %v, want source unavailable", firstErr)
	}
	if first.ConversationTitle != "离线标题" || first.TitleSyncState != protocol.CodexTitleSyncStatePaused {
		t.Fatalf("offline projected title = %+v", first)
	}
	var desired, operationState, operationError string
	if err := db.Pool().QueryRow(ctx, `SELECT desired_title, state, last_error FROM codex_title_operations WHERE request_id = $1`, "title-request-offline-"+suffix).Scan(&desired, &operationState, &operationError); err != nil {
		t.Fatalf("read offline title operation: %v", err)
	}
	if desired != "离线标题" || operationState != "title_sync_paused" || operationError == "" {
		t.Fatalf("offline title operation = (%q, %q, %q)", desired, operationState, operationError)
	}

	if _, err := db.Pool().Exec(ctx, `UPDATE codex_sync_sources SET state = 'online', capabilities = '[]'::jsonb, updated_at = $2 WHERE host_id = $1`, hostID, now.Add(time.Minute)); err != nil {
		t.Fatalf("make Codex source online without title capability: %v", err)
	}
	second, secondErr := service.UpdateTitle(ctx, principal, hostID, threadID, protocol.CodexTitleUpdateRequest{RequestID: "title-request-unsupported-" + suffix, Title: "能力缺失标题"})
	if !errors.Is(secondErr, codex.ErrCapabilityUnsupported) {
		t.Fatalf("unsupported UpdateTitle() error = %v, want capability unsupported", secondErr)
	}
	if second.ConversationTitle != "能力缺失标题" || second.TitleSyncState != protocol.CodexTitleSyncStateUnsupported {
		t.Fatalf("unsupported projected title = %+v", second)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT state, last_error FROM codex_title_operations WHERE request_id = $1`, "title-request-unsupported-"+suffix).Scan(&operationState, &operationError); err != nil {
		t.Fatalf("read unsupported title operation: %v", err)
	}
	if operationState != "title_sync_failed" || operationError == "" {
		t.Fatalf("unsupported title operation = (%q, %q)", operationState, operationError)
	}
}

func stringPointer(value string) *string { return &value }
