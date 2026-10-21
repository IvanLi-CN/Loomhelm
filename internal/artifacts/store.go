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
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
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
	faults     *faultHooks
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
	faults     *faultHooks
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
		return nil, fmt.Errorf("prepare artifact storage root: %w", ErrStoreUnavailable)
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("resolve artifact storage root: %w", ErrStoreUnavailable)
	}
	root = resolvedRoot
	objects := filepath.Join(root, "objects")
	if err := prepareDirectory(objects, 0o700); err != nil {
		return nil, fmt.Errorf("prepare artifact object directory: %w", ErrStoreUnavailable)
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
		faults:     cfg.faults,
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
	createdAtProvided := artifact.CreatedAt != ""
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

	staged, stagingName, err := s.stage(ctx, normalized, expectedHash, source)
	if err != nil {
		return protocol.Artifact{}, err
	}
	keepStaging := true
	defer func() {
		if !keepStaging {
			s.removeStaging(stagingName)
		}
	}()

	record, err := s.ensurePending(ctx, staged, createdAtProvided, stagingName)
	if err != nil {
		return protocol.Artifact{}, err
	}
	if !sameArtifactMetadata(staged, record.Artifact, createdAtProvided) {
		return protocol.Artifact{}, ErrConflict
	}
	switch record.State {
	case publicationReady:
		check, inspectErr := s.inspectReady(record)
		if inspectErr != nil {
			return protocol.Artifact{}, inspectErr
		}
		if check != fileValid {
			s.markReadyObjectUnavailable(record.Artifact.ID, "ready-mismatch")
			return protocol.Artifact{}, unavailableError(ErrIntegrity)
		}
		keepStaging = false
		return record.Artifact, nil
	case publicationUnavailable:
		return protocol.Artifact{}, unavailableError(ErrIntegrity)
	case publicationPending:
		resolved, status, err := s.reconcileOne(ctx, record.Artifact.ID)
		if err != nil {
			return protocol.Artifact{}, err
		}
		if status == recoveryUnavailable {
			return protocol.Artifact{}, unavailableError(ErrIntegrity)
		}
		if status != recoveryReady {
			return protocol.Artifact{}, ErrRecoveryIncomplete
		}
		keepStaging = false
		return resolved.Artifact, nil
	default:
		return protocol.Artifact{}, fmt.Errorf("artifact publication state is invalid: %w", ErrIntegrity)
	}
}

func (s *Store) Metadata(ctx context.Context, id string) (protocol.Artifact, error) {
	if s == nil {
		return protocol.Artifact{}, ErrStoreUnavailable
	}
	if err := requireContext(ctx); err != nil {
		return protocol.Artifact{}, err
	}
	if err := validateIdentifier(id, "artifact id"); err != nil {
		return protocol.Artifact{}, err
	}
	record, err := s.readReadyRecord(ctx, id)
	if err != nil {
		return protocol.Artifact{}, err
	}
	if err := s.authorize(ctx, OperationMetadata, record.Artifact); err != nil {
		return protocol.Artifact{}, err
	}
	return record.Artifact, nil
}

func (s *Store) Open(ctx context.Context, id string) (protocol.Artifact, protocol.ArtifactReader, error) {
	if s == nil {
		return protocol.Artifact{}, nil, ErrStoreUnavailable
	}
	if err := requireContext(ctx); err != nil {
		return protocol.Artifact{}, nil, err
	}
	if err := validateIdentifier(id, "artifact id"); err != nil {
		return protocol.Artifact{}, nil, err
	}
	record, err := s.readReadyRecord(ctx, id)
	if err != nil {
		return protocol.Artifact{}, nil, err
	}
	if err := s.authorize(ctx, OperationOpen, record.Artifact); err != nil {
		return protocol.Artifact{}, nil, err
	}
	path, err := s.objectPath(record.Artifact.ID)
	if err != nil {
		return protocol.Artifact{}, nil, err
	}
	if err := s.ensureObjectDirectory(); err != nil {
		return protocol.Artifact{}, nil, err
	}
	file, err := openStoredFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			s.markReadyObjectUnavailable(record.Artifact.ID, "final-missing")
			return protocol.Artifact{}, nil, unavailableError(ErrIntegrity)
		}
		return protocol.Artifact{}, nil, err
	}
	if err := verifyFile(file, record.Artifact); err != nil {
		_ = file.Close()
		if errors.Is(err, ErrIntegrity) || errors.Is(err, ErrSizeMismatch) || errors.Is(err, ErrHashMismatch) {
			s.markReadyObjectUnavailable(record.Artifact.ID, "final-mismatch")
			return protocol.Artifact{}, nil, unavailableError(err)
		}
		return protocol.Artifact{}, nil, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return protocol.Artifact{}, nil, fmt.Errorf("rewind artifact bytes: %w", ErrStoreUnavailable)
	}
	return record.Artifact, file, nil
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
	if strings.TrimSpace(artifact.ContentType) == "" || len(artifact.ContentType) > 255 {
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
		return fmt.Errorf("stat artifact object directory: %w", ErrStoreUnavailable)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("artifact object directory is not a real directory: %w", ErrIntegrity)
	}
	resolved, err := filepath.EvalSymlinks(s.objects)
	if err != nil {
		return fmt.Errorf("resolve artifact object directory: %w", ErrStoreUnavailable)
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
		if errors.Is(err, os.ErrNotExist) {
			return nil, os.ErrNotExist
		}
		return nil, fmt.Errorf("inspect stored artifact: %w", ErrStoreUnavailable)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("stored artifact is not a regular file: %w", ErrIntegrity)
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) {
			return nil, fmt.Errorf("stored artifact is a symlink: %w", ErrIntegrity)
		}
		return nil, fmt.Errorf("open stored artifact: %w", ErrStoreUnavailable)
	}
	return file, nil
}

func verifyFile(file *os.File, artifact protocol.Artifact) error {
	if file == nil {
		return ErrIntegrity
	}
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat artifact bytes: %w", ErrStoreUnavailable)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("artifact bytes are not regular: %w", ErrIntegrity)
	}
	if info.Size() != artifact.Size {
		return fmt.Errorf("got %d bytes, want %d: %w", info.Size(), artifact.Size, ErrSizeMismatch)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind artifact bytes for verification: %w", ErrStoreUnavailable)
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return fmt.Errorf("hash artifact bytes: %w", ErrStoreUnavailable)
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
