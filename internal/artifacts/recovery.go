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
	DefaultRecoveryLimit = 64
	MaxRecoveryLimit     = 1024
	cleanupTimeout       = 5 * time.Second
)

var (
	ErrUnavailable        = errors.New("artifact is unavailable")
	ErrRecoveryIncomplete = errors.New("artifact recovery incomplete")
)

func databaseWriteError(message string, err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return fmt.Errorf("%s: %w", message, ErrStoreUnavailable)
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
}

type faultPoint string

const (
	faultAfterStage              faultPoint = "after-stage"
	faultAfterIntentCommit       faultPoint = "after-intent-commit"
	faultAfterRepairIntentCommit faultPoint = "after-repair-intent-commit"
	faultAfterFinalLink          faultPoint = "after-final-link"
	faultAfterFinalPublication   faultPoint = "after-final-publication"
	faultAfterReadyCommit        faultPoint = "after-ready-commit"
)

// faultHooks is intentionally unexported. Package tests use it to terminate a
// helper process at durable publication boundaries; production composition
// cannot configure process-exit behavior through Config.
type faultHooks struct {
	AfterStage                func()
	AfterIntentCommit         func()
	AfterRepairIntentCommit   func()
	AfterFinalLink            func()
	AfterFinalPublication     func()
	AfterReadyCommit          func()
	CommitResponseLost        func() error
	BeforeIdentityLock        func(context.Context, pgx.Tx, string)
	AfterIdentityLock         func()
	BeforeReadyStagingRemoval func()
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
	}
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
		return artifactRecord{}, ErrNotFound
	}
	if record.State != publicationReady {
		return artifactRecord{}, unavailableError(ErrIntegrity)
	}
	return record, nil
}

func (s *Store) inspectReady(record artifactRecord) (fileCheck, error) {
	path, err := s.objectPath(record.Artifact.ID)
	if err != nil {
		return fileUnknown, err
	}
	return inspectArtifactFile(path, record.Artifact)
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
	tx, err := s.beginIdentityTx(ctx, candidate.ID, cleanup)
	if err != nil {
		return artifactRecord{}, err
	}
	defer func() { rollbackTx(tx, cleanup) }()
	if err := lockStagingName(ctx, tx, stagingName); err != nil {
		return artifactRecord{}, err
	}

	existing, err := readArtifactRecord(ctx, tx, candidate.ID)
	if err == nil {
		if !sameArtifactMetadata(candidate, existing.Artifact) {
			return artifactRecord{}, ErrConflict
		}
		if existing.State == publicationUnavailable && repairableUnavailableReason(existing.UnavailableReason) {
			return s.repairUnavailable(ctx, tx, existing, candidate, stagingName, cleanup)
		}
		return existing, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return artifactRecord{}, err
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

func repairableUnavailableReason(reason string) bool {
	return reason == "staging-missing" || reason == "staging-corrupt"
}

func publicationStateMatchesIntent(state publicationState) bool {
	return state == publicationPending || state == publicationReady
}

func (s *Store) repairUnavailable(ctx context.Context, tx pgx.Tx, existing artifactRecord, candidate protocol.Artifact, stagingName string, cleanup *cleanupDeadline) (artifactRecord, error) {
	if err := s.authorize(ctx, OperationPut, candidate); err != nil {
		return artifactRecord{}, err
	}
	finalPath, err := s.objectPath(candidate.ID)
	if err != nil {
		return artifactRecord{}, err
	}
	finalCheck, err := inspectArtifactFile(finalPath, existing.Artifact)
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
		return artifactRecord{}, ErrConflict
	case fileUnknown:
		return artifactRecord{}, fmt.Errorf("inspect final artifact for repair: %w", ErrStoreUnavailable)
	}

	stagingPath, err := s.stagingPath(stagingName)
	if err != nil {
		return artifactRecord{}, err
	}
	stagingCheck, err := inspectArtifactFile(stagingPath, candidate)
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
			_ = os.Remove(temporaryPath)
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
		keep = true
		return protocol.Artifact{}, "", fmt.Errorf("sync artifact staging file: %w", ErrStoreUnavailable)
	}
	if err := temporary.Close(); err != nil {
		keep = true
		return protocol.Artifact{}, "", fmt.Errorf("close artifact staging file: %w", ErrStoreUnavailable)
	}
	if err := syncDirectory(s.objects); err != nil {
		keep = true
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

func inspectArtifactFile(path string, artifact protocol.Artifact) (fileCheck, error) {
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
	if err := verifyFile(file, artifact); err != nil {
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
	reclaimReady := s.reclaimReadyStaging
	if respectRetryAfter {
		reclaimReady = s.reclaimReadyStagingForRecovery
	}
	if record.State != publicationPending {
		if record.State == publicationReady {
			if record.StagingReclaimed {
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
		if confirmErr == nil && samePublicationState(confirmed, updated) {
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
	if !samePublicationState(confirmed, updated) {
		return artifactRecord{}, recoveryPending, fmt.Errorf("artifact recovery state changed unexpectedly: %w", ErrStoreUnavailable)
	}
	if confirmed.State == publicationReady {
		return reclaimReady(ctx, id, cleanup)
	}
	return confirmed, stateRecoveryStatus(confirmed.State), nil
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
		if !record.StagingReclaimed {
			if err := s.queueStagingCleanupTx(ctx, tx, record.StagingName, record.StagingIdentity); err != nil {
				return artifactRecord{}, recoveryPending, err
			}
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
	finalCheck, err := s.inspectReady(record)
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
	removeStaging := sameStagingIdentity(record.StagingIdentity, currentIdentity)
	if record.StagingIdentity == nil && currentIdentity != nil {
		stagingPath, pathErr := s.stagingPath(record.StagingName)
		if pathErr != nil {
			return artifactRecord{}, recoveryPending, pathErr
		}
		stagingCheck, checkErr := inspectArtifactFile(stagingPath, record.Artifact)
		if checkErr != nil {
			return artifactRecord{}, recoveryPending, checkErr
		}
		removeStaging = stagingCheck == fileValid
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
	finalCheck, err = s.inspectReady(record)
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
	finalCheck, err := inspectArtifactFile(finalPath, record.Artifact)
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
	stagingCheck, err := inspectArtifactFile(stagingPath, record.Artifact)
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
			finalCheck, inspectErr := inspectArtifactFile(finalPath, record.Artifact)
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
	finalCheck, err = inspectArtifactFile(finalPath, record.Artifact)
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
	if err := syncDirectory(s.objects); err != nil {
		return fmt.Errorf("sync artifact staging directory after removal: %w", ErrStoreUnavailable)
	}
	return nil
}

func (s *Store) enqueueStagingCleanup(name string, cleanup *cleanupDeadline) {
	if s == nil || s.pool == nil || cleanup == nil {
		return
	}
	ctx, cancel := cleanup.context()
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return
	}
	defer func() { rollbackTx(tx, cleanup) }()
	if err := s.queueCurrentStagingCleanupTx(ctx, tx, name); err != nil {
		return
	}
	_ = s.commit(ctx, tx)
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
		if err := s.commit(ctx, tx); err != nil {
			return false, databaseWriteError("commit active staging cleanup debt", err)
		}
		return true, nil
	}
	currentIdentity, err := s.stagingIdentity(name)
	if err != nil {
		return false, err
	}
	if expectedIdentity != nil && currentIdentity == nil {
		if _, err := tx.Exec(ctx, `DELETE FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, name); err != nil {
			return false, databaseWriteError("discard replaced staging cleanup debt", err)
		}
		if err := s.commit(ctx, tx); err != nil {
			return false, databaseWriteError("commit replaced staging cleanup debt", err)
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
		if err := s.commit(ctx, tx); err != nil {
			return false, databaseWriteError("commit replaced staging cleanup deferral", err)
		}
		return false, nil
	}
	if removeErr := s.removeStaging(name); removeErr != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE conversation_artifact_staging_cleanup
			SET retry_after = clock_timestamp() + INTERVAL '1 minute'
			WHERE staging_name = $1
		`, name); err != nil {
			return false, databaseWriteError("defer staging cleanup", err)
		}
		if err := s.commit(ctx, tx); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return false, err
			}
			return false, databaseWriteError("commit staging cleanup deferral", err)
		}
		return false, removeErr
	}
	if _, err := tx.Exec(ctx, `DELETE FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, name); err != nil {
		return false, databaseWriteError("delete staging cleanup debt", err)
	}
	if err := s.commit(ctx, tx); err != nil {
		return false, databaseWriteError("commit staging cleanup", err)
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

func (s *Store) deferArtifactRecovery(id string, cleanup *cleanupDeadline) error {
	if s == nil || s.pool == nil || cleanup == nil {
		return ErrStoreUnavailable
	}
	ctx, cancel := cleanup.context()
	defer cancel()
	tx, err := s.beginIdentityTx(ctx, id, cleanup)
	if err != nil {
		return err
	}
	defer func() { rollbackTx(tx, cleanup) }()
	var state string
	var reclaimed bool
	if err := tx.QueryRow(ctx, `
		SELECT state, (staging_reclaimed_at IS NOT NULL)
		FROM conversation_artifacts
		WHERE id = $1
		FOR UPDATE
	`, id).Scan(&state, &reclaimed); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return fmt.Errorf("read artifact recovery state: %w", ErrStoreUnavailable)
	}
	if state != string(publicationPending) && !(state == string(publicationReady) && !reclaimed) {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversation_artifacts
		SET staging_reclaim_after = clock_timestamp() + INTERVAL '1 minute'
		WHERE id = $1 AND (state = 'pending' OR (state = 'ready' AND staging_reclaimed_at IS NULL))
	`, id); err != nil {
		return databaseWriteError("defer artifact recovery", err)
	}
	if err := s.commit(ctx, tx); err != nil {
		confirmCtx, confirmCancel := cleanup.context()
		deferred := false
		var confirmErr error
		confirmErr = s.pool.QueryRow(confirmCtx, `
			SELECT (state = 'pending' OR (state = 'ready' AND staging_reclaimed_at IS NULL))
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
	pendingIDs, err := s.listRecoveryIDs(ctx, `
		SELECT id FROM conversation_artifacts
		WHERE state = 'pending' AND staging_reclaim_after <= NOW()
		ORDER BY staging_reclaim_after, created_at, id
		LIMIT $1
	`, limit)
	if err != nil {
		return report, err
	}
	readyIDs, err := s.listRecoveryIDs(ctx, `
	SELECT id FROM conversation_artifacts
		WHERE state = 'ready' AND staging_reclaimed_at IS NULL AND staging_reclaim_after <= NOW()
		ORDER BY staging_reclaim_after, created_at, id
		LIMIT $1
	`, limit)
	if err != nil {
		return report, err
	}
	cleanupNames, err := s.listRecoveryIDs(ctx, `
		SELECT staging_name FROM conversation_artifact_staging_cleanup
		WHERE retry_after <= NOW()
		ORDER BY retry_after, staging_name
		LIMIT $1
	`, limit)
	if err != nil {
		return report, err
	}
	ids := append(pendingIDs, readyIDs...)

	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		report.Scanned++
		_, status, err := s.reconcileOneForRecovery(ctx, id, cleanup)
		if err != nil {
			report.Failed++
			if firstFailure == nil {
				firstFailure = err
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return report, err
			}
			if deferErr := s.deferArtifactRecovery(id, cleanup); errors.Is(deferErr, context.Canceled) || errors.Is(deferErr, context.DeadlineExceeded) {
				return report, deferErr
			} else if deferErr != nil {
				firstFailure = errors.Join(firstFailure, deferErr)
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
	}
	for _, name := range cleanupNames {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		report.Scanned++
		cleaned, err := s.recoverStagingCleanup(ctx, name, cleanup)
		if err != nil {
			report.Failed++
			if firstFailure == nil {
				firstFailure = err
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return report, err
			}
			continue
		}
		if cleaned {
			report.Cleaned++
		}
	}
	if report.Failed > 0 {
		if firstFailure != nil {
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
	var state, stagingName string
	var stagingIdentity *string
	var reclaimed bool
	if err := tx.QueryRow(ctx, `
		SELECT state, staging_name, staging_identity, (staging_reclaimed_at IS NOT NULL)
		FROM conversation_artifacts
		WHERE id = $1
		FOR UPDATE
	`, id).Scan(&state, &stagingName, &stagingIdentity, &reclaimed); err != nil {
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
	if _, err := tx.Exec(ctx, `UPDATE conversation_artifacts SET state = 'unavailable', unavailable_reason = $2 WHERE id = $1 AND state = 'ready'`, id, reason); err != nil {
		return databaseWriteError("mark ready artifact unavailable", err)
	}
	if !reclaimed {
		if err := s.queueStagingCleanupTx(ctx, tx, stagingName, stagingIdentity); err != nil {
			return err
		}
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

func unavailableError(reason error) error {
	if reason == nil {
		return ErrUnavailable
	}
	return fmt.Errorf("artifact is unavailable: %w", errors.Join(ErrUnavailable, reason))
}
