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
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
)

const DefaultRecoveryLimit = 64

var (
	ErrUnavailable        = errors.New("artifact is unavailable")
	ErrRecoveryIncomplete = errors.New("artifact recovery incomplete")
)

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
	Failed      int
}

type faultPoint string

const (
	faultAfterStage            faultPoint = "after-stage"
	faultAfterIntentCommit     faultPoint = "after-intent-commit"
	faultAfterFinalPublication faultPoint = "after-final-publication"
	faultAfterReadyCommit      faultPoint = "after-ready-commit"
)

// faultHooks is intentionally unexported. Package tests use it to terminate a
// helper process at durable publication boundaries; production composition
// cannot configure process-exit behavior through Config.
type faultHooks struct {
	AfterStage            func()
	AfterIntentCommit     func()
	AfterFinalPublication func()
	AfterReadyCommit      func()
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

func (s *Store) beginIdentityTx(ctx context.Context, id string) (pgx.Tx, error) {
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
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "loomhelm:artifact:"+id); err != nil {
		_ = tx.Rollback(context.Background())
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, fmt.Errorf("lock artifact publication: %w", ErrStoreUnavailable)
	}
	return tx, nil
}

func readArtifactRecord(ctx context.Context, queryer rowQuerier, id string) (artifactRecord, error) {
	var record artifactRecord
	var runID *string
	var kind string
	var createdAt time.Time
	var state string
	if err := queryer.QueryRow(ctx, `
		SELECT id, session_id, run_id, name, kind, size, sha256, content_type,
		       created_at, state, staging_name, unavailable_reason
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
		&record.UnavailableReason,
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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return readArtifactRecord(ctx, s.pool, id)
}

func (s *Store) readReadyRecord(ctx context.Context, id string) (artifactRecord, error) {
	if s == nil || s.pool == nil {
		return artifactRecord{}, ErrStoreUnavailable
	}
	record, err := readArtifactRecord(ctx, s.pool, id)
	if err != nil {
		return artifactRecord{}, err
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

func sameArtifactMetadata(candidate, existing protocol.Artifact, createdAtProvided bool) bool {
	if candidate.ID != existing.ID || candidate.SessionID != existing.SessionID || candidate.Name != existing.Name || candidate.Kind != existing.Kind || candidate.Size != existing.Size || candidate.Sha256 != existing.Sha256 || candidate.ContentType != existing.ContentType || !sameOptionalID(candidate.RunID, existing.RunID) {
		return false
	}
	return !createdAtProvided || candidate.CreatedAt == existing.CreatedAt
}

func (s *Store) ensurePending(ctx context.Context, candidate protocol.Artifact, createdAtProvided bool, stagingName string) (artifactRecord, error) {
	tx, err := s.beginIdentityTx(ctx, candidate.ID)
	if err != nil {
		return artifactRecord{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	existing, err := readArtifactRecord(ctx, tx, candidate.ID)
	if err == nil {
		if !sameArtifactMetadata(candidate, existing.Artifact, createdAtProvided) {
			return artifactRecord{}, ErrConflict
		}
		return existing, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return artifactRecord{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, run_id, name, kind, size, sha256, content_type,
			created_at, state, staging_name, unavailable_reason
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, '')
	`, candidate.ID, candidate.SessionID, nullableString(candidate.RunID), candidate.Name, string(candidate.Kind), candidate.Size, candidate.Sha256, candidate.ContentType, parseCreatedAt(candidate.CreatedAt), stagingName); err != nil {
		return artifactRecord{}, fmt.Errorf("persist artifact intent: %w", ErrStoreUnavailable)
	}
	if err := tx.Commit(ctx); err != nil {
		confirmed, confirmErr := s.confirmRecord(candidate.ID)
		if confirmErr == nil && sameArtifactMetadata(candidate, confirmed.Artifact, createdAtProvided) && confirmed.State == publicationPending {
			return confirmed, nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return artifactRecord{}, err
		}
		return artifactRecord{}, fmt.Errorf("confirm artifact intent: %w", ErrStoreUnavailable)
	}
	s.fault(faultAfterIntentCommit)
	confirmed, err := s.confirmRecord(candidate.ID)
	if err != nil {
		return artifactRecord{}, err
	}
	if !sameArtifactMetadata(candidate, confirmed.Artifact, createdAtProvided) || confirmed.State != publicationPending {
		return artifactRecord{}, ErrConflict
	}
	return confirmed, nil
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
		return protocol.Artifact{}, "", fmt.Errorf("write artifact bytes: %w", err)
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

func (s *Store) reconcileOne(ctx context.Context, id string) (artifactRecord, recoveryStatus, error) {
	if err := s.ensureObjectDirectory(); err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	tx, err := s.beginIdentityTx(ctx, id)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	record, err := readArtifactRecord(ctx, tx, id)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if record.State != publicationPending {
		return record, stateRecoveryStatus(record.State), nil
	}
	updated, _, err := s.reconcilePendingTx(ctx, tx, record)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if err := tx.Commit(ctx); err != nil {
		confirmed, confirmErr := s.confirmRecord(id)
		if confirmErr == nil && confirmed.State == updated.State {
			if confirmed.State == publicationReady {
				s.removeStaging(confirmed.StagingName)
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
	confirmed, err := s.confirmRecord(id)
	if err != nil {
		return artifactRecord{}, recoveryPending, err
	}
	if confirmed.State != updated.State {
		return artifactRecord{}, recoveryPending, fmt.Errorf("artifact recovery state changed unexpectedly: %w", ErrStoreUnavailable)
	}
	if confirmed.State == publicationReady {
		s.removeStaging(confirmed.StagingName)
	}
	return confirmed, stateRecoveryStatus(confirmed.State), nil
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
				return s.updatePublicationState(ctx, tx, record, publicationReady, "")
			}
			return s.updatePublicationState(ctx, tx, record, publicationUnavailable, "final-conflict")
		}
		return artifactRecord{}, recoveryPending, fmt.Errorf("publish final artifact: %w", ErrStoreUnavailable)
	}
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
		SET state = $2, unavailable_reason = $3
		WHERE id = $1 AND state = 'pending'
	`, record.Artifact.ID, string(state), reason)
	if err != nil {
		return artifactRecord{}, recoveryPending, fmt.Errorf("update artifact publication: %w", ErrStoreUnavailable)
	}
	if tag.RowsAffected() != 1 {
		return artifactRecord{}, recoveryPending, fmt.Errorf("artifact publication row changed unexpectedly: %w", ErrStoreUnavailable)
	}
	record.State = state
	record.UnavailableReason = reason
	return record, stateRecoveryStatus(state), nil
}

func (s *Store) removeStaging(name string) {
	path, err := s.stagingPath(name)
	if err != nil {
		return
	}
	if err := os.Remove(path); err != nil {
		return
	}
	_ = syncDirectory(s.objects)
}

// Recover reconciles at most limit pending publications. It never removes a
// staging or final object solely because a previous operation returned an
// error; unresolved bytes remain recoverable and are reported as failures.
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
	rows, err := s.pool.Query(ctx, `
		SELECT id FROM conversation_artifacts
		WHERE state = 'pending'
		ORDER BY created_at, id
		LIMIT $1
	`, limit)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return report, err
		}
		return report, fmt.Errorf("list artifact recovery work: %w", ErrStoreUnavailable)
	}
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return report, fmt.Errorf("read artifact recovery work: %w", ErrStoreUnavailable)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return report, fmt.Errorf("read artifact recovery work: %w", ErrStoreUnavailable)
	}
	rows.Close()

	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		report.Scanned++
		_, status, err := s.reconcileOne(ctx, id)
		if err != nil {
			report.Failed++
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return report, err
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
	if report.Failed > 0 {
		return report, ErrRecoveryIncomplete
	}
	return report, nil
}

func (s *Store) markReadyObjectUnavailable(id string, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := s.beginIdentityTx(ctx, id)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var state string
	if err := tx.QueryRow(ctx, `SELECT state FROM conversation_artifacts WHERE id = $1 FOR UPDATE`, id).Scan(&state); err != nil || state != string(publicationReady) {
		return
	}
	if _, err := tx.Exec(ctx, `UPDATE conversation_artifacts SET state = 'unavailable', unavailable_reason = $2 WHERE id = $1 AND state = 'ready'`, id, reason); err != nil {
		return
	}
	if err := tx.Commit(ctx); err != nil {
		return
	}
	_, _ = s.confirmRecord(id)
}

func unavailableError(reason error) error {
	if reason == nil {
		return ErrUnavailable
	}
	return fmt.Errorf("artifact is unavailable: %w", errors.Join(ErrUnavailable, reason))
}
