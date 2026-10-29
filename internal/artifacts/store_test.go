package artifacts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
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

func TestValidateArtifactRejectsBidiFilenameControls(t *testing.T) {
	artifact := protocol.Artifact{
		ID: "artifact-valid", SessionID: "session-valid", Name: "report\u202Etxt.txt",
		Kind: protocol.ArtifactKindFile, Size: 1, ContentType: "application/octet-stream",
	}
	if _, _, err := validateArtifact(artifact, DefaultMaxBytes); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bidi filename validation error = %v, want %v", err, ErrInvalid)
	}
}

func TestConfigValidateRejectsFilesystemRoot(t *testing.T) {
	if _, err := (Config{Root: string(filepath.Separator)}).validate(); !errors.Is(err, ErrInvalid) {
		t.Fatalf("filesystem root validation error = %v, want %v", err, ErrInvalid)
	}
}

func TestStoreRemoveStagingIfIdentityPreservesReplacement(t *testing.T) {
	root := t.TempDir()
	objects := filepath.Join(root, "objects")
	if err := prepareDirectory(objects, 0o700); err != nil {
		t.Fatal(err)
	}
	store := &Store{objects: objects}
	stagingName := ".upload-identity-guard"
	stagingPath := filepath.Join(objects, stagingName)
	if err := os.WriteFile(stagingPath, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	expected, err := store.stagingIdentity(stagingName)
	if err != nil || expected == nil {
		t.Fatalf("original staging identity = %v/%v", expected, err)
	}
	replacementPath := stagingPath + "-replacement"
	if err := os.WriteFile(replacementPath, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(stagingPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacementPath, stagingPath); err != nil {
		t.Fatal(err)
	}
	if err := store.removeStagingIfIdentity(stagingName, expected); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(stagingPath)
	if err != nil || string(content) != "replacement" {
		t.Fatalf("replacement staging = %q, err=%v, want replacement", content, err)
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

func TestStoreSyncStagingDirectorySanitizesFilesystemErrors(t *testing.T) {
	privatePath := filepath.Join(t.TempDir(), "private-artifact-root", "objects")
	store := &Store{objects: privatePath}
	err := store.syncStagingDirectory()
	if err == nil {
		t.Fatal("sync staging directory unexpectedly succeeded")
	}
	if strings.Contains(err.Error(), privatePath) {
		t.Fatalf("sync staging directory error exposes private path: %v", err)
	}
	if !errors.Is(err, ErrStoreUnavailable) {
		t.Fatalf("sync staging directory error = %v, want %v", err, ErrStoreUnavailable)
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
	db, store, ctx := openMigratedIntegrationStore(t, nil)
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

func TestStoreOpenDoesNotQuarantineContentChangedDuringVerification(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("stable artifact bytes")
	replacement := []byte("changed artifact bytes")
	artifact := testArtifact(uniqueID("artifact-open-version"), nil, content)
	stagingName := ".upload-open-version-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, store, ctx, artifact, stagingName)
	store.faults = &faultHooks{
		BeforeOpenVerification: func() {
			if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), replacement, 0o600); err != nil {
				t.Fatalf("replace artifact during open verification: %v", err)
			}
		},
	}
	if _, _, err := store.Open(ctx, artifact.ID); !errors.Is(err, ErrContentChanged) {
		t.Fatalf("Open error = %v, want %v", err, ErrContentChanged)
	}
	var state string
	if err := db.Pool().QueryRow(ctx, `SELECT state FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationReady) {
		t.Fatalf("content-change state = %q, want %q", state, publicationReady)
	}
}

func TestStoreContentMismatchIsRecoverableAfterFinalVerification(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("recoverable artifact bytes")
	corrupt := bytes.Repeat([]byte("x"), len(content))
	artifact := testArtifact(uniqueID("artifact-content-mismatch"), nil, content)
	stagingName := ".upload-content-mismatch-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, store, ctx, artifact, stagingName)
	_, reader, err := store.OpenContent(ctx, artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	contentReader, ok := reader.(*contentReader)
	if !ok {
		_ = reader.Close()
		t.Fatalf("content reader type = %T, want *contentReader", reader)
	}
	verifyErr := contentReader.verifyContent(ctx, artifact)
	_ = reader.Close()
	if !errors.Is(verifyErr, ErrUnavailable) || !errors.Is(verifyErr, ErrHashMismatch) {
		t.Fatalf("content verification error = %v, want unavailable/hash-mismatch", verifyErr)
	}
	var state, reason string
	if err := db.Pool().QueryRow(ctx, `SELECT state, unavailable_reason FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&state, &reason); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationUnavailable) || reason != contentMismatchReason {
		t.Fatalf("content mismatch state = %q/%q, want unavailable/%q", state, reason, contentMismatchReason)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Recover(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Metadata(ctx, artifact.ID); err != nil {
		t.Fatalf("recovered artifact metadata error = %v", err)
	}
}

func TestStoreRejectsMismatchesAndInterruptedUploads(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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

func TestStoreStageFailureQueuesCleanupDebt(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("stage cleanup debt")
	artifact := testArtifact(uniqueID("artifact-stage-cleanup"), nil, content)
	var syncFailures atomic.Int32
	syncErr := errors.New("injected stage sync failure")
	store.faults = &faultHooks{
		BeforeStagingDirectorySync: func() error {
			if syncFailures.Add(1) <= 2 {
				return syncErr
			}
			return nil
		},
	}
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrStoreUnavailable) {
		t.Fatalf("stage sync failure = %v, want %v", err, ErrStoreUnavailable)
	}
	var artifactCount, cleanupCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&artifactCount); err != nil {
		t.Fatal(err)
	}
	var cleanupIdentity *string
	if err := db.Pool().QueryRow(ctx, `
		SELECT staging_identity
		FROM conversation_artifact_staging_cleanup
		LIMIT 1
	`).Scan(&cleanupIdentity); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup`).Scan(&cleanupCount); err != nil {
		t.Fatal(err)
	}
	if artifactCount != 0 || cleanupCount != 1 || cleanupIdentity == nil {
		t.Fatalf("stage failure durable rows = artifact %d/cleanup %d/identity %v, want 0/1/non-null", artifactCount, cleanupCount, cleanupIdentity)
	}
	assertNoStagingFiles(t, store.objects)

	store.faults = &faultHooks{CommitResponseLost: func() error { return errors.New("simulated cleanup commit response loss") }}
	if report, err := store.Recover(ctx, 1); err != nil || report.Cleaned != 1 {
		t.Fatalf("stage cleanup recovery = %#v, err=%v, want one cleaned item", report, err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup`).Scan(&cleanupCount); err != nil {
		t.Fatal(err)
	}
	if cleanupCount != 0 {
		t.Fatalf("stage cleanup debt after recovery = %d, want 0", cleanupCount)
	}
}

func TestStoreRetriesImmutableArtifactAndRejectsConflicts(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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

func TestStorePutHidesCrossSessionArtifactExistence(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("cross-session artifact")
	artifact := testArtifact(uniqueID("artifact-cross-session"), nil, content)
	artifact.SessionID = "session-owner"
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	requester, err := NewStore(db.Pool(), Config{
		Root: store.root,
		Authorizer: AuthorizerFunc(func(_ context.Context, _ Operation, candidate protocol.Artifact) error {
			if candidate.SessionID != "session-requester" {
				return ErrUnauthorized
			}
			return nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	candidate := artifact
	candidate.SessionID = "session-requester"
	if _, err := requester.Put(ctx, candidate, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-session existing artifact error = %v, want %v", err, ErrNotFound)
	}
	if report, err := requester.Recover(ctx, 1); err != nil || report.Cleaned != 1 {
		t.Fatalf("cross-session rejected staging recovery = %#v, err=%v, want one cleaned item", report, err)
	}
	assertNoStagingFiles(t, requester.objects)
}

func TestStoreRejectedStagingQueuesCleanupWithIdentity(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("cross-session cleanup identity")
	artifact := testArtifact(uniqueID("artifact-cross-session-cleanup"), nil, content)
	artifact.SessionID = "session-owner"
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	requester, err := NewStore(db.Pool(), Config{
		Root: store.root,
		Authorizer: AuthorizerFunc(func(_ context.Context, _ Operation, candidate protocol.Artifact) error {
			if candidate.SessionID != "session-requester" {
				return ErrUnauthorized
			}
			return nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	candidate := artifact
	candidate.SessionID = "session-requester"
	if _, err := requester.Put(ctx, candidate, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-session sync-failed cleanup error = %v, want %v", err, ErrNotFound)
	}
	var cleanupName string
	var cleanupIdentity *string
	if err := db.Pool().QueryRow(ctx, `
		SELECT staging_name, staging_identity
		FROM conversation_artifact_staging_cleanup
		LIMIT 1
	`).Scan(&cleanupName, &cleanupIdentity); err != nil {
		t.Fatal(err)
	}
	if cleanupName == "" || cleanupIdentity == nil {
		t.Fatalf("rejected staging cleanup = %q/%v, want a retained filesystem identity", cleanupName, cleanupIdentity)
	}
	report, err := requester.Recover(ctx, 1)
	if err != nil || report.Cleaned != 1 {
		t.Fatalf("rejected staging cleanup recovery = %#v, err=%v, want one cleaned item", report, err)
	}
}

func TestStorePutReauthorizesExistingArtifactWithSingleConnectionPool(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("single connection authorization")
	artifact := testArtifact(uniqueID("artifact-single-connection"), nil, content)
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	singleDB, err := database.Open(ctx, database.Config{
		URL:      strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")),
		MinConns: 1,
		MaxConns: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer singleDB.Close()
	authorizer := AuthorizerFunc(func(authContext context.Context, _ Operation, _ protocol.Artifact) error {
		var one int
		return singleDB.Pool().QueryRow(authContext, `SELECT 1`).Scan(&one)
	})
	singleStore, err := NewStore(singleDB.Pool(), Config{Root: store.root, Authorizer: authorizer})
	if err != nil {
		t.Fatal(err)
	}
	putContext, cancel := context.WithTimeout(ctx, cleanupTimeout+time.Second)
	defer cancel()
	if _, err := singleStore.Put(putContext, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatalf("single-connection existing artifact Put = %v", err)
	}
}

func TestStoreCancellationDuringExistingArtifactAuthorizationRetainsStaging(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("authorization cancellation")
	artifact := testArtifact(uniqueID("artifact-auth-cancel"), nil, content)
	artifact.SessionID = "session-owner"
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	authorizationStarted := make(chan struct{})
	var authorizationCalls atomic.Int32
	requester, err := NewStore(db.Pool(), Config{
		Root: store.root,
		Authorizer: AuthorizerFunc(func(authContext context.Context, _ Operation, candidate protocol.Artifact) error {
			if authorizationCalls.Add(1) == 1 {
				if candidate.SessionID != "session-requester" {
					return ErrUnauthorized
				}
				return nil
			}
			close(authorizationStarted)
			<-authContext.Done()
			return authContext.Err()
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	candidate := artifact
	candidate.SessionID = "session-requester"
	putContext, cancel := context.WithCancel(ctx)
	result := make(chan error, 1)
	go func() {
		_, err := requester.Put(putContext, candidate, readCloser(bytes.NewReader(content)))
		result <- err
	}()
	select {
	case <-authorizationStarted:
	case <-time.After(cleanupTimeout + time.Second):
		cancel()
		t.Fatal("existing artifact authorization did not start")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("authorization-cancelled Put error = %v, want %v", err, context.Canceled)
		}
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("authorization-cancelled Put did not finish")
	}
	var cleanupCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup`).Scan(&cleanupCount); err != nil {
		t.Fatal(err)
	}
	if cleanupCount != 0 {
		t.Fatalf("authorization-cancelled staging cleanup debt = %d, want 0", cleanupCount)
	}
	assertHasStagingFiles(t, requester.objects)
}

func TestStorePutReauthorizesRepairAfterIdentityLock(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("repair authorization")
	artifact := testArtifact(uniqueID("artifact-repair-auth"), nil, content)
	insertUnavailableArtifact(t, store, ctx, artifact, ".upload-repair-auth-old", "staging-missing")
	authorizationCalls := atomic.Int32{}
	requester, err := NewStore(db.Pool(), Config{
		Root: store.root,
		Authorizer: AuthorizerFunc(func(authContext context.Context, _ Operation, _ protocol.Artifact) error {
			var one int
			if err := db.Pool().QueryRow(authContext, `SELECT 1`).Scan(&one); err != nil {
				return err
			}
			if authorizationCalls.Add(1) < 3 {
				return nil
			}
			return ErrUnauthorized
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := requester.Put(ctx, artifact, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrNotFound) {
		t.Fatalf("repair authorization error = %v, want %v", err, ErrNotFound)
	}
	if got := authorizationCalls.Load(); got < 3 {
		t.Fatalf("repair authorization calls = %d, want a post-lock check", got)
	}
	var cleanupCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup`).Scan(&cleanupCount); err != nil {
		t.Fatal(err)
	}
	if cleanupCount != 1 {
		t.Fatalf("repair authorization cleanup debt = %d, want 1", cleanupCount)
	}
	if _, err := requester.Recover(ctx, MaxRecoveryLimit); err != nil {
		t.Fatal(err)
	}
	assertNoStagingFiles(t, requester.objects)
}

func TestStorePutRejectsRepairWhenAuthorizationRevokedDuringIdentityLockWait(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("repair authorization revoked during wait")
	artifact := testArtifact(uniqueID("artifact-repair-auth-revoked"), nil, content)
	insertUnavailableArtifact(t, store, ctx, artifact, ".upload-repair-auth-revoked-old", "staging-missing")
	var revoked atomic.Bool
	var authorizationCalls atomic.Int32
	requester, err := NewStore(db.Pool(), Config{
		Root: store.root,
		Authorizer: AuthorizerFunc(func(context.Context, Operation, protocol.Artifact) error {
			authorizationCalls.Add(1)
			if revoked.Load() {
				return ErrUnauthorized
			}
			return nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	holder, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "loomhelm:artifact:"+artifact.ID); err != nil {
		t.Fatal(err)
	}
	identityAttempt := make(chan struct {
		pid int32
		err error
	}, 1)
	var identityAttemptOnce sync.Once
	requester.faults = &faultHooks{
		BeforeIdentityLock: func(lockContext context.Context, tx pgx.Tx, _ string) {
			identityAttemptOnce.Do(func() {
				var pid int32
				err := tx.QueryRow(lockContext, `SELECT pg_backend_pid()`).Scan(&pid)
				identityAttempt <- struct {
					pid int32
					err error
				}{pid: pid, err: err}
			})
		},
	}
	result := make(chan error, 1)
	go func() {
		_, err := requester.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
		result <- err
	}()
	var attempt struct {
		pid int32
		err error
	}
	select {
	case attempt = <-identityAttempt:
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("repair upload did not reach identity-lock attempt")
	}
	if attempt.err != nil {
		t.Fatalf("capture repair upload backend pid: %v", attempt.err)
	}
	checkContext, checkCancel := context.WithTimeout(ctx, cleanupTimeout+time.Second)
	defer checkCancel()
	waiting := false
	deadline := time.Now().Add(cleanupTimeout + time.Second)
	for !waiting && time.Now().Before(deadline) {
		if err := db.Pool().QueryRow(checkContext, `SELECT COALESCE(array_length(pg_blocking_pids($1), 1), 0) > 0`, attempt.pid).Scan(&waiting); err != nil {
			t.Fatalf("check repair upload lock wait: %v", err)
		}
		if !waiting {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if !waiting {
		t.Fatal("repair upload was not observed waiting on the identity lock")
	}
	revoked.Store(true)
	if err := holder.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("repair after authorization revocation error = %v, want %v", err, ErrNotFound)
		}
	case <-time.After(cleanupTimeout + 2*time.Second):
		t.Fatal("repair after authorization revocation did not return")
	}
	if got := authorizationCalls.Load(); got < 3 {
		t.Fatalf("repair authorization calls during lock wait = %d, want a post-wait check", got)
	}
	var cleanupCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup`).Scan(&cleanupCount); err != nil {
		t.Fatal(err)
	}
	if cleanupCount != 1 {
		t.Fatalf("repair after authorization revocation cleanup debt = %d, want 1", cleanupCount)
	}
	if _, err := requester.Recover(ctx, MaxRecoveryLimit); err != nil {
		t.Fatal(err)
	}
	assertNoStagingFiles(t, requester.objects)
}

func TestStorePutReauthorizesRepairAfterIdentityLockWait(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("repair authorization after wait")
	artifact := testArtifact(uniqueID("artifact-repair-auth-wait"), nil, content)
	insertUnavailableArtifact(t, store, ctx, artifact, ".upload-repair-auth-wait-old", "staging-missing")
	var revoked atomic.Bool
	var authorizationCalls atomic.Int32
	requester, err := NewStore(db.Pool(), Config{
		Root: store.root,
		Authorizer: AuthorizerFunc(func(context.Context, Operation, protocol.Artifact) error {
			authorizationCalls.Add(1)
			if revoked.Load() {
				return ErrUnauthorized
			}
			return nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	holder, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "loomhelm:artifact:"+artifact.ID); err != nil {
		t.Fatal(err)
	}
	identityAttempt := make(chan struct {
		pid int32
		err error
	}, 1)
	secondHolderReady := make(chan error, 1)
	var identityAttemptOnce sync.Once
	var secondHolderOnce sync.Once
	var secondHolder pgx.Tx
	defer func() {
		if secondHolder != nil {
			_ = secondHolder.Rollback(ctx)
		}
	}()
	requester.faults = &faultHooks{
		BeforeIdentityLock: func(lockContext context.Context, tx pgx.Tx, _ string) {
			identityAttemptOnce.Do(func() {
				var pid int32
				err := tx.QueryRow(lockContext, `SELECT pg_backend_pid()`).Scan(&pid)
				identityAttempt <- struct {
					pid int32
					err error
				}{pid: pid, err: err}
			})
		},
		BeforeIdentityTryLock: func() {
			secondHolderOnce.Do(func() {
				var err error
				secondHolder, err = db.Pool().Begin(ctx)
				if err == nil {
					_, err = secondHolder.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "loomhelm:artifact:"+artifact.ID)
				}
				if err == nil {
					revoked.Store(true)
				}
				secondHolderReady <- err
			})
		},
	}
	result := make(chan error, 1)
	go func() {
		_, err := requester.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
		result <- err
	}()
	var attempt struct {
		pid int32
		err error
	}
	select {
	case attempt = <-identityAttempt:
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("repair upload did not reach identity-lock attempt")
	}
	if attempt.err != nil {
		t.Fatalf("capture repair upload backend pid: %v", attempt.err)
	}
	checkContext, checkCancel := context.WithTimeout(ctx, cleanupTimeout+time.Second)
	defer checkCancel()
	waiting := false
	deadline := time.Now().Add(cleanupTimeout + time.Second)
	for !waiting && time.Now().Before(deadline) {
		if err := db.Pool().QueryRow(checkContext, `SELECT COALESCE(array_length(pg_blocking_pids($1), 1), 0) > 0`, attempt.pid).Scan(&waiting); err != nil {
			t.Fatalf("check repair upload lock wait: %v", err)
		}
		if !waiting {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if !waiting {
		t.Fatal("repair upload was not observed waiting on the identity lock")
	}
	if err := holder.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-secondHolderReady:
		if err != nil {
			t.Fatalf("hold second repair lock: %v", err)
		}
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("repair upload did not reach its try-lock contention")
	}
	select {
	case err := <-result:
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("repair after authorization revocation error = %v, want %v", err, ErrNotFound)
		}
	case <-time.After(cleanupTimeout + 2*time.Second):
		t.Fatal("repair after authorization revocation did not return")
	}
	if secondHolder != nil {
		if err := secondHolder.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if got := authorizationCalls.Load(); got < 4 {
		t.Fatalf("repair authorization calls after lock wait = %d, want a post-wait check", got)
	}
	var cleanupCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup`).Scan(&cleanupCount); err != nil {
		t.Fatal(err)
	}
	if cleanupCount != 1 {
		t.Fatalf("repair after authorization revocation cleanup debt = %d, want 1", cleanupCount)
	}
	if _, err := requester.Recover(ctx, MaxRecoveryLimit); err != nil {
		t.Fatal(err)
	}
	assertNoStagingFiles(t, requester.objects)
}

func TestStoreCancellationBeforeRejectedCleanupCommitRetainsStaging(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("rejected cleanup cancellation")
	artifact := testArtifact(uniqueID("artifact-rejected-cleanup-cancel"), nil, content)
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	putContext, cancel := context.WithCancel(ctx)
	defer cancel()
	var authorizationCalls atomic.Int32
	commitStarted := make(chan struct{})
	var commitOnce sync.Once
	requester, err := NewStore(db.Pool(), Config{
		Root: store.root,
		Authorizer: AuthorizerFunc(func(context.Context, Operation, protocol.Artifact) error {
			if authorizationCalls.Add(1) == 1 {
				return nil
			}
			return ErrUnauthorized
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	requester.faults = &faultHooks{
		BeforeStagingCleanupCommit: func() {
			commitOnce.Do(func() {
				close(commitStarted)
				cancel()
			})
		},
	}
	result := make(chan error, 1)
	go func() {
		_, err := requester.Put(putContext, artifact, readCloser(bytes.NewReader(content)))
		result <- err
	}()
	select {
	case <-commitStarted:
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("rejected cleanup did not reach its commit boundary")
	}
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("rejected cleanup cancellation error = %v, want %v", err, context.Canceled)
		}
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("rejected cleanup cancellation did not return")
	}
	var cleanupCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup`).Scan(&cleanupCount); err != nil {
		t.Fatal(err)
	}
	if cleanupCount != 0 {
		t.Fatalf("cancelled rejected cleanup debt = %d, want 0", cleanupCount)
	}
	assertHasStagingFiles(t, requester.objects)
}

func TestStoreRetainsStagingWhenRecoveryConflictsAfterIntentCommit(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("ready staging cleanup")
	artifactIDs := make([]string, 0, 2)
	stagingNames := make([]string, 0, 2)
	for index := 0; index < 2; index++ {
		artifact := testArtifact(uniqueID(fmt.Sprintf("artifact-ready-staging-%d", index)), nil, content)
		stagingName := fmt.Sprintf(".upload-ready-%d-%d", index, time.Now().UnixNano())
		if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
			t.Fatal(err)
		}
		insertReadyArtifactAt(t, store, ctx, artifact, stagingName, time.Date(2000, 1, 1+index, 0, 0, 0, 0, time.UTC))
		artifactIDs = append(artifactIDs, artifact.ID)
		stagingNames = append(stagingNames, stagingName)
	}
	_, err := store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("first ready cleanup err=%v", err)
	}
	var firstState, secondState string
	var firstReclaimed, secondReclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, artifactIDs[0]).Scan(&firstState, &firstReclaimed); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, artifactIDs[1]).Scan(&secondState, &secondReclaimed); err != nil {
		t.Fatal(err)
	}
	if firstState != string(publicationReady) || !firstReclaimed || secondState != string(publicationReady) || secondReclaimed {
		t.Fatalf("first batch states = %q/%v and %q/%v, want ready/reclaimed and ready/not reclaimed", firstState, firstReclaimed, secondState, secondReclaimed)
	}
	_, err = store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("second ready cleanup err=%v", err)
	}
	for index, artifactID := range artifactIDs {
		var state string
		var reclaimed bool
		if err := db.Pool().QueryRow(ctx, `
			SELECT state, staging_reclaimed_at IS NOT NULL
			FROM conversation_artifacts
			WHERE id = $1
		`, artifactID).Scan(&state, &reclaimed); err != nil {
			t.Fatal(err)
		}
		if state != string(publicationReady) || !reclaimed {
			t.Fatalf("second batch artifact %q = state %q/reclaimed %v, want ready/reclaimed", artifactID, state, reclaimed)
		}
		if _, err := os.Stat(filepath.Join(store.objects, stagingNames[index])); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("reclaimed staging %q = %v, want missing", stagingNames[index], err)
		}
	}
	assertNoStagingFiles(t, store.objects)
}

func TestStoreRecoveryPreservesReadyStagingWhenFinalIsInvalid(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("ready staging must survive")
	artifactIDs := make([]string, 0, 2)
	stagingNames := make([]string, 0, 2)
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
		insertReadyArtifact(t, store, ctx, artifact, stagingName)
		artifactIDs = append(artifactIDs, artifact.ID)
		stagingNames = append(stagingNames, stagingName)
	}
	_, err := store.Recover(ctx, 2)
	if err != nil {
		t.Fatalf("invalid ready recovery err=%v", err)
	}
	for index, artifactID := range artifactIDs {
		var state, stagingName string
		var reclaimed bool
		if err := db.Pool().QueryRow(ctx, `
			SELECT state, staging_name, staging_reclaimed_at IS NOT NULL
			FROM conversation_artifacts
			WHERE id = $1
		`, artifactID).Scan(&state, &stagingName, &reclaimed); err != nil {
			t.Fatal(err)
		}
		if state != string(publicationUnavailable) || stagingName != stagingNames[index] || reclaimed {
			t.Fatalf("invalid ready artifact %q = state %q, staging %q, reclaimed %v", artifactID, state, stagingName, reclaimed)
		}
		var queued int
		if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
			t.Fatal(err)
		}
		if queued != 0 {
			t.Fatalf("invalid ready cleanup rows for %q = %d, want 0", stagingName, queued)
		}
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

func TestStoreRecoveryRetiresInvalidReadyStagingCleanupWithoutRemovingStaging(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("ready cleanup debt")
	artifact := testArtifact(uniqueID("artifact-ready-cleanup-debt"), nil, content)
	stagingName := ".upload-ready-cleanup-debt-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, store, ctx, artifact, stagingName)
	first, err := store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("ready cleanup debt recovery = %#v, err=%v", first, err)
	}
	var state string
	if err := db.Pool().QueryRow(ctx, `SELECT state FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "unavailable" {
		t.Fatalf("ready cleanup debt state = %q, want unavailable", state)
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("invalid ready cleanup rows after transition = %d, want 0", queued)
	}
	stagingIdentity, err := store.stagingIdentity(stagingName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO conversation_artifact_staging_cleanup (staging_name, staging_identity, retry_after)
		VALUES ($1, $2, NOW())
	`, stagingName, stagingIdentity); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	cleaned, err := store.recoverStagingCleanup(ctx, stagingName, cleanup)
	if err != nil || !cleaned {
		t.Fatalf("ready cleanup debt retry cleaned=%v, err=%v", cleaned, err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("ready cleanup debt rows after retry = %d, want 0", queued)
	}
	if _, err := os.Stat(filepath.Join(store.objects, stagingName)); err != nil {
		t.Fatalf("diagnostic ready staging = %v, want retained", err)
	}
}

func TestStoreRecoveryUsesSharedBatchLimit(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("shared recovery limit")

	pending := testArtifact(uniqueID("artifact-shared-limit-pending"), nil, content)
	pendingStaging := ".upload-shared-limit-pending-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, pendingStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertPendingArtifactAt(t, db.Pool(), ctx, pending, pendingStaging, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))

	ready := testArtifact(uniqueID("artifact-shared-limit-ready"), nil, content)
	readyStaging := ".upload-shared-limit-ready-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, readyStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, ready.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifactAt(t, store, ctx, ready, readyStaging, time.Date(2000, 1, 2, 0, 0, 0, 0, time.UTC))

	cleanupName := ".upload-shared-limit-cleanup-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, cleanupName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.enqueueStagingCleanup(cleanupName, cleanup)

	report, err := store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("shared recovery limit error = %#v, err=%v", report, err)
	}
	if report.Scanned != 1 {
		t.Fatalf("shared recovery limit report = %#v, want exactly one scanned item", report)
	}
	var reclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, ready.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if reclaimed {
		t.Fatal("ready work was scanned despite the shared recovery limit")
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, cleanupName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("cleanup work was scanned despite the shared recovery limit: rows=%d", queued)
	}
}

func TestStoreRecoveryOrdersDueWorkAcrossQueues(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("recovery queue order")
	ready := testArtifact(uniqueID("artifact-recovery-order-ready"), nil, content)
	readyStaging := ".upload-recovery-order-ready-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, readyStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, ready.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifactAt(t, store, ctx, ready, readyStaging, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaim_after = TIMESTAMPTZ '2000-01-01'
		WHERE id = $1
	`, ready.ID); err != nil {
		t.Fatal(err)
	}

	pending := testArtifact(uniqueID("artifact-recovery-order-pending"), nil, content)
	pendingStaging := ".upload-recovery-order-pending-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, pendingStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertPendingArtifactAt(t, db.Pool(), ctx, pending, pendingStaging, time.Now().UTC())

	first, err := store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("old ready recovery = %#v, err=%v", first, err)
	}
	var readyReclaimed bool
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaimed_at IS NOT NULL FROM conversation_artifacts WHERE id = $1`, ready.ID).Scan(&readyReclaimed); err != nil {
		t.Fatal(err)
	}
	if !readyReclaimed {
		t.Fatal("older ready work was starved by newer pending work")
	}

	cleanupName := ".upload-recovery-order-cleanup-" + fmt.Sprint(time.Now().UnixNano())
	cleanupPath := filepath.Join(store.objects, cleanupName)
	if err := os.WriteFile(cleanupPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.enqueueStagingCleanup(cleanupName, cleanup)
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifact_staging_cleanup
		SET retry_after = TIMESTAMPTZ '2000-01-01'
		WHERE staging_name = $1
	`, cleanupName); err != nil {
		t.Fatal(err)
	}
	second, err := store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("old cleanup recovery = %#v, err=%v", second, err)
	}
	if _, err := os.Stat(cleanupPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old cleanup staging = %v, want missing", err)
	}
	var pendingState string
	if err := db.Pool().QueryRow(ctx, `SELECT state FROM conversation_artifacts WHERE id = $1`, pending.ID).Scan(&pendingState); err != nil {
		t.Fatal(err)
	}
	if pendingState != string(publicationPending) {
		t.Fatalf("newer pending state = %q, want pending after fair queue pass", pendingState)
	}
}

func TestStoreRecoveryDefersFailedReadyCleanupWithoutStarvingRetry(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	insertReadyArtifactAt(t, store, ctx, failed, failedStaging, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))

	healthy := testArtifact("artifact-reclaim-healthy-"+fmt.Sprint(time.Now().UnixNano()), nil, content)
	healthyStaging := ".upload-reclaim-healthy-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, healthyStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, healthy.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifactAt(t, store, ctx, healthy, healthyStaging, time.Date(2000, 1, 2, 0, 0, 0, 0, time.UTC))
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaim_after = CASE id WHEN $1 THEN TIMESTAMPTZ '2000-01-01' ELSE TIMESTAMPTZ '2000-01-02' END
		WHERE id IN ($1, $2)
	`, failed.ID, healthy.ID); err != nil {
		t.Fatal(err)
	}

	first, err := store.Recover(ctx, 1)
	if !errors.Is(err, ErrRecoveryIncomplete) {
		t.Fatalf("failed cleanup recovery = %#v, err=%v", first, err)
	}
	var retryDeferred bool
	var reclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT staging_reclaim_after > clock_timestamp(), staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, failed.ID).Scan(&retryDeferred, &reclaimed); err != nil {
		t.Fatal(err)
	}
	if !retryDeferred {
		t.Fatal("failed cleanup retry_at is not in the future according to the database clock")
	}
	if reclaimed {
		t.Fatal("failed cleanup was marked reclaimed before its staging became removable")
	}
	if _, err := os.Stat(failedPath); err != nil {
		t.Fatalf("failed cleanup staging = %v, want present", err)
	}

	second, err := store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("healthy cleanup recovery = %#v, err=%v", second, err)
	}
	var healthyState string
	var healthyReclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, healthy.ID).Scan(&healthyState, &healthyReclaimed); err != nil {
		t.Fatal(err)
	}
	if healthyState != "ready" || !healthyReclaimed {
		t.Fatalf("healthy cleanup state = %q/%v, want ready/reclaimed", healthyState, healthyReclaimed)
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
	if err != nil {
		t.Fatalf("retried cleanup recovery = %#v, err=%v", third, err)
	}
	var failedState string
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, failed.ID).Scan(&failedState, &reclaimed); err != nil {
		t.Fatal(err)
	}
	if failedState != "ready" || !reclaimed {
		t.Fatalf("failed cleanup state = %q/%v, want ready/reclaimed", failedState, reclaimed)
	}
}

func TestStoreRecoveryDefersArtifactAfterIdentityLockTimeout(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("identity lock timeout")
	artifact := testArtifact(uniqueID("artifact-lock-timeout"), nil, content)
	stagingName := ".upload-lock-timeout-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifactAt(t, store, ctx, artifact, stagingName, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifacts SET staging_reclaim_after = NOW() - INTERVAL '1 minute' WHERE id = $1`, artifact.ID); err != nil {
		t.Fatal(err)
	}
	holder, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "loomhelm:artifact:"+artifact.ID); err != nil {
		t.Fatal(err)
	}
	identityAttempt := make(chan struct {
		pid int32
		err error
	}, 1)
	var identityAttemptOnce sync.Once
	store.faults = &faultHooks{
		BeforeIdentityLock: func(hookContext context.Context, tx pgx.Tx, _ string) {
			identityAttemptOnce.Do(func() {
				var pid int32
				err := tx.QueryRow(hookContext, `SELECT pg_backend_pid()`).Scan(&pid)
				identityAttempt <- struct {
					pid int32
					err error
				}{pid: pid, err: err}
			})
		},
	}
	recoveryContext, cancel := context.WithCancel(ctx)
	defer cancel()
	recoverResult := make(chan error, 1)
	go func() {
		_, err := store.Recover(recoveryContext, 1)
		recoverResult <- err
	}()
	var attempt struct {
		pid int32
		err error
	}
	select {
	case attempt = <-identityAttempt:
	case <-time.After(cleanupTimeout + time.Second):
		cancel()
		_ = holder.Rollback(ctx)
		select {
		case <-recoverResult:
		case <-time.After(cleanupTimeout + time.Second):
			t.Fatal("recovery did not finish after identity-lock attempt timeout")
		}
		t.Fatal("recovery did not reach the identity-lock attempt")
	}
	if attempt.err != nil {
		cancel()
		_ = holder.Rollback(ctx)
		<-recoverResult
		t.Fatalf("capture recovery backend pid: %v", attempt.err)
	}
	checkContext, checkCancel := context.WithTimeout(ctx, 2*time.Second)
	var waiting bool
	for deadline := time.Now().Add(2 * time.Second); !waiting && time.Now().Before(deadline); {
		if err := db.Pool().QueryRow(checkContext, `SELECT COALESCE(array_length(pg_blocking_pids($1), 1), 0) > 0`, attempt.pid).Scan(&waiting); err != nil {
			checkCancel()
			cancel()
			_ = holder.Rollback(ctx)
			<-recoverResult
			t.Fatalf("check recovery lock wait: %v", err)
		}
		if !waiting {
			time.Sleep(10 * time.Millisecond)
		}
	}
	checkCancel()
	if !waiting {
		cancel()
		_ = holder.Rollback(ctx)
		<-recoverResult
		t.Fatal("recovery backend was not observed waiting on the held identity lock")
	}
	cancel()
	recoverErr := <-recoverResult
	if !errors.Is(recoverErr, context.Canceled) {
		_ = holder.Rollback(ctx)
		t.Fatalf("lock-timeout recovery error = %v, want %v", recoverErr, context.Canceled)
	}
	if err := holder.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var retryDeferred bool
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaim_after > clock_timestamp() FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&retryDeferred); err != nil {
		t.Fatal(err)
	}
	if !retryDeferred {
		t.Fatal("lock-timeout recovery did not defer the artifact according to the database clock")
	}
}

func TestStoreRecoveryDefersFailedStagingCleanupWithoutStarvingLaterDebt(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("staging cleanup retry fairness")
	badName := ".upload-staging-cleanup-starve-bad-" + fmt.Sprint(time.Now().UnixNano())
	badPath := filepath.Join(store.objects, badName)
	if err := os.WriteFile(badPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.enqueueStagingCleanup(badName, cleanup)
	if err := os.Remove(badPath); err != nil {
		t.Fatal(err)
	}

	healthyName := ".upload-staging-cleanup-starve-healthy-" + fmt.Sprint(time.Now().UnixNano())
	healthyPath := filepath.Join(store.objects, healthyName)
	if err := os.WriteFile(healthyPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	store.enqueueStagingCleanup(healthyName, cleanup)
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifact_staging_cleanup
		SET retry_after = CASE staging_name
			WHEN $1 THEN TIMESTAMPTZ '2000-01-01'
			ELSE TIMESTAMPTZ '2000-01-02'
		END
		WHERE staging_name IN ($1, $2)
	`, badName, healthyName); err != nil {
		t.Fatal(err)
	}

	syncErr := errors.New("injected staging cleanup sync failure")
	store.faults = &faultHooks{BeforeStagingDirectorySync: func() error { return syncErr }}
	first, err := store.Recover(ctx, 1)
	if !errors.Is(err, ErrRecoveryIncomplete) {
		t.Fatalf("failed staging cleanup recovery = %#v, err=%v", first, err)
	}
	var retryDeferred bool
	if err := db.Pool().QueryRow(ctx, `SELECT retry_after > clock_timestamp() FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, badName).Scan(&retryDeferred); err != nil {
		t.Fatal(err)
	}
	if !retryDeferred {
		t.Fatal("failed staging cleanup retry_at is not in the future according to the database clock")
	}

	store.faults = nil
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifact_staging_cleanup SET retry_after = NOW() WHERE staging_name = $1`, healthyName); err != nil {
		t.Fatal(err)
	}
	second, err := store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("healthy staging cleanup recovery = %#v, err=%v", second, err)
	}
	if _, err := os.Stat(healthyPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("healthy staging cleanup path = %v, want missing", err)
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, healthyName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("healthy staging cleanup debt = %d, want 0", queued)
	}
}

func TestStoreRecoveryDefersPendingFailuresForFairness(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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

	_, err := store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("healthy pending recovery err=%v", err)
	}
	var healthyState string
	var healthyReclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, healthy.ID).Scan(&healthyState, &healthyReclaimed); err != nil {
		t.Fatal(err)
	}
	if healthyState != string(publicationReady) || !healthyReclaimed {
		t.Fatalf("healthy pending state = %q/%v, want ready/reclaimed", healthyState, healthyReclaimed)
	}
	var retryDeferred bool
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaim_after > clock_timestamp() FROM conversation_artifacts WHERE id = $1`, failed.ID).Scan(&retryDeferred); err != nil {
		t.Fatal(err)
	}
	if !retryDeferred {
		t.Fatal("pending retry_at is not in the future according to the database clock")
	}

	failedStaging := ".upload-pending-failed-retry-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, failedStaging), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifacts SET staging_name = $2, staging_reclaim_after = NOW() - INTERVAL '1 day' WHERE id = $1`, failed.ID, failedStaging); err != nil {
		t.Fatal(err)
	}
	_, err = store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("retried pending recovery err=%v", err)
	}
	var failedState string
	var failedReclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, failed.ID).Scan(&failedState, &failedReclaimed); err != nil {
		t.Fatal(err)
	}
	if failedState != string(publicationReady) || !failedReclaimed {
		t.Fatalf("retried pending state = %q/%v, want ready/reclaimed", failedState, failedReclaimed)
	}
}

func TestStoreRecoveryRechecksPersistedRetryDeadline(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	insertReadyArtifactAt(t, store, ctx, artifact, stagingName, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	insertReadyArtifactAt(t, store, ctx, failed, failedStaging, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))
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
	insertReadyArtifactAt(t, store, ctx, healthy, healthyStaging, time.Date(2000, 1, 2, 0, 0, 0, 0, time.UTC))
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaim_after = TIMESTAMPTZ '2000-01-02'
		WHERE id = $1
	`, healthy.ID); err != nil {
		t.Fatal(err)
	}

	_, err := store.Recover(ctx, 1)
	if err != nil {
		t.Fatalf("healthy ready recovery err=%v", err)
	}
	var healthyState string
	var healthyReclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, healthy.ID).Scan(&healthyState, &healthyReclaimed); err != nil {
		t.Fatal(err)
	}
	if healthyState != string(publicationReady) || !healthyReclaimed {
		t.Fatalf("healthy ready state = %q/%v, want ready/reclaimed", healthyState, healthyReclaimed)
	}
	var retryDeferred bool
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaim_after > clock_timestamp() FROM conversation_artifacts WHERE id = $1`, failed.ID).Scan(&retryDeferred); err != nil {
		t.Fatal(err)
	}
	if !retryDeferred {
		t.Fatal("ready retry_at is not in the future according to the database clock")
	}
}

func TestStoreRetriesKnownUnreferencedStagingCleanupDebt(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	if _, err := store.recoverStagingCleanup(ctx, stagingName, cleanup); err == nil {
		t.Fatal("cleanup unexpectedly succeeded for non-empty staging directory")
	}
	var retryDeferred bool
	if err := db.Pool().QueryRow(ctx, `SELECT retry_after > clock_timestamp() FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&retryDeferred); err != nil {
		t.Fatal(err)
	}
	if !retryDeferred {
		t.Fatal("cleanup retry_at is not in the future according to the database clock")
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
	if _, err := store.recoverStagingCleanup(ctx, stagingName, cleanup); err != nil {
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	if _, err := store.recoverStagingCleanup(ctx, stagingName, cleanup); err != nil {
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	if _, err := store.recoverStagingCleanup(ctx, stagingName, cleanup); err != nil {
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

func TestStoreCleanupDebtMissingStagingRequiresDirectorySync(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	stagingName := ".upload-cleanup-missing-sync-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, []byte("missing sync"), 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.enqueueStagingCleanup(stagingName, cleanup)
	if err := os.Remove(stagingPath); err != nil {
		t.Fatal(err)
	}

	syncErr := errors.New("injected staging directory sync failure")
	store.faults = &faultHooks{
		BeforeStagingDirectorySync: func() error { return syncErr },
	}
	cleaned, err := store.recoverStagingCleanup(ctx, stagingName, cleanup)
	if !errors.Is(err, syncErr) || cleaned {
		t.Fatalf("missing staging cleanup with failed sync = cleaned %v, err %v, want false/injected error", cleaned, err)
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("missing staging cleanup debt after failed sync = %d, want 1", queued)
	}

	store.faults = nil
	cleaned, err = store.recoverStagingCleanup(ctx, stagingName, cleanup)
	if err != nil || !cleaned {
		t.Fatalf("missing staging cleanup retry = cleaned %v, err %v, want true/nil", cleaned, err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("missing staging cleanup debt after successful sync = %d, want 0", queued)
	}
}

func TestStoreCleanupDebtDoesNotRemoveReusedStaging(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	stagingName := ".upload-cleanup-reused-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, []byte("old staging"), 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.enqueueStagingCleanup(stagingName, cleanup)
	replacementPath := stagingPath + ".replacement"
	if err := os.WriteFile(replacementPath, []byte("new staging"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(stagingPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacementPath, stagingPath); err != nil {
		t.Fatal(err)
	}
	if _, err := store.recoverStagingCleanup(ctx, stagingName, cleanup); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(stagingPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "new staging" {
		t.Fatalf("reused staging content = %q, want new staging", content)
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("reused staging cleanup debt rows = %d, want 1 until the new incarnation is explicitly queued", queued)
	}
	store.enqueueStagingCleanup(stagingName, cleanup)
	if _, err := store.recoverStagingCleanup(ctx, stagingName, cleanup); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stagingPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("explicitly requeued staging remains: %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("reused staging cleanup debt after explicit requeue = %d, want 0", queued)
	}
}

func TestStoreCleanupDebtWithUnknownIdentityPreservesReplacement(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	stagingName := ".upload-cleanup-unknown-identity-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, []byte("old staging"), 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	store.enqueueStagingCleanup(stagingName, cleanup)
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifact_staging_cleanup
		SET staging_identity = NULL
		WHERE staging_name = $1
	`, stagingName); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stagingPath+".replacement", []byte("new staging"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(stagingPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(stagingPath+".replacement", stagingPath); err != nil {
		t.Fatal(err)
	}
	cleaned, err := store.recoverStagingCleanup(ctx, stagingName, cleanup)
	if err != nil || cleaned {
		t.Fatalf("unknown-identity replacement cleanup = cleaned %v, err %v, want false/nil", cleaned, err)
	}
	content, err := os.ReadFile(stagingPath)
	if err != nil || string(content) != "new staging" {
		t.Fatalf("unknown-identity replacement content = %q, err=%v", content, err)
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("unknown-identity replacement cleanup debt = %d, want 1", queued)
	}
	if err := os.Remove(stagingPath); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifact_staging_cleanup SET retry_after = NOW() WHERE staging_name = $1`, stagingName); err != nil {
		t.Fatal(err)
	}
	syncErr := fmt.Errorf("open %s: permission denied", filepath.Join(store.objects, "private-staging-root"))
	store.faults = &faultHooks{BeforeStagingDirectorySync: func() error { return syncErr }}
	cleaned, err = store.recoverStagingCleanup(ctx, stagingName, cleanup)
	if !errors.Is(err, syncErr) || cleaned {
		t.Fatalf("unknown-identity missing cleanup with failed sync = cleaned %v, err %v, want false/injected error", cleaned, err)
	}
	store.faults = nil
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifact_staging_cleanup SET retry_after = NOW() WHERE staging_name = $1`, stagingName); err != nil {
		t.Fatal(err)
	}
	cleaned, err = store.recoverStagingCleanup(ctx, stagingName, cleanup)
	if err != nil || !cleaned {
		t.Fatalf("unknown-identity missing cleanup retry = cleaned %v, err %v, want true/nil", cleaned, err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("unknown-identity missing cleanup debt after retry = %d, want 0", queued)
	}
}

func TestStoreCleanupDebtPreservesArtifactWithUnknownIdentity(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("unavailable artifact staging")
	artifact := testArtifact(uniqueID("artifact-cleanup-unknown-artifact-identity"), nil, content)
	stagingName := ".upload-cleanup-unknown-artifact-identity-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertUnavailableArtifact(t, store, ctx, artifact, stagingName, "final-missing")
	stagingIdentity, err := store.stagingIdentity(stagingName)
	if err != nil || stagingIdentity == nil {
		t.Fatalf("read cleanup staging identity = %v/%v", stagingIdentity, err)
	}
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_identity = NULL
		WHERE id = $1
	`, artifact.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO conversation_artifact_staging_cleanup (staging_name, staging_identity, retry_after)
		VALUES ($1, $2, NOW())
	`, stagingName, stagingIdentity); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	cleaned, err := store.recoverStagingCleanup(ctx, stagingName, cleanup)
	if err != nil || !cleaned {
		t.Fatalf("unknown-artifact-identity cleanup = cleaned %v, err %v, want true/nil", cleaned, err)
	}
	retained, err := os.ReadFile(stagingPath)
	if err != nil || !bytes.Equal(retained, content) {
		t.Fatalf("unknown-artifact-identity staging = %q, err=%v, want retained original bytes", retained, err)
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("unknown-artifact-identity cleanup debt = %d, want 0", queued)
	}
}

func TestStoreCleanupDebtPreservesReadyArtifactWithUnknownIdentity(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("ready artifact unknown identity")
	artifact := testArtifact(uniqueID("artifact-ready-cleanup-unknown-identity"), nil, content)
	stagingName := ".upload-ready-cleanup-unknown-identity-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, store, ctx, artifact, stagingName)
	stagingIdentity, err := store.stagingIdentity(stagingName)
	if err != nil || stagingIdentity == nil {
		t.Fatalf("read ready cleanup staging identity = %v/%v", stagingIdentity, err)
	}
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_identity = NULL, staging_reclaimed_at = NOW(), staging_reclaim_after = NOW()
		WHERE id = $1
	`, artifact.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO conversation_artifact_staging_cleanup (staging_name, staging_identity, retry_after)
		VALUES ($1, $2, NOW())
	`, stagingName, stagingIdentity); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	cleaned, err := store.recoverStagingCleanup(ctx, stagingName, cleanup)
	if err != nil || !cleaned {
		t.Fatalf("ready unknown-identity cleanup = cleaned %v, err=%v, want true/nil", cleaned, err)
	}
	retained, err := os.ReadFile(stagingPath)
	if err != nil || !bytes.Equal(retained, content) {
		t.Fatalf("ready unknown-identity staging = %q, err=%v, want retained bytes", retained, err)
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("ready unknown-identity cleanup debt = %d, want 0", queued)
	}
}

func TestStoreReadyReclamationPreservesReusedStaging(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("ready incarnation")
	artifact := testArtifact(uniqueID("artifact-ready-incarnation"), nil, content)
	stagingName := ".upload-ready-incarnation-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, store, ctx, artifact, stagingName)
	identity, err := store.stagingIdentity(stagingName)
	if err != nil || identity == nil {
		t.Fatalf("read original staging identity = %v/%v", identity, err)
	}
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_identity = $2, staging_reclaim_after = NOW()
		WHERE id = $1
	`, artifact.ID, identity); err != nil {
		t.Fatal(err)
	}
	replacementPath := stagingPath + "-replacement"
	if err := os.WriteFile(replacementPath, []byte("replacement staging"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(stagingPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacementPath, stagingPath); err != nil {
		t.Fatal(err)
	}
	newIdentity, err := store.stagingIdentity(stagingName)
	if err != nil || newIdentity == nil || *newIdentity == *identity {
		t.Fatalf("replacement staging identity = %v, original = %v, err = %v", newIdentity, identity, err)
	}
	var reclaimed bool
	syncErr := errors.New("injected replacement staging directory sync failure")
	store.faults = &faultHooks{
		BeforeStagingDirectorySync: func() error { return syncErr },
	}
	_, status, err := store.reclaimReadyStagingForRecovery(ctx, artifact.ID, nil)
	if !errors.Is(err, syncErr) || status != recoveryPending {
		t.Fatalf("replacement staging reclamation with failed sync = status %q, err %v, want pending/injected error", status, err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaimed_at IS NOT NULL FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if reclaimed {
		t.Fatal("replacement staging was marked reclaimed after failed directory sync")
	}
	store.faults = nil
	_, status, err = store.reclaimReadyStagingForRecovery(ctx, artifact.ID, nil)
	if err != nil || status != recoveryReady {
		t.Fatalf("replacement staging reclamation retry = status %q, err %v, want ready/nil", status, err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaimed_at IS NOT NULL FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if !reclaimed {
		t.Fatal("replacement staging was not marked reclaimed after successful directory sync")
	}
	replacement, err := os.ReadFile(stagingPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(replacement) != "replacement staging" {
		t.Fatalf("replacement staging content = %q, want replacement staging", replacement)
	}
	var state string
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, artifact.ID).Scan(&state, &reclaimed); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationReady) || !reclaimed {
		t.Fatalf("ready recovery state = %q/reclaimed %v, want ready/reclaimed after preserving the replacement", state, reclaimed)
	}
}

func TestStoreReadyReclamationPreservesUnidentifiedStaging(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("unidentified ready staging")
	artifact := testArtifact(uniqueID("artifact-ready-unidentified"), nil, content)
	stagingName := ".upload-ready-unidentified-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, store, ctx, artifact, stagingName)
	if _, err := db.Pool().Exec(ctx, `UPDATE conversation_artifacts SET staging_identity = NULL WHERE id = $1`, artifact.ID); err != nil {
		t.Fatal(err)
	}
	syncErr := errors.New("injected unidentified staging directory sync failure")
	store.faults = &faultHooks{
		BeforeStagingDirectorySync: func() error { return syncErr },
	}
	_, status, err := store.reclaimReadyStagingForRecovery(ctx, artifact.ID, nil)
	if !errors.Is(err, syncErr) || status != recoveryPending {
		t.Fatalf("unidentified ready staging reclamation with failed sync = status %q, err %v, want pending/injected error", status, err)
	}
	var reclaimed bool
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaimed_at IS NOT NULL FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if reclaimed {
		t.Fatal("unidentified ready staging was marked reclaimed after failed directory sync")
	}
	store.faults = nil
	_, status, err = store.reclaimReadyStagingForRecovery(ctx, artifact.ID, nil)
	if err != nil || status != recoveryReady {
		t.Fatalf("unidentified ready staging reclamation = status %q, err %v, want ready/nil", status, err)
	}
	retained, err := os.ReadFile(stagingPath)
	if err != nil || !bytes.Equal(retained, content) {
		t.Fatalf("unidentified ready staging = %q, err=%v, want retained original bytes", retained, err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT staging_reclaimed_at IS NOT NULL FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if !reclaimed {
		t.Fatal("unidentified ready staging was not marked reclaimed after retaining its bytes")
	}
}

func TestStoreHoldsIdentityLockThroughReadyStagingRemoval(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("ready cleanup lock")
	artifact := testArtifact(uniqueID("artifact-reclaim-lock"), nil, content)
	stagingName := ".upload-reclaim-lock-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, store, ctx, artifact, stagingName)

	removalStarted := make(chan struct{})
	contenderAttempted := make(chan struct{})
	contenderRemovalEntered := make(chan struct{})
	contenderDone := make(chan struct{})
	holderRemovalCompleted := make(chan struct{})
	markerRelease := make(chan struct{})
	holderRelease := make(chan struct{})
	contenderIdentity := make(chan struct {
		pid int32
		err error
	}, 1)
	var attemptCount atomic.Int32
	var removalCount atomic.Int32
	var holderReleased atomic.Bool
	var lockViolated atomic.Bool
	var removalStartOnce sync.Once
	var contenderAttemptOnce sync.Once
	var contenderRemovalOnce sync.Once
	var releaseOnce sync.Once
	var markerReleaseOnce sync.Once
	store.faults = &faultHooks{
		BeforeIdentityLock: func(hookContext context.Context, tx pgx.Tx, _ string) {
			if attemptCount.Add(1) != 2 {
				return
			}
			var pid int32
			err := tx.QueryRow(hookContext, `SELECT pg_backend_pid()`).Scan(&pid)
			contenderIdentity <- struct {
				pid int32
				err error
			}{pid: pid, err: err}
			contenderAttemptOnce.Do(func() { close(contenderAttempted) })
		},
		BeforeReadyStagingRemoval: func() {
			if removalCount.Add(1) == 1 {
				removalStartOnce.Do(func() { close(removalStarted) })
				<-holderRelease
				return
			}
			if !holderReleased.Load() {
				lockViolated.Store(true)
			}
			select {
			case <-holderRemovalCompleted:
			default:
				lockViolated.Store(true)
			}
			if _, err := os.Stat(stagingPath); err == nil || !errors.Is(err, os.ErrNotExist) {
				lockViolated.Store(true)
			}
			contenderRemovalOnce.Do(func() { close(contenderRemovalEntered) })
		},
		AfterReadyStagingRemoval: func() {
			close(holderRemovalCompleted)
			<-markerRelease
		},
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	releaseHolder := func() {
		releaseOnce.Do(func() {
			holderReleased.Store(true)
			close(holderRelease)
		})
	}
	defer releaseHolder()
	releaseMarker := func() {
		markerReleaseOnce.Do(func() { close(markerRelease) })
	}
	defer releaseMarker()
	waitResult := func(result <-chan error, label string) error {
		select {
		case err := <-result:
			return err
		case <-time.After(6 * time.Second):
			return fmt.Errorf("%s did not finish", label)
		}
	}
	reclaimResult := make(chan error, 1)
	go func() {
		_, _, err := store.reclaimReadyStaging(ctx, artifact.ID, cleanup)
		reclaimResult <- err
	}()
	started := false
	select {
	case <-removalStarted:
		started = true
	case <-time.After(cleanupTimeout + time.Second):
	}
	if !started {
		releaseHolder()
		if err := waitResult(reclaimResult, "ready cleanup"); err != nil {
			t.Fatalf("ready cleanup did not reach staging removal: %v", err)
		}
		t.Fatal("ready cleanup did not reach staging removal")
	}
	contenderContext, cancel := context.WithTimeout(ctx, cleanupTimeout+10*time.Second)
	defer cancel()
	contenderResult := make(chan error, 1)
	go func() {
		_, _, err := store.reconcileOne(contenderContext, artifact.ID, nil)
		contenderResult <- err
		close(contenderDone)
	}()
	failure := ""
	var contenderErr error
	contenderResultConsumed := false
	select {
	case <-contenderAttempted:
		outcome := <-contenderIdentity
		if outcome.err != nil {
			failure = fmt.Sprintf("capture contender backend pid: %v", outcome.err)
		} else {
			checkContext, checkCancel := context.WithTimeout(ctx, cleanupTimeout+time.Second)
			ticker := time.NewTicker(5 * time.Millisecond)
			waitingOnIdentityLock := false
			for failure == "" && !waitingOnIdentityLock {
				var waiting bool
				if err := db.Pool().QueryRow(checkContext, `
					SELECT EXISTS (
						SELECT 1
						FROM pg_locks
						WHERE pid = $1
						  AND locktype = 'advisory'
						  AND NOT granted
						  AND mode = 'ExclusiveLock'
						  AND classid = ((hashtextextended($2, 0) >> 32) & 4294967295::bigint)::oid
						  AND objid = (hashtextextended($2, 0) & 4294967295::bigint)::oid
						  AND objsubid = 1
					)
				`, outcome.pid, "loomhelm:artifact:"+artifact.ID).Scan(&waiting); err != nil {
					failure = fmt.Sprintf("check contender lock wait: %v", err)
					break
				}
				waitingOnIdentityLock = waiting
				if waitingOnIdentityLock {
					break
				}
				select {
				case <-contenderRemovalEntered:
					failure = "contender entered staging removal before the holder released the identity lock"
				case <-contenderDone:
					contenderErr = <-contenderResult
					contenderResultConsumed = true
					failure = fmt.Sprintf("contender completed before the holder released the identity lock: %v", contenderErr)
				case <-checkContext.Done():
					failure = "contender backend was not observed waiting on the identity lock"
				case <-ticker.C:
				}
			}
			ticker.Stop()
			checkCancel()
		}
	case <-time.After(cleanupTimeout + time.Second):
		failure = "contender did not reach the identity-lock attempt"
	}
	releaseHolder()
	if failure == "" {
		select {
		case <-holderRemovalCompleted:
		case <-contenderRemovalEntered:
			failure = "contender entered staging removal before the holder committed its reclamation marker"
		case <-time.After(cleanupTimeout + time.Second):
			failure = "holder did not reach the post-removal marker barrier"
		}
		select {
		case err := <-reclaimResult:
			failure = fmt.Sprintf("ready cleanup committed before the marker barrier released: %v", err)
		default:
		}
	}
	releaseMarker()
	if err := waitResult(reclaimResult, "ready cleanup"); err != nil {
		t.Fatalf("ready cleanup = %v", err)
	}
	if !contenderResultConsumed {
		contenderErr = waitResult(contenderResult, "contender")
	}
	if failure != "" {
		t.Fatal(failure)
	}
	if contenderErr != nil {
		t.Fatalf("contender = %v", contenderErr)
	}
	if lockViolated.Load() {
		t.Fatal("contender entered staging removal before the holder released the identity lock")
	}
}

func TestNewStoreCreatesPrivateNestedRoot(t *testing.T) {
	db, _, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	insertReadyArtifact(t, store, ctx, artifact, stagingName)
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
	db, _, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	_, err := store.Recover(ctx, MaxRecoveryLimit)
	if err != nil {
		t.Fatal(err)
	}
	var state, reason string
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, unavailable_reason
		FROM conversation_artifacts
		WHERE id = $1
	`, artifact.ID).Scan(&state, &reason); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationUnavailable) || reason != "staging-missing" {
		t.Fatalf("missing staging artifact = state %q/reason %q, want unavailable/staging-missing", state, reason)
	}
	if _, err := store.Metadata(ctx, artifact.ID); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unavailable metadata error = %v, want %v", err, ErrUnavailable)
	}
}

func TestStorePendingMetadataAndOpenReturnUnavailableWithoutIntegrity(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	artifact := testArtifact(uniqueID("artifact-pending-read"), nil, []byte("pending read"))
	insertPendingArtifact(t, db.Pool(), ctx, artifact, ".upload-pending-read")
	if _, err := store.Metadata(ctx, artifact.ID); !errors.Is(err, ErrUnavailable) || errors.Is(err, ErrIntegrity) {
		t.Fatalf("pending metadata error = %v, want unavailable without integrity", err)
	}
	if _, _, err := store.Open(ctx, artifact.ID); !errors.Is(err, ErrUnavailable) || errors.Is(err, ErrIntegrity) {
		t.Fatalf("pending open error = %v, want unavailable without integrity", err)
	}
}

func TestRecoveryStateConvergenceRequiresReplacementBinding(t *testing.T) {
	identity := "1:2"
	updated := artifactRecord{
		State:             publicationUnavailable,
		StagingName:       ".upload-original",
		StagingIdentity:   &identity,
		UnavailableReason: "staging-missing",
	}
	if recoveryStateConverged(artifactRecord{
		State:           publicationPending,
		StagingName:     updated.StagingName,
		StagingIdentity: &identity,
	}, updated) {
		t.Fatal("unchanged pending binding was treated as a recovered convergence")
	}
	replacementIdentity := "3:4"
	if !recoveryStateConverged(artifactRecord{
		State:           publicationPending,
		StagingName:     ".upload-replacement",
		StagingIdentity: &replacementIdentity,
	}, updated) {
		t.Fatal("replacement pending binding was not treated as a recovered convergence")
	}
	if !recoveryStateConverged(artifactRecord{State: publicationReady}, updated) {
		t.Fatal("ready convergence was rejected")
	}
	if !recoveryStateConverged(artifactRecord{
		State:             publicationUnavailable,
		UnavailableReason: "final-missing",
	}, artifactRecord{State: publicationReady}) {
		t.Fatal("ready to unavailable convergence was rejected")
	}
}

func TestStoreKeepsDurableStagingWhenDatabaseCommitIsUnavailable(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("lost repair response")
	artifact := testArtifact(uniqueID("artifact-lost-repair"), nil, content)
	insertUnavailableArtifact(t, store, ctx, artifact, ".upload-original", "staging-missing")
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	firstContext, cancelFirst := context.WithCancel(ctx)
	defer cancelFirst()
	intentStarted := make(chan struct{})
	secondEntered := make(chan struct{})
	var intentOnce sync.Once
	var intentCalls atomic.Int32
	var secondEntryOnce sync.Once
	secondID := uniqueID("artifact-unrelated")
	store.faults = &faultHooks{
		AfterIntentCommit: func() {
			if intentCalls.Add(1) == 1 {
				intentOnce.Do(func() { close(intentStarted) })
				<-firstContext.Done()
			}
		},
		BeforeIdentityLock: func(_ context.Context, _ pgx.Tx, id string) {
			if id == secondID {
				secondEntryOnce.Do(func() { close(secondEntered) })
			}
		},
	}
	firstContent := []byte("cancelled after intent")
	secondContent := []byte("unrelated upload")
	firstID := uniqueID("artifact-cancel-after-intent")
	firstResult := make(chan error, 1)
	go func() {
		_, err := store.Put(firstContext, testArtifact(firstID, nil, firstContent), readCloser(bytes.NewReader(firstContent)))
		firstResult <- err
	}()
	select {
	case <-intentStarted:
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("first upload did not reach committed intent")
	}
	secondResult := make(chan error, 1)
	go func() {
		_, err := store.Put(ctx, testArtifact(secondID, nil, secondContent), readCloser(bytes.NewReader(secondContent)))
		secondResult <- err
	}()
	select {
	case <-secondEntered:
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("unrelated upload did not enter while first upload was blocked")
	}
	select {
	case err := <-secondResult:
		if err != nil {
			t.Fatalf("unrelated upload error while first was blocked = %v", err)
		}
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("unrelated upload was stalled by cancelled upload")
	}
	secondMetadata, secondReader, err := store.Open(ctx, secondID)
	if err != nil {
		t.Fatalf("unrelated upload Open error = %v", err)
	}
	secondReadBack, readErr := io.ReadAll(secondReader)
	closeErr := secondReader.Close()
	if readErr != nil || closeErr != nil || secondMetadata.ID != secondID || !bytes.Equal(secondReadBack, secondContent) {
		t.Fatalf("unrelated upload publication = %#v/%q, readErr=%v, closeErr=%v", secondMetadata, secondReadBack, readErr, closeErr)
	}
	cancelFirst()
	select {
	case err := <-firstResult:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled after-intent error = %v, want %v", err, context.Canceled)
		}
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("cancelled after-intent upload did not return")
	}
	store.faults = nil
	_, err = store.Recover(ctx, MaxRecoveryLimit)
	if err != nil {
		t.Fatalf("cancelled intent recovery err=%v", err)
	}
	var state string
	var reclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, firstID).Scan(&state, &reclaimed); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationReady) || !reclaimed {
		t.Fatalf("cancelled intent artifact = state %q/reclaimed %v, want ready/reclaimed", state, reclaimed)
	}
}

func TestStoreCancellationUsesSharedCleanupDeadlineForBlockedIdentityLock(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	if elapsed := time.Since(started); elapsed > cleanupTimeout+2*time.Second {
		t.Fatalf("blocked cleanup lock elapsed %s, want no more than %s", elapsed, cleanupTimeout+2*time.Second)
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
	cancelledAt := time.Now()
	cancel()
	cleanup.start()
	deadline, ok := cleanupContext.Deadline()
	if !ok {
		t.Fatal("cleanup context has no deadline")
	}
	if deadline.Before(cancelledAt.Add(cleanupTimeout)) {
		t.Fatalf("cleanup deadline = %s, want at least %s after cancellation", deadline, cancelledAt.Add(cleanupTimeout))
	}
}

func TestStoreRoundsCreatedAtToDatabasePrecision(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	insertUnavailableArtifact(t, store, ctx, unavailable, ".upload-original", "operator-hold")
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("blocked source was not read")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled Put error = %v, want %v", err, context.Canceled)
		}
	case <-time.After(cleanupTimeout + time.Second):
		t.Fatal("cancelled Put did not return after source Close")
	}
	if got := source.closeCount.Load(); got != 1 {
		t.Fatalf("blocked source close count = %d, want 1", got)
	}
	var cleanupCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup`).Scan(&cleanupCount); err != nil {
		t.Fatal(err)
	}
	if cleanupCount != 0 {
		t.Fatalf("cancelled staging cleanup debt = %d, want 0", cleanupCount)
	}
	assertHasStagingFiles(t, store.objects)
}

func TestStoreReadyReclamationMissingStagingRequiresDirectorySync(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("ready missing sync")
	artifact := testArtifact(uniqueID("artifact-ready-missing-sync"), nil, content)
	stagingName := ".upload-ready-missing-sync-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, store, ctx, artifact, stagingName)
	if err := os.Remove(stagingPath); err != nil {
		t.Fatal(err)
	}

	syncErr := errors.New("injected staging directory sync failure")
	store.faults = &faultHooks{
		BeforeStagingDirectorySync: func() error { return syncErr },
	}
	_, status, err := store.reclaimReadyStagingForRecovery(ctx, artifact.ID, nil)
	if !errors.Is(err, syncErr) || status != recoveryPending {
		t.Fatalf("missing staging reclamation with failed sync = status %q, err %v, want pending/injected error", status, err)
	}
	var reclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, artifact.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if reclaimed {
		t.Fatal("missing staging was marked reclaimed after failed directory sync")
	}

	store.faults = nil
	_, status, err = store.reclaimReadyStagingForRecovery(ctx, artifact.ID, nil)
	if err != nil || status != recoveryReady {
		t.Fatalf("missing staging reclamation retry = status %q, err %v, want ready/nil", status, err)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, artifact.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if !reclaimed {
		t.Fatal("missing staging was not marked reclaimed after successful directory sync")
	}
}

func TestStoreReadyReclamationMissingUnrecordedStagingRequiresDirectorySync(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("ready missing unrecorded sync")
	artifact := testArtifact(uniqueID("artifact-ready-missing-unrecorded-sync"), nil, content)
	stagingName := ".upload-ready-missing-unrecorded-sync-" + fmt.Sprint(time.Now().UnixNano())
	stagingPath := filepath.Join(store.objects, stagingName)
	if err := os.WriteFile(stagingPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, store, ctx, artifact, stagingName)
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_identity = NULL
		WHERE id = $1
	`, artifact.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(stagingPath); err != nil {
		t.Fatal(err)
	}

	syncErr := errors.New("injected staging directory sync failure")
	store.faults = &faultHooks{
		BeforeStagingDirectorySync: func() error { return syncErr },
	}
	_, status, err := store.reclaimReadyStagingForRecovery(ctx, artifact.ID, nil)
	if !errors.Is(err, syncErr) || status != recoveryPending {
		t.Fatalf("missing unrecorded staging reclamation with failed sync = status %q, err %v, want pending/injected error", status, err)
	}
	var reclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, artifact.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if reclaimed {
		t.Fatal("missing unrecorded staging was marked reclaimed after failed directory sync")
	}

	store.faults = nil
	_, status, err = store.reclaimReadyStagingForRecovery(ctx, artifact.ID, nil)
	if err != nil || status != recoveryReady {
		t.Fatalf("missing unrecorded staging reclamation retry = status %q, err %v, want ready/nil", status, err)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, artifact.ID).Scan(&reclaimed); err != nil {
		t.Fatal(err)
	}
	if !reclaimed {
		t.Fatal("missing unrecorded staging was not marked reclaimed after successful directory sync")
	}
}

func TestStoreMetadataRevalidatesReadyBytesAndDoesNotRepairReadyLoss(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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

func TestStoreReconcileRevalidatesReclaimedReadyBytes(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("reconcile ready bytes")
	artifact := testArtifact(uniqueID("artifact-reconcile-ready-loss"), nil, content)
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(store.objects, artifact.ID)); err != nil {
		t.Fatal(err)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	resolved, status, err := store.reconcileOne(ctx, artifact.ID, cleanup)
	if err != nil || status != recoveryUnavailable || resolved.UnavailableReason != "final-missing" {
		t.Fatalf("reconcile reclaimed ready loss = %#v/%q, err=%v, want final-missing unavailable", resolved, status, err)
	}
	var state string
	if err := db.Pool().QueryRow(ctx, `SELECT state FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationUnavailable) {
		t.Fatalf("reconciled ready loss state = %q, want unavailable", state)
	}
}

func TestStoreMetadataDoesNotMutateWhenObjectDirectoryIsUnavailable(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("object directory outage")
	artifact := testArtifact(uniqueID("artifact-object-directory-outage"), nil, content)
	if _, err := store.Put(ctx, artifact, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(store.objects, artifact.ID)); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(store.objects); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Metadata(ctx, artifact.ID); !errors.Is(err, ErrStoreUnavailable) {
		t.Fatalf("missing object directory metadata error = %v, want %v", err, ErrStoreUnavailable)
	}
	var state string
	if err := db.Pool().QueryRow(ctx, `SELECT state FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationReady) {
		t.Fatalf("missing object directory state = %q, want %q", state, publicationReady)
	}
}

func TestStoreRecoveryDoesNotMarkReadyUnavailableWhenObjectDirectoryIsUnavailable(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("recovery object directory outage")
	artifact := testArtifact(uniqueID("artifact-recovery-object-directory-outage"), nil, content)
	stagingName := ".upload-recovery-object-directory-outage-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, stagingName), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.objects, artifact.ID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	insertReadyArtifact(t, store, ctx, artifact, stagingName)
	if err := os.Remove(filepath.Join(store.objects, stagingName)); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(store.objects, artifact.ID)); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(store.objects); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaim_after = TIMESTAMPTZ '1970-01-01'
		WHERE id = $1
	`, artifact.ID); err != nil {
		t.Fatal(err)
	}
	_, err := store.Recover(ctx, 1)
	if !errors.Is(err, ErrRecoveryIncomplete) {
		t.Fatalf("object directory outage recovery err=%v, want %v", err, ErrRecoveryIncomplete)
	}
	var state string
	if err := db.Pool().QueryRow(ctx, `SELECT state FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationReady) {
		t.Fatalf("object directory outage state = %q, want %q", state, publicationReady)
	}
}

func TestStoreOpenMarksNonregularFinalUnavailable(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("repairable bytes")
	artifact := testArtifact(uniqueID("artifact-repair"), nil, content)
	insertUnavailableArtifact(t, store, ctx, artifact, ".upload-original", "staging-missing")
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
	oldStagingName := ".upload-repair-corrupt-old-" + fmt.Sprint(time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(store.objects, oldStagingName), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	insertUnavailableArtifact(t, store, ctx, corrupt, oldStagingName, "staging-corrupt")
	if _, err := store.Put(ctx, corrupt, readCloser(bytes.NewReader(content))); err != nil {
		t.Fatalf("staging-corrupt retry error = %v", err)
	}
	if _, _, err := store.Open(ctx, corrupt.ID); err != nil {
		t.Fatalf("staging-corrupt repaired Open error = %v", err)
	}
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, oldStagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("obsolete corrupt staging debt rows = %d, want 1", queued)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	if _, err := store.recoverStagingCleanup(ctx, oldStagingName, cleanup); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store.objects, oldStagingName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("obsolete corrupt staging file = %v, want missing", err)
	}
}

func TestStorePutRepairsMissingPendingStagingInOneAttempt(t *testing.T) {
	db, store, ctx := openArtifactStoreFixture(t, nil)
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
	db, store, ctx := openArtifactStoreFixture(t, nil)
	defer db.Close()
	content := []byte("repair rejection")
	unknown := testArtifact(uniqueID("artifact-repair-unknown"), nil, content)
	insertUnavailableArtifact(t, store, ctx, unknown, ".upload-original", "operator-hold")
	if _, err := store.Put(ctx, unknown, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unknown-reason retry error = %v, want %v", err, ErrUnavailable)
	}

	conflict := testArtifact(uniqueID("artifact-repair-conflict"), nil, content)
	insertUnavailableArtifact(t, store, ctx, conflict, ".upload-original", "staging-missing")
	finalPath := filepath.Join(store.objects, conflict.ID)
	conflictingBytes := []byte("different final")
	if err := os.WriteFile(finalPath, conflictingBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(ctx, conflict, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting-final retry error = %v, want %v", err, ErrConflict)
	}
	var state, reason string
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, unavailable_reason
		FROM conversation_artifacts
		WHERE id = $1
	`, conflict.ID).Scan(&state, &reason); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationUnavailable) || reason != "final-conflict" {
		t.Fatalf("conflicting-final state = %q/%q, want unavailable/final-conflict", state, reason)
	}
	if err := os.Remove(finalPath); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(ctx, conflict, readCloser(bytes.NewReader(content))); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("conflicting-final retry after removal error = %v, want %v", err, ErrUnavailable)
	}
	readBack, err := os.ReadFile(finalPath)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("conflicting final after removal = %q, err=%v, want missing", readBack, err)
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

func TestArtifactIntegrationFixturesDoNotClearSiblingSchemaRows(t *testing.T) {
	baseURL := strings.TrimSpace(os.Getenv(artifactTestBaseURLEnv))
	if baseURL == "" {
		baseURL = strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	}
	if baseURL == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sharedSchema := fmt.Sprintf("loomhelm_artifacts_sentinel_%d_%d", os.Getpid(), artifactTestSchemaSequence.Add(1))
	sharedURL, err := artifactTestDatabaseURL(baseURL, sharedSchema)
	if err != nil {
		t.Fatalf("scope sibling integration database: %v", err)
	}
	if err := prepareArtifactStoreFixtureSchema(baseURL, sharedURL, sharedSchema); err != nil {
		t.Fatalf("prepare sibling integration database: %v", err)
	}
	t.Cleanup(func() {
		if err := dropArtifactTestDatabase(baseURL, sharedSchema); err != nil {
			t.Errorf("drop sibling integration schema: %v", err)
		}
	})
	sharedDB, err := database.Open(ctx, database.Config{URL: sharedURL, MinConns: 1, MaxConns: 2})
	if err != nil {
		t.Fatalf("open sibling integration database: %v", err)
	}
	defer sharedDB.Close()

	content := []byte("shared fixture sentinel")
	artifact := testArtifact(uniqueID("artifact-shared-fixture"), nil, content)
	stagingName := ".upload-shared-fixture-" + fmt.Sprint(time.Now().UnixNano())
	_, err = sharedDB.Pool().Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, staging_identity, unavailable_reason
		) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'pending', $8, NULL, '')
	`, artifact.ID, artifact.SessionID, artifact.Name, string(artifact.Kind), artifact.Size, artifact.Sha256, artifact.ContentType, stagingName)
	if err != nil {
		t.Fatalf("insert shared artifact sentinel: %v", err)
	}
	if _, err := sharedDB.Pool().Exec(ctx, `
		INSERT INTO conversation_artifact_staging_cleanup (staging_name, staging_identity, retry_after)
		VALUES ($1, NULL, NOW())
	`, stagingName); err != nil {
		t.Fatalf("insert shared cleanup sentinel: %v", err)
	}

	isolatedDB, _, _ := openArtifactStoreFixture(t, nil)
	isolatedDB.Close()

	var artifactCount, cleanupCount int
	if err := sharedDB.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifacts WHERE id = $1`, artifact.ID).Scan(&artifactCount); err != nil {
		t.Fatal(err)
	}
	if err := sharedDB.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, stagingName).Scan(&cleanupCount); err != nil {
		t.Fatal(err)
	}
	if artifactCount != 1 || cleanupCount != 1 {
		t.Fatalf("shared fixture rows after isolated setup = artifact %d/cleanup %d, want 1/1", artifactCount, cleanupCount)
	}
}

func TestArtifactTestDatabaseURLScopesSupportedDSNs(t *testing.T) {
	const schema = "loomhelm_artifacts_test_scope"
	t.Setenv("PGOPTIONS", "-c lock_timeout=2500")
	for _, tt := range []struct {
		name string
		base string
	}{
		{name: "uri", base: "postgresql://test:secret@example.test/loomhelm?options=-c%20search_path%3Dpg_catalog&search_path=public&sslmode=disable"},
		{name: "keyword", base: "host=example.test port=5432 user=test password='literal%value' dbname=loomhelm options='-c search_path=pg_catalog' search_path=public sslmode=disable"},
		{name: "uri-uppercase", base: "postgresql://test:secret@example.test/loomhelm?OPTIONS=-c%20search_path%3Dpg_catalog&SEARCH_PATH=public&sslmode=disable"},
		{name: "keyword-uppercase", base: "host=example.test port=5432 user=test password='literal%value' dbname=loomhelm OPTIONS='-c search_path=pg_catalog' SEARCH_PATH=public sslmode=disable"},
		{name: "uri-options-plus", base: "postgresql://test:secret@example.test/loomhelm?options=-c%20application_name%3Da+b&search_path=public&sslmode=disable"},
		{name: "environment-options", base: "postgresql://test:secret@example.test/loomhelm?search_path=public&sslmode=disable"},
		{name: "literal-plus", base: "postgresql://test:secret@example.test/loomhelm?application_name=a+b&search_path=public&sslmode=disable"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			scoped, err := artifactTestDatabaseURL(tt.base, schema)
			if err != nil {
				t.Fatalf("scope database URL: %v", err)
			}
			parsed, err := pgx.ParseConfig(scoped)
			if err != nil {
				t.Fatalf("parse scoped database URL: %v", err)
			}
			if got := parsed.RuntimeParams["search_path"]; got != schema+",public" {
				t.Fatalf("search_path = %q, want %q in %q", got, schema+",public", scoped)
			}
			wantOptions := "-c search_path=pg_catalog -c search_path=" + schema + ",public"
			if tt.name == "environment-options" || tt.name == "literal-plus" {
				wantOptions = "-c lock_timeout=2500 -c search_path=" + schema + ",public"
			} else if tt.name == "uri-options-plus" {
				wantOptions = "-c application_name=a+b -c search_path=" + schema + ",public"
			}
			if got := parsed.RuntimeParams["options"]; got != wantOptions {
				t.Fatalf("options = %q, want %q in %q", got, wantOptions, scoped)
			}
			if tt.name == "literal-plus" && parsed.RuntimeParams["application_name"] != "a+b" {
				t.Fatalf("application_name = %q, want literal plus in %q", parsed.RuntimeParams["application_name"], scoped)
			}
		})
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

func insertUnavailableArtifact(t *testing.T, store *Store, ctx context.Context, artifact protocol.Artifact, stagingName, reason string) {
	t.Helper()
	stagingIdentity, err := store.stagingIdentity(stagingName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.pool.Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, staging_identity, unavailable_reason
		) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'unavailable', $8, $9, $10)
	`, artifact.ID, artifact.SessionID, artifact.Name, string(artifact.Kind), artifact.Size, artifact.Sha256, artifact.ContentType, stagingName, stagingIdentity, reason); err != nil {
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

func insertReadyArtifact(t *testing.T, store *Store, ctx context.Context, artifact protocol.Artifact, stagingName string) {
	insertReadyArtifactAt(t, store, ctx, artifact, stagingName, time.Now().UTC())
}

func insertReadyArtifactAt(t *testing.T, store *Store, ctx context.Context, artifact protocol.Artifact, stagingName string, createdAt time.Time) {
	t.Helper()
	stagingIdentity, err := store.stagingIdentity(stagingName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.pool.Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, staging_identity, unavailable_reason
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready', $9, $10, '')
		`, artifact.ID, artifact.SessionID, artifact.Name, string(artifact.Kind), artifact.Size, artifact.Sha256, artifact.ContentType, createdAt, stagingName, stagingIdentity); err != nil {
		t.Fatal(err)
	}
}

func uniqueID(prefix string) string {
	return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
}

const (
	artifactTestSchemaEnv        = "LOOMHELM_ARTIFACT_TEST_SCHEMA"
	artifactTestBaseURLEnv       = "LOOMHELM_ARTIFACT_TEST_BASE_URL"
	artifactTestHelperEnv        = "LOOMHELM_ARTIFACT_HELPER"
	artifactHelperCapability     = "loomhelm-artifact-helper-v1\n"
	artifactTestCloneTablePrefix = "loomhelm_artifacts_canonical_"
)

var artifactTestSchemaSequence atomic.Uint64
var artifactHelperProcess bool
var artifactTestCanonicalSchema string

func TestMain(m *testing.M) {
	baseURL := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	artifactHelperProcess = authenticatedArtifactHelper()
	if baseURL == "" || artifactHelperProcess {
		os.Exit(m.Run())
	}

	if err := os.Setenv(artifactTestBaseURLEnv, baseURL); err != nil {
		fmt.Fprintf(os.Stderr, "set shared artifact database URL: %v\n", err)
		os.Exit(1)
	}
	canonicalSchema := fmt.Sprintf("%s%d_%d", artifactTestCloneTablePrefix, os.Getpid(), artifactTestSchemaSequence.Add(1))
	canonicalURL, err := artifactTestDatabaseURL(baseURL, canonicalSchema)
	if err == nil {
		err = prepareArtifactTestDatabase(baseURL, canonicalSchema, canonicalURL)
	}
	if err == nil {
		err = verifyArtifactTestMigrationState(canonicalURL)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "prepare canonical artifact integration schema: %v\n", err)
		os.Exit(1)
	}
	artifactTestCanonicalSchema = canonicalSchema
	code := m.Run()
	if err := dropArtifactTestDatabase(baseURL, canonicalSchema); err != nil {
		fmt.Fprintf(os.Stderr, "drop canonical artifact integration schema: %v\n", err)
		if code == 0 {
			code = 1
		}
	}
	os.Exit(code)
}

var artifactTestDatabaseState = struct {
	sync.Mutex
	schemas map[*testing.T]string
}{
	schemas: make(map[*testing.T]string),
}

func ensureArtifactTestDatabase(t *testing.T) {
	t.Helper()
	if artifactHelperProcess {
		return
	}
	baseURL := strings.TrimSpace(os.Getenv(artifactTestBaseURLEnv))
	if baseURL == "" {
		baseURL = strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	}
	if baseURL == "" {
		return
	}
	artifactTestDatabaseState.Lock()
	if _, ok := artifactTestDatabaseState.schemas[t]; ok {
		artifactTestDatabaseState.Unlock()
		return
	}
	schema := fmt.Sprintf("loomhelm_artifacts_test_%d_%d", os.Getpid(), artifactTestSchemaSequence.Add(1))
	artifactTestDatabaseState.schemas[t] = schema
	artifactTestDatabaseState.Unlock()
	scopedURL, err := artifactTestDatabaseURL(baseURL, schema)
	if err == nil {
		err = prepareArtifactStoreFixtureSchema(baseURL, scopedURL, schema)
	}
	if err != nil {
		artifactTestDatabaseState.Lock()
		delete(artifactTestDatabaseState.schemas, t)
		artifactTestDatabaseState.Unlock()
		t.Fatalf("prepare isolated artifact integration schema: %v", err)
	}
	t.Setenv("LOOMHELM_DATABASE_URL", scopedURL)
	t.Setenv(artifactTestSchemaEnv, schema)
	t.Cleanup(func() {
		if err := dropArtifactTestDatabase(baseURL, schema); err != nil {
			t.Errorf("drop isolated artifact integration schema: %v", err)
		}
		artifactTestDatabaseState.Lock()
		delete(artifactTestDatabaseState.schemas, t)
		artifactTestDatabaseState.Unlock()
	})
}

func authenticatedArtifactHelper() bool {
	if strings.TrimSpace(os.Getenv(artifactTestHelperEnv)) == "" {
		return false
	}
	capability := os.NewFile(uintptr(3), "loomhelm-artifact-helper-capability")
	if capability == nil {
		return false
	}
	defer capability.Close()
	contents, err := io.ReadAll(capability)
	return err == nil && string(contents) == artifactHelperCapability
}

func artifactTestDatabaseURL(databaseURL, schema string) (string, error) {
	rawURL := strings.TrimSpace(databaseURL)
	parsedConfig, err := pgx.ParseConfig(rawURL)
	if err != nil {
		return "", fmt.Errorf("parse database URL: %w", err)
	}
	searchPath := schema + ",public"
	if strings.HasPrefix(rawURL, "postgres://") || strings.HasPrefix(rawURL, "postgresql://") {
		parsedURL, err := url.Parse(rawURL)
		if err != nil {
			return "", fmt.Errorf("parse database URL for schema scoping: %w", err)
		}
		existingOptions := artifactTestRuntimeParam(parsedConfig.RuntimeParams, "options")
		if rawOptions, found, err := artifactTestURIParam(rawURL, "options"); err != nil {
			return "", fmt.Errorf("parse database URL options for schema scoping: %w", err)
		} else if found {
			existingOptions = rawOptions
		}
		options := artifactTestConnectionOptions(existingOptions, searchPath)
		queryParts := make([]string, 0, strings.Count(parsedURL.RawQuery, "&")+2)
		for _, part := range strings.Split(parsedURL.RawQuery, "&") {
			key := part
			if index := strings.IndexByte(part, '='); index >= 0 {
				key = part[:index]
			}
			decodedKey, err := url.QueryUnescape(key)
			if err != nil {
				return "", fmt.Errorf("parse database URL query for schema scoping: %w", err)
			}
			if strings.EqualFold(decodedKey, "search_path") || strings.EqualFold(decodedKey, "options") {
				continue
			}
			if part != "" {
				queryParts = append(queryParts, part)
			}
		}
		queryParts = append(queryParts,
			"search_path="+encodeArtifactTestQueryValue(searchPath),
			"options="+encodeArtifactTestQueryValue(options),
		)
		parsedURL.RawQuery = strings.Join(queryParts, "&")
		parsedURL.ForceQuery = parsedURL.RawQuery != ""
		return parsedURL.String(), nil
	}
	settings, err := parseArtifactTestKeywordSettings(rawURL)
	if err != nil {
		return "", fmt.Errorf("parse keyword database URL for schema scoping: %w", err)
	}
	existingOptions := artifactTestRuntimeParam(parsedConfig.RuntimeParams, "options")
	for _, setting := range settings {
		if strings.EqualFold(setting.key, "options") {
			existingOptions = setting.value
		}
	}
	options := artifactTestConnectionOptions(existingOptions, searchPath)
	parts := make([]string, 0, len(settings)+2)
	for _, setting := range settings {
		if strings.EqualFold(setting.key, "search_path") || strings.EqualFold(setting.key, "options") {
			continue
		}
		parts = append(parts, setting.key+"="+quoteArtifactTestKeywordValue(setting.value))
	}
	parts = append(parts,
		"search_path="+quoteArtifactTestKeywordValue(searchPath),
		"options="+quoteArtifactTestKeywordValue(options),
	)
	return strings.Join(parts, " "), nil
}

type artifactTestKeywordSetting struct {
	key   string
	value string
}

func artifactTestRuntimeParam(params map[string]string, key string) string {
	for name, value := range params {
		if strings.EqualFold(name, key) {
			return value
		}
	}
	return ""
}

func artifactTestURIParam(rawURL, key string) (string, bool, error) {
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return "", false, err
	}
	var value string
	found := false
	for _, part := range strings.Split(parsedURL.RawQuery, "&") {
		if part == "" {
			continue
		}
		rawKey, rawValue, ok := strings.Cut(part, "=")
		if !ok || strings.ContainsRune(rawValue, '=') {
			return "", false, errors.New("invalid URI query parameter")
		}
		decodedKey, err := artifactTestURIComponent(rawKey)
		if err != nil {
			return "", false, err
		}
		if !strings.EqualFold(decodedKey, key) {
			continue
		}
		value, err = artifactTestURIComponent(rawValue)
		if err != nil {
			return "", false, err
		}
		found = true
	}
	return value, found, nil
}

func artifactTestURIComponent(value string) (string, error) {
	return url.QueryUnescape(strings.ReplaceAll(value, "+", "%2B"))
}

func parseArtifactTestKeywordSettings(raw string) ([]artifactTestKeywordSetting, error) {
	settings := make([]artifactTestKeywordSetting, 0)
	raw = strings.TrimLeft(raw, " \t\n\r\v\f")
	for len(raw) > 0 {
		eqIndex := strings.IndexByte(raw, '=')
		if eqIndex < 0 {
			return nil, errors.New("invalid keyword/value")
		}
		key := strings.Trim(raw[:eqIndex], " \t\n\r\v\f")
		if key == "" || strings.ContainsAny(key, " \t\n\r\v\f") {
			return nil, errors.New("invalid keyword/value key")
		}
		raw = strings.TrimLeft(raw[eqIndex+1:], " \t\n\r\v\f")
		value := ""
		if len(raw) > 0 && raw[0] == '\'' {
			raw = raw[1:]
			end := 0
			for end < len(raw) {
				if raw[end] == '\\' {
					end += 2
					continue
				}
				if raw[end] == '\'' {
					break
				}
				end++
			}
			if end >= len(raw) {
				return nil, errors.New("unterminated quoted string")
			}
			value = unescapeArtifactTestKeywordValue(raw[:end])
			raw = strings.TrimLeft(raw[end+1:], " \t\n\r\v\f")
		} else {
			end := 0
			for end < len(raw) {
				if asciiSpaceByte(raw[end]) {
					break
				}
				if raw[end] == '\\' {
					end++
					if end == len(raw) {
						break
					}
				}
				end++
			}
			value = unescapeArtifactTestKeywordValue(raw[:end])
			raw = strings.TrimLeft(raw[end:], " \t\n\r\v\f")
		}
		settings = append(settings, artifactTestKeywordSetting{key: key, value: value})
	}
	return settings, nil
}

func unescapeArtifactTestKeywordValue(value string) string {
	if !strings.ContainsRune(value, '\\') {
		return value
	}
	var builder strings.Builder
	builder.Grow(len(value))
	for index := 0; index < len(value); index++ {
		if value[index] == '\\' {
			index++
			if index == len(value) {
				break
			}
		}
		builder.WriteByte(value[index])
	}
	return builder.String()
}

func asciiSpaceByte(value byte) bool {
	return value == ' ' || value == '\t' || value == '\n' || value == '\r' || value == '\v' || value == '\f'
}

func artifactTestConnectionOptions(existing, searchPath string) string {
	scopedSearchPath := "-c search_path=" + searchPath
	if strings.TrimSpace(existing) == "" {
		return scopedSearchPath
	}
	return strings.TrimSpace(existing) + " " + scopedSearchPath
}

func encodeArtifactTestQueryValue(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

func quoteArtifactTestKeywordValue(value string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(value) + "'"
}

func prepareArtifactTestDatabase(databaseURL, schema, scopedURL string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 2})
	if err != nil {
		return err
	}
	if _, err := db.Pool().Exec(ctx, "CREATE SCHEMA "+quoteArtifactTestIdentifier(schema)); err != nil {
		db.Close()
		return fmt.Errorf("create schema: %w", err)
	}
	db.Close()

	scopedDB, err := database.Open(ctx, database.Config{URL: scopedURL, MinConns: 1, MaxConns: 2})
	if err != nil {
		return cleanupArtifactTestDatabase(databaseURL, schema, fmt.Errorf("open scoped database: %w", err))
	}
	migrationErr := scopedDB.Migrate(ctx)
	scopedDB.Close()
	if migrationErr != nil {
		return cleanupArtifactTestDatabase(databaseURL, schema, fmt.Errorf("migrate scoped database: %w", migrationErr))
	}
	return nil
}

var artifactStoreFixtureTables = []string{
	"conversation_artifacts",
	"conversation_artifact_staging_cleanup",
}

func prepareArtifactStoreFixtureSchema(databaseURL, scopedURL, schema string) error {
	canonicalSchema := strings.TrimSpace(artifactTestCanonicalSchema)
	if canonicalSchema == "" {
		return errors.New("canonical artifact migration schema is not initialized")
	}
	return cloneArtifactStoreTables(databaseURL, scopedURL, canonicalSchema, schema)
}

func cloneArtifactStoreTables(databaseURL, scopedURL, sourceSchema, targetSchema string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 2})
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin artifact test schema clone: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := verifyArtifactStoreSourceDependencies(ctx, tx, sourceSchema); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "CREATE SCHEMA "+quoteArtifactTestIdentifier(targetSchema)); err != nil {
		return fmt.Errorf("create cloned schema: %w", err)
	}
	for _, table := range artifactStoreFixtureTables {
		rowCount, err := artifactTestTableRowCount(ctx, tx, sourceSchema, table)
		if err != nil {
			return fmt.Errorf("count canonical %s rows: %w", table, err)
		}
		if rowCount != 0 {
			return fmt.Errorf("canonical %s contains %d rows", table, rowCount)
		}
		cloneTable := fmt.Sprintf(
			"CREATE TABLE %s.%s (LIKE %s.%s INCLUDING ALL)",
			quoteArtifactTestIdentifier(targetSchema),
			quoteArtifactTestIdentifier(table),
			quoteArtifactTestIdentifier(sourceSchema),
			quoteArtifactTestIdentifier(table),
		)
		if _, err := tx.Exec(ctx, cloneTable); err != nil {
			return fmt.Errorf("clone %s: %w", table, err)
		}
		sourceSignature, err := artifactStoreTableCatalogSignature(ctx, tx, sourceSchema, table)
		if err != nil {
			return fmt.Errorf("read canonical %s catalog: %w", table, err)
		}
		targetSignature, err := artifactStoreTableCatalogSignature(ctx, tx, targetSchema, table)
		if err != nil {
			return fmt.Errorf("read cloned %s catalog: %w", table, err)
		}
		if sourceSignature != targetSignature {
			sourceParts := strings.Split(sourceSignature, "\n")
			targetParts := strings.Split(targetSignature, "\n")
			mismatches := make([]string, 0, 3)
			for index, name := range []string{"columns", "constraints", "indexes"} {
				if index >= len(sourceParts) || index >= len(targetParts) || sourceParts[index] != targetParts[index] {
					mismatches = append(mismatches, name)
				}
			}
			return fmt.Errorf("cloned %s catalog differs from canonical: %s", table, strings.Join(mismatches, ","))
		}
		rowCount, err = artifactTestTableRowCount(ctx, tx, targetSchema, table)
		if err != nil {
			return fmt.Errorf("count cloned %s rows: %w", table, err)
		}
		if rowCount != 0 {
			return fmt.Errorf("cloned %s contains %d rows", table, rowCount)
		}
	}
	gooseExists, err := artifactTestTableExists(ctx, tx, targetSchema, "goose_db_version")
	if err != nil {
		return fmt.Errorf("check cloned migration ledger: %w", err)
	}
	if gooseExists {
		return errors.New("fast artifact store fixture must not contain goose_db_version")
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit cloned artifact schema: %w", err)
	}
	if err := verifyArtifactStoreSearchPath(scopedURL, targetSchema); err != nil {
		_ = dropArtifactTestDatabase(databaseURL, targetSchema)
		return err
	}
	return nil
}

func verifyArtifactStoreSourceDependencies(ctx context.Context, tx pgx.Tx, schema string) error {
	foreignKeys, err := artifactTestCatalogCount(ctx, tx, `
		SELECT count(*)
		FROM pg_constraint c
		JOIN pg_class r ON r.oid = c.conrelid
		JOIN pg_namespace n ON n.oid = r.relnamespace
		WHERE n.nspname = $1
		  AND r.relname = ANY($2::text[])
		  AND c.contype = 'f'
	`, schema, artifactStoreFixtureTables)
	if err != nil {
		return fmt.Errorf("inspect artifact foreign-key dependencies: %w", err)
	}
	ownedSequences, err := artifactTestCatalogCount(ctx, tx, `
		SELECT count(*)
		FROM pg_class sequence_rel
		JOIN pg_depend d ON d.objid = sequence_rel.oid AND d.deptype = 'a'
		JOIN pg_class table_rel ON table_rel.oid = d.refobjid
		JOIN pg_namespace table_ns ON table_ns.oid = table_rel.relnamespace
		WHERE sequence_rel.relkind = 'S'
		  AND table_ns.nspname = $1
		  AND table_rel.relname = ANY($2::text[])
	`, schema, artifactStoreFixtureTables)
	if err != nil {
		return fmt.Errorf("inspect artifact sequence dependencies: %w", err)
	}
	triggers, err := artifactTestCatalogCount(ctx, tx, `
		SELECT count(*)
		FROM pg_trigger tr
		JOIN pg_class r ON r.oid = tr.tgrelid
		JOIN pg_namespace n ON n.oid = r.relnamespace
		WHERE n.nspname = $1
		  AND r.relname = ANY($2::text[])
		  AND NOT tr.tgisinternal
	`, schema, artifactStoreFixtureTables)
	if err != nil {
		return fmt.Errorf("inspect artifact trigger dependencies: %w", err)
	}
	customFunctions, err := artifactTestCatalogCount(ctx, tx, `
		SELECT count(*)
		FROM pg_depend d
		JOIN pg_proc p ON p.oid = d.refobjid
		JOIN pg_namespace pn ON pn.oid = p.pronamespace
		WHERE d.refclassid = 'pg_proc'::regclass
		  AND pn.nspname <> 'pg_catalog'
		  AND (
			(d.classid = 'pg_attrdef'::regclass AND d.objid IN (
				SELECT ad.oid
				FROM pg_attrdef ad
				JOIN pg_class r ON r.oid = ad.adrelid
				JOIN pg_namespace n ON n.oid = r.relnamespace
				WHERE n.nspname = $1 AND r.relname = ANY($2::text[])
			))
			OR (d.classid = 'pg_constraint'::regclass AND d.objid IN (
				SELECT c.oid
				FROM pg_constraint c
				JOIN pg_class r ON r.oid = c.conrelid
				JOIN pg_namespace n ON n.oid = r.relnamespace
				WHERE n.nspname = $1 AND r.relname = ANY($2::text[])
			))
		  )
	`, schema, artifactStoreFixtureTables)
	if err != nil {
		return fmt.Errorf("inspect artifact function dependencies: %w", err)
	}
	if foreignKeys != 0 || ownedSequences != 0 || triggers != 0 || customFunctions != 0 {
		return fmt.Errorf("unsupported artifact fixture dependencies: foreign_keys=%d sequences=%d triggers=%d functions=%d", foreignKeys, ownedSequences, triggers, customFunctions)
	}
	return nil
}

func artifactTestCatalogCount(ctx context.Context, tx pgx.Tx, query string, args ...any) (int64, error) {
	var count int64
	if err := tx.QueryRow(ctx, query, args...).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func artifactTestTableExists(ctx context.Context, tx pgx.Tx, schema, table string) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
		)
	`, schema, table).Scan(&exists)
	return exists, err
}

func artifactTestTableRowCount(ctx context.Context, tx pgx.Tx, schema, table string) (int64, error) {
	var count int64
	query := "SELECT count(*) FROM " + quoteArtifactTestIdentifier(schema) + "." + quoteArtifactTestIdentifier(table)
	if err := tx.QueryRow(ctx, query).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func artifactStoreTableCatalogSignature(ctx context.Context, tx pgx.Tx, schema, table string) (string, error) {
	const query = `
		SELECT
			COALESCE((
				SELECT jsonb_agg(
					jsonb_build_array(
						a.attname,
						format_type(a.atttypid, a.atttypmod),
						a.attnotnull,
						COALESCE(pg_get_expr(d.adbin, d.adrelid, true), ''),
						a.attidentity,
						a.attgenerated
					)
					ORDER BY a.attnum
				)::text
				FROM pg_attribute a
				JOIN pg_class r ON r.oid = a.attrelid
				JOIN pg_namespace n ON n.oid = r.relnamespace
				LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
				WHERE n.nspname = $1 AND r.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
			), '[]'),
			COALESCE((
				SELECT jsonb_agg(
					jsonb_build_array(
						c.conname,
						c.contype,
						c.conkey::text,
						c.confkey::text,
						c.convalidated,
						pg_get_constraintdef(c.oid, true)
					)
					ORDER BY c.conname
				)::text
				FROM pg_constraint c
				JOIN pg_class r ON r.oid = c.conrelid
				JOIN pg_namespace n ON n.oid = r.relnamespace
				WHERE n.nspname = $1 AND r.relname = $2
			), '[]'),
			COALESCE((
				SELECT jsonb_agg(
					jsonb_build_array(
						i.indisunique,
						i.indisprimary,
						i.indisexclusion,
						i.indisvalid,
						i.indisready,
						i.indnkeyatts,
						i.indnatts,
						i.indkey::text,
						i.indoption::text,
						COALESCE(pg_get_expr(i.indpred, i.indrelid, true), ''),
						COALESCE(pg_get_expr(i.indexprs, i.indrelid, true), ''),
						COALESCE((
							SELECT jsonb_agg(pg_get_indexdef(i.indexrelid, positions.position, true) ORDER BY positions.position)
							FROM generate_series(1, i.indnatts) AS positions(position)
						), '[]'::jsonb)
					)
					ORDER BY
						i.indisprimary DESC,
						i.indisunique DESC,
						i.indkey::text,
						i.indoption::text,
						COALESCE(pg_get_expr(i.indpred, i.indrelid, true), ''),
						COALESCE(pg_get_expr(i.indexprs, i.indrelid, true), '')
				)::text
				FROM pg_index i
				JOIN pg_class r ON r.oid = i.indrelid
				JOIN pg_namespace n ON n.oid = r.relnamespace
				WHERE n.nspname = $1 AND r.relname = $2
			), '[]')
	`
	var columns, constraints, indexes string
	if err := tx.QueryRow(ctx, query, schema, table).Scan(&columns, &constraints, &indexes); err != nil {
		return "", err
	}
	return columns + "\n" + constraints + "\n" + indexes, nil
}

func verifyArtifactStoreSearchPath(scopedURL, schema string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: scopedURL, MinConns: 1, MaxConns: 2})
	if err != nil {
		return fmt.Errorf("open scoped artifact fixture: %w", err)
	}
	defer db.Close()
	var currentSchema, searchPath string
	if err := db.Pool().QueryRow(ctx, "SELECT current_schema(), array_to_string(current_schemas(false), ',')").Scan(&currentSchema, &searchPath); err != nil {
		return fmt.Errorf("read scoped artifact search_path: %w", err)
	}
	if currentSchema != schema || searchPath != schema+",public" {
		return fmt.Errorf("artifact fixture search_path = %q/%q, want %q/%q", currentSchema, searchPath, schema, schema+",public")
	}
	return nil
}

func verifyArtifactTestMigrationState(scopedURL string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: scopedURL, MinConns: 1, MaxConns: 2})
	if err != nil {
		return fmt.Errorf("open migrated artifact schema: %w", err)
	}
	defer db.Close()
	var count, maxVersion int64
	var allApplied bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT count(*), COALESCE(max(version_id), -1), COALESCE(bool_and(is_applied), false)
		FROM goose_db_version
	`).Scan(&count, &maxVersion, &allApplied); err != nil {
		return fmt.Errorf("read artifact migration history: %w", err)
	}
	if count != 15 || maxVersion != 14 || !allApplied {
		return fmt.Errorf("artifact migration history = count %d/max %d/all_applied %t, want 15/14/true", count, maxVersion, allApplied)
	}
	return nil
}

func cleanupArtifactTestDatabase(databaseURL, schema string, cause error) error {
	if err := dropArtifactTestDatabase(databaseURL, schema); err != nil {
		return errors.Join(cause, fmt.Errorf("drop partially prepared artifact test schema: %w", err))
	}
	return cause
}

func dropArtifactTestDatabase(databaseURL, schema string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 2})
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err := db.Pool().Exec(ctx, "DROP SCHEMA IF EXISTS "+quoteArtifactTestIdentifier(schema)+" CASCADE"); err != nil {
		return fmt.Errorf("drop schema: %w", err)
	}
	return nil
}

func quoteArtifactTestIdentifier(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

func openArtifactStoreFixture(t *testing.T, authorizer Authorizer) (*database.DB, *Store, context.Context) {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	ensureArtifactTestDatabase(t)
	databaseURL := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("open integration database: %v", err)
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

func openMigratedIntegrationStore(t *testing.T, authorizer Authorizer) (*database.DB, *Store, context.Context) {
	t.Helper()
	baseURL := strings.TrimSpace(os.Getenv(artifactTestBaseURLEnv))
	if baseURL == "" {
		baseURL = strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	}
	if baseURL == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	schema := fmt.Sprintf("loomhelm_artifacts_migrated_%d_%d", os.Getpid(), artifactTestSchemaSequence.Add(1))
	scopedURL, err := artifactTestDatabaseURL(baseURL, schema)
	if err != nil {
		t.Fatalf("scope migrated integration database: %v", err)
	}
	if err := prepareArtifactTestDatabase(baseURL, schema, scopedURL); err != nil {
		t.Fatalf("prepare migrated integration database: %v", err)
	}
	if err := verifyArtifactTestMigrationState(scopedURL); err != nil {
		_ = dropArtifactTestDatabase(baseURL, schema)
		t.Fatalf("verify migrated integration database: %v", err)
	}
	t.Setenv("LOOMHELM_DATABASE_URL", scopedURL)
	t.Setenv(artifactTestSchemaEnv, schema)
	t.Cleanup(func() {
		if err := dropArtifactTestDatabase(baseURL, schema); err != nil {
			t.Errorf("drop migrated artifact integration schema: %v", err)
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	db, err := database.Open(ctx, database.Config{URL: scopedURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("open migrated integration database: %v", err)
	}
	if authorizer == nil {
		authorizer = allowAllAuthorizer{}
	}
	store, err := NewStore(db.Pool(), Config{Root: t.TempDir(), Authorizer: authorizer})
	if err != nil {
		db.Close()
		t.Fatalf("create migrated integration store: %v", err)
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
