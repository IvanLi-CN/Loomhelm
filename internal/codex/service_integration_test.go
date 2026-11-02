package codex_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/codex"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
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

}

func stringPointer(value string) *string { return &value }
