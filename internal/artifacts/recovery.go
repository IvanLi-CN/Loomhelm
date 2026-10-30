package artifacts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
)

const (
	DefaultRecoveryLimit  = 64
	MaxRecoveryLimit      = 1024
	cleanupTimeout        = 5 * time.Second
	contentMismatchReason = "content-mismatch"
)

var (
	ErrUnavailable        = errors.New("artifact is unavailable")
	ErrRecoveryPending    = errors.New("artifact recovery is pending")
	ErrRecoveryIncomplete = errors.New("artifact recovery incomplete")
	ErrRecoveryDeferred   = errors.New("artifact recovery deferred")
)

func databaseWriteError(message string, err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return fmt.Errorf("%s: %w", message, ErrStoreUnavailable)
}

type sanitizedStagingSyncError struct {
	cause error
}

func (e sanitizedStagingSyncError) Error() string {
	return "artifact staging directory sync failed"
}

func (e sanitizedStagingSyncError) Is(target error) bool {
	return target == ErrStoreUnavailable || errors.Is(e.cause, target)
}

type publicationState string

const (
	publicationPending     publicationState = "pending"
	publicationReady       publicationState = "ready"
	publicationUnavailable publicationState = "unavailable"
)

type artifactRecord struct {
	Artifact          protocol.Artifact
	State             publicationState
	StagingName       string
	StagingIdentity   *string
	StagingReclaimed  bool
	UnavailableReason string
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

type recoveryStatus string

const (
	recoveryReady       recoveryStatus = "ready"
	recoveryUnavailable recoveryStatus = "unavailable"
	recoveryPending     recoveryStatus = "pending"
)

// RecoveryReport describes one bounded reconciliation pass.
type RecoveryReport struct {
	Scanned     int
	Ready       int
	Unavailable int
	Pending     int
	Cleaned     int
	Failed      int
	Deferred    int
}

type faultPoint string

const (
	faultAfterStage                  faultPoint = "after-stage"
	faultAfterIntentCommit           faultPoint = "after-intent-commit"
	faultAfterRepairIntentCommit     faultPoint = "after-repair-intent-commit"
	faultAfterFinalLink              faultPoint = "after-final-link"
	faultAfterFinalPublication       faultPoint = "after-final-publication"
	faultAfterReadyCommit            faultPoint = "after-ready-commit"
	faultBeforeContentMismatchMark   faultPoint = "before-content-mismatch-mark"
	faultBeforeObjectUnavailableMark faultPoint = "before-object-unavailable-mark"
)

// faultHooks is intentionally unexported. Package tests use it to terminate a
// helper process at durable publication boundaries; production composition
// cannot configure process-exit behavior through Config.
type faultHooks struct {
	AfterStage                  func()
	AfterIntentCommit           func()
	AfterRepairIntentCommit     func()
	AfterFinalLink              func()
	AfterFinalPublication       func()
	AfterReadyCommit            func()
	CommitResponseLost          func() error
	BeforeIdentityLock          func(context.Context, pgx.Tx, string)
	BeforeIdentityTryLock       func()
	AfterIdentityLock           func()
	BeforeReadyStagingRemoval   func()
	AfterReadyStagingRemoval    func()
	BeforeStagingDirectorySync  func() error
	BeforeStagingCleanupCommit  func()
	BeforeOpenVerification      func()
	BeforeContentMismatchMark   func()
	BeforeObjectUnavailableMark func()
}

func (s *Store) fault(point faultPoint) {
	if s == nil || s.faults == nil {
		return
	}
	switch point {
	case faultAfterStage:
		if s.faults.AfterStage != nil {
			s.faults.AfterStage()
		}
	case faultAfterIntentCommit:
		if s.faults.AfterIntentCommit != nil {
			s.faults.AfterIntentCommit()
		}
	case faultAfterRepairIntentCommit:
		if s.faults.AfterRepairIntentCommit != nil {
			s.faults.AfterRepairIntentCommit()
		}
	case faultAfterFinalLink:
		if s.faults.AfterFinalLink != nil {
			s.faults.AfterFinalLink()
		}
	case faultAfterFinalPublication:
		if s.faults.AfterFinalPublication != nil {
			s.faults.AfterFinalPublication()
		}
	case faultAfterReadyCommit:
		if s.faults.AfterReadyCommit != nil {
			s.faults.AfterReadyCommit()
		}
	case faultBeforeContentMismatchMark:
		if s.faults.BeforeContentMismatchMark != nil {
			s.faults.BeforeContentMismatchMark()
		}
	case faultBeforeObjectUnavailableMark:
		if s.faults.BeforeObjectUnavailableMark != nil {
			s.faults.BeforeObjectUnavailableMark()
		}
	}
}

func (s *Store) syncStagingDirectory() error {
	if s != nil && s.faults != nil && s.faults.BeforeStagingDirectorySync != nil {
		if err := s.faults.BeforeStagingDirectorySync(); err != nil {
			return sanitizedStagingSyncError{cause: err}
		}
	}
	if err := syncDirectory(s.objects); err != nil {
		return sanitizedStagingSyncError{cause: err}
	}
	return nil
}

func (s *Store) cleanupFailedStaging(name string, cleanup *cleanupDeadline) {
	if s == nil {
		return
	}
	if cleanup != nil && cleanup.parent != nil && cleanup.parent.Err() != nil {
		if s.pool == nil {
			_ = s.removeStaging(name)
		}
		return
	}
	identity, identityErr := s.stagingIdentity(name)
	if cleanup != nil && cleanup.parent != nil && cleanup.parent.Err() != nil {
		if s.pool == nil {
			_ = s.removeStaging(name)
		}
		return
	}
	if identityErr != nil {
		if s.pool != nil {
			_ = s.enqueueStagingCleanup(name, cleanup)
			return
		}
		_ = s.removeStaging(name)
		return
	}
	if err := s.removeStaging(name); err == nil || s.pool == nil {
		return
	}
	_ = s.enqueueStagingCleanupWithIdentity(name, identity, cleanup)
}

func (s *Store) commit(ctx context.Context, tx pgx.Tx) error {
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if s != nil && s.faults != nil && s.faults.CommitResponseLost != nil {
		return s.faults.CommitResponseLost()
	}
	return nil
}

type cleanupDeadline struct {
	mu       sync.Mutex
	parent   context.Context
	deadline time.Time
	contexts map[*cleanupContext]struct{}
	stopFunc func() bool
}

func newCleanupDeadline(ctx context.Context) *cleanupDeadline {
	deadline := &cleanupDeadline{parent: ctx, contexts: make(map[*cleanupContext]struct{})}
	deadline.stopFunc = context.AfterFunc(ctx, deadline.start)
	return deadline
}

func (d *cleanupDeadline) start() {
	if d == nil {
		return
	}
	d.mu.Lock()
	if d.deadline.IsZero() {
		d.deadline = time.Now().Add(cleanupTimeout)
	}
	deadline := d.deadline
	contexts := make([]*cleanupContext, 0, len(d.contexts))
	for cleanupContext := range d.contexts {
		contexts = append(contexts, cleanupContext)
	}
	d.mu.Unlock()
	for _, cleanupContext := range contexts {
		cleanupContext.extend(deadline)
	}
}

func (d *cleanupDeadline) context() (context.Context, context.CancelFunc) {
	if d == nil {
		return context.WithTimeout(context.Background(), cleanupTimeout)
	}
	if d.parent != nil && d.parent.Err() != nil {
		d.start()
	}
	d.mu.Lock()
	deadline := d.deadline
	if deadline.IsZero() {
		deadline = time.Now().Add(cleanupTimeout)
	}
	cleanupContext := newCleanupContext(d, deadline)
	d.contexts[cleanupContext] = struct{}{}
	d.mu.Unlock()
	return cleanupContext, cleanupContext.cancel
}

func (d *cleanupDeadline) stop() {
	if d != nil && d.stopFunc != nil {
		d.stopFunc()
	}
}

func (d *cleanupDeadline) remove(cleanupContext *cleanupContext) {
	if d == nil {
		return
	}
	d.mu.Lock()
	delete(d.contexts, cleanupContext)
	d.mu.Unlock()
}

// cleanupContext keeps an operation bounded before cancellation and moves its
// deadline with the shared post-cancellation budget if cancellation starts
// while the operation is still in flight.
type cleanupContext struct {
	owner    *cleanupDeadline
	parent   context.Context
	done     chan struct{}
	mu       sync.Mutex
	timer    *time.Timer
	deadline time.Time
	err      error
	closed   bool
}

func newCleanupContext(owner *cleanupDeadline, deadline time.Time) *cleanupContext {
	cleanupContext := &cleanupContext{
		owner:    owner,
		parent:   owner.parent,
		done:     make(chan struct{}),
		deadline: deadline,
	}
	cleanupContext.timer = time.AfterFunc(time.Until(deadline), cleanupContext.expire)
	return cleanupContext
}

func (c *cleanupContext) Deadline() (time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.deadline, true
}

func (c *cleanupContext) Done() <-chan struct{} {
	return c.done
}

func (c *cleanupContext) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *cleanupContext) Value(key any) any {
	if c.parent == nil {
		return nil
	}
	return c.parent.Value(key)
}

func (c *cleanupContext) extend(deadline time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || !deadline.After(c.deadline) {
		return
	}
	c.deadline = deadline
	if c.timer != nil {
		c.timer.Reset(time.Until(deadline))
	}
}

func (c *cleanupContext) expire() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	if remaining := time.Until(c.deadline); remaining > 0 {
		if c.timer != nil {
			c.timer.Reset(remaining)
		}
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.err = context.DeadlineExceeded
	close(c.done)
	c.mu.Unlock()
	c.owner.remove(c)
}

func (c *cleanupContext) cancel() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.err = context.Canceled
	if c.timer != nil {
		c.timer.Stop()
	}
	close(c.done)
	c.mu.Unlock()
	c.owner.remove(c)
}

type ownedReadCloser struct {
	reader io.ReadCloser
	once   sync.Once
	err    error
}

func newOwnedReadCloser(reader io.ReadCloser) *ownedReadCloser {
	return &ownedReadCloser{reader: reader}
}

func (r *ownedReadCloser) Read(buffer []byte) (int, error) {
	return r.reader.Read(buffer)
}

func (r *ownedReadCloser) Close() error {
	r.once.Do(func() { r.err = r.reader.Close() })
	return r.err
}

func rollbackTx(tx pgx.Tx, cleanup *cleanupDeadline) {
	if tx == nil {
		return
	}
	ctx, cancel := cleanup.context()
	defer cancel()
	_ = tx.Rollback(ctx)
}

func (s *Store) beginIdentityTx(ctx context.Context, id string, cleanup *cleanupDeadline) (pgx.Tx, error) {
	if s == nil || s.pool == nil {
		return nil, ErrStoreUnavailable
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, fmt.Errorf("begin artifact publication: %w", ErrStoreUnavailable)
	}
	if s.faults != nil && s.faults.BeforeIdentityLock != nil {
		s.faults.BeforeIdentityLock(ctx, tx, id)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "loomhelm:artifact:"+id); err != nil {
		rollbackTx(tx, cleanup)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, fmt.Errorf("lock artifact publication: %w", ErrStoreUnavailable)
	}
	if s.faults != nil && s.faults.AfterIdentityLock != nil {
		s.faults.AfterIdentityLock()
	}
	return tx, nil
}

func (s *Store) beginIdentityTryTx(ctx context.Context, id string, cleanup *cleanupDeadline) (pgx.Tx, bool, error) {
	if s == nil || s.pool == nil {
		return nil, false, ErrStoreUnavailable
	}
	if s.faults != nil && s.faults.BeforeIdentityTryLock != nil {
		s.faults.BeforeIdentityTryLock()
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, false, err
		}
		return nil, false, fmt.Errorf("begin artifact publication: %w", ErrStoreUnavailable)
	}
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`, "loomhelm:artifact:"+id).Scan(&locked); err != nil {
		rollbackTx(tx, cleanup)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, false, err
		}
		return nil, false, fmt.Errorf("check artifact publication lock: %w", ErrStoreUnavailable)
	}
	if !locked {
		rollbackTx(tx, cleanup)
		return nil, false, nil
	}
	if s.faults != nil && s.faults.AfterIdentityLock != nil {
		s.faults.AfterIdentityLock()
	}
	return tx, true, nil
}

func lockStagingName(ctx context.Context, tx pgx.Tx, name string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "loomhelm:staging:"+name); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return fmt.Errorf("lock artifact staging: %w", ErrStoreUnavailable)
	}
	return nil
}

func readArtifactRecord(ctx context.Context, queryer rowQuerier, id string) (artifactRecord, error) {
	var record artifactRecord
	var runID *string
	var kind string
	var createdAt time.Time
	var state string
	if err := queryer.QueryRow(ctx, `
		SELECT id, session_id, run_id, name, kind, size, sha256, content_type,
		       created_at, state, staging_name, staging_identity, unavailable_reason,
		       (staging_reclaimed_at IS NOT NULL)
		FROM conversation_artifacts
		WHERE id = $1
	`, id).Scan(
		&record.Artifact.ID,
		&record.Artifact.SessionID,
		&runID,
		&record.Artifact.Name,
		&kind,
		&record.Artifact.Size,
		&record.Artifact.Sha256,
		&record.Artifact.ContentType,
		&createdAt,
		&state,
		&record.StagingName,
		&record.StagingIdentity,
		&record.UnavailableReason,
		&record.StagingReclaimed,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return artifactRecord{}, ErrNotFound
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return artifactRecord{}, err
		}
		return artifactRecord{}, fmt.Errorf("read artifact publication: %w", ErrStoreUnavailable)
	}
	record.Artifact.RunID = runID
	record.Artifact.Kind = protocol.ArtifactKind(kind)
	record.Artifact.CreatedAt = formatTime(createdAt)
	record.State = publicationState(state)
	switch record.State {
	case publicationPending, publicationReady, publicationUnavailable:
		return record, nil
	default:
		return artifactRecord{}, fmt.Errorf("artifact publication state is invalid: %w", ErrIntegrity)
	}
}

func (s *Store) confirmRecord(id string) (artifactRecord, error) {
	if s == nil || s.pool == nil {
		return artifactRecord{}, ErrStoreUnavailable
	}
	ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
	defer cancel()
	return readArtifactRecord(ctx, s.pool, id)
}

func (s *Store) confirmRecordWithCleanup(id string, cleanup *cleanupDeadline) (artifactRecord, error) {
	if s == nil || s.pool == nil {
		return artifactRecord{}, ErrStoreUnavailable
	}
	ctx, cancel := cleanup.context()
	defer cancel()
	return readArtifactRecord(ctx, s.pool, id)
}

func (s *Store) stagingUnreferenced(parent context.Context, id, stagingName string, cleanup *cleanupDeadline) bool {
	if s == nil || s.pool == nil || cleanup == nil {
		return false
	}
	ctx, cancel := cleanup.context()
	defer cancel()
	tx, err := s.beginIdentityTx(ctx, id, cleanup)
	if err != nil {
		return false
	}
	defer func() { rollbackTx(tx, cleanup) }()
	record, err := readArtifactRecord(ctx, tx, id)
	recordFound := true
	if errors.Is(err, ErrNotFound) {
		recordFound = false
	}
	if err != nil && recordFound {
		return false
	}
	if err := lockStagingName(ctx, tx, stagingName); err != nil {
		return false
	}
	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversation_artifacts
			WHERE staging_name = $1
			  AND (state = 'pending' OR (state = 'ready' AND staging_reclaimed_at IS NULL))
		)
	`, stagingName).Scan(&active); err != nil {
		return false
	}
	return !active && (!recordFound || record.StagingName != stagingName)
}

func (s *Store) readAuthorizedReadyRecord(ctx context.Context, id string, operation Operation) (artifactRecord, error) {
	if s == nil || s.pool == nil {
		return artifactRecord{}, ErrStoreUnavailable
	}
	record, err := readArtifactRecord(ctx, s.pool, id)
	if err != nil {
		return artifactRecord{}, err
	}
	if err := s.authorize(ctx, operation, record.Artifact); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return artifactRecord{}, err
		}
		if errors.Is(err, ErrStoreUnavailable) {
			return artifactRecord{}, ErrStoreUnavailable
		}
		return artifactRecord{}, ErrNotFound
	}
	if record.State != publicationReady {
		if record.State == publicationPending {
			return artifactRecord{}, fmt.Errorf("%w: %w", ErrRecoveryPending, ErrUnavailable)
		}
		return artifactRecord{}, unavailableError(ErrIntegrity)
	}
	return record, nil
}

func (s *Store) inspectReady(ctx context.Context, record artifactRecord) (fileCheck, error) {
	path, err := s.objectPath(record.Artifact.ID)
	if err != nil {
		return fileUnknown, err
	}
	return inspectArtifactFile(ctx, path, record.Artifact)
}

func sameArtifactMetadata(candidate, existing protocol.Artifact) bool {
	if candidate.ID != existing.ID || candidate.SessionID != existing.SessionID || candidate.Name != existing.Name || candidate.Kind != existing.Kind || candidate.Size != existing.Size || candidate.Sha256 != existing.Sha256 || candidate.ContentType != existing.ContentType || !sameOptionalID(candidate.RunID, existing.RunID) {
		return false
	}
	// CreatedAt is assigned by the server when the identity is first created.
	// Caller retries must converge on that persisted value regardless of the
	// request copy they carry.
	return true
}

func (s *Store) ensurePending(ctx context.Context, candidate protocol.Artifact, stagingName string, cleanup *cleanupDeadline) (artifactRecord, error) {
	repairAuthorizationChecked := false
	repairTryLock := false
	for attempt := 0; attempt < 3; attempt++ {
		existing, readErr := readArtifactRecord(ctx, s.pool, candidate.ID)
		if readErr != nil && !errors.Is(readErr, ErrNotFound) {
			return artifactRecord{}, readErr
		}
		var stagedIdentity *string
		if readErr == nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return artifactRecord{}, s.rejectStagedPut(ctxErr, stagingName, nil, cleanup)
			}
			stagedIdentity, _ = s.stagingIdentity(stagingName)
			if !repairAuthorizationChecked {
				if authErr := s.authorize(ctx, OperationPut, existing.Artifact); authErr != nil {
					return artifactRecord{}, s.rejectStagedPut(authErr, stagingName, stagedIdentity, cleanup)
				}
			}
		}

		var tx pgx.Tx
		var err error
		if repairTryLock && readErr == nil {
			var acquired bool
			tx, acquired, err = s.beginIdentityTryTx(ctx, candidate.ID, cleanup)
			if err != nil {
				return artifactRecord{}, err
			}
			if !acquired {
				if authErr := s.authorize(ctx, OperationPut, existing.Artifact); authErr != nil {
					return artifactRecord{}, s.rejectStagedPut(authErr, stagingName, stagedIdentity, cleanup)
				}
				repairAuthorizationChecked = true
				continue
			}
		} else {
			repairTryLock = false
			tx, err = s.beginIdentityTx(ctx, candidate.ID, cleanup)
			if err != nil {
				return artifactRecord{}, err
			}
		}
		keepTransaction := true
		defer func() {
			if keepTransaction {
				rollbackTx(tx, cleanup)
			}
		}()
		if err := lockStagingName(ctx, tx, stagingName); err != nil {
			return artifactRecord{}, err
		}

		locked, lockedErr := readArtifactRecord(ctx, tx, candidate.ID)
		if lockedErr == nil {
			if readErr != nil || !sameArtifactMetadata(existing.Artifact, locked.Artifact) {
				repairAuthorizationChecked = false
				repairTryLock = false
				rollbackTx(tx, cleanup)
				keepTransaction = false
				continue
			}
			if !sameArtifactMetadata(candidate, locked.Artifact) {
				return artifactRecord{}, ErrConflict
			}
			if locked.State == publicationUnavailable && repairableUnavailableReason(locked.UnavailableReason) {
				if !repairAuthorizationChecked {
					// Release the identity lock before authorization because a
					// database-backed authorizer may need this pool connection.
					rollbackTx(tx, cleanup)
					keepTransaction = false
					if authErr := s.authorize(ctx, OperationPut, locked.Artifact); authErr != nil {
						return artifactRecord{}, s.rejectStagedPut(authErr, stagingName, stagedIdentity, cleanup)
					}
					repairAuthorizationChecked = true
					repairTryLock = true
					continue
				}
				repairAuthorizationChecked = false
				repairTryLock = false
				return s.repairUnavailable(ctx, tx, locked, candidate, stagingName, cleanup)
			}
			return locked, nil
		}
		if !errors.Is(lockedErr, ErrNotFound) {
			return artifactRecord{}, lockedErr
		}
		if readErr == nil {
			repairAuthorizationChecked = false
			repairTryLock = false
			rollbackTx(tx, cleanup)
			keepTransaction = false
			continue
		}

		stagingIdentity, identityErr := s.stagingIdentity(stagingName)
		if identityErr != nil {
			return artifactRecord{}, identityErr
		}
		if stagingIdentity == nil {
			return artifactRecord{}, fmt.Errorf("staging object disappeared before intent: %w", ErrStoreUnavailable)
		}
		candidate.CreatedAt = formatTime(time.Now())
		if _, err := tx.Exec(ctx, `
			INSERT INTO conversation_artifacts (
				id, session_id, run_id, name, kind, size, sha256, content_type,
				created_at, state, staging_name, staging_identity, unavailable_reason
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, '')
		`, candidate.ID, candidate.SessionID, nullableString(candidate.RunID), candidate.Name, string(candidate.Kind), candidate.Size, candidate.Sha256, candidate.ContentType, parseCreatedAt(candidate.CreatedAt), stagingName, stagingIdentity); err != nil {
			return artifactRecord{}, databaseWriteError("persist artifact intent", err)
		}
		if err := s.commit(ctx, tx); err != nil {
			confirmed, confirmErr := s.confirmRecordWithCleanup(candidate.ID, cleanup)
			if confirmErr == nil && sameArtifactMetadata(candidate, confirmed.Artifact) && publicationStateMatchesIntent(confirmed.State) {
				return confirmed, nil
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return artifactRecord{}, err
			}
			return artifactRecord{}, fmt.Errorf("confirm artifact intent: %w", ErrStoreUnavailable)
		}
		keepTransaction = false
		s.fault(faultAfterIntentCommit)
		confirmed, err := s.confirmRecordWithCleanup(candidate.ID, cleanup)
		if err != nil {
			return artifactRecord{}, err
		}
		if !sameArtifactMetadata(candidate, confirmed.Artifact) || !publicationStateMatchesIntent(confirmed.State) {
			return artifactRecord{}, ErrConflict
		}
		return confirmed, nil
	}
	return artifactRecord{}, fmt.Errorf("revalidate artifact authorization: %w", ErrStoreUnavailable)
}

func (s *Store) rejectStagedPut(authErr error, stagingName string, stagingIdentity *string, cleanup *cleanupDeadline) error {
	if cleanup != nil && cleanup.parent != nil {
		if contextErr := cleanup.parent.Err(); contextErr != nil {
			return contextErr
		}
	}
	if errors.Is(authErr, context.Canceled) || errors.Is(authErr, context.DeadlineExceeded) {
		// Once authorization is cancelled, the staged bytes are unconfirmed. Keep
		// them for diagnosis instead of entering an uninterruptible filesystem
		// operation on the request's cancellation path.
		return authErr
	}
	if stagingIdentity == nil {
		return ErrNotFound
	}
	if err := s.enqueueStagingCleanupWithIdentityBeforeCancellation(stagingName, stagingIdentity, cleanup); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return databaseWriteError("record rejected staging cleanup", err)
	}
	if errors.Is(authErr, context.Canceled) || errors.Is(authErr, context.DeadlineExceeded) {
		return authErr
	}
	return ErrNotFound
}

func repairableUnavailableReason(reason string) bool {
	return reason == "staging-missing" || reason == "staging-corrupt"
}

func publicationStateMatchesIntent(state publicationState) bool {
	return state == publicationPending || state == publicationReady
}

func (s *Store) repairUnavailable(ctx context.Context, tx pgx.Tx, existing artifactRecord, candidate protocol.Artifact, stagingName string, cleanup *cleanupDeadline) (artifactRecord, error) {
	finalPath, err := s.objectPath(candidate.ID)
	if err != nil {
		return artifactRecord{}, err
	}
	finalCheck, err := inspectArtifactFile(ctx, finalPath, existing.Artifact)
	if err != nil {
		return artifactRecord{}, err
	}
	switch finalCheck {
	case fileValid:
		updated, err := s.updateUnavailableState(ctx, tx, existing, publicationReady, existing.StagingName, existing.StagingIdentity, "")
		if err != nil {
			return artifactRecord{}, err
		}
		return s.commitRepairState(ctx, updated, cleanup, tx, false, "", nil)
	case fileInvalid:
		updated, updateErr := s.updateUnavailableState(ctx, tx, existing, publicationUnavailable, existing.StagingName, existing.StagingIdentity, "final-conflict")
		if updateErr != nil {
			return artifactRecord{}, updateErr
		}
		if commitErr := s.commit(ctx, tx); commitErr != nil {
			confirmed, confirmErr := s.confirmRecordWithCleanup(existing.Artifact.ID, cleanup)
			if confirmErr == nil && samePublicationState(confirmed, updated) {
				return artifactRecord{}, ErrConflict
			}
			if errors.Is(commitErr, context.Canceled) || errors.Is(commitErr, context.DeadlineExceeded) {
				return artifactRecord{}, commitErr
			}
			return artifactRecord{}, fmt.Errorf("confirm final conflict state: %w", ErrStoreUnavailable)
		}
		return artifactRecord{}, ErrConflict
	case fileUnknown:
		return artifactRecord{}, fmt.Errorf("inspect final artifact for repair: %w", ErrStoreUnavailable)
	}

	stagingPath, err := s.stagingPath(stagingName)
	if err != nil {
		return artifactRecord{}, err
	}
	stagingCheck, err := inspectArtifactFile(ctx, stagingPath, candidate)
	if err != nil {
		return artifactRecord{}, err
	}
	if stagingCheck != fileValid {
		return artifactRecord{}, fmt.Errorf("repair staging object is not valid: %w", ErrIntegrity)
	}
	stagingIdentity, identityErr := s.stagingIdentity(stagingName)
	if identityErr != nil {
		return artifactRecord{}, identityErr
	}
	if stagingIdentity == nil {
		return artifactRecord{}, fmt.Errorf("repair staging object disappeared: %w", ErrStoreUnavailable)
	}
	updated, err := s.updateUnavailableState(ctx, tx, existing, publicationPending, stagingName, stagingIdentity, "")
	if err != nil {
		return artifactRecord{}, err
	}
	if !sameArtifactMetadata(candidate, updated.Artifact) {
		return artifactRecord{}, ErrConflict
	}
	return s.commitRepairState(ctx, updated, cleanup, tx, true, existing.StagingName, existing.StagingIdentity)
}

func (s *Store) commitRepairState(ctx context.Context, updated artifactRecord, cleanup *cleanupDeadline, tx pgx.Tx, fault bool, obsoleteStagingName string, obsoleteStagingIdentity *string) (artifactRecord, error) {
	// Queue obsolete staging cleanup with the repair intent so a crash cannot
	// publish the new binding without preserving the old bytes' cleanup debt.
	if err := s.queueObsoleteStaging(ctx, tx, obsoleteStagingName, obsoleteStagingIdentity, updated.StagingName); err != nil {
		return artifactRecord{}, err
	}
	if err := s.commit(ctx, tx); err != nil {
		confirmed, confirmErr := s.confirmRecordWithCleanup(updated.Artifact.ID, cleanup)
		if confirmErr == nil && sameArtifactMetadata(updated.Artifact, confirmed.Artifact) && publicationStateMatchesIntent(confirmed.State) {
			return confirmed, nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return artifactRecord{}, err
		}
		return artifactRecord{}, fmt.Errorf("confirm artifact repair intent: %w", ErrStoreUnavailable)
	}
	if fault {
		s.fault(faultAfterRepairIntentCommit)
	}
	confirmed, err := s.confirmRecordWithCleanup(updated.Artifact.ID, cleanup)
	if err != nil {
		return artifactRecord{}, err
	}
	if !sameArtifactMetadata(updated.Artifact, confirmed.Artifact) || !publicationStateMatchesIntent(confirmed.State) {
		return artifactRecord{}, ErrConflict
	}
	return confirmed, nil
}

func (s *Store) queueObsoleteStaging(ctx context.Context, tx pgx.Tx, obsoleteName string, obsoleteIdentity *string, currentName string) error {
	if obsoleteName == "" || obsoleteName == currentName {
		return nil
	}
	return s.queueStagingCleanupTx(ctx, tx, obsoleteName, obsoleteIdentity)
}

func (s *Store) updateUnavailableState(ctx context.Context, tx pgx.Tx, record artifactRecord, state publicationState, stagingName string, stagingIdentity *string, reason string) (artifactRecord, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE conversation_artifacts
		SET state = $2, staging_name = $3, staging_identity = $4, unavailable_reason = $5, staging_reclaimed_at = NULL, staging_reclaim_after = NOW()
		WHERE id = $1 AND state = 'unavailable' AND unavailable_reason = $6
	`, record.Artifact.ID, string(state), stagingName, stagingIdentity, reason, record.UnavailableReason)
	if err != nil {
		return artifactRecord{}, databaseWriteError("update artifact repair intent", err)
	}
	if tag.RowsAffected() != 1 {
		return artifactRecord{}, fmt.Errorf("artifact repair row changed unexpectedly: %w", ErrStoreUnavailable)
	}
	record.State = state
	record.StagingName = stagingName
	record.StagingIdentity = stagingIdentity
	record.StagingReclaimed = false
	record.UnavailableReason = reason
	return record, nil
}

func (s *Store) stage(ctx context.Context, artifact protocol.Artifact, expectedHash string, source io.Reader) (protocol.Artifact, string, error) {
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	if err := s.ensureObjectDirectory(); err != nil {
		return protocol.Artifact{}, "", err
	}
	temporary, err := os.CreateTemp(s.objects, ".upload-*")
	if err != nil {
		return protocol.Artifact{}, "", fmt.Errorf("create artifact staging file: %w", ErrStoreUnavailable)
	}
	temporaryPath := temporary.Name()
	keep := false
	defer func() {
		_ = temporary.Close()
		if !keep {
			s.cleanupFailedStaging(filepath.Base(temporaryPath), cleanup)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return protocol.Artifact{}, "", fmt.Errorf("set artifact staging permissions: %w", ErrStoreUnavailable)
	}

	hasher := sha256.New()
	limit := s.maxBytes
	if limit < 1<<63-1 {
		limit++
	}
	size, err := io.Copy(io.MultiWriter(temporary, hasher), io.LimitReader(contextReader{ctx: ctx, reader: source}, limit))
	if err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return protocol.Artifact{}, "", contextErr
		}
		return protocol.Artifact{}, "", fmt.Errorf("write artifact bytes: %w", ErrStoreUnavailable)
	}
	if err := ctx.Err(); err != nil {
		return protocol.Artifact{}, "", err
	}
	if size > s.maxBytes {
		return protocol.Artifact{}, "", ErrTooLarge
	}
	if size != artifact.Size {
		return protocol.Artifact{}, "", fmt.Errorf("got %d bytes, want %d: %w", size, artifact.Size, ErrSizeMismatch)
	}
	actualHash := hex.EncodeToString(hasher.Sum(nil))
	if expectedHash != "" && expectedHash != actualHash {
		return protocol.Artifact{}, "", fmt.Errorf("got %s, want %s: %w", actualHash, expectedHash, ErrHashMismatch)
	}
	artifact.Sha256 = actualHash
	if err := temporary.Sync(); err != nil {
		return protocol.Artifact{}, "", fmt.Errorf("sync artifact staging file: %w", ErrStoreUnavailable)
	}
	if err := temporary.Close(); err != nil {
		return protocol.Artifact{}, "", fmt.Errorf("close artifact staging file: %w", ErrStoreUnavailable)
	}
	if err := s.syncStagingDirectory(); err != nil {
		return protocol.Artifact{}, "", fmt.Errorf("sync artifact staging directory: %w", ErrStoreUnavailable)
	}
	keep = true
	s.fault(faultAfterStage)
	return artifact, filepath.Base(temporaryPath), nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func finalReason(check fileCheck) string {
	if check == fileMissing {
		return "final-missing"
	}
	return "final-mismatch"
}

func (r contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	count, err := r.reader.Read(buffer)
	if contextErr := r.ctx.Err(); contextErr != nil {
		return count, contextErr
	}
	return count, err
}

func (s *Store) stagingPath(name string) (string, error) {
	if s == nil || s.objects == "" || name == "" || filepath.Base(name) != name || !strings.HasPrefix(name, ".upload-") {
		return "", fmt.Errorf("artifact staging object is invalid: %w", ErrIntegrity)
	}
	path := filepath.Join(s.objects, name)
	if filepath.Dir(path) != s.objects {
		return "", fmt.Errorf("artifact staging object escaped storage: %w", ErrIntegrity)
	}
	return path, nil
}

func inspectArtifactFile(ctx context.Context, path string, artifact protocol.Artifact) (fileCheck, error) {
	if err := requireContext(ctx); err != nil {
		return fileUnknown, err
	}
	file, err := openStoredFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fileMissing, nil
		}
		if errors.Is(err, ErrIntegrity) {
			return fileInvalid, nil
		}
		return fileUnknown, err
	}
	defer file.Close()
	if err := verifyFile(ctx, file, artifact); err != nil {
		if errors.Is(err, ErrIntegrity) || errors.Is(err, ErrSizeMismatch) || errors.Is(err, ErrHashMismatch) {
			return fileInvalid, nil
		}
		return fileUnknown, err
	}
	return fileValid, nil
}

type fileCheck uint8

const (
	fileMissing fileCheck = iota
	fileValid
	fileInvalid
	fileUnknown
)

func (s *Store) reconcileOne(ctx context.Context, id string, cleanup *cleanupDeadline) (artifactRecord, recoveryStatus, error) {
	return s.reconcileOneWithRetryPolicy(ctx, id, cleanup, false)
}

func (s *Store) reconcileOneForRecovery(ctx context.Context, id string, cleanup *cleanupDeadline) (artifactRecord, recoveryStatus, error) {
	return s.reconcileOneWithRetryPolicy(ctx, id, cleanup, true)
}

func (s *Store) reconcileOneWithRetryPolicy(ctx context.Context, id string, cleanup *cleanupDeadline, respectRetryAfter bool) (artifactRecord, recoveryStatus, error) {
	if err := s.ensureObjectDirectory(); err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if cleanup == nil {
		cleanup = newCleanupDeadline(ctx)
		defer cleanup.stop()
	}
	tx, err := s.beginIdentityTx(ctx, id, cleanup)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	defer func() { rollbackTx(tx, cleanup) }()
	record, err := readArtifactRecord(ctx, tx, id)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if respectRetryAfter {
		var due bool
		if err := tx.QueryRow(ctx, `
			SELECT staging_reclaim_after <= NOW()
			FROM conversation_artifacts
			WHERE id = $1
		`, id).Scan(&due); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return artifactRecord{}, recoveryPending, err
			}
			return artifactRecord{}, recoveryPending, fmt.Errorf("check artifact recovery retry: %w", ErrStoreUnavailable)
		}
		if !due {
			return record, recoveryPending, nil
		}
	}
	if record.State == publicationUnavailable && record.UnavailableReason == contentMismatchReason {
		return s.reconcileContentMismatch(ctx, tx, record, cleanup)
	}
	reclaimReady := s.reclaimReadyStaging
	if respectRetryAfter {
		reclaimReady = s.reclaimReadyStagingForRecovery
	}
	if record.State != publicationPending {
		if record.State == publicationReady {
			if record.StagingReclaimed {
				finalCheck, inspectErr := s.inspectReady(ctx, record)
				if inspectErr != nil {
					return artifactRecord{}, recoveryPending, inspectErr
				}
				if finalCheck == fileUnknown {
					return artifactRecord{}, recoveryPending, fmt.Errorf("inspect ready artifact: %w", ErrStoreUnavailable)
				}
				if finalCheck != fileValid {
					rollbackTx(tx, cleanup)
					tx = nil
					if err := s.markReadyObjectUnavailable(ctx, id, finalReason(finalCheck)); err != nil {
						return artifactRecord{}, recoveryPending, err
					}
					confirmed, confirmErr := s.confirmRecordWithCleanup(id, cleanup)
					if confirmErr != nil {
						return artifactRecord{}, recoveryPending, confirmErr
					}
					if confirmed.State != publicationUnavailable {
						return artifactRecord{}, recoveryPending, fmt.Errorf("ready artifact state changed unexpectedly: %w", ErrStoreUnavailable)
					}
					return confirmed, recoveryUnavailable, nil
				}
				return record, recoveryReady, nil
			}
			rollbackTx(tx, cleanup)
			tx = nil
			return reclaimReady(ctx, id, cleanup)
		}
		return record, stateRecoveryStatus(record.State), nil
	}
	updated, _, err := s.reconcilePendingTx(ctx, tx, record)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if err := s.commit(ctx, tx); err != nil {
		confirmed, confirmErr := s.confirmRecordWithCleanup(id, cleanup)
		if confirmErr == nil && recoveryStateConverged(confirmed, updated) {
			if confirmed.State == publicationReady {
				return reclaimReady(ctx, id, cleanup)
			}
			return confirmed, stateRecoveryStatus(confirmed.State), nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return artifactRecord{}, recoveryPending, err
		}
		return artifactRecord{}, recoveryPending, fmt.Errorf("confirm artifact recovery: %w", ErrStoreUnavailable)
	}
	if updated.State == publicationReady {
		s.fault(faultAfterReadyCommit)
	}
	confirmed, err := s.confirmRecordWithCleanup(id, cleanup)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if !recoveryStateConverged(confirmed, updated) {
		return artifactRecord{}, recoveryPending, fmt.Errorf("artifact recovery state changed unexpectedly: %w", ErrStoreUnavailable)
	}
	if confirmed.State == publicationReady {
		return reclaimReady(ctx, id, cleanup)
	}
	return confirmed, stateRecoveryStatus(confirmed.State), nil
}

func (s *Store) reconcileContentMismatch(ctx context.Context, tx pgx.Tx, record artifactRecord, cleanup *cleanupDeadline) (artifactRecord, recoveryStatus, error) {
	finalCheck, err := s.inspectReady(ctx, record)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if finalCheck != fileValid {
		if _, err := tx.Exec(ctx, `
			UPDATE conversation_artifacts
			SET staging_reclaim_after = clock_timestamp() + INTERVAL '1 minute'
			WHERE id = $1 AND state = 'unavailable' AND unavailable_reason = $2
		`, record.Artifact.ID, contentMismatchReason); err != nil {
			return artifactRecord{}, recoveryPending, databaseWriteError("defer artifact content verification", err)
		}
		if err := s.commit(ctx, tx); err != nil {
			confirmed, confirmErr := s.confirmRecordWithCleanup(record.Artifact.ID, cleanup)
			if confirmErr == nil && confirmed.State == publicationUnavailable && confirmed.UnavailableReason == contentMismatchReason {
				return confirmed, recoveryPending, nil
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return artifactRecord{}, recoveryPending, err
			}
			return artifactRecord{}, recoveryPending, fmt.Errorf("confirm artifact content verification deferral: %w", ErrStoreUnavailable)
		}
		confirmed, err := s.confirmRecordWithCleanup(record.Artifact.ID, cleanup)
		if err != nil {
			return artifactRecord{}, recoveryPending, err
		}
		if confirmed.State != publicationUnavailable || confirmed.UnavailableReason != contentMismatchReason {
			return artifactRecord{}, recoveryPending, fmt.Errorf("artifact content verification state changed unexpectedly: %w", ErrStoreUnavailable)
		}
		return confirmed, recoveryPending, nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversation_artifacts
		SET state = 'ready', unavailable_reason = '', staging_reclaim_after = NOW()
		WHERE id = $1 AND state = 'unavailable' AND unavailable_reason = $2
	`, record.Artifact.ID, contentMismatchReason); err != nil {
		return artifactRecord{}, recoveryPending, databaseWriteError("restore artifact after content verification", err)
	}
	if err := s.commit(ctx, tx); err != nil {
		confirmed, confirmErr := s.confirmRecordWithCleanup(record.Artifact.ID, cleanup)
		if confirmErr == nil && confirmed.State == publicationReady {
			if confirmed.StagingReclaimed {
				return confirmed, recoveryReady, nil
			}
			return s.reclaimReadyStagingForRecovery(ctx, record.Artifact.ID, cleanup)
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return artifactRecord{}, recoveryPending, err
		}
		return artifactRecord{}, recoveryPending, fmt.Errorf("confirm artifact content verification recovery: %w", ErrStoreUnavailable)
	}
	confirmed, err := s.confirmRecordWithCleanup(record.Artifact.ID, cleanup)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if confirmed.State != publicationReady {
		return artifactRecord{}, recoveryPending, fmt.Errorf("artifact content verification recovery state changed unexpectedly: %w", ErrStoreUnavailable)
	}
	if confirmed.StagingReclaimed {
		return confirmed, recoveryReady, nil
	}
	return s.reclaimReadyStagingForRecovery(ctx, record.Artifact.ID, cleanup)
}

func (s *Store) reclaimReadyStaging(ctx context.Context, id string, cleanup *cleanupDeadline) (artifactRecord, recoveryStatus, error) {
	return s.reclaimReadyStagingWithRetryPolicy(ctx, id, cleanup, false)
}

func (s *Store) reclaimReadyStagingForRecovery(ctx context.Context, id string, cleanup *cleanupDeadline) (artifactRecord, recoveryStatus, error) {
	return s.reclaimReadyStagingWithRetryPolicy(ctx, id, cleanup, true)
}

func (s *Store) reclaimReadyStagingWithRetryPolicy(ctx context.Context, id string, cleanup *cleanupDeadline, respectRetryAfter bool) (artifactRecord, recoveryStatus, error) {
	if err := s.ensureObjectDirectory(); err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	tx, err := s.beginIdentityTx(ctx, id, cleanup)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	defer func() { rollbackTx(tx, cleanup) }()
	record, err := readArtifactRecord(ctx, tx, id)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if record.State != publicationReady {
		return record, stateRecoveryStatus(record.State), nil
	}
	if record.StagingReclaimed {
		return record, recoveryReady, nil
	}
	if respectRetryAfter {
		var due bool
		if err := tx.QueryRow(ctx, `
			SELECT staging_reclaim_after <= NOW()
			FROM conversation_artifacts
			WHERE id = $1
		`, id).Scan(&due); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return artifactRecord{}, recoveryPending, err
			}
			return artifactRecord{}, recoveryPending, fmt.Errorf("check ready artifact retry: %w", ErrStoreUnavailable)
		}
		if !due {
			return record, recoveryPending, nil
		}
	}
	commitUnavailable := func(reason string) (artifactRecord, recoveryStatus, error) {
		if _, err := tx.Exec(ctx, `
			UPDATE conversation_artifacts
			SET state = 'unavailable', unavailable_reason = $2, staging_reclaim_after = NOW()
			WHERE id = $1 AND state = 'ready'
		`, id, reason); err != nil {
			return artifactRecord{}, recoveryPending, databaseWriteError("update invalid ready artifact", err)
		}
		updated := record
		updated.State = publicationUnavailable
		updated.UnavailableReason = reason
		if err := s.commit(ctx, tx); err != nil {
			confirmed, confirmErr := s.confirmRecordWithCleanup(id, cleanup)
			if confirmErr == nil && samePublicationState(confirmed, updated) {
				return confirmed, recoveryUnavailable, nil
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return artifactRecord{}, recoveryPending, err
			}
			return artifactRecord{}, recoveryPending, fmt.Errorf("confirm invalid ready artifact: %w", ErrStoreUnavailable)
		}
		confirmed, err := s.confirmRecordWithCleanup(id, cleanup)
		if err != nil {
			return artifactRecord{}, recoveryPending, err
		}
		if !samePublicationState(confirmed, updated) {
			return artifactRecord{}, recoveryPending, fmt.Errorf("invalid ready artifact state changed unexpectedly: %w", ErrStoreUnavailable)
		}
		return confirmed, recoveryUnavailable, nil
	}
	finalCheck, err := s.inspectReady(ctx, record)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if finalCheck == fileUnknown {
		return artifactRecord{}, recoveryPending, fmt.Errorf("inspect ready artifact for reclamation: %w", ErrStoreUnavailable)
	}
	if finalCheck != fileValid {
		return commitUnavailable(finalReason(finalCheck))
	}
	if err := lockStagingName(ctx, tx, record.StagingName); err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	currentIdentity, identityErr := s.stagingIdentity(record.StagingName)
	if identityErr != nil {
		return artifactRecord{}, recoveryPending, identityErr
	}
	removeStaging := record.StagingIdentity != nil && currentIdentity != nil && sameStagingIdentity(record.StagingIdentity, currentIdentity)
	if !removeStaging {
		if err := ctx.Err(); err != nil {
			return artifactRecord{}, recoveryPending, err
		}
		if err := s.syncStagingDirectory(); err != nil {
			return artifactRecord{}, recoveryPending, fmt.Errorf("sync artifact staging directory before retaining staging: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaim_after = clock_timestamp() + INTERVAL '1 minute'
		WHERE id = $1 AND state = 'ready' AND staging_reclaimed_at IS NULL
	`, id); err != nil {
		return artifactRecord{}, recoveryPending, databaseWriteError("defer artifact staging reclamation", err)
	}
	// Recheck while the identity lock is still held. The lock must remain held
	// through deletion and marker publication so another reconciler cannot
	// transition the row while this process is removing its staging copy.
	finalCheck, err = s.inspectReady(ctx, record)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if finalCheck == fileUnknown {
		return artifactRecord{}, recoveryPending, fmt.Errorf("reinspect ready artifact for reclamation: %w", ErrStoreUnavailable)
	}
	if finalCheck != fileValid {
		return commitUnavailable(finalReason(finalCheck))
	}
	if s.faults != nil && s.faults.BeforeReadyStagingRemoval != nil {
		s.faults.BeforeReadyStagingRemoval()
	}
	if err := ctx.Err(); err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if removeStaging {
		if removeErr := s.removeStaging(record.StagingName); removeErr != nil {
			commitErr := s.commit(ctx, tx)
			if commitErr != nil {
				confirmed, confirmErr := s.confirmRecordWithCleanup(id, cleanup)
				if confirmErr == nil && confirmed.State == publicationReady && !confirmed.StagingReclaimed {
					return confirmed, recoveryPending, removeErr
				}
				if errors.Is(commitErr, context.Canceled) || errors.Is(commitErr, context.DeadlineExceeded) {
					return artifactRecord{}, recoveryPending, commitErr
				}
				return artifactRecord{}, recoveryPending, fmt.Errorf("confirm staging reclamation deferral: %w", ErrStoreUnavailable)
			}
			confirmed, confirmErr := s.confirmRecordWithCleanup(id, cleanup)
			if confirmErr != nil {
				return artifactRecord{}, recoveryPending, confirmErr
			}
			if confirmed.State != publicationReady {
				return confirmed, stateRecoveryStatus(confirmed.State), nil
			}
			if confirmed.StagingReclaimed {
				return confirmed, recoveryReady, nil
			}
			return confirmed, recoveryPending, removeErr
		}
		if s.faults != nil && s.faults.AfterReadyStagingRemoval != nil {
			s.faults.AfterReadyStagingRemoval()
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaimed_at = NOW(), staging_reclaim_after = NOW()
		WHERE id = $1 AND state = 'ready' AND staging_reclaimed_at IS NULL
	`, id); err != nil {
		return artifactRecord{}, recoveryPending, databaseWriteError("record artifact staging reclamation", err)
	}
	if err := s.commit(ctx, tx); err != nil {
		confirmed, confirmErr := s.confirmRecordWithCleanup(id, cleanup)
		if confirmErr == nil && confirmed.State == publicationReady && confirmed.StagingReclaimed {
			return confirmed, recoveryReady, nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return artifactRecord{}, recoveryPending, err
		}
		return artifactRecord{}, recoveryPending, fmt.Errorf("confirm artifact staging reclamation: %w", ErrStoreUnavailable)
	}
	confirmed, err := s.confirmRecordWithCleanup(id, cleanup)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if confirmed.State != publicationReady || !confirmed.StagingReclaimed {
		return artifactRecord{}, recoveryPending, fmt.Errorf("artifact staging reclamation state changed unexpectedly: %w", ErrStoreUnavailable)
	}
	return confirmed, recoveryReady, nil
}

func samePublicationState(left, right artifactRecord) bool {
	return left.State == right.State && left.UnavailableReason == right.UnavailableReason
}

func recoveryStateConverged(confirmed, updated artifactRecord) bool {
	if samePublicationState(confirmed, updated) {
		return true
	}
	if updated.State != publicationUnavailable || !repairableUnavailableReason(updated.UnavailableReason) {
		return updated.State == publicationReady && confirmed.State == publicationUnavailable
	}
	if confirmed.State == publicationPending {
		return confirmed.StagingName != updated.StagingName || !sameStagingIdentity(confirmed.StagingIdentity, updated.StagingIdentity)
	}
	return confirmed.State == publicationReady || confirmed.State == publicationUnavailable
}

func sameStagingIdentity(expected, current *string) bool {
	if expected == nil || current == nil {
		return expected == nil && current == nil
	}
	return *expected == *current
}

func stateRecoveryStatus(state publicationState) recoveryStatus {
	switch state {
	case publicationReady:
		return recoveryReady
	case publicationUnavailable:
		return recoveryUnavailable
	default:
		return recoveryPending
	}
}

func (s *Store) reconcilePendingTx(ctx context.Context, tx pgx.Tx, record artifactRecord) (artifactRecord, recoveryStatus, error) {
	finalPath, err := s.objectPath(record.Artifact.ID)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	finalCheck, err := inspectArtifactFile(ctx, finalPath, record.Artifact)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	switch finalCheck {
	case fileValid:
		if err := syncDirectory(s.objects); err != nil {
			return artifactRecord{}, recoveryPending, fmt.Errorf("sync final artifact directory: %w", ErrStoreUnavailable)
		}
		return s.updatePublicationState(ctx, tx, record, publicationReady, "")
	case fileInvalid:
		return s.updatePublicationState(ctx, tx, record, publicationUnavailable, "final-conflict")
	case fileUnknown:
		return artifactRecord{}, recoveryPending, fmt.Errorf("inspect final artifact: %w", ErrStoreUnavailable)
	}

	stagingPath, err := s.stagingPath(record.StagingName)
	if err != nil {
		return s.updatePublicationState(ctx, tx, record, publicationUnavailable, "staging-invalid")
	}
	stagingCheck, err := inspectArtifactFile(ctx, stagingPath, record.Artifact)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	switch stagingCheck {
	case fileMissing:
		return s.updatePublicationState(ctx, tx, record, publicationUnavailable, "staging-missing")
	case fileInvalid:
		return s.updatePublicationState(ctx, tx, record, publicationUnavailable, "staging-corrupt")
	case fileUnknown:
		return artifactRecord{}, recoveryPending, fmt.Errorf("inspect staging artifact: %w", ErrStoreUnavailable)
	}

	if err := ctx.Err(); err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if err := os.Link(stagingPath, finalPath); err != nil {
		if errors.Is(err, os.ErrExist) {
			finalCheck, inspectErr := inspectArtifactFile(ctx, finalPath, record.Artifact)
			if inspectErr != nil {
				return artifactRecord{}, recoveryPending, inspectErr
			}
			if finalCheck == fileValid {
				if err := syncDirectory(s.objects); err != nil {
					return artifactRecord{}, recoveryPending, fmt.Errorf("sync final artifact directory: %w", ErrStoreUnavailable)
				}
				return s.updatePublicationState(ctx, tx, record, publicationReady, "")
			}
			return s.updatePublicationState(ctx, tx, record, publicationUnavailable, "final-conflict")
		}
		return artifactRecord{}, recoveryPending, fmt.Errorf("publish final artifact: %w", ErrStoreUnavailable)
	}
	s.fault(faultAfterFinalLink)
	if err := syncDirectory(s.objects); err != nil {
		return artifactRecord{}, recoveryPending, fmt.Errorf("sync final artifact directory: %w", ErrStoreUnavailable)
	}
	s.fault(faultAfterFinalPublication)
	finalCheck, err = inspectArtifactFile(ctx, finalPath, record.Artifact)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if finalCheck != fileValid {
		return s.updatePublicationState(ctx, tx, record, publicationUnavailable, "final-verification")
	}
	return s.updatePublicationState(ctx, tx, record, publicationReady, "")
}

func (s *Store) updatePublicationState(ctx context.Context, tx pgx.Tx, record artifactRecord, state publicationState, reason string) (artifactRecord, recoveryStatus, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE conversation_artifacts
		SET state = $2, unavailable_reason = $3, staging_identity = $4, staging_reclaimed_at = NULL, staging_reclaim_after = NOW()
		WHERE id = $1 AND state = 'pending'
	`, record.Artifact.ID, string(state), reason, record.StagingIdentity)
	if err != nil {
		return artifactRecord{}, recoveryPending, databaseWriteError("update artifact publication", err)
	}
	if tag.RowsAffected() != 1 {
		return artifactRecord{}, recoveryPending, fmt.Errorf("artifact publication row changed unexpectedly: %w", ErrStoreUnavailable)
	}
	record.State = state
	record.StagingReclaimed = false
	record.UnavailableReason = reason
	return record, stateRecoveryStatus(state), nil
}

func (s *Store) removeStaging(name string) error {
	path, err := s.stagingPath(name)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove artifact staging: %w", ErrStoreUnavailable)
	}
	if err := s.syncStagingDirectory(); err != nil {
		return fmt.Errorf("sync artifact staging directory after removal: %w", err)
	}
	return nil
}

func (s *Store) removeStagingIfIdentity(name string, expected *string) error {
	current, err := s.stagingIdentity(name)
	if err != nil {
		return err
	}
	if !sameStagingIdentity(expected, current) {
		return nil
	}
	return s.removeStaging(name)
}

func (s *Store) enqueueStagingCleanup(name string, cleanup *cleanupDeadline) error {
	var intendedIdentity *string
	return s.enqueueStagingCleanupWithQueue(name, cleanup, func(ctx context.Context, tx pgx.Tx) error {
		identity, err := s.stagingIdentity(name)
		if err != nil {
			return err
		}
		intendedIdentity = identity
		return s.queueStagingCleanupTx(ctx, tx, name, identity)
	}, func(confirmCleanup *cleanupDeadline) (bool, error) {
		return s.stagingCleanupMatches(name, intendedIdentity, confirmCleanup)
	})
}

func (s *Store) enqueueStagingCleanupWithIdentity(name string, identity *string, cleanup *cleanupDeadline) error {
	return s.enqueueStagingCleanupWithQueue(name, cleanup, func(ctx context.Context, tx pgx.Tx) error {
		return s.queueStagingCleanupTx(ctx, tx, name, identity)
	}, func(confirmCleanup *cleanupDeadline) (bool, error) {
		return s.stagingCleanupMatches(name, identity, confirmCleanup)
	})
}

func (s *Store) enqueueStagingCleanupWithIdentityBeforeCancellation(name string, identity *string, cleanup *cleanupDeadline) error {
	return s.enqueueStagingCleanupWithQueuePolicy(name, cleanup, true, func(ctx context.Context, tx pgx.Tx) error {
		return s.queueStagingCleanupTx(ctx, tx, name, identity)
	}, func(confirmCleanup *cleanupDeadline) (bool, error) {
		return s.stagingCleanupMatches(name, identity, confirmCleanup)
	})
}

func (s *Store) enqueueStagingCleanupWithQueue(name string, cleanup *cleanupDeadline, queue func(context.Context, pgx.Tx) error, confirm func(*cleanupDeadline) (bool, error)) error {
	return s.enqueueStagingCleanupWithQueuePolicy(name, cleanup, false, queue, confirm)
}

func (s *Store) enqueueStagingCleanupWithQueuePolicy(name string, cleanup *cleanupDeadline, honorParentCancellation bool, queue func(context.Context, pgx.Tx) error, confirm func(*cleanupDeadline) (bool, error)) error {
	if s == nil || s.pool == nil || cleanup == nil || queue == nil || confirm == nil {
		return nil
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		var ctx context.Context
		var cancel context.CancelFunc
		if honorParentCancellation {
			parent := cleanup.parent
			if parent == nil {
				parent = context.Background()
			}
			ctx, cancel = context.WithTimeout(parent, cleanupTimeout)
			if err := parent.Err(); err != nil {
				cancel()
				return err
			}
		} else {
			ctx, cancel = cleanup.context()
		}
		tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
		if err == nil {
			err = queue(ctx, tx)
		}
		if err != nil {
			if tx != nil {
				rollbackTx(tx, cleanup)
			}
			cancel()
			lastErr = err
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			continue
		}
		if honorParentCancellation && cleanup.parent != nil {
			if parentErr := cleanup.parent.Err(); parentErr != nil {
				rollbackTx(tx, cleanup)
				cancel()
				return parentErr
			}
		}
		if s.faults != nil && s.faults.BeforeStagingCleanupCommit != nil {
			s.faults.BeforeStagingCleanupCommit()
		}
		commitErr := s.commit(ctx, tx)
		if commitErr == nil {
			cancel()
			if honorParentCancellation && cleanup.parent != nil {
				if parentErr := cleanup.parent.Err(); parentErr != nil {
					return parentErr
				}
			}
			return nil
		}
		rollbackTx(tx, cleanup)
		cancel()
		lastErr = commitErr
		confirmed, confirmErr := confirm(cleanup)
		if confirmErr == nil && confirmed {
			return nil
		}
		if confirmErr != nil {
			lastErr = errors.Join(lastErr, confirmErr)
		}
		if errors.Is(commitErr, context.Canceled) || errors.Is(commitErr, context.DeadlineExceeded) {
			return commitErr
		}
	}
	if lastErr == nil {
		return ErrStoreUnavailable
	}
	return databaseWriteError("enqueue staging cleanup", lastErr)
}

func (s *Store) stagingCleanupState(name string, cleanup *cleanupDeadline) (bool, *string, bool, error) {
	if s == nil || s.pool == nil || cleanup == nil {
		return false, nil, false, ErrStoreUnavailable
	}
	ctx, cancel := cleanup.context()
	defer cancel()
	var identity *string
	var retryFuture bool
	if err := s.pool.QueryRow(ctx, `
		SELECT staging_identity, retry_after > clock_timestamp()
		FROM conversation_artifact_staging_cleanup
		WHERE staging_name = $1
	`, name).Scan(&identity, &retryFuture); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil, false, nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return false, nil, false, err
		}
		return false, nil, false, fmt.Errorf("confirm staging cleanup debt: %w", ErrStoreUnavailable)
	}
	return true, identity, retryFuture, nil
}

func (s *Store) stagingCleanupMatches(name string, expectedIdentity *string, cleanup *cleanupDeadline) (bool, error) {
	exists, identity, _, err := s.stagingCleanupState(name, cleanup)
	if err != nil {
		return false, err
	}
	return exists && sameStagingIdentity(identity, expectedIdentity), nil
}

func (s *Store) stagingCleanupExists(name string, cleanup *cleanupDeadline) (bool, error) {
	exists, _, _, err := s.stagingCleanupState(name, cleanup)
	return exists, err
}

func (s *Store) queueStagingCleanupTx(ctx context.Context, tx pgx.Tx, name string, identity *string) error {
	if err := lockStagingName(ctx, tx, name); err != nil {
		return err
	}
	return s.insertStagingCleanupTx(ctx, tx, name, identity)
}

func (s *Store) queueCurrentStagingCleanupTx(ctx context.Context, tx pgx.Tx, name string) error {
	if err := lockStagingName(ctx, tx, name); err != nil {
		return err
	}
	identity, err := s.stagingIdentity(name)
	if err != nil {
		return err
	}
	return s.insertStagingCleanupTx(ctx, tx, name, identity)
}

func (s *Store) insertStagingCleanupTx(ctx context.Context, tx pgx.Tx, name string, identity *string) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_artifact_staging_cleanup (staging_name, staging_identity, retry_after)
		SELECT $1, $2, clock_timestamp()
		WHERE NOT EXISTS (
			SELECT 1
			FROM conversation_artifacts
			WHERE staging_name = $1
			  AND (state = 'pending' OR (state = 'ready' AND staging_reclaimed_at IS NULL))
		)
		ON CONFLICT (staging_name) DO UPDATE SET staging_identity = EXCLUDED.staging_identity, retry_after = clock_timestamp()
	`, name, identity); err != nil {
		return databaseWriteError("queue staging cleanup", err)
	}
	return nil
}

func (s *Store) stagingIdentity(name string) (*string, error) {
	path, err := s.stagingPath(name)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if _, dirErr := os.Lstat(filepath.Dir(path)); dirErr != nil {
				if errors.Is(dirErr, os.ErrNotExist) {
					return nil, fmt.Errorf("stat artifact staging directory: %w", ErrStoreUnavailable)
				}
				return nil, fmt.Errorf("stat artifact staging directory: %w", ErrStoreUnavailable)
			}
			return nil, nil
		}
		return nil, fmt.Errorf("stat artifact staging object: %w", ErrStoreUnavailable)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, fmt.Errorf("read artifact staging identity: %w", ErrStoreUnavailable)
	}
	identity := fmt.Sprintf("%d:%d", stat.Dev, stat.Ino)
	return &identity, nil
}

func (s *Store) commitStagingCleanupState(ctx context.Context, tx pgx.Tx, name string, cleanup *cleanupDeadline, expectExists, expectDeferred bool) error {
	if err := s.commit(ctx, tx); err == nil {
		return nil
	} else {
		exists, _, retryFuture, confirmErr := s.stagingCleanupState(name, cleanup)
		if confirmErr == nil && exists == expectExists && (!expectDeferred || retryFuture) {
			return nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return databaseWriteError("commit staging cleanup", err)
	}
}

func (s *Store) recoverStagingCleanup(ctx context.Context, name string, cleanup *cleanupDeadline) (bool, error) {
	if s == nil || s.pool == nil || cleanup == nil {
		return false, ErrStoreUnavailable
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return false, err
		}
		return false, fmt.Errorf("begin staging cleanup: %w", ErrStoreUnavailable)
	}
	defer func() { rollbackTx(tx, cleanup) }()
	if err := lockStagingName(ctx, tx, name); err != nil {
		return false, err
	}
	var expectedIdentity *string
	var due bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversation_artifact_staging_cleanup
			WHERE staging_name = $1 AND retry_after <= clock_timestamp()
		), (
			SELECT staging_identity
			FROM conversation_artifact_staging_cleanup
			WHERE staging_name = $1
		)
	`, name).Scan(&due, &expectedIdentity); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return false, err
		}
		return false, fmt.Errorf("check staging cleanup retry: %w", ErrStoreUnavailable)
	}
	if !due {
		return false, nil
	}
	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversation_artifacts
			WHERE staging_name = $1
			  AND (state = 'pending' OR (state = 'ready' AND staging_reclaimed_at IS NULL))
		)
	`, name).Scan(&active); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return false, err
		}
		return false, fmt.Errorf("check staging cleanup reference: %w", ErrStoreUnavailable)
	}
	if active {
		if _, err := tx.Exec(ctx, `DELETE FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, name); err != nil {
			return false, databaseWriteError("discard active staging cleanup debt", err)
		}
		if err := s.commitStagingCleanupState(ctx, tx, name, cleanup, false, false); err != nil {
			return false, err
		}
		return true, nil
	}
	var diagnostic bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversation_artifacts
			WHERE staging_name = $1
			  AND (
					(state = 'unavailable'
					 AND unavailable_reason IN ('final-missing', 'final-mismatch')
					 AND staging_reclaimed_at IS NULL)
				 OR (state = 'ready' AND staging_reclaimed_at IS NOT NULL AND staging_identity IS NULL)
			  )
			  AND (staging_identity IS NULL OR $2::text IS NULL OR staging_identity IS NOT DISTINCT FROM $2::text)
		)
	`, name, nullableString(expectedIdentity)).Scan(&diagnostic); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return false, err
		}
		return false, fmt.Errorf("check diagnostic staging reference: %w", ErrStoreUnavailable)
	}
	if diagnostic {
		if _, err := tx.Exec(ctx, `DELETE FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, name); err != nil {
			return false, databaseWriteError("retire diagnostic staging cleanup debt", err)
		}
		if err := s.commitStagingCleanupState(ctx, tx, name, cleanup, false, false); err != nil {
			return false, err
		}
		return true, nil
	}
	currentIdentity, err := s.stagingIdentity(name)
	if err != nil {
		return false, err
	}
	if expectedIdentity != nil && currentIdentity == nil {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		if err := s.syncStagingDirectory(); err != nil {
			return false, fmt.Errorf("sync artifact staging directory after missing staging: %w", err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, name); err != nil {
			return false, databaseWriteError("discard replaced staging cleanup debt", err)
		}
		if err := s.commitStagingCleanupState(ctx, tx, name, cleanup, false, false); err != nil {
			return false, err
		}
		return true, nil
	}
	if !sameStagingIdentity(expectedIdentity, currentIdentity) {
		if _, err := tx.Exec(ctx, `
			UPDATE conversation_artifact_staging_cleanup
			SET retry_after = clock_timestamp() + INTERVAL '1 minute'
			WHERE staging_name = $1
		`, name); err != nil {
			return false, databaseWriteError("defer replaced staging cleanup debt", err)
		}
		if err := s.commitStagingCleanupState(ctx, tx, name, cleanup, true, true); err != nil {
			return false, err
		}
		return false, nil
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if removeErr := s.removeStaging(name); removeErr != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE conversation_artifact_staging_cleanup
			SET retry_after = clock_timestamp() + INTERVAL '1 minute'
			WHERE staging_name = $1
		`, name); err != nil {
			return false, databaseWriteError("defer staging cleanup", err)
		}
		if err := s.commitStagingCleanupState(ctx, tx, name, cleanup, true, true); err != nil {
			return false, err
		}
		return false, removeErr
	}
	if _, err := tx.Exec(ctx, `DELETE FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, name); err != nil {
		return false, databaseWriteError("delete staging cleanup debt", err)
	}
	if err := s.commitStagingCleanupState(ctx, tx, name, cleanup, false, false); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) listRecoveryIDs(ctx context.Context, query string, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, query, limit)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, fmt.Errorf("list artifact recovery work: %w", ErrStoreUnavailable)
	}
	defer rows.Close()
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil, err
			}
			return nil, fmt.Errorf("read artifact recovery work: %w", ErrStoreUnavailable)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, fmt.Errorf("read artifact recovery work: %w", ErrStoreUnavailable)
	}
	return ids, nil
}

type recoveryWork struct {
	kind int
	name string
}

const (
	recoveryArtifactWork = iota
	recoveryCleanupWork
)

func (s *Store) listRecoveryWork(ctx context.Context, limit int) ([]recoveryWork, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT work_kind, work_name
		FROM (
			SELECT work_kind, work_name, due_at, tie_at
			FROM (
				SELECT 0 AS work_kind, id::text AS work_name, staging_reclaim_after AS due_at, created_at AS tie_at
				FROM conversation_artifacts
				WHERE state = 'pending' AND staging_reclaim_after <= NOW()
				ORDER BY staging_reclaim_after, created_at, id
				LIMIT $1
			) AS pending_work
			UNION ALL
			SELECT work_kind, work_name, due_at, tie_at
			FROM (
				SELECT 0 AS work_kind, id::text AS work_name, staging_reclaim_after AS due_at, created_at AS tie_at
				FROM conversation_artifacts
				WHERE state = 'ready' AND staging_reclaimed_at IS NULL AND staging_reclaim_after <= NOW()
				ORDER BY staging_reclaim_after, created_at, id
				LIMIT $1
			) AS ready_work
			UNION ALL
			SELECT work_kind, work_name, due_at, tie_at
			FROM (
				SELECT 0 AS work_kind, id::text AS work_name, staging_reclaim_after AS due_at, created_at AS tie_at
				FROM conversation_artifacts
				WHERE state = 'unavailable' AND unavailable_reason = 'content-mismatch' AND staging_reclaim_after <= NOW()
				ORDER BY staging_reclaim_after, created_at, id
				LIMIT $1
			) AS content_mismatch_work
			UNION ALL
			SELECT work_kind, work_name, due_at, tie_at
			FROM (
				SELECT 1 AS work_kind, staging_name AS work_name, retry_after AS due_at, retry_after AS tie_at
				FROM conversation_artifact_staging_cleanup
				WHERE retry_after <= NOW()
				ORDER BY retry_after, staging_name
				LIMIT $1
			) AS cleanup_work
		) AS recovery_work
		ORDER BY due_at, work_kind, tie_at, work_name
		LIMIT $1
	`, limit)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, fmt.Errorf("list artifact recovery work: %w", ErrStoreUnavailable)
	}
	defer rows.Close()
	work := make([]recoveryWork, 0, limit)
	for rows.Next() {
		var item recoveryWork
		if err := rows.Scan(&item.kind, &item.name); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil, err
			}
			return nil, fmt.Errorf("read artifact recovery work: %w", ErrStoreUnavailable)
		}
		work = append(work, item)
	}
	if err := rows.Err(); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, fmt.Errorf("read artifact recovery work: %w", ErrStoreUnavailable)
	}
	return work, nil
}

func (s *Store) deferArtifactRecovery(id string, cleanup *cleanupDeadline) error {
	if s == nil || s.pool == nil || cleanup == nil {
		return ErrStoreUnavailable
	}
	ctx, cancel := cleanup.context()
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return fmt.Errorf("begin artifact recovery deferral: %w", ErrStoreUnavailable)
	}
	defer func() { rollbackTx(tx, cleanup) }()
	// The conditional row update serializes against publication state changes;
	// retry deferral must not reacquire the identity advisory lock that caused
	// this recovery attempt to time out.
	if _, err := tx.Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaim_after = clock_timestamp() + INTERVAL '1 minute'
		WHERE id = $1
		  AND (state = 'pending' OR (state = 'ready' AND staging_reclaimed_at IS NULL) OR (state = 'unavailable' AND unavailable_reason = 'content-mismatch'))
		  AND staging_reclaim_after <= clock_timestamp()
	`, id); err != nil {
		return databaseWriteError("defer artifact recovery", err)
	}
	if err := s.commit(ctx, tx); err != nil {
		confirmCtx, confirmCancel := cleanup.context()
		deferred := false
		var confirmErr error
		confirmErr = s.pool.QueryRow(confirmCtx, `
			SELECT (state = 'pending' OR (state = 'ready' AND staging_reclaimed_at IS NULL) OR (state = 'unavailable' AND unavailable_reason = 'content-mismatch'))
			       AND staging_reclaim_after > clock_timestamp()
			FROM conversation_artifacts
			WHERE id = $1
		`, id).Scan(&deferred)
		confirmCancel()
		if confirmErr == nil && deferred {
			return nil
		}
		return databaseWriteError("commit artifact recovery deferral", err)
	}
	return nil
}

func (s *Store) deferStagingCleanupRetry(name string, cleanup *cleanupDeadline) error {
	if s == nil || s.pool == nil || cleanup == nil {
		return ErrStoreUnavailable
	}
	ctx, cancel := cleanup.context()
	defer cancel()
	if _, err := s.pool.Exec(ctx, `
		UPDATE conversation_artifact_staging_cleanup
		SET retry_after = clock_timestamp() + INTERVAL '1 minute'
		WHERE staging_name = $1 AND retry_after <= clock_timestamp()
	`, name); err == nil {
		return nil
	} else {
		confirmCtx, confirmCancel := cleanup.context()
		var deferred bool
		confirmErr := s.pool.QueryRow(confirmCtx, `
			SELECT retry_after > clock_timestamp()
			FROM conversation_artifact_staging_cleanup
			WHERE staging_name = $1
		`, name).Scan(&deferred)
		confirmCancel()
		if confirmErr == nil && deferred {
			return nil
		}
		if errors.Is(confirmErr, context.Canceled) || errors.Is(confirmErr, context.DeadlineExceeded) {
			return confirmErr
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return databaseWriteError("defer staging cleanup retry", err)
	}
}

// Recover reconciles at most limit pending publications, ready-row staging
// reclamations and known-unreferenced staging cleanup tasks. It never removes an unreferenced staging
// object from the pre-intent crash window because recovery cannot prove that
// an active uploader is not still using it; those bytes remain diagnosable and
// do not participate in publication coordination.
func (s *Store) Recover(ctx context.Context, limit int) (RecoveryReport, error) {
	var report RecoveryReport
	if s == nil || s.pool == nil {
		return report, ErrStoreUnavailable
	}
	if err := requireContext(ctx); err != nil {
		return report, err
	}
	if limit == 0 {
		limit = DefaultRecoveryLimit
	}
	if limit < 1 {
		return report, fmt.Errorf("artifact recovery limit must be positive: %w", ErrInvalid)
	}
	if limit > MaxRecoveryLimit {
		return report, fmt.Errorf("artifact recovery limit is too large: %w", ErrTooLarge)
	}
	cleanup := newCleanupDeadline(ctx)
	defer cleanup.stop()
	var firstFailure error
	work, err := s.listRecoveryWork(ctx, limit)
	if err != nil {
		return report, err
	}
	for _, item := range work {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		report.Scanned++
		if item.kind == recoveryArtifactWork {
			_, status, err := s.reconcileOneForRecovery(ctx, item.name, cleanup)
			if err != nil {
				report.Failed++
				if firstFailure == nil {
					firstFailure = err
				}
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					if deferErr := s.deferArtifactRecovery(item.name, cleanup); deferErr != nil {
						return report, errors.Join(err, deferErr)
					}
					return report, err
				}
				deferErr := s.deferArtifactRecovery(item.name, cleanup)
				if errors.Is(deferErr, context.Canceled) || errors.Is(deferErr, context.DeadlineExceeded) {
					return report, deferErr
				}
				if deferErr != nil {
					firstFailure = errors.Join(firstFailure, deferErr)
				} else {
					report.Deferred++
				}
				continue
			}
			switch status {
			case recoveryReady:
				report.Ready++
			case recoveryUnavailable:
				report.Unavailable++
			default:
				report.Pending++
			}
			continue
		}
		cleaned, err := s.recoverStagingCleanup(ctx, item.name, cleanup)
		if err != nil {
			report.Failed++
			if firstFailure == nil {
				firstFailure = err
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				if deferErr := s.deferStagingCleanupRetry(item.name, cleanup); deferErr != nil {
					return report, errors.Join(err, deferErr)
				}
				return report, err
			}
			deferErr := s.deferStagingCleanupRetry(item.name, cleanup)
			if errors.Is(deferErr, context.Canceled) || errors.Is(deferErr, context.DeadlineExceeded) {
				return report, deferErr
			}
			if deferErr != nil {
				firstFailure = errors.Join(firstFailure, deferErr)
			} else {
				report.Deferred++
			}
			continue
		}
		if cleaned {
			report.Cleaned++
		}
	}
	if report.Failed > 0 {
		if firstFailure != nil {
			if report.Deferred == report.Failed {
				return report, fmt.Errorf("%w: %w: %v", ErrRecoveryIncomplete, ErrRecoveryDeferred, firstFailure)
			}
			return report, fmt.Errorf("%w: %v", ErrRecoveryIncomplete, firstFailure)
		}
		return report, ErrRecoveryIncomplete
	}
	return report, nil
}

func (s *Store) markReadyObjectUnavailable(parent context.Context, id string, reason string) error {
	cleanup := newCleanupDeadline(parent)
	defer cleanup.stop()
	ctx, cancel := cleanup.context()
	defer cancel()
	tx, err := s.beginIdentityTx(ctx, id, cleanup)
	if err != nil {
		return err
	}
	defer func() { rollbackTx(tx, cleanup) }()
	var state string
	if err := tx.QueryRow(ctx, `
		SELECT state
		FROM conversation_artifacts
		WHERE id = $1
		FOR UPDATE
	`, id).Scan(&state); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return fmt.Errorf("read ready artifact state: %w", ErrStoreUnavailable)
	}
	if state != string(publicationReady) {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE conversation_artifacts SET state = 'unavailable', unavailable_reason = $2, staging_reclaim_after = NOW() WHERE id = $1 AND state = 'ready'`, id, reason); err != nil {
		return databaseWriteError("mark ready artifact unavailable", err)
	}
	if err := s.commit(ctx, tx); err != nil {
		confirmed, confirmErr := s.confirmRecordWithCleanup(id, cleanup)
		if confirmErr == nil && confirmed.State == publicationUnavailable && confirmed.UnavailableReason == reason {
			return nil
		}
		return databaseWriteError("commit ready artifact unavailable state", err)
	}
	return nil
}

func (s *Store) markReadyObjectUnavailableForVersion(parent context.Context, id, expectedVersion, reason string) error {
	if strings.TrimSpace(expectedVersion) == "" {
		return fmt.Errorf("artifact content version is missing: %w", ErrContentChanged)
	}
	cleanup := newCleanupDeadline(parent)
	defer cleanup.stop()
	ctx, cancel := cleanup.context()
	defer cancel()
	tx, err := s.beginIdentityTx(ctx, id, cleanup)
	if err != nil {
		return err
	}
	defer func() { rollbackTx(tx, cleanup) }()
	var state string
	if err := tx.QueryRow(ctx, `
		SELECT state
		FROM conversation_artifacts
		WHERE id = $1
		FOR UPDATE
	`, id).Scan(&state); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return fmt.Errorf("read ready artifact state: %w", ErrStoreUnavailable)
	}
	if state != string(publicationReady) {
		return nil
	}
	if err := s.verifyCanonicalObjectPathVersion(ctx, id, expectedVersion); err != nil {
		return err
	}
	s.fault(faultBeforeObjectUnavailableMark)
	if _, err := tx.Exec(ctx, `UPDATE conversation_artifacts SET state = 'unavailable', unavailable_reason = $2, staging_reclaim_after = NOW() WHERE id = $1 AND state = 'ready'`, id, reason); err != nil {
		return databaseWriteError("mark ready artifact unavailable", err)
	}
	if err := s.verifyCanonicalObjectPathVersion(ctx, id, expectedVersion); err != nil {
		return err
	}
	if err := s.commit(ctx, tx); err != nil {
		confirmed, confirmErr := s.confirmRecordWithCleanup(id, cleanup)
		if confirmErr == nil && confirmed.State == publicationUnavailable && confirmed.UnavailableReason == reason {
			return nil
		}
		return databaseWriteError("commit ready artifact unavailable state", err)
	}
	return nil
}

func (s *Store) verifyCanonicalObjectVersion(ctx context.Context, id, expectedVersion string) error {
	if strings.TrimSpace(expectedVersion) == "" {
		return fmt.Errorf("artifact content version is missing: %w", ErrContentChanged)
	}
	path, err := s.objectPath(id)
	if err != nil {
		return err
	}
	file, err := openStoredFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, ErrIntegrity) {
			return fmt.Errorf("artifact content path changed while quarantining: %w", ErrContentChanged)
		}
		return err
	}
	defer file.Close()
	version, err := fileContentVersion(file)
	if err != nil {
		return err
	}
	if version != expectedVersion {
		return fmt.Errorf("artifact content path changed while quarantining: %w", ErrContentChanged)
	}
	return nil
}

func (s *Store) verifyCanonicalObjectPathVersion(ctx context.Context, id, expectedVersion string) error {
	if err := requireContext(ctx); err != nil {
		return err
	}
	path, err := s.objectPath(id)
	if err != nil {
		return err
	}
	version, err := objectPathVersion(path)
	if err != nil {
		return err
	}
	if version != expectedVersion {
		return fmt.Errorf("artifact content path changed while quarantining: %w", ErrContentChanged)
	}
	return nil
}

// markReadyContentMismatch rechecks the canonical object while the ready row
// is locked and immediately before commit. A replacement that arrives after
// the reader's last verification therefore leaves the row ready for a later
// conflict-safe retry instead of quarantining the replacement bytes.
func (s *Store) markReadyContentMismatch(parent context.Context, id, expectedVersion string) error {
	return s.markReadyObjectUnavailableForVersion(parent, id, expectedVersion, contentMismatchReason)
}

func unavailableError(reason error) error {
	if reason == nil {
		return ErrUnavailable
	}
	return fmt.Errorf("artifact is unavailable: %w", errors.Join(ErrUnavailable, reason))
}
