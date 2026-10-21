package artifacts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestValidateArtifactRejectsHostPathIdentifiers(t *testing.T) {
	valid := protocol.Artifact{
		ID:          "artifact-valid",
		SessionID:   "session-valid",
		Name:        "conversation.bin",
		Kind:        protocol.ArtifactKindFile,
		Size:        1,
		ContentType: "application/octet-stream",
	}
	for _, id := range []string{"../outside", "..", ".", "/absolute", `..\\outside`, "artifact/child", " artifact", "artifact\x00file"} {
		t.Run(id, func(t *testing.T) {
			candidate := valid
			candidate.ID = id
			if _, _, err := validateArtifact(candidate, DefaultMaxBytes); !errors.Is(err, ErrInvalid) {
				t.Fatalf("validation error = %v, want %v", err, ErrInvalid)
			}
		})
	}
}

func TestStorePutDeniesBeforeWritingWhenAuthorizationIsMissing(t *testing.T) {
	root := t.TempDir()
	objects := filepath.Join(root, "objects")
	if err := prepareDirectory(objects, 0o700); err != nil {
		t.Fatal(err)
	}
	store := &Store{root: root, objects: objects, maxBytes: DefaultMaxBytes, authorizer: DenyAllAuthorizer{}}
	artifact := testArtifact("artifact-denied", nil, []byte("private"))
	_, err := store.Put(context.Background(), artifact, strings.NewReader("private"))
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Put error = %v, want %v", err, ErrUnauthorized)
	}
	entries, err := os.ReadDir(objects)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("staged files after denial = %d, want 0", len(entries))
	}
}

func TestStoreRejectsUnsupportedInputBeforeStaging(t *testing.T) {
	root := t.TempDir()
	objects := filepath.Join(root, "objects")
	if err := prepareDirectory(objects, 0o700); err != nil {
		t.Fatal(err)
	}
	store := &Store{root: root, objects: objects, maxBytes: DefaultMaxBytes, authorizer: allowAllAuthorizer{}}
	artifact := testArtifact("artifact-input", nil, []byte("input"))
	_, err := store.Put(context.Background(), artifact, strings.NewReader("input"))
	if !errors.Is(err, ErrInputNotCancellable) {
		t.Fatalf("Put error = %v, want %v", err, ErrInputNotCancellable)
	}
	assertNoStagingFiles(t, objects)
}

func TestOpenStoredFileRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(target, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(root, "artifact-link")
	if err := os.Symlink(target, symlink); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	_, err := openStoredFile(symlink)
	if !errors.Is(err, ErrIntegrity) {
		t.Fatalf("open symlink error = %v, want %v", err, ErrIntegrity)
	}
}

func TestStorePutMetadataOpenAndReopen(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte{0x00, 0xff, '\n', '<', 's', 'c', 'r', 'i', 'p', 't', '>'}
	runID := uniqueID("run")
	artifact := testArtifact(uniqueID("artifact"), &runID, content)
	stored, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Sha256 != artifact.Sha256 || stored.Size != int64(len(content)) || stored.RunID == nil || *stored.RunID != runID {
		t.Fatalf("stored metadata = %#v", stored)
	}
	metadata, err := store.Metadata(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(metadata, stored) {
		t.Fatalf("metadata = %#v, want %#v", metadata, stored)
	}
	openedMetadata, reader, err := store.Open(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	closeErr := reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	if !reflect.DeepEqual(openedMetadata, stored) || !bytes.Equal(readBack, content) {
		t.Fatalf("opened metadata/bytes = %#v/%x, want %#v/%x", openedMetadata, readBack, stored, content)
	}

	root := store.root
	db.Close()
	db = reopenIntegrationDatabase(t, ctx)
	defer db.Close()
	reopened, err := NewStore(db.Pool(), Config{Root: root, Authorizer: allowAllAuthorizer{}})
	if err != nil {
		t.Fatal(err)
	}
	reopenedMetadata, err := reopened.Metadata(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reopenedMetadata, stored) {
		t.Fatalf("reopened metadata = %#v, want %#v", reopenedMetadata, stored)
	}
	reopenedMetadata, reader, err = reopened.Open(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	reopenedBytes, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reopenedMetadata, stored) || !bytes.Equal(reopenedBytes, content) {
		t.Fatalf("reopened metadata/bytes = %#v/%x, want %#v/%x", reopenedMetadata, reopenedBytes, stored, content)
	}
}

func TestStoreRejectsMismatchesAndInterruptedUploads(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("complete content")

	wrongHash := testArtifact(uniqueID("artifact-hash"), nil, content)
	wrongHash.Sha256 = strings.Repeat("0", sha256.Size*2)
	if _, err := store.Put(ctx, wrongHash, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("hash mismatch error = %v, want %v", err, ErrHashMismatch)
	}

	wrongSize := testArtifact(uniqueID("artifact-size"), nil, content)
	wrongSize.Size++
	if _, err := store.Put(ctx, wrongSize, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrSizeMismatch) {
		t.Fatalf("size mismatch error = %v, want %v", err, ErrSizeMismatch)
	}

	interrupted := testArtifact(uniqueID("artifact-interrupted"), nil, content)
	if _, err := store.Put(ctx, interrupted, &failingReader{data: content[:5], err: errors.New("upload interrupted")}); err == nil || !strings.Contains(err.Error(), "write artifact bytes") {
		t.Fatalf("interrupted upload error = %v", err)
	}
	for _, id := range []string{wrongHash.ID, wrongSize.ID, interrupted.ID} {
		if _, err := store.Metadata(ctx, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("metadata for rejected %s = %v, want %v", id, err, ErrNotFound)
		}
	}
	assertNoStagingFiles(t, store.objects)
}

func TestStageHonorsCancellationBeforeWriting(t *testing.T) {
	root := t.TempDir()
	objects := filepath.Join(root, "objects")
	if err := prepareDirectory(objects, 0o700); err != nil {
		t.Fatal(err)
	}
	objects, err := filepath.EvalSymlinks(objects)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("cancelled content")
	store := &Store{objects: objects, maxBytes: DefaultMaxBytes}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := store.stage(ctx, testArtifact("artifact-cancelled", nil, content), "", bytes.NewReader(content)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled stage error = %v, want %v", err, context.Canceled)
	}
	assertNoStagingFiles(t, objects)
}

func TestStoreRetriesImmutableArtifactAndRejectsConflicts(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("retryable content")
	artifact := testArtifact(uniqueID("artifact-retry"), nil, content)
	first, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(second, first) {
		t.Fatalf("retry metadata = %#v, want %#v", second, first)
	}
	conflicting := testArtifact(artifact.ID, nil, []byte("different content"))
	if _, err := store.Put(ctx, conflicting, readCloser(bytes.NewReader([]byte("different content")))); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting retry error = %v, want %v", err, ErrConflict)
	}
	opened, reader, err := store.Open(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(opened, first) || !bytes.Equal(readBack, content) {
		t.Fatalf("conflicting retry changed publication: %#v/%q", opened, readBack)
	}
}

func TestStoreRejectsAssociationAndImmutableMetadataConflicts(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("immutable metadata")
	artifact := testArtifact(uniqueID("artifact-metadata-conflicts"), nil, content)
	stored, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	runID := "run-other"
	variants := []struct {
		name   string
		mutate func(*protocol.Artifact)
	}{
		{name: "session", mutate: func(candidate *protocol.Artifact) { candidate.SessionID = "session-other" }},
		{name: "run", mutate: func(candidate *protocol.Artifact) { candidate.RunID = &runID }},
		{name: "name", mutate: func(candidate *protocol.Artifact) { candidate.Name = "other.bin" }},
		{name: "kind", mutate: func(candidate *protocol.Artifact) { candidate.Kind = protocol.ArtifactKindDiff }},
		{name: "content type", mutate: func(candidate *protocol.Artifact) { candidate.ContentType = "text/plain" }},
	}
	for _, variant := range variants {
		t.Run(variant.name, func(t *testing.T) {
			candidate := artifact
			variant.mutate(&candidate)
			if _, err := store.Put(ctx, candidate, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrConflict) {
				t.Fatalf("%s conflict error = %v, want %v", variant.name, err, ErrConflict)
			}
		})
	}
	metadata, reader, err := store.Open(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || !reflect.DeepEqual(metadata, stored) || !bytes.Equal(readBack, content) {
		t.Fatalf("metadata conflict changed publication: %#v/%q, err=%v", metadata, readBack, err)
	}
}

func TestStoreRetainsStagingWhenRecoveryConflictsAfterIntentCommit(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("post-commit conflict")
	artifact := testArtifact(uniqueID("artifact-post-commit-conflict"), nil, content)
	conflictingBytes := []byte("conflicting final")
	var recoveryErr error
	store.faults = &faultHooks{
		AfterIntentCommit: func() {
			finalPath := filepath.Join(store.objects, artifact.ID)
			if err := os.WriteFile(finalPath, conflictingBytes, 0o600); err != nil {
				recoveryErr = err
				return
			}
			_, recoveryErr = store.Recover(ctx, MaxRecoveryLimit)
		},
	}
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrConflict) {
		t.Fatalf("post-commit conflict error = %v, want %v", err, ErrConflict)
	}
	if recoveryErr != nil {
		t.Fatalf("conflicting recovery error = %v", recoveryErr)
	}
	var stagingName, state string
	if err := db.Pool().QueryRow(ctx, `SELECT staging_name, state FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&stagingName, &state); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationUnavailable) || stagingName == "" {
		t.Fatalf("post-commit conflict state = %q, staging = %q", state, stagingName)
	}
	if _, err := os.Stat(filepath.Join(store.objects, stagingName)); err != nil {
		t.Fatalf("referenced staging object was removed: %v", err)
	}
}

func TestStoreRecoveryReclaimsReadyStagingAcrossBoundedBatches(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("ready staging cleanup")
	for index := 0; index < 2; index++ {
		artifact := testArtifact(uniqueID(fmt.Sprintf("artifact-ready-staging-%d", index)), nil, content)
		stagingName := fmt.Sprintf(".upload-ready-%d-%d", index, time.Now().UnixNano())
		if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
			t.Fatal(err)
		}
		insertReadyArtifact(t, db.Pool(), ctx, artifact, stagingName)
	}
	first, err := store.Recover(ctx, 1)
	if err != nil || first.Ready != 1 {
		t.Fatalf("first ready cleanup = %#v, err=%v", first, err)
	}
	second, err := store.Recover(ctx, 1)
	if err != nil || second.Ready != 1 {
		t.Fatalf("second ready cleanup = %#v, err=%v", second, err)
	}
	assertNoStagingFiles(t, store.objects)
}

func TestStoreRecoveryPreservesReadyStagingWhenFinalIsInvalid(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("ready staging must survive")
	for index, finalContent := range [][]byte{nil, []byte("corrupt final")} {
		artifact := testArtifact(uniqueID(fmt.Sprintf("artifact-ready-invalid-%d", index)), nil, content)
		stagingName := fmt.Sprintf(".upload-invalid-%d-%d", index, time.Now().UnixNano())
		if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
			t.Fatal(err)
		}
		if finalContent != nil {
			if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), finalContent, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		insertReadyArtifact(t, db.Pool(), ctx, artifact, stagingName)
	}
	report, err := store.Recover(ctx, 2)
	if err != nil || report.Unavailable != 2 {
		t.Fatalf("invalid ready recovery = %#v, err=%v", report, err)
	}
	entries, err := os.ReadDir(store.objects)
	if err != nil {
		t.Fatal(err)
	}
	stagingCount := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".upload-invalid-") {
			stagingCount++
		}
	}
	if stagingCount != 2 {
		t.Fatalf("invalid ready staging count = %d, want 2", stagingCount)
	}
}

func TestStoreRecoveryDefersFailedReadyCleanupWithoutStarvingRetry(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("ready cleanup retry")
	failed := testArtifact("artifact-reclaim-failed-"+fmt.Sprint(time.Now().UnixNano()), nil, content)
	failedStaging := ".upload-reclaim-failed-" + fmt.Sprint(time.Now().UnixNano())
	failedPath := filepath.Join(store.objects, failedStaging)
	if err := os.Mkdir(failedPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(failedPath, "keep"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, failed.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifactAt(t, db.Pool(), ctx, failed, failedStaging, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))

	healthy := testArtifact("artifact-reclaim-healthy-"+fmt.Sprint(time.Now().UnixNano()), nil, content)
	healthyStaging := ".upload-reclaim-healthy-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, healthyStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, healthy.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifactAt(t, db.Pool(), ctx, healthy, healthyStaging, time.Date(2000, 1, 2, 0, 0, 0, 0, time.UTC))
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaim_after = CASE id WHEN $1 THEN TIMESTAMPTZ '2000-01-01' ELSE TIMESTAMPTZ '2000-01-02' END
		WHERE id IN ($1, $2)
	`, failed.ID, healthy.ID); err != nil {
		t.Fatal(err)
	}

	first, err := store.Recover(ctx, 1)
	if !errors.Is(err, ErrRecoveryIncomplete) || first.Failed != 1 || first.Scanned != 1 {
		t.Fatalf("failed cleanup recovery = %#v, err=%v", first, err)
	}
	var retryAt time.Time
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaim_after FROM conversation_artifacts WHERE id = $1`, failed.ID).Scan(&retryAt); err != nil {
		t.Fatal(err)
	}
	if !retryAt.After(time.Now()) {
		t.Fatalf("failed cleanup retry_at = %s, want a deferred time", retryAt)
	}

	second, err := store.Recover(ctx, 1)
	if err != nil || second.Ready != 1 {
		t.Fatalf("healthy cleanup recovery = %#v, err=%v", second, err)
	}
	if _, err := os.Stat(filepath.Join(store.objects, healthyStaging)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("healthy staging error = %v, want missing", err)
	}

	if err := os.Remove(filepath.Join(failedPath, "keep")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(failedPath); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifacts SET staging_reclaim_after = NOW() WHERE id = $1`, failed.ID); err != nil {
		t.Fatal(err)
	}
	third, err := store.Recover(ctx, 1)
	if err != nil || third.Ready != 1 {
		t.Fatalf("retried cleanup recovery = %#v, err=%v", third, err)
	}
	var reclaimed bool
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaimed_at IS NOT NULL FROM conversation_artifacts WHERE id = $1`, failed.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if !reclaimed {
		t.Fatal("failed cleanup was not marked reclaimed after retry")
	}
}

func TestStoreRecoveryDefersPendingFailuresForFairness(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("pending cleanup retry")
	failed := testArtifact("artifact-pending-failed-"+fmt.Sprint(time.Now().UnixNano()), nil, content)
	insertPendingArtifactAt(t, db.Pool(), ctx, failed, ".upload-pending-failed", time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.deferArtifactRecovery(failed.ID, cleanup)

	healthy := testArtifact("artifact-pending-healthy-"+fmt.Sprint(time.Now().UnixNano()), nil, content)
	healthyStaging := ".upload-pending-healthy-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, healthyStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertPendingArtifactAt(t, db.Pool(), ctx, healthy, healthyStaging, time.Date(2000, 1, 2, 0, 0, 0, 0, time.UTC))
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaim_after = TIMESTAMPTZ '2000-01-02'
		WHERE id = $1
	`, healthy.ID); err != nil {
		t.Fatal(err)
	}

	first, err := store.Recover(ctx, 1)
	if err != nil || first.Ready != 1 || first.Failed != 0 {
		t.Fatalf("healthy pending recovery = %#v, err=%v", first, err)
	}
	var retryAt time.Time
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaim_after FROM conversation_artifacts WHERE id = $1`, failed.ID).Scan(&retryAt); err != nil {
		t.Fatal(err)
	}
	if !retryAt.After(time.Now()) {
		t.Fatalf("pending retry_at = %s, want a deferred time", retryAt)
	}

	failedStaging := ".upload-pending-failed-retry-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, failedStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifacts SET staging_name = $2, staging_reclaim_after = NOW() - INTERVAL '1 day' WHERE id = $1`, failed.ID, failedStaging); err != nil {
		t.Fatal(err)
	}
	second, err := store.Recover(ctx, 1)
	if err != nil || second.Ready != 1 {
		t.Fatalf("retried pending recovery = %#v, err=%v", second, err)
	}
}

func TestStoreRecoveryRechecksPersistedRetryDeadline(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("retry deadline recheck")
	artifact := testArtifact(uniqueID("artifact-retry-recheck"), nil, content)
	stagingName := ".upload-retry-recheck-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertPendingArtifactAt(t, db.Pool(), ctx, artifact, stagingName, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifacts SET staging_reclaim_after = NOW() WHERE id = $1`, artifact.ID); err != nil {
		t.Fatal(err)
	}
	var updateErr error
	store.faults = &faultHooks{
		BeforeIdentityLock: func(lockCtx context.Context, _ pgx.Tx, id string) {
			if id != artifact.ID {
				return
			}
			_, updateErr = db.Pool().Exec(lockCtx, `
				UPDATE conversation_artifacts
				SET staging_reclaim_after = NOW() + INTERVAL '1 minute'
				WHERE id = $1
			`, id)
		},
	}
	_, status, err := store.reconcileOneForRecovery(ctx, artifact.ID, nil)
	if err != nil {
		t.Fatalf("stale recovery error = %v", err)
	}
	if updateErr != nil {
		t.Fatalf("persist retry update error = %v", updateErr)
	}
	if status != recoveryPending {
		t.Fatalf("stale recovery status = %q, want pending", status)
	}
	var state string
	if err := db.Pool().QueryRow(ctx, `SELECT state FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationPending) {
		t.Fatalf("stale recovery state = %q, want pending", state)
	}
}

func TestStoreRecoveryRechecksReadyRetryDeadline(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("ready retry deadline recheck")
	artifact := testArtifact(uniqueID("artifact-ready-retry-recheck"), nil, content)
	stagingName := ".upload-ready-retry-recheck-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifactAt(t, db.Pool(), ctx, artifact, stagingName, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifacts SET staging_reclaim_after = NOW() WHERE id = $1`, artifact.ID); err != nil {
		t.Fatal(err)
	}
	var updateErr error
	store.faults = &faultHooks{
		BeforeIdentityLock: func(lockCtx context.Context, _ pgx.Tx, id string) {
			if id != artifact.ID {
				return
			}
			_, updateErr = db.Pool().Exec(lockCtx, `
				UPDATE conversation_artifacts
				SET staging_reclaim_after = NOW() + INTERVAL '1 minute'
				WHERE id = $1
			`, id)
		},
	}
	_, status, err := store.reclaimReadyStagingForRecovery(ctx, artifact.ID, nil)
	if err != nil {
		t.Fatalf("stale ready recovery error = %v", err)
	}
	if updateErr != nil {
		t.Fatalf("persist ready retry update error = %v", updateErr)
	}
	if status != recoveryPending {
		t.Fatalf("stale ready recovery status = %q, want pending", status)
	}
	if _, err := os.Stat(filepath.Join(store.objects, stagingName)); err != nil {
		t.Fatalf("stale ready recovery removed staging: %v", err)
	}
}

func TestStoreRecoveryDefersReadyFailuresForFairness(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("ready recovery retry")
	failed := testArtifact("artifact-ready-failed-"+fmt.Sprint(time.Now().UnixNano()), nil, content)
	failedStaging := ".upload-ready-failed-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, failedStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, failed.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifactAt(t, db.Pool(), ctx, failed, failedStaging, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.deferArtifactRecovery(failed.ID, cleanup)

	healthy := testArtifact("artifact-ready-healthy-"+fmt.Sprint(time.Now().UnixNano()), nil, content)
	healthyStaging := ".upload-ready-healthy-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, healthyStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, healthy.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifactAt(t, db.Pool(), ctx, healthy, healthyStaging, time.Date(2000, 1, 2, 0, 0, 0, 0, time.UTC))
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaim_after = TIMESTAMPTZ '2000-01-02'
		WHERE id = $1
	`, healthy.ID); err != nil {
		t.Fatal(err)
	}

	first, err := store.Recover(ctx, 1)
	if err != nil || first.Ready != 1 {
		t.Fatalf("healthy ready recovery = %#v, err=%v", first, err)
	}
	var retryAt time.Time
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaim_after FROM conversation_artifacts WHERE id = $1`, failed.ID).Scan(&retryAt); err != nil {
		t.Fatal(err)
	}
	if !retryAt.After(time.Now()) {
		t.Fatalf("ready retry_at = %s, want a deferred time", retryAt)
	}
}

func TestStoreRetriesKnownUnreferencedStagingCleanupDebt(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	stagingName := ".upload-cleanup-debt-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.Mkdir(stagingPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stagingPath, "keep"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.enqueueStagingCleanup(stagingName, cleanup)
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("cleanup debt rows = %d, want 1", queued)
	}
	if err := store.recoverStagingCleanup(ctx, stagingName, cleanup); err == nil {
		t.Fatal("cleanup unexpectedly succeeded for non-empty staging directory")
	}
	var retryAt time.Time
	if err := db.Pool().QueryRow(ctx, `SELECT retry_after FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&retryAt); err != nil {
		t.Fatal(err)
	}
	if !retryAt.After(time.Now()) {
		t.Fatalf("cleanup retry_at = %s, want a deferred time", retryAt)
	}
	if err := os.Remove(filepath.Join(stagingPath, "keep")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(stagingPath); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifact_staging_cleanup SET retry_after = NOW() WHERE staging_name = $1`, stagingName); err != nil {
		t.Fatal(err)
	}
	if err := store.recoverStagingCleanup(ctx, stagingName, cleanup); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("cleanup debt rows after retry = %d, want 0", queued)
	}
}

func TestStoreCleanupDebtSkipsActiveStagingReference(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("active staging reference")
	stagingName := ".upload-cleanup-active-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.enqueueStagingCleanup(stagingName, cleanup)
	artifact := testArtifact(uniqueID("artifact-cleanup-active"), nil, content)
	insertPendingArtifact(t, db.Pool(), ctx, artifact, stagingName)
	if err := store.recoverStagingCleanup(ctx, stagingName, cleanup); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store.objects, stagingName)); err != nil {
		t.Fatalf("active staging was removed: %v", err)
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("active cleanup debt rows = %d, want 0", queued)
	}
}

func TestStoreCleanupDebtRechecksRetryDeadline(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	stagingName := ".upload-cleanup-retry-recheck-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, []byte("retry later"), 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.enqueueStagingCleanup(stagingName, cleanup)
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifact_staging_cleanup
		SET retry_after = NOW() + INTERVAL '1 minute'
		WHERE staging_name = $1
	`, stagingName); err != nil {
		t.Fatal(err)
	}
	if err := store.recoverStagingCleanup(ctx, stagingName, cleanup); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stagingPath); err != nil {
		t.Fatalf("deferred cleanup removed staging: %v", err)
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("deferred cleanup debt rows = %d, want 1", queued)
	}
}

func TestStoreHoldsIdentityLockThroughReadyStagingRemoval(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("ready cleanup lock")
	artifact := testArtifact(uniqueID("artifact-reclaim-lock"), nil, content)
	stagingName := ".upload-reclaim-lock-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, db.Pool(), ctx, artifact, stagingName)

	removalStarted := make(chan struct{})
	contenderAttempted := make(chan struct{})
	var attemptCount atomic.Int32
	var removalOnce sync.Once
	store.faults = &faultHooks{
		BeforeIdentityLock: func(context.Context, pgx.Tx, string) {
			if attemptCount.Add(1) == 2 {
				close(contenderAttempted)
			}
		},
		BeforeReadyStagingRemoval: func() {
			removalOnce.Do(func() { close(removalStarted) })
			<-contenderAttempted
			time.Sleep(100 * time.Millisecond)
		},
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	reclaimResult := make(chan error, 1)
	go func() {
		_, _, err := store.reclaimReadyStaging(ctx, artifact.ID, cleanup)
		reclaimResult <- err
	}()
	select {
	case <-removalStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("ready cleanup did not reach staging removal")
	}
	contenderContext, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	contenderResult := make(chan error, 1)
	go func() {
		_, _, err := store.reconcileOne(contenderContext, artifact.ID, nil)
		contenderResult <- err
	}()
	select {
	case err := <-contenderResult:
		t.Fatalf("contender completed while cleanup held identity lock: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := <-reclaimResult; err != nil {
		t.Fatal(err)
	}
	if err := <-contenderResult; err != nil {
		t.Fatal(err)
	}
}

func TestNewStoreCreatesPrivateNestedRoot(t *testing.T) {
	db, _, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	root := filepath.Join(t.TempDir(), "missing", "nested", "artifact-root")
	store, err := NewStore(db.Pool(), Config{Root: root, Authorizer: allowAllAuthorizer{}})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{store.root, store.objects} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !info.IsDir() || info.Mode().Perm() != 0o700 {
			t.Fatalf("directory %s mode = %o, want 0700", path, info.Mode().Perm())
		}
	}
	content := []byte("nested root")
	if _, err := store.Put(ctx, testArtifact(uniqueID("artifact-nested-root"), nil, content), readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
}

func TestStorePutReclaimsUnmarkedReadyStaging(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("ready retry cleanup")
	artifact := testArtifact(uniqueID("artifact-ready-retry"), nil, content)
	stagingName := ".upload-ready-retry-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, db.Pool(), ctx, artifact, stagingName)
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store.objects, stagingName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("ready retry staging error = %v, want missing", err)
	}
	var reclaimed bool
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaimed_at IS NOT NULL FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if !reclaimed {
		t.Fatal("ready retry did not persist staging reclamation")
	}
}

func TestStoreEnforcesConfiguredMaxBytesAtBothBoundaries(t *testing.T) {
	db, _, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	store, err := NewStore(db.Pool(), Config{Root: t.TempDir(), MaxBytes: 8, Authorizer: allowAllAuthorizer{}})
	if err != nil {
		t.Fatal(err)
	}
	exact := []byte("12345678")
	if _, err := store.Put(ctx, testArtifact(uniqueID("artifact-max-exact"), nil, exact), readCloser(bytes.NewReader(exact))); err != nil {
		t.Fatalf("exact configured limit error = %v", err)
	}
	oversized := []byte("123456789")
	declaredOversizedArtifact := testArtifact(uniqueID("artifact-max-declared-over"), nil, oversized)
	if _, err := store.Put(ctx, declaredOversizedArtifact, readCloser(bytes.NewReader(oversized))); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("declared over-limit error = %v, want %v", err, ErrTooLarge)
	}
	oversizedArtifact := testArtifact(uniqueID("artifact-max-over"), nil, exact)
	if _, err := store.Put(ctx, oversizedArtifact, readCloser(bytes.NewReader(oversized))); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("over-limit error = %v, want %v", err, ErrTooLarge)
	}
	if _, err := store.Metadata(ctx, oversizedArtifact.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("over-limit metadata error = %v, want %v", err, ErrNotFound)
	}
	assertNoStagingFiles(t, store.objects)
}

func TestStoreRecoveryMarksMissingStagingUnavailable(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("unavailable content")
	artifact := testArtifact(uniqueID("artifact-unavailable"), nil, content)
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, unavailable_reason
		) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'pending', $8, '')
	`, artifact.ID, artifact.SessionID, artifact.Name, string(artifact.Kind), artifact.Size, artifact.Sha256, artifact.ContentType, ".upload-missing"); err != nil {
		t.Fatal(err)
	}
	report, err := store.Recover(ctx, MaxRecoveryLimit)
	if err != nil {
		t.Fatal(err)
	}
	if report.Unavailable < 1 {
		t.Fatalf("recovery report = %#v, want an unavailable publication", report)
	}
	if _, err := store.Metadata(ctx, artifact.ID); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unavailable metadata error = %v, want %v", err, ErrUnavailable)
	}
}

func TestStoreKeepsDurableStagingWhenDatabaseCommitIsUnavailable(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	content := []byte("preserve this staging")
	artifact := testArtifact(uniqueID("artifact-db-down"), nil, content)
	db.Close()
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err == nil {
		t.Fatal("Put succeeded with a closed database")
	}
	entries, err := os.ReadDir(store.objects)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("durable staging was deleted after an uncertain database operation")
	}
}

func TestStoreResolvesLostCommitResponsesFromDurableState(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	store.faults = &faultHooks{
		CommitResponseLost: func() error { return errors.New("simulated commit response loss") },
	}
	content := []byte("lost commit response")
	artifact := testArtifact(uniqueID("artifact-lost-commit"), nil, content)
	stored, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	if stored.ID != artifact.ID {
		t.Fatalf("stored metadata = %#v", stored)
	}
	metadata, reader, err := store.Open(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || metadata.ID != artifact.ID || !bytes.Equal(readBack, content) {
		t.Fatalf("lost-response publication = %#v/%q, err=%v", metadata, readBack, err)
	}
}

func TestStoreResolvesLostRepairIntentCommitResponse(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("lost repair response")
	artifact := testArtifact(uniqueID("artifact-lost-repair"), nil, content)
	insertUnavailableArtifact(t, db.Pool(), ctx, artifact, "staging-missing")
	store.faults = &faultHooks{
		CommitResponseLost: func() error { return errors.New("simulated repair commit response loss") },
	}
	stored, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	if stored.ID != artifact.ID {
		t.Fatalf("stored repaired metadata = %#v", stored)
	}
	metadata, reader, err := store.Open(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || metadata.ID != artifact.ID || !bytes.Equal(readBack, content) {
		t.Fatalf("lost-response repair publication = %#v/%q, err=%v", metadata, readBack, err)
	}
	assertNoStagingFiles(t, store.objects)
}

func TestStoreRejectsLongContentTypeBeforeStaging(t *testing.T) {
	content := []byte("content")
	artifact := testArtifact("artifact-content-type", nil, content)
	artifact.ContentType = strings.Repeat("a", 256)
	if _, _, err := validateArtifact(artifact, DefaultMaxBytes); !errors.Is(err, ErrInvalid) {
		t.Fatalf("long content type error = %v, want %v", err, ErrInvalid)
	}
}

func TestStoreCancellationAfterIntentDoesNotBlockOtherUpload(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	firstContext, cancelFirst := context.WithCancel(ctx)
	defer cancelFirst()
	intentStarted := make(chan struct{})
	var intentOnce sync.Once
	store.faults = &faultHooks{
		AfterIntentCommit: func() {
			intentOnce.Do(func() { close(intentStarted) })
			<-firstContext.Done()
		},
	}
	firstContent := []byte("cancelled after intent")
	secondContent := []byte("unrelated upload")
	firstResult := make(chan error, 1)
	go func() {
		_, err := store.Put(firstContext, testArtifact(uniqueID("artifact-cancel-after-intent"), nil, firstContent), readCloser(bytes.NewReader(firstContent)))
		firstResult <- err
	}()
	select {
	case <-intentStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("first upload did not reach committed intent")
	}
	secondResult := make(chan error, 1)
	secondID := uniqueID("artifact-unrelated")
	go func() {
		_, err := store.Put(ctx, testArtifact(secondID, nil, secondContent), readCloser(bytes.NewReader(secondContent)))
		secondResult <- err
	}()
	cancelFirst()
	select {
	case err := <-firstResult:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled after-intent error = %v, want %v", err, context.Canceled)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled after-intent upload did not return")
	}
	select {
	case err := <-secondResult:
		if err != nil {
			t.Fatalf("unrelated upload error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("unrelated upload was stalled by cancelled upload")
	}
	store.faults = nil
	report, err := store.Recover(ctx, MaxRecoveryLimit)
	if err != nil || report.Ready < 1 {
		t.Fatalf("cancelled intent recovery = %#v, err=%v", report, err)
	}
}

func TestStoreCancellationUsesSharedCleanupDeadlineForBlockedIdentityLock(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	id := uniqueID("artifact-cleanup-lock")
	holder, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(ctx)
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "loomhelm:artifact:"+id); err != nil {
		t.Fatal(err)
	}

	parent, cancel := context.WithCancel(ctx)
	cleanup := newCleanupDeadline(parent)
	defer cleanup.stop()
	cancel()
	cleanupContext, cleanupCancel := cleanup.context()
	defer cleanupCancel()
	started := time.Now()
	tx, err := store.beginIdentityTx(cleanupContext, id, cleanup)
	if tx != nil {
		rollbackTx(tx, cleanup)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked cleanup lock error = %v, want %v", err, context.DeadlineExceeded)
	}
	if elapsed := time.Since(started); elapsed > cleanupTimeout+time.Second {
		t.Fatalf("blocked cleanup lock elapsed %s, want no more than %s", elapsed, cleanupTimeout+time.Second)
	}
}

func TestCleanupContextExtendsWhenCancellationStartsAfterAllocation(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleanup := newCleanupDeadline(parent)
	defer cleanup.stop()
	cleanupContext, cleanupCancel := cleanup.context()
	defer cleanupCancel()
	time.Sleep(25 * time.Millisecond)
	cancel()
	cleanup.start()
	deadline, ok := cleanupContext.Deadline()
	if !ok {
		t.Fatal("cleanup context has no deadline")
	}
	if remaining := time.Until(deadline); remaining < cleanupTimeout-100*time.Millisecond {
		t.Fatalf("cleanup deadline remaining = %s, want at least %s after cancellation", remaining, cleanupTimeout-100*time.Millisecond)
	}
}

func TestStoreRoundsCreatedAtToDatabasePrecision(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("timestamp precision")
	artifact := testArtifact(uniqueID("artifact-time"), nil, content)
	artifact.CreatedAt = "2026-01-02T03:04:05.123456789Z"
	started := time.Now().UTC().Add(-time.Second)
	stored, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	createdAt, err := time.Parse(time.RFC3339Nano, stored.CreatedAt)
	if err != nil {
		t.Fatalf("stored created_at = %q: %v", stored.CreatedAt, err)
	}
	if !createdAt.After(started) || createdAt.After(time.Now().UTC().Add(time.Second)) {
		t.Fatalf("stored created_at = %q, want a server-assigned current timestamp", stored.CreatedAt)
	}
	retried, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	if err != nil || retried.CreatedAt != stored.CreatedAt {
		t.Fatalf("timestamp retry = %#v, err=%v; want persisted timestamp %q", retried, err, stored.CreatedAt)
	}
}

func TestStoreRedactsFilesystemPaths(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "missing-objects")
	store := &Store{root: root, objects: missing, maxBytes: DefaultMaxBytes, authorizer: allowAllAuthorizer{}}
	err := store.ensureObjectDirectory()
	if err == nil || strings.Contains(err.Error(), root) {
		t.Fatalf("filesystem error = %v, must be redacted and non-nil", err)
	}
}

func TestStoreRejectsUnauthorizedMetadataAndOpen(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("authorized bytes")
	artifact := testArtifact(uniqueID("artifact-auth"), nil, content)
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	denied, err := NewStore(db.Pool(), Config{Root: store.root, Authorizer: DenyAllAuthorizer{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := denied.Metadata(ctx, artifact.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unauthorized metadata error = %v, want %v", err, ErrNotFound)
	}
	if _, _, err := denied.Open(ctx, artifact.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unauthorized open error = %v, want %v", err, ErrNotFound)
	}
	unavailable := testArtifact(uniqueID("artifact-auth-unavailable"), nil, content)
	insertUnavailableArtifact(t, db.Pool(), ctx, unavailable, "operator-hold")
	if _, err := denied.Metadata(ctx, unavailable.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unauthorized unavailable metadata error = %v, want %v", err, ErrNotFound)
	}
	if _, _, err := denied.Open(ctx, unavailable.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unauthorized unavailable open error = %v, want %v", err, ErrNotFound)
	}
	if _, err := denied.Metadata(ctx, uniqueID("artifact-auth-missing")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing metadata error = %v, want %v", err, ErrNotFound)
	}
	if _, _, err := denied.Open(ctx, uniqueID("artifact-auth-missing-open")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing open error = %v, want %v", err, ErrNotFound)
	}
	if _, err := denied.Put(ctx, testArtifact(uniqueID("artifact-write-denied"), nil, content), bytes.NewReader(content)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unauthorized put error = %v, want %v", err, ErrUnauthorized)
	}
}

func TestStoreClosesAdmittedSourceExactlyOnce(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("close once")
	source := &countingReadCloser{Reader: bytes.NewReader(content)}
	if _, err := store.Put(ctx, testArtifact(uniqueID("artifact-close"), nil, content), source); err != nil {
		t.Fatal(err)
	}
	if got := source.closeCount.Load(); got != 1 {
		t.Fatalf("source close count = %d, want 1", got)
	}
}

func TestStoreCancellationClosesBlockedSourceAndReturns(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	putContext, cancel := context.WithCancel(ctx)
	source := newBlockingReadCloser()
	result := make(chan error, 1)
	go func() {
		_, err := store.Put(putContext, testArtifact(uniqueID("artifact-blocked"), nil, nil), source)
		result <- err
	}()
	select {
	case <-source.started:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked source was not read")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled Put error = %v, want %v", err, context.Canceled)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled Put did not return after source Close")
	}
	if got := source.closeCount.Load(); got != 1 {
		t.Fatalf("blocked source close count = %d, want 1", got)
	}
	assertNoStagingFiles(t, store.objects)
}

func TestStoreMetadataRevalidatesReadyBytesAndDoesNotRepairReadyLoss(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("ready bytes")
	artifact := testArtifact(uniqueID("artifact-ready-loss"), nil, content)
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(store.objects, artifact.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Metadata(ctx, artifact.ID); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing ready metadata error = %v, want %v", err, ErrUnavailable)
	}
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("retry after ready loss error = %v, want %v", err, ErrUnavailable)
	}
	if _, err := os.Stat(filepath.Join(store.objects, artifact.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("ready-loss retry recreated final object: %v", err)
	}
	assertNoStagingFiles(t, store.objects)
}

func TestStoreOpenMarksNonregularFinalUnavailable(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("nonregular final")
	artifact := testArtifact(uniqueID("artifact-nonregular-final"), nil, content)
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	finalPath := filepath.Join(store.objects, artifact.ID)
	outsidePath := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outsidePath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(finalPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsidePath, finalPath); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if _, _, err := store.Open(ctx, artifact.ID); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("nonregular final open error = %v, want %v", err, ErrUnavailable)
	}
	var state string
	if err := db.Pool().QueryRow(ctx, `SELECT state FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationUnavailable) {
		t.Fatalf("nonregular final state = %q, want %q", state, publicationUnavailable)
	}
}

func TestStoreRepairsOnlyNeverReadyMissingStaging(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("repairable bytes")
	artifact := testArtifact(uniqueID("artifact-repair"), nil, content)
	insertUnavailableArtifact(t, db.Pool(), ctx, artifact, "staging-missing")
	stored, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	if stored.ID != artifact.ID {
		t.Fatalf("repaired metadata = %#v", stored)
	}
	metadata, reader, err := store.Open(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || metadata.ID != artifact.ID || !bytes.Equal(readBack, content) {
		t.Fatalf("repaired publication = %#v/%q, err=%v", metadata, readBack, err)
	}
	assertNoStagingFiles(t, store.objects)

	corrupt := testArtifact(uniqueID("artifact-repair-corrupt"), nil, content)
	insertUnavailableArtifact(t, db.Pool(), ctx, corrupt, "staging-corrupt")
	if _, err := store.Put(ctx, corrupt, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatalf("staging-corrupt retry error = %v", err)
	}
	if _, _, err := store.Open(ctx, corrupt.ID); err != nil {
		t.Fatalf("staging-corrupt repaired Open error = %v", err)
	}
}

func TestStorePutRepairsMissingPendingStagingInOneAttempt(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("pending staging replacement")
	artifact := testArtifact(uniqueID("artifact-pending-repair"), nil, content)
	insertPendingArtifact(t, db.Pool(), ctx, artifact, ".upload-pending-missing")
	stored, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	if stored.ID != artifact.ID {
		t.Fatalf("stored metadata = %#v", stored)
	}
	metadata, reader, err := store.Open(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || metadata.ID != artifact.ID || !bytes.Equal(readBack, content) {
		t.Fatalf("repaired pending publication = %#v/%q, err=%v", metadata, readBack, err)
	}
}

func TestStoreRejectsRepairForUnknownReasonOrConflictingFinal(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("repair rejection")
	unknown := testArtifact(uniqueID("artifact-repair-unknown"), nil, content)
	insertUnavailableArtifact(t, db.Pool(), ctx, unknown, "operator-hold")
	if _, err := store.Put(ctx, unknown, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unknown-reason retry error = %v, want %v", err, ErrUnavailable)
	}

	conflict := testArtifact(uniqueID("artifact-repair-conflict"), nil, content)
	insertUnavailableArtifact(t, db.Pool(), ctx, conflict, "staging-missing")
	finalPath := filepath.Join(store.objects, conflict.ID)
	conflictingBytes := []byte("different final")
	if err := os.WriteFile(finalPath, conflictingBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(ctx, conflict, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting-final retry error = %v, want %v", err, ErrConflict)
	}
	readBack, err := os.ReadFile(finalPath)
	if err != nil || !bytes.Equal(readBack, conflictingBytes) {
		t.Fatalf("conflicting final changed: %q, err=%v", readBack, err)
	}
	assertNoStagingFiles(t, store.objects)
}

type allowAllAuthorizer struct{}

func (allowAllAuthorizer) Authorize(context.Context, Operation, protocol.Artifact) error { return nil }

type failingReader struct {
	data []byte
	err  error
}

func (r *failingReader) Read(buffer []byte) (int, error) {
	if len(r.data) > 0 {
		n := copy(buffer, r.data)
		r.data = r.data[n:]
		if len(r.data) == 0 {
			return n, r.err
		}
		return n, nil
	}
	return 0, r.err
}

func (r *failingReader) Close() error { return nil }

func readCloser(reader io.Reader) io.ReadCloser { return io.NopCloser(reader) }

type countingReadCloser struct {
	io.Reader
	closeCount atomic.Int32
}

func (r *countingReadCloser) Close() error {
	r.closeCount.Add(1)
	return nil
}

type blockingReadCloser struct {
	started    chan struct{}
	release    chan struct{}
	startOnce  sync.Once
	closeOnce  sync.Once
	closeCount atomic.Int32
}

func newBlockingReadCloser() *blockingReadCloser {
	return &blockingReadCloser{started: make(chan struct{}), release: make(chan struct{})}
}

func (r *blockingReadCloser) Read([]byte) (int, error) {
	r.startOnce.Do(func() { close(r.started) })
	<-r.release
	return 0, io.EOF
}

func (r *blockingReadCloser) Close() error {
	r.closeCount.Add(1)
	r.closeOnce.Do(func() { close(r.release) })
	return nil
}

func testArtifact(id string, runID *string, content []byte) protocol.Artifact {
	digest := sha256.Sum256(content)
	return protocol.Artifact{
		ID:          id,
		SessionID:   "session-artifact-test",
		RunID:       runID,
		Name:        "conversation.bin",
		Kind:        protocol.ArtifactKindFile,
		Size:        int64(len(content)),
		Sha256:      hex.EncodeToString(digest[:]),
		ContentType: "application/octet-stream",
	}
}

func assertNoStagingFiles(t *testing.T, objects string) {
	t.Helper()
	entries, err := os.ReadDir(objects)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".upload-") {
			t.Fatalf("staging file remains: %s", entry.Name())
		}
	}
}

func assertHasStagingFiles(t *testing.T, objects string) {
	t.Helper()
	entries, err := os.ReadDir(objects)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".upload-") {
			return
		}
	}
	t.Fatal("no staging file remains")
}

func insertUnavailableArtifact(t *testing.T, pool *pgxpool.Pool, ctx context.Context, artifact protocol.Artifact, reason string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, unavailable_reason
		) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'unavailable', $8, $9)
	`, artifact.ID, artifact.SessionID, artifact.Name, string(artifact.Kind), artifact.Size, artifact.Sha256, artifact.ContentType, ".upload-original", reason); err != nil {
		t.Fatal(err)
	}
}

func insertPendingArtifact(t *testing.T, pool *pgxpool.Pool, ctx context.Context, artifact protocol.Artifact, stagingName string) {
	insertPendingArtifactAt(t, pool, ctx, artifact, stagingName, time.Now().UTC())
}

func insertPendingArtifactAt(t *testing.T, pool *pgxpool.Pool, ctx context.Context, artifact protocol.Artifact, stagingName string, createdAt time.Time) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, unavailable_reason
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, '')
	`, artifact.ID, artifact.SessionID, artifact.Name, string(artifact.Kind), artifact.Size, artifact.Sha256, artifact.ContentType, createdAt, stagingName); err != nil {
		t.Fatal(err)
	}
}

func insertReadyArtifact(t *testing.T, pool *pgxpool.Pool, ctx context.Context, artifact protocol.Artifact, stagingName string) {
	insertReadyArtifactAt(t, pool, ctx, artifact, stagingName, time.Now().UTC())
}

func insertReadyArtifactAt(t *testing.T, pool *pgxpool.Pool, ctx context.Context, artifact protocol.Artifact, stagingName string, createdAt time.Time) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, unavailable_reason
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready', $9, '')
	`, artifact.ID, artifact.SessionID, artifact.Name, string(artifact.Kind), artifact.Size, artifact.Sha256, artifact.ContentType, createdAt, stagingName); err != nil {
		t.Fatal(err)
	}
}

func uniqueID(prefix string) string {
	return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
}

func openIntegrationStore(t *testing.T, authorizer Authorizer) (*database.DB, *Store, context.Context) {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("open integration database: %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		t.Fatalf("migrate integration database: %v", err)
	}
	if authorizer == nil {
		authorizer = allowAllAuthorizer{}
	}
	store, err := NewStore(db.Pool(), Config{Root: t.TempDir(), Authorizer: authorizer})
	if err != nil {
		db.Close()
		t.Fatalf("create integration store: %v", err)
	}
	return db, store, ctx
}

func reopenIntegrationDatabase(t *testing.T, ctx context.Context) *database.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("reopen integration database: %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		t.Fatalf("re-migrate integration database: %v", err)
	}
	return db
}
