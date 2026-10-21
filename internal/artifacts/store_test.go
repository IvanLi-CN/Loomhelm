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
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
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
	stored, err := store.Put(ctx, artifact, bytes.NewReader(content))
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
	reopenedMetadata, reader, err := reopened.Open(ctx, artifact.ID)
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
	if _, err := store.Put(ctx, wrongHash, bytes.NewReader(content)); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("hash mismatch error = %v, want %v", err, ErrHashMismatch)
	}

	wrongSize := testArtifact(uniqueID("artifact-size"), nil, content)
	wrongSize.Size++
	if _, err := store.Put(ctx, wrongSize, bytes.NewReader(content)); !errors.Is(err, ErrSizeMismatch) {
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
}

func TestStoreRejectsUnauthorizedMetadataAndOpen(t *testing.T) {
	db, store, ctx := openIntegrationStore(t, nil)
	defer db.Close()
	content := []byte("authorized bytes")
	artifact := testArtifact(uniqueID("artifact-auth"), nil, content)
	if _, err := store.Put(ctx, artifact, bytes.NewReader(content)); err != nil {
		t.Fatal(err)
	}
	denied, err := NewStore(db.Pool(), Config{Root: store.root, Authorizer: DenyAllAuthorizer{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := denied.Metadata(ctx, artifact.ID); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unauthorized metadata error = %v, want %v", err, ErrUnauthorized)
	}
	if _, _, err := denied.Open(ctx, artifact.ID); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unauthorized open error = %v, want %v", err, ErrUnauthorized)
	}
	if _, err := denied.Put(ctx, testArtifact(uniqueID("artifact-write-denied"), nil, content), bytes.NewReader(content)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unauthorized put error = %v, want %v", err, ErrUnauthorized)
	}
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
