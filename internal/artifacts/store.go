// Package artifacts owns durable conversation-file bytes and metadata.
package artifacts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	DefaultMaxBytes = 64 << 20
	maxIdentifier   = 128
	maxNameBytes    = 1024
)

var (
	ErrUnauthorized     = errors.New("artifact access denied")
	ErrInvalid          = errors.New("invalid artifact")
	ErrNotFound         = errors.New("artifact not found")
	ErrConflict         = errors.New("artifact already exists")
	ErrIntegrity        = errors.New("artifact integrity check failed")
	ErrSizeMismatch     = errors.New("artifact size does not match metadata")
	ErrHashMismatch     = errors.New("artifact hash does not match metadata")
	ErrTooLarge         = errors.New("artifact exceeds the configured size limit")
	ErrStoreUnavailable = errors.New("artifact store is unavailable")
)

// Operation identifies the access being authorized. Authorization is checked
// for writes as well as reads so an artifact cannot be uploaded into an
// otherwise unauthorized session.
type Operation string

const (
	OperationPut      Operation = "put"
	OperationMetadata Operation = "metadata"
	OperationOpen     Operation = "open"
)

// Authorizer is the required domain boundary for artifact access. A
// production implementation should resolve the caller's principal and the
// session's project through the application services; this package does not
// infer authorization from an artifact ID or a host path.
type Authorizer interface {
	Authorize(context.Context, Operation, protocol.Artifact) error
}

// AuthorizerFunc adapts a function to Authorizer.
type AuthorizerFunc func(context.Context, Operation, protocol.Artifact) error

func (f AuthorizerFunc) Authorize(ctx context.Context, operation Operation, artifact protocol.Artifact) error {
	if f == nil {
		return ErrUnauthorized
	}
	return f(ctx, operation, artifact)
}

// DenyAllAuthorizer is the default when a caller forgot to wire the real
// domain authorization service.
type DenyAllAuthorizer struct{}

func (DenyAllAuthorizer) Authorize(context.Context, Operation, protocol.Artifact) error {
	return ErrUnauthorized
}

type Config struct {
	Root       string
	MaxBytes   int64
	Authorizer Authorizer
}

func (c Config) validate() (string, error) {
	if strings.TrimSpace(c.Root) == "" {
		return "", fmt.Errorf("artifact storage root must not be empty: %w", ErrInvalid)
	}
	if c.MaxBytes < 0 {
		return "", fmt.Errorf("artifact storage size limit must not be negative: %w", ErrInvalid)
	}
	maxBytes := c.MaxBytes
	if maxBytes == 0 {
		maxBytes = DefaultMaxBytes
	}
	if maxBytes <= 0 {
		return "", fmt.Errorf("artifact storage size limit must be positive: %w", ErrInvalid)
	}
	absRoot, err := filepath.Abs(c.Root)
	if err != nil {
		return "", fmt.Errorf("resolve artifact storage root: %w", ErrInvalid)
	}
	return absRoot, nil
}

type Store struct {
	pool       *pgxpool.Pool
	root       string
	objects    string
	maxBytes   int64
	authorizer Authorizer
	putMu      sync.Mutex
}

var _ protocol.ArtifactStore = (*Store)(nil)

func NewStore(pool *pgxpool.Pool, cfg Config) (*Store, error) {
	if pool == nil {
		return nil, fmt.Errorf("artifact store database must be open: %w", ErrStoreUnavailable)
	}
	root, err := cfg.validate()
	if err != nil {
		return nil, err
	}
	if err := prepareDirectory(root, 0o700); err != nil {
		return nil, fmt.Errorf("prepare artifact storage root: %w", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("resolve artifact storage root: %w", err)
	}
	root = resolvedRoot
	objects := filepath.Join(root, "objects")
	if err := prepareDirectory(objects, 0o700); err != nil {
		return nil, fmt.Errorf("prepare artifact object directory: %w", err)
	}
	authorizer := cfg.Authorizer
	if authorizer == nil {
		authorizer = DenyAllAuthorizer{}
	}
	maxBytes := cfg.MaxBytes
	if maxBytes == 0 {
		maxBytes = DefaultMaxBytes
	}
	return &Store{
		pool:       pool,
		root:       root,
		objects:    objects,
		maxBytes:   maxBytes,
		authorizer: authorizer,
	}, nil
}

func (s *Store) Put(ctx context.Context, artifact protocol.Artifact, source io.Reader) (protocol.Artifact, error) {
	if s == nil {
		return protocol.Artifact{}, ErrStoreUnavailable
	}
	if err := requireContext(ctx); err != nil {
		return protocol.Artifact{}, err
	}
	if source == nil {
		return protocol.Artifact{}, fmt.Errorf("artifact source must not be nil: %w", ErrInvalid)
	}
	normalized, expectedHash, err := validateArtifact(artifact, s.maxBytes)
	if err != nil {
		return protocol.Artifact{}, err
	}
	if err := s.authorize(ctx, OperationPut, normalized); err != nil {
		return protocol.Artifact{}, err
	}
	if s.pool == nil {
		return protocol.Artifact{}, ErrStoreUnavailable
	}

	// The ID is the only storage key. Serialize local writers to avoid two
	// callers racing through the final link step; the database uniqueness
	// constraint remains the cross-process guard.
	s.putMu.Lock()
	defer s.putMu.Unlock()
	if err := s.ensureObjectDirectory(); err != nil {
		return protocol.Artifact{}, err
	}

	temporary, err := os.CreateTemp(s.objects, ".upload-*")
	if err != nil {
		return protocol.Artifact{}, fmt.Errorf("create artifact staging file: %w", err)
	}
	temporaryPath := temporary.Name()
	removeTemporary := true
	defer func() {
		_ = temporary.Close()
		if removeTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return protocol.Artifact{}, fmt.Errorf("set artifact staging permissions: %w", err)
	}

	hasher := sha256.New()
	limited := io.LimitReader(source, s.maxBytes+1)
	size, err := io.Copy(io.MultiWriter(temporary, hasher), limited)
	if err != nil {
		return protocol.Artifact{}, fmt.Errorf("write artifact bytes: %w", err)
	}
	if size > s.maxBytes {
		return protocol.Artifact{}, ErrTooLarge
	}
	if size != normalized.Size {
		return protocol.Artifact{}, fmt.Errorf("got %d bytes, want %d: %w", size, normalized.Size, ErrSizeMismatch)
	}
	actualHash := hex.EncodeToString(hasher.Sum(nil))
	if expectedHash != "" && expectedHash != actualHash {
		return protocol.Artifact{}, fmt.Errorf("got %s, want %s: %w", actualHash, expectedHash, ErrHashMismatch)
	}
	normalized.Sha256 = actualHash
	if err := temporary.Sync(); err != nil {
		return protocol.Artifact{}, fmt.Errorf("sync artifact staging file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return protocol.Artifact{}, fmt.Errorf("close artifact staging file: %w", err)
	}

	finalPath, err := s.objectPath(normalized.ID)
	if err != nil {
		return protocol.Artifact{}, err
	}
	if err := os.Link(temporaryPath, finalPath); err != nil {
		if errors.Is(err, os.ErrExist) {
			return protocol.Artifact{}, ErrConflict
		}
		return protocol.Artifact{}, fmt.Errorf("commit artifact bytes: %w", err)
	}
	removeTemporary = false
	if err := os.Remove(temporaryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		removeTemporary = true
		return protocol.Artifact{}, fmt.Errorf("remove artifact staging file: %w", err)
	}
	if err := syncDirectory(s.objects); err != nil {
		_ = os.Remove(finalPath)
		return protocol.Artifact{}, fmt.Errorf("sync artifact object directory: %w", err)
	}

	stored, err := s.insertMetadata(ctx, normalized)
	if err != nil {
		_ = os.Remove(finalPath)
		if errors.Is(err, ErrConflict) {
			return protocol.Artifact{}, err
		}
		return protocol.Artifact{}, err
	}
	return stored, nil
}

func (s *Store) Metadata(ctx context.Context, id string) (protocol.Artifact, error) {
	if err := requireContext(ctx); err != nil {
		return protocol.Artifact{}, err
	}
	if err := validateIdentifier(id, "artifact id"); err != nil {
		return protocol.Artifact{}, err
	}
	artifact, err := s.readMetadata(ctx, id)
	if err != nil {
		return protocol.Artifact{}, err
	}
	if err := s.authorize(ctx, OperationMetadata, artifact); err != nil {
		return protocol.Artifact{}, err
	}
	return artifact, nil
}

func (s *Store) Open(ctx context.Context, id string) (protocol.Artifact, protocol.ArtifactReader, error) {
	if err := requireContext(ctx); err != nil {
		return protocol.Artifact{}, nil, err
	}
	if err := validateIdentifier(id, "artifact id"); err != nil {
		return protocol.Artifact{}, nil, err
	}
	artifact, err := s.readMetadata(ctx, id)
	if err != nil {
		return protocol.Artifact{}, nil, err
	}
	if err := s.authorize(ctx, OperationOpen, artifact); err != nil {
		return protocol.Artifact{}, nil, err
	}
	path, err := s.objectPath(artifact.ID)
	if err != nil {
		return protocol.Artifact{}, nil, err
	}
	if err := s.ensureObjectDirectory(); err != nil {
		return protocol.Artifact{}, nil, err
	}
	file, err := openStoredFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return protocol.Artifact{}, nil, fmt.Errorf("artifact bytes are missing: %w", ErrIntegrity)
		}
		return protocol.Artifact{}, nil, err
	}
	if err := verifyFile(file, artifact); err != nil {
		_ = file.Close()
		return protocol.Artifact{}, nil, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return protocol.Artifact{}, nil, fmt.Errorf("rewind artifact bytes: %w", err)
	}
	return artifact, file, nil
}

func (s *Store) authorize(ctx context.Context, operation Operation, artifact protocol.Artifact) error {
	if s == nil || s.authorizer == nil {
		return ErrUnauthorized
	}
	if err := s.authorizer.Authorize(ctx, operation, artifact); err != nil {
		if errors.Is(err, ErrUnauthorized) {
			return err
		}
		return fmt.Errorf("authorize artifact %s: %w", operation, err)
	}
	return nil
}

func (s *Store) insertMetadata(ctx context.Context, artifact protocol.Artifact) (protocol.Artifact, error) {
	if s == nil || s.pool == nil {
		return protocol.Artifact{}, ErrStoreUnavailable
	}
	var runID *string
	var kind string
	var createdAt time.Time
	err := s.pool.QueryRow(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, run_id, name, kind, size, sha256, content_type, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, session_id, run_id, name, kind, size, sha256, content_type, created_at
	`, artifact.ID, artifact.SessionID, nullableString(artifact.RunID), artifact.Name, string(artifact.Kind), artifact.Size, artifact.Sha256, artifact.ContentType, parseCreatedAt(artifact.CreatedAt)).Scan(
		&artifact.ID,
		&artifact.SessionID,
		&runID,
		&artifact.Name,
		&kind,
		&artifact.Size,
		&artifact.Sha256,
		&artifact.ContentType,
		&createdAt,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return protocol.Artifact{}, ErrConflict
		}
		return protocol.Artifact{}, fmt.Errorf("persist artifact metadata: %w", err)
	}
	artifact.RunID = runID
	artifact.Kind = protocol.ArtifactKind(kind)
	artifact.CreatedAt = formatTime(createdAt)
	return artifact, nil
}

func (s *Store) readMetadata(ctx context.Context, id string) (protocol.Artifact, error) {
	if s == nil || s.pool == nil {
		return protocol.Artifact{}, ErrStoreUnavailable
	}
	var artifact protocol.Artifact
	var runID *string
	var kind string
	var createdAt time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT id, session_id, run_id, name, kind, size, sha256, content_type, created_at
		FROM conversation_artifacts
		WHERE id = $1
	`, id).Scan(&artifact.ID, &artifact.SessionID, &runID, &artifact.Name, &kind, &artifact.Size, &artifact.Sha256, &artifact.ContentType, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return protocol.Artifact{}, ErrNotFound
	}
	if err != nil {
		return protocol.Artifact{}, fmt.Errorf("read artifact metadata: %w", err)
	}
	artifact.RunID = runID
	artifact.Kind = protocol.ArtifactKind(kind)
	artifact.CreatedAt = formatTime(createdAt)
	return artifact, nil
}

func validateArtifact(artifact protocol.Artifact, maxBytes int64) (protocol.Artifact, string, error) {
	if err := validateIdentifier(artifact.ID, "artifact id"); err != nil {
		return protocol.Artifact{}, "", err
	}
	if err := validateIdentifier(artifact.SessionID, "session id"); err != nil {
		return protocol.Artifact{}, "", err
	}
	if artifact.RunID != nil {
		if err := validateIdentifier(*artifact.RunID, "run id"); err != nil {
			return protocol.Artifact{}, "", err
		}
	}
	if artifact.Name == "" || len(artifact.Name) > maxNameBytes || !utf8Safe(artifact.Name) {
		return protocol.Artifact{}, "", fmt.Errorf("artifact name is invalid: %w", ErrInvalid)
	}
	for _, character := range artifact.Name {
		if unicode.IsControl(character) {
			return protocol.Artifact{}, "", fmt.Errorf("artifact name contains a control character: %w", ErrInvalid)
		}
	}
	switch artifact.Kind {
	case protocol.ArtifactKindFile, protocol.ArtifactKindDiff, protocol.ArtifactKindSnapshot:
	default:
		return protocol.Artifact{}, "", fmt.Errorf("unsupported artifact kind %q: %w", artifact.Kind, ErrInvalid)
	}
	if artifact.Size < 0 {
		return protocol.Artifact{}, "", fmt.Errorf("artifact size must not be negative: %w", ErrInvalid)
	}
	if artifact.Size > maxBytes {
		return protocol.Artifact{}, "", ErrTooLarge
	}
	if strings.TrimSpace(artifact.ContentType) == "" {
		return protocol.Artifact{}, "", fmt.Errorf("artifact content type is required: %w", ErrInvalid)
	}
	if _, _, err := mime.ParseMediaType(artifact.ContentType); err != nil {
		return protocol.Artifact{}, "", fmt.Errorf("artifact content type is invalid: %w", ErrInvalid)
	}
	expectedHash := ""
	if artifact.Sha256 != "" {
		if len(artifact.Sha256) != sha256.Size*2 {
			return protocol.Artifact{}, "", fmt.Errorf("artifact sha256 must contain 64 hexadecimal characters: %w", ErrInvalid)
		}
		expectedHash = strings.ToLower(artifact.Sha256)
		if _, err := hex.DecodeString(expectedHash); err != nil {
			return protocol.Artifact{}, "", fmt.Errorf("artifact sha256 is invalid: %w", ErrInvalid)
		}
	}
	if artifact.CreatedAt == "" {
		artifact.CreatedAt = formatTime(time.Now().UTC())
	} else {
		createdAt, err := time.Parse(time.RFC3339Nano, artifact.CreatedAt)
		if err != nil {
			return protocol.Artifact{}, "", fmt.Errorf("artifact created_at is invalid: %w", ErrInvalid)
		}
		artifact.CreatedAt = formatTime(createdAt)
	}
	artifact.Sha256 = expectedHash
	return artifact, expectedHash, nil
}

func (s *Store) objectPath(id string) (string, error) {
	if s == nil || s.objects == "" {
		return "", ErrStoreUnavailable
	}
	if err := validateIdentifier(id, "artifact id"); err != nil {
		return "", err
	}
	path := filepath.Join(s.objects, id)
	if filepath.Dir(path) != s.objects {
		return "", fmt.Errorf("artifact path escaped object directory: %w", ErrInvalid)
	}
	return path, nil
}

func (s *Store) ensureObjectDirectory() error {
	if s == nil || s.objects == "" {
		return ErrStoreUnavailable
	}
	info, err := os.Lstat(s.objects)
	if err != nil {
		return fmt.Errorf("stat artifact object directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("artifact object directory is not a real directory: %w", ErrIntegrity)
	}
	resolved, err := filepath.EvalSymlinks(s.objects)
	if err != nil {
		return fmt.Errorf("resolve artifact object directory: %w", err)
	}
	if resolved != s.objects {
		return fmt.Errorf("artifact object directory escaped storage root: %w", ErrIntegrity)
	}
	return nil
}

func validateIdentifier(value, label string) error {
	if value == "" || len(value) > maxIdentifier || strings.TrimSpace(value) != value || value == "." || value == ".." {
		return fmt.Errorf("%s is invalid: %w", label, ErrInvalid)
	}
	for _, character := range value {
		if !(character == '-' || character == '_' || character == '.' || character == ':' || character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9') {
			return fmt.Errorf("%s contains an unsafe character: %w", label, ErrInvalid)
		}
	}
	if !identifierPattern.MatchString(value) {
		return fmt.Errorf("%s must begin with an alphanumeric character: %w", label, ErrInvalid)
	}
	return nil
}

var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)

func prepareDirectory(path string, mode os.FileMode) error {
	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("%s is not a real directory", path)
	}
	return os.Chmod(path, mode)
}

func openStoredFile(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("stored artifact is not a regular file: %w", ErrIntegrity)
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) {
			return nil, fmt.Errorf("stored artifact is a symlink: %w", ErrIntegrity)
		}
		return nil, err
	}
	return file, nil
}

func verifyFile(file *os.File, artifact protocol.Artifact) error {
	if file == nil {
		return ErrIntegrity
	}
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat artifact bytes: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("artifact bytes are not regular: %w", ErrIntegrity)
	}
	if info.Size() != artifact.Size {
		return fmt.Errorf("got %d bytes, want %d: %w", info.Size(), artifact.Size, ErrSizeMismatch)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind artifact bytes for verification: %w", err)
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return fmt.Errorf("hash artifact bytes: %w", err)
	}
	if hex.EncodeToString(hasher.Sum(nil)) != artifact.Sha256 {
		return ErrHashMismatch
	}
	return nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func requireContext(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("artifact context must not be nil: %w", ErrInvalid)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func parseCreatedAt(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func utf8Safe(value string) bool {
	return utf8.ValidString(value)
}
