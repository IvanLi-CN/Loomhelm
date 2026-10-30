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
	"reflect"
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
	DefaultMaxBytes                   = 64 << 20
	maxIdentifier                     = 128
	maxNameBytes                      = 1024
	maxConcurrentMetadataVerification = 2
)

var (
	ErrUnauthorized        = errors.New("artifact access denied")
	ErrInvalid             = errors.New("invalid artifact")
	ErrNotFound            = errors.New("artifact not found")
	ErrConflict            = errors.New("artifact already exists")
	ErrIntegrity           = errors.New("artifact integrity check failed")
	ErrSizeMismatch        = errors.New("artifact size does not match metadata")
	ErrHashMismatch        = errors.New("artifact hash does not match metadata")
	ErrContentChanged      = errors.New("artifact content changed during download")
	ErrRangeNotSatisfiable = errors.New("artifact range is not satisfiable")
	ErrTooLarge            = errors.New("artifact exceeds the configured size limit")
	ErrStoreUnavailable    = errors.New("artifact store is unavailable")
	ErrInputNotCancellable = errors.New("artifact source does not support cancellation")
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
	if filepath.Dir(absRoot) == absRoot {
		return "", fmt.Errorf("artifact storage root must not be the filesystem root: %w", ErrInvalid)
	}
	return absRoot, nil
}

type Store struct {
	pool                      *pgxpool.Pool
	root                      string
	objects                   string
	maxBytes                  int64
	authorizer                Authorizer
	faults                    *faultHooks
	metadataVerificationSlots chan struct{}
}

func (s *Store) maxArtifactBytes() int64 {
	if s == nil || s.maxBytes <= 0 {
		return DefaultMaxBytes
	}
	return s.maxBytes
}

type contentReader struct {
	*os.File
	store   *Store
	id      string
	version string
}

func (r *contentReader) contentVersion() string {
	if r == nil {
		return ""
	}
	return r.version
}

// Read and Seek enforce the same file-incarnation check for the unbounded
// browser download path that the bounded content endpoint performs around
// every chunk. A rename leaves this descriptor on the original immutable
// object; an in-place mutation is rejected before its bytes can be emitted.
func (r *contentReader) Read(buffer []byte) (int, error) {
	if err := r.verifyContentVersion(context.Background()); err != nil {
		return 0, err
	}
	n, err := r.File.Read(buffer)
	if n > 0 {
		if versionErr := r.verifyContentVersion(context.Background()); versionErr != nil {
			return 0, versionErr
		}
	}
	return n, err
}

func (r *contentReader) Seek(offset int64, whence int) (int64, error) {
	if err := r.verifyContentVersion(context.Background()); err != nil {
		return 0, err
	}
	position, err := r.File.Seek(offset, whence)
	if err != nil {
		return position, err
	}
	if err := r.verifyContentVersion(context.Background()); err != nil {
		return 0, err
	}
	return position, nil
}

func (r *contentReader) verifyContentVersion(ctx context.Context) error {
	if r == nil || r.File == nil {
		return ErrStoreUnavailable
	}
	if err := requireContext(ctx); err != nil {
		return err
	}
	version, err := fileContentVersion(r.File)
	if err != nil {
		return err
	}
	if version != r.version {
		return fmt.Errorf("artifact content snapshot changed while reading: %w", ErrContentChanged)
	}
	return nil
}

func (r *contentReader) verifyCanonicalContentVersion(ctx context.Context) error {
	if r == nil || r.File == nil || r.store == nil {
		return ErrStoreUnavailable
	}
	if err := requireContext(ctx); err != nil {
		return err
	}
	path, err := r.store.objectPath(r.id)
	if err != nil {
		return err
	}
	file, err := openStoredFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, ErrIntegrity) {
			return fmt.Errorf("artifact content path changed while reading: %w", ErrContentChanged)
		}
		return err
	}
	defer file.Close()
	version, err := fileContentVersion(file)
	if err != nil {
		return err
	}
	if version != r.version {
		return fmt.Errorf("artifact content path changed while reading: %w", ErrContentChanged)
	}
	return nil
}

func (r *contentReader) verifyContent(ctx context.Context, artifact protocol.Artifact) error {
	if r == nil || r.File == nil || r.store == nil {
		return ErrStoreUnavailable
	}
	if err := r.verifyContentVersion(ctx); err != nil {
		return err
	}
	if err := r.verifyCanonicalContentVersion(ctx); err != nil {
		return err
	}
	if err := verifyFile(ctx, r.File, artifact); err != nil {
		if errors.Is(err, ErrIntegrity) || errors.Is(err, ErrSizeMismatch) || errors.Is(err, ErrHashMismatch) {
			// Distinguish an in-place mutation from stable corruption before
			// recording a recoverable content-mismatch state. Recovery revalidates
			// the final object and restores ready when the bytes become valid, so
			// the database cannot be permanently poisoned by this read race.
			if versionErr := r.verifyContentVersion(ctx); versionErr != nil {
				return versionErr
			}
			if pathErr := r.verifyCanonicalContentVersion(ctx); pathErr != nil {
				return pathErr
			}
			r.store.fault(faultBeforeContentMismatchMark)
			if markErr := r.store.markReadyContentMismatch(ctx, r.id, r.version); markErr != nil {
				return markErr
			}
			return unavailableError(err)
		}
		return err
	}
	if err := r.verifyContentVersion(ctx); err != nil {
		return err
	}
	return r.verifyCanonicalContentVersion(ctx)
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
	if err := prepareDirectoryDurable(root, 0o700); err != nil {
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
	if err := syncDirectory(root); err != nil {
		return nil, fmt.Errorf("sync artifact storage root: %w", ErrStoreUnavailable)
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
		pool:                      pool,
		root:                      root,
		objects:                   objects,
		maxBytes:                  maxBytes,
		authorizer:                authorizer,
		faults:                    cfg.faults,
		metadataVerificationSlots: make(chan struct{}, maxConcurrentMetadataVerification),
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
	readSource, ok := source.(io.ReadCloser)
	if !ok {
		return protocol.Artifact{}, fmt.Errorf("artifact source must be an io.ReadCloser: %w", ErrInputNotCancellable)
	}
	if s.pool == nil {
		return protocol.Artifact{}, ErrStoreUnavailable
	}
	ownedSource := newOwnedReadCloser(readSource)
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	stopCloseOnCancel := context.AfterFunc(ctx, func() {
		cleanup.start()
		_ = ownedSource.Close()
	})
	defer stopCloseOnCancel()
	defer ownedSource.Close()

	staged, stagingName, err := s.stage(ctx, normalized, expectedHash, ownedSource)
	if err != nil {
		return protocol.Artifact{}, err
	}
	stagedIdentity, identityErr := s.stagingIdentity(stagingName)
	if identityErr != nil {
		s.cleanupFailedStaging(stagingName, cleanup)
		return protocol.Artifact{}, identityErr
	}
	if stagedIdentity == nil {
		s.cleanupFailedStaging(stagingName, cleanup)
		return protocol.Artifact{}, fmt.Errorf("staging object disappeared after staging: %w", ErrStoreUnavailable)
	}
	keepStaging := true
	defer func() {
		if !keepStaging {
			if err := s.removeStagingIfIdentity(stagingName, stagedIdentity); err != nil {
				_ = s.enqueueStagingCleanupWithIdentity(stagingName, stagedIdentity, cleanup)
			}
		}
	}()

	record, err := s.ensurePending(ctx, staged, stagingName, cleanup)
	if err != nil {
		if errors.Is(err, ErrConflict) {
			keepStaging = !s.stagingUnreferenced(ctx, staged.ID, stagingName, cleanup)
		}
		return protocol.Artifact{}, err
	}
	if !sameArtifactMetadata(staged, record.Artifact) {
		keepStaging = false
		return protocol.Artifact{}, ErrConflict
	}
	switch record.State {
	case publicationReady:
		check, pathVersion, inspectErr := s.inspectReadyWithVersion(ctx, record)
		if inspectErr != nil {
			return protocol.Artifact{}, inspectErr
		}
		if check == fileUnknown {
			return protocol.Artifact{}, ErrStoreUnavailable
		}
		if check != fileValid {
			keepStaging = false
			if markErr := s.markReadyObjectUnavailableForVersion(ctx, record.Artifact.ID, pathVersion, finalReason(check)); markErr != nil {
				return protocol.Artifact{}, markErr
			}
			return protocol.Artifact{}, unavailableError(ErrIntegrity)
		}
		resolved, status, reclaimErr := s.reclaimReadyStaging(ctx, record.Artifact.ID, cleanup)
		if reclaimErr != nil {
			return protocol.Artifact{}, reclaimErr
		}
		if status == recoveryUnavailable {
			keepStaging = false
			return protocol.Artifact{}, unavailableError(ErrIntegrity)
		}
		if status != recoveryReady {
			return protocol.Artifact{}, ErrRecoveryIncomplete
		}
		keepStaging = false
		return resolved.Artifact, nil
	case publicationUnavailable:
		keepStaging = false
		return protocol.Artifact{}, unavailableError(ErrIntegrity)
	case publicationPending:
		resolved, status, err := s.reconcileOne(ctx, record.Artifact.ID, cleanup)
		if err != nil {
			return protocol.Artifact{}, err
		}
		if status == recoveryUnavailable && repairableUnavailableReason(resolved.UnavailableReason) {
			// The staged bytes from this Put are already verified. Rebind the
			// repairable pending identity to them before cleanup can discard them.
			repaired, repairErr := s.ensurePending(ctx, staged, stagingName, cleanup)
			if repairErr != nil {
				return protocol.Artifact{}, repairErr
			}
			if !sameArtifactMetadata(staged, repaired.Artifact) {
				keepStaging = false
				return protocol.Artifact{}, ErrConflict
			}
			switch repaired.State {
			case publicationPending:
				resolved, status, err = s.reconcileOne(ctx, repaired.Artifact.ID, cleanup)
			case publicationReady:
				resolved, status, err = s.reclaimReadyStaging(ctx, repaired.Artifact.ID, cleanup)
			default:
				resolved, status = repaired, recoveryUnavailable
			}
			if err != nil {
				return protocol.Artifact{}, err
			}
		}
		if status == recoveryUnavailable {
			keepStaging = resolved.StagingName == stagingName
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
	record, err := s.readAuthorizedReadyRecord(ctx, id, OperationMetadata)
	if err != nil {
		return protocol.Artifact{}, err
	}
	releaseVerification, err := s.acquireMetadataVerification(ctx)
	if err != nil {
		return protocol.Artifact{}, err
	}
	defer releaseVerification()
	if err := s.ensureObjectDirectory(); err != nil {
		return protocol.Artifact{}, err
	}
	check, pathVersion, inspectErr := s.inspectReadyWithVersion(ctx, record)
	if inspectErr != nil {
		return protocol.Artifact{}, inspectErr
	}
	if check == fileUnknown {
		return protocol.Artifact{}, ErrStoreUnavailable
	}
	if check != fileValid {
		if markErr := s.markReadyObjectUnavailableForVersion(ctx, record.Artifact.ID, pathVersion, finalReason(check)); markErr != nil {
			return protocol.Artifact{}, markErr
		}
		return protocol.Artifact{}, unavailableError(ErrIntegrity)
	}
	return record.Artifact, nil
}

func (s *Store) acquireMetadataVerification(ctx context.Context) (func(), error) {
	if s == nil || s.metadataVerificationSlots == nil {
		return func() {}, nil
	}
	select {
	case s.metadataVerificationSlots <- struct{}{}:
		return func() { <-s.metadataVerificationSlots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return nil, ErrStoreUnavailable
	}
}

func (s *Store) Open(ctx context.Context, id string) (protocol.Artifact, protocol.ArtifactReader, error) {
	return s.openReadyArtifact(ctx, id, true, "")
}

// OpenContent opens an authorized, immutable ready object for a bounded
// content transfer. Publication verifies the complete SHA-256 before the
// object enters the ready state and final objects are never overwritten by
// Store. This path repeats authorization, regular-file and exact-size checks
// for every request. OpenContentAt additionally binds each request to the
// previous file incarnation without a server-side transfer cache. The first
// chunk calls verifyContent once before bytes are emitted, so the server
// rejects a corrupt object before reporting any content; the response also
// carries the canonical SHA-256 for caller-side reassembly verification. Open
// remains the fully verifying path for browser downloads and callers that need
// a server-side full hash check before the first byte.
func (s *Store) OpenContent(ctx context.Context, id string) (protocol.Artifact, protocol.ArtifactReader, error) {
	return s.openReadyArtifact(ctx, id, false, "")
}

// OpenContentAt resumes a bounded content transfer only when the current
// object is the same filesystem incarnation that produced expectedVersion.
// The token is stateless and opaque; it binds requests without keeping a
// server-side transfer cache.
func (s *Store) OpenContentAt(ctx context.Context, id, expectedVersion string) (protocol.Artifact, protocol.ArtifactReader, error) {
	return s.openReadyArtifact(ctx, id, false, expectedVersion)
}

func (s *Store) openReadyArtifact(ctx context.Context, id string, verify bool, expectedVersion string) (protocol.Artifact, protocol.ArtifactReader, error) {
	if s == nil {
		return protocol.Artifact{}, nil, ErrStoreUnavailable
	}
	if err := requireContext(ctx); err != nil {
		return protocol.Artifact{}, nil, err
	}
	if err := validateIdentifier(id, "artifact id"); err != nil {
		return protocol.Artifact{}, nil, err
	}
	record, err := s.readAuthorizedReadyRecord(ctx, id, OperationOpen)
	if err != nil {
		return protocol.Artifact{}, nil, err
	}
	path, err := s.objectPath(record.Artifact.ID)
	if err != nil {
		return protocol.Artifact{}, nil, err
	}
	if err := s.ensureObjectDirectory(); err != nil {
		return protocol.Artifact{}, nil, err
	}
	pathVersion, pathVersionErr := objectPathVersion(path)
	if pathVersionErr != nil {
		return protocol.Artifact{}, nil, pathVersionErr
	}
	file, err := openStoredFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if markErr := s.markReadyObjectUnavailableForVersion(ctx, record.Artifact.ID, pathVersion, "final-missing"); markErr != nil {
				return protocol.Artifact{}, nil, markErr
			}
			return protocol.Artifact{}, nil, unavailableError(ErrIntegrity)
		}
		if errors.Is(err, ErrIntegrity) {
			if markErr := s.markReadyObjectUnavailableForVersion(ctx, record.Artifact.ID, pathVersion, "final-mismatch"); markErr != nil {
				return protocol.Artifact{}, nil, markErr
			}
			return protocol.Artifact{}, nil, unavailableError(ErrIntegrity)
		}
		return protocol.Artifact{}, nil, err
	}
	version, versionErr := fileContentVersion(file)
	if versionErr != nil {
		_ = file.Close()
		return protocol.Artifact{}, nil, versionErr
	}
	if expectedVersion != "" && expectedVersion != version {
		_ = file.Close()
		return protocol.Artifact{}, nil, fmt.Errorf("artifact content snapshot does not match: %w", ErrContentChanged)
	}
	if s.faults != nil && s.faults.BeforeOpenVerification != nil {
		s.faults.BeforeOpenVerification()
	}
	var verifyErr error
	if verify {
		verifyErr = verifyFile(ctx, file, record.Artifact)
	} else {
		verifyErr = verifyFileSize(ctx, file, record.Artifact)
	}
	if verifyErr != nil {
		currentVersion, currentVersionErr := fileContentVersion(file)
		_ = file.Close()
		if currentVersionErr != nil {
			return protocol.Artifact{}, nil, currentVersionErr
		}
		if currentVersion != version {
			return protocol.Artifact{}, nil, fmt.Errorf("artifact content snapshot changed while opening: %w", ErrContentChanged)
		}
		if errors.Is(verifyErr, ErrIntegrity) || errors.Is(verifyErr, ErrSizeMismatch) || errors.Is(verifyErr, ErrHashMismatch) {
			if pathErr := s.verifyCanonicalObjectVersion(ctx, record.Artifact.ID, version); pathErr != nil {
				return protocol.Artifact{}, nil, pathErr
			}
			if markErr := s.markReadyObjectUnavailableForVersion(ctx, record.Artifact.ID, version, "final-mismatch"); markErr != nil {
				return protocol.Artifact{}, nil, markErr
			}
			return protocol.Artifact{}, nil, unavailableError(verifyErr)
		}
		return protocol.Artifact{}, nil, verifyErr
	}
	currentVersion, currentVersionErr := fileContentVersion(file)
	if currentVersionErr != nil {
		_ = file.Close()
		return protocol.Artifact{}, nil, currentVersionErr
	}
	if currentVersion != version {
		_ = file.Close()
		return protocol.Artifact{}, nil, fmt.Errorf("artifact content snapshot changed while opening: %w", ErrContentChanged)
	}
	if expectedVersion != "" && expectedVersion != currentVersion {
		_ = file.Close()
		return protocol.Artifact{}, nil, fmt.Errorf("artifact content snapshot does not match: %w", ErrContentChanged)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return protocol.Artifact{}, nil, fmt.Errorf("rewind artifact bytes: %w", ErrStoreUnavailable)
	}
	if !verify {
		return record.Artifact, &contentReader{File: file, store: s, id: record.Artifact.ID, version: currentVersion}, nil
	}
	return record.Artifact, &contentReader{File: file, store: s, id: record.Artifact.ID, version: currentVersion}, nil
}

func (s *Store) authorize(ctx context.Context, operation Operation, artifact protocol.Artifact) error {
	if s == nil || s.authorizer == nil {
		return ErrUnauthorized
	}
	if err := s.authorizer.Authorize(ctx, operation, artifact); err != nil {
		if errors.Is(err, ErrUnauthorized) {
			return ErrUnauthorized
		}
		if errors.Is(err, ErrStoreUnavailable) {
			return ErrStoreUnavailable
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return ErrUnauthorized
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
		if unicode.IsControl(character) || unicode.Is(unicode.Bidi_Control, character) {
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
	if artifact.CreatedAt != "" {
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

func prepareDirectoryDurable(path string, mode os.FileMode) error {
	missing := make([]string, 0, 2)
	for current := path; ; current = filepath.Dir(current) {
		if _, err := os.Lstat(current); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		missing = append(missing, current)
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
	}
	if err := prepareDirectory(path, mode); err != nil {
		return err
	}
	for _, directory := range missing {
		if err := syncDirectory(directory); err != nil {
			return err
		}
	}
	if len(missing) > 0 {
		return syncDirectory(filepath.Dir(missing[len(missing)-1]))
	}
	return nil
}

func openStoredFile(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if _, dirErr := os.Lstat(filepath.Dir(path)); dirErr != nil {
				if errors.Is(dirErr, os.ErrNotExist) {
					return nil, fmt.Errorf("artifact object directory is unavailable: %w", ErrStoreUnavailable)
				}
				return nil, fmt.Errorf("inspect artifact object directory: %w", ErrStoreUnavailable)
			}
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

func verifyFile(ctx context.Context, file *os.File, artifact protocol.Artifact) error {
	if file == nil {
		return ErrIntegrity
	}
	if err := requireContext(ctx); err != nil {
		return err
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
	if _, err := io.Copy(hasher, contextReader{ctx: ctx, reader: file}); err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return contextErr
		}
		return fmt.Errorf("hash artifact bytes: %w", ErrStoreUnavailable)
	}
	if hex.EncodeToString(hasher.Sum(nil)) != artifact.Sha256 {
		return ErrHashMismatch
	}
	return nil
}

func verifyFileSize(ctx context.Context, file *os.File, artifact protocol.Artifact) error {
	if file == nil {
		return ErrIntegrity
	}
	if err := requireContext(ctx); err != nil {
		return err
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
	return nil
}

func fileContentVersion(file *os.File) (string, error) {
	if file == nil {
		return "", ErrIntegrity
	}
	info, err := file.Stat()
	if err != nil {
		return "", fmt.Errorf("stat artifact content version: %w", ErrStoreUnavailable)
	}
	return fileInfoContentVersion(info)
}

func fileInfoContentVersion(info os.FileInfo) (string, error) {
	if info == nil {
		return "", ErrIntegrity
	}
	identity := fmt.Sprintf(
		"%T|dev=%s|ino=%s|mode=%s|size=%d|mtime=%s|modtime=%d",
		info.Sys(),
		statField(info.Sys(), "Dev"),
		statField(info.Sys(), "Ino"),
		statField(info.Sys(), "Mode"),
		info.Size(),
		statField(info.Sys(), "Mtim", "Mtimespec"),
		info.ModTime().UnixNano(),
	)
	digest := sha256.Sum256([]byte(identity))
	return "v1-" + hex.EncodeToString(digest[:]), nil
}

const missingObjectPathVersion = "missing"

func objectPathVersion(path string) (string, error) {
	info, err := os.Lstat(path)
	if err == nil {
		return fileInfoContentVersion(info)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect artifact object path: %w", ErrStoreUnavailable)
	}
	if _, dirErr := os.Lstat(filepath.Dir(path)); dirErr != nil {
		return "", fmt.Errorf("inspect artifact object directory: %w", ErrStoreUnavailable)
	}
	return missingObjectPathVersion, nil
}

func statField(system any, names ...string) string {
	value := reflect.ValueOf(system)
	if !value.IsValid() {
		return ""
	}
	if value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return ""
		}
		value = value.Elem()
	}
	for _, name := range names {
		field := value.FieldByName(name)
		if field.IsValid() && field.CanInterface() {
			return fmt.Sprintf("%#v", field.Interface())
		}
	}
	return ""
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
	return parsed.Round(time.Microsecond)
}

func formatTime(value time.Time) string {
	return value.UTC().Round(time.Microsecond).Format(time.RFC3339Nano)
}

func utf8Safe(value string) bool {
	return utf8.ValidString(value)
}
