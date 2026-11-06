package deployment

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidCandidate    = errors.New("invalid deployment candidate")
	ErrIdempotencyConflict = errors.New("deployment idempotency key conflicts with an existing request")
	ErrStaleFingerprint    = errors.New("deployment current fingerprint is stale")
	ErrOperationLocked     = errors.New("another deployment operation is already running")
	ErrExecutorUnavailable = errors.New("deployment executor is unavailable")
)

type Config struct {
	OwnerUserIDs []string
	Executor     Executor
	Observer     ObservationProvider
	Logger       *slog.Logger
	Now          func() time.Time
	ReadOnly     bool
}

type ObservationProvider interface {
	Observe(context.Context, Status) (Observation, error)
}

type Service struct {
	pool     *pgxpool.Pool
	owners   map[string]struct{}
	executor Executor
	observer ObservationProvider
	logger   *slog.Logger
	now      func() time.Time
	readOnly bool
}

func NewService(pool *pgxpool.Pool, config Config) (*Service, error) {
	if pool == nil {
		return nil, errors.New("deployment database pool must not be nil")
	}
	owners := make(map[string]struct{}, len(config.OwnerUserIDs))
	for _, value := range config.OwnerUserIDs {
		value = strings.TrimSpace(value)
		if value != "" {
			owners[value] = struct{}{}
		}
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	executor := config.Executor
	if executor == nil {
		executor = UnavailableExecutor{}
	}
	observer := config.Observer
	if observer == nil {
		observer, _ = executor.(ObservationProvider)
	}
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{pool: pool, owners: owners, executor: executor, observer: observer, logger: logger, now: now, readOnly: config.ReadOnly}, nil
}

func ConfigFromEnvironment() Config {
	var owners []string
	for _, value := range strings.Split(os.Getenv("LOOMHELM_DEPLOYMENT_OWNER_USER_IDS"), ",") {
		if strings.TrimSpace(value) != "" {
			owners = append(owners, strings.TrimSpace(value))
		}
	}
	return Config{OwnerUserIDs: owners}
}

type UnavailableExecutor struct{}

func (UnavailableExecutor) Execute(context.Context, Operation) error { return ErrExecutorUnavailable }
func (UnavailableExecutor) Ready(context.Context) error              { return ErrExecutorUnavailable }

type readinessChecker interface {
	Ready(context.Context) error
}

func (s *Service) Ready(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("deployment service is not initialized")
	}
	if ctx == nil {
		return errors.New("deployment readiness context must not be nil")
	}
	if err := s.pool.Ping(ctx); err != nil {
		return fmt.Errorf("deployment database is not ready: %w", err)
	}
	if s.executor == nil {
		return ErrExecutorUnavailable
	}
	if checker, ok := s.executor.(readinessChecker); ok {
		if err := checker.Ready(ctx); err != nil {
			return fmt.Errorf("deployment executor is not ready: %w", err)
		}
	}
	return nil
}

func (s *Service) Role(ctx context.Context, principal auth.Principal) (Role, error) {
	if principal.UserID == "" {
		return "", auth.ErrUnauthenticated
	}
	if len(principal.ProjectScope) > 0 {
		return "", auth.ErrForbidden
	}
	if _, ok := s.owners[principal.UserID]; ok {
		return RoleOwner, nil
	}
	var role string
	err := s.pool.QueryRow(ctx, `SELECT role FROM deployment_roles WHERE user_id = $1`, principal.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", auth.ErrForbidden
	}
	if err != nil {
		return "", fmt.Errorf("load deployment role: %w", err)
	}
	return Role(role), nil
}

func allowed(role Role, capability Capability) bool {
	if role == RoleOwner {
		return true
	}
	switch capability {
	case CapabilityView:
		return role == RoleObserver || role == RoleOperator || role == RoleReleaser || role == RoleRecovery
	case CapabilityPreflight, CapabilityStage:
		return role == RoleOperator || role == RoleReleaser
	case CapabilityPromote, CapabilityRollback:
		return role == RoleReleaser
	case CapabilityReconcile, CapabilityDrain:
		return role == RoleRecovery
	default:
		return false
	}
}

func (s *Service) Require(ctx context.Context, principal auth.Principal, capability Capability) (Role, error) {
	role, err := s.Role(ctx, principal)
	if err != nil {
		return "", err
	}
	if !allowed(role, capability) {
		return "", auth.ErrForbidden
	}
	return role, nil
}

func (s *Service) Status(ctx context.Context, principal auth.Principal) (Status, error) {
	role, err := s.Require(ctx, principal, CapabilityView)
	if err != nil {
		return Status{}, err
	}
	var result Status
	var activeSlot, candidateID, fingerprint string
	if err := s.pool.QueryRow(ctx, `
		SELECT active_slot, active_candidate_id, active_fingerprint
		FROM deployment_installations WHERE id = 'default'
	`).Scan(&activeSlot, &candidateID, &fingerprint); err != nil {
		return Status{}, fmt.Errorf("load deployment installation: %w", err)
	}
	result.ActiveSlot = activeSlot
	result.ActiveCandidateID = candidateID
	result.ActiveFingerprint = fingerprint
	if err := s.pool.QueryRow(ctx, `SELECT next_worker_generation FROM deployment_installations WHERE id = 'default'`).Scan(&result.NextWorkerGeneration); err != nil {
		return Status{}, fmt.Errorf("load next worker generation: %w", err)
	}
	rows, err := s.pool.Query(ctx, `SELECT slot, state, COALESCE(candidate_id, ''), worker_generation FROM deployment_slots ORDER BY slot`)
	if err != nil {
		return Status{}, fmt.Errorf("list deployment slots: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var slot Slot
		if err := rows.Scan(&slot.Name, &slot.State, &slot.CandidateID, &slot.WorkerGeneration); err != nil {
			return Status{}, fmt.Errorf("scan deployment slot: %w", err)
		}
		result.Slots = append(result.Slots, slot)
	}
	if err := rows.Err(); err != nil {
		return Status{}, fmt.Errorf("read deployment slots: %w", err)
	}
	var operation Operation
	if err := scanOperation(s.pool.QueryRow(ctx, `
		SELECT id, kind, status, COALESCE(candidate_id, ''), COALESCE(slot, ''), COALESCE(target_operation_id, ''), expected_fingerprint, error_code, error_message, created_at, started_at, finished_at, updated_at
		FROM deployment_operations ORDER BY created_at DESC, id DESC LIMIT 1
	`), &operation); err == nil {
		result.LatestOperation = &operation
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Status{}, fmt.Errorf("load latest deployment operation: %w", err)
	}
	result.Role = role
	result.Capabilities = capabilitiesForRole(role)
	result.ControllerReady = true
	return result, nil
}

func (s *Service) Observe(ctx context.Context, principal auth.Principal) (Observation, error) {
	if _, err := s.Require(ctx, principal, CapabilityView); err != nil {
		return Observation{}, err
	}
	status, err := s.Status(ctx, principal)
	if err != nil {
		return Observation{}, err
	}
	if s.observer == nil {
		return unavailableObservation(status, "runtime observation provider is unavailable"), nil
	}
	observation, err := s.observer.Observe(ctx, status)
	if err != nil {
		return unavailableObservation(status, "runtime observation is unavailable"), nil
	}
	return observation, nil
}

func unavailableObservation(status Status, reason string) Observation {
	result := Observation{
		State:                  ObservationUnavailable,
		Reason:                 reason,
		DesiredActiveSlot:      status.ActiveSlot,
		MigrationState:         ObservationUnknown,
		SharedWorkerLoadState:  ObservationUnavailable,
		SharedWorkerLoadReason: reason,
		ObservedAt:             time.Now().UTC(),
		Slots:                  make([]SlotObservation, 0, len(status.Slots)),
	}
	for _, slot := range status.Slots {
		result.Slots = append(result.Slots, SlotObservation{
			Slot:             slot.Name,
			DesiredState:     slot.State,
			CandidateID:      slot.CandidateID,
			WorkerGeneration: slot.WorkerGeneration,
			Server:           ComponentObservation{State: ObservationUnavailable, LoadState: ObservationUnavailable, Reason: reason, LoadReason: reason},
			Worker:           ComponentObservation{State: ObservationUnavailable, LoadState: ObservationUnavailable, Reason: reason, LoadReason: reason},
			Traffic:          SlotTrafficObservation{State: ObservationUnavailable, Reason: reason},
			Load:             SlotLoadObservation{State: ObservationUnavailable, Reason: reason},
		})
	}
	return result
}

func capabilitiesForRole(role Role) []Capability {
	all := []Capability{CapabilityView, CapabilityPreflight, CapabilityStage, CapabilityPromote, CapabilityRollback, CapabilityReconcile, CapabilityDrain}
	if role == RoleOwner {
		return all
	}
	var result []Capability
	for _, capability := range all {
		if allowed(role, capability) {
			result = append(result, capability)
		}
	}
	return result
}

func (s *Service) ListCandidates(ctx context.Context) ([]Candidate, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, source_sha, artifact_digest, web_digest, server_image, worker_image, state_version, read_min, read_max, migration_mode, status, created_at, updated_at
		FROM deployment_candidates ORDER BY created_at DESC, id DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list deployment candidates: %w", err)
	}
	defer rows.Close()
	result := make([]Candidate, 0)
	for rows.Next() {
		var candidate Candidate
		if err := rows.Scan(&candidate.ID, &candidate.SourceSHA, &candidate.ArtifactDigest, &candidate.WebDigest, &candidate.ServerImage, &candidate.WorkerImage, &candidate.StateVersion, &candidate.ReadMin, &candidate.ReadMax, &candidate.MigrationMode, &candidate.Status, &candidate.CreatedAt, &candidate.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan deployment candidate: %w", err)
		}
		result = append(result, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read deployment candidates: %w", err)
	}
	return result, nil
}

func (s *Service) RegisterCandidate(ctx context.Context, envelope Envelope) (Candidate, error) {
	if envelope.SchemaVersion != 2 || envelope.CandidateID == "" || envelope.SourceSHA == "" || envelope.ArtifactDigest == "" || envelope.WebDigest == "" || !validImageReference(envelope.ServerImage) || !validImageReference(envelope.WorkerImage) {
		return Candidate{}, ErrInvalidCandidate
	}
	manifest := envelope.ManifestJSON
	if len(manifest) == 0 || !json.Valid(manifest) {
		return Candidate{}, fmt.Errorf("%w: original manifest is required", ErrInvalidCandidate)
	}
	var candidate Candidate
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO deployment_candidates (id, source_sha, artifact_digest, web_digest, server_image, worker_image, manifest, state_version, read_min, read_max, migration_mode)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
		ON CONFLICT (id) DO UPDATE SET
			updated_at = CURRENT_TIMESTAMP
		WHERE deployment_candidates.source_sha = EXCLUDED.source_sha
		  AND deployment_candidates.artifact_digest = EXCLUDED.artifact_digest
		  AND deployment_candidates.web_digest = EXCLUDED.web_digest
		  AND deployment_candidates.server_image = EXCLUDED.server_image
		  AND deployment_candidates.worker_image = EXCLUDED.worker_image
		  AND deployment_candidates.manifest = EXCLUDED.manifest
		RETURNING id, source_sha, artifact_digest, web_digest, server_image, worker_image, state_version, read_min, read_max, migration_mode, status, created_at, updated_at
	`, envelope.CandidateID, envelope.SourceSHA, envelope.ArtifactDigest, envelope.WebDigest, envelope.ServerImage, envelope.WorkerImage, manifest, envelope.StateVersion, envelope.ReadMin, envelope.ReadMax, envelope.MigrationMode).Scan(&candidate.ID, &candidate.SourceSHA, &candidate.ArtifactDigest, &candidate.WebDigest, &candidate.ServerImage, &candidate.WorkerImage, &candidate.StateVersion, &candidate.ReadMin, &candidate.ReadMax, &candidate.MigrationMode, &candidate.Status, &candidate.CreatedAt, &candidate.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Candidate{}, ErrIdempotencyConflict
		}
		return Candidate{}, fmt.Errorf("register deployment candidate: %w", err)
	}
	return candidate, nil
}

func (s *Service) GetOperation(ctx context.Context, operationID string) (Operation, error) {
	if strings.TrimSpace(operationID) == "" {
		return Operation{}, fmt.Errorf("%w: operation id is required", auth.ErrInvalid)
	}
	var operation Operation
	if err := scanOperation(s.pool.QueryRow(ctx, `
		SELECT id, kind, status, COALESCE(candidate_id, ''), COALESCE(slot, ''), COALESCE(target_operation_id, ''), expected_fingerprint, error_code, error_message, created_at, started_at, finished_at, updated_at
		FROM deployment_operations WHERE id = $1
	`, operationID), &operation); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Operation{}, auth.ErrNotFound
		}
		return Operation{}, fmt.Errorf("load deployment operation: %w", err)
	}
	return operation, nil
}

func (s *Service) ListEvents(ctx context.Context, limit int) ([]Event, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, operation_id, type, candidate_id, slot, worker_generation, observed_fingerprint, details, created_at
		FROM deployment_events ORDER BY id DESC LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("list deployment events: %w", err)
	}
	defer rows.Close()
	result := make([]Event, 0)
	for rows.Next() {
		var event Event
		var details []byte
		if err := rows.Scan(&event.ID, &event.OperationID, &event.Type, &event.CandidateID, &event.Slot, &event.WorkerGeneration, &event.ObservedFingerprint, &details, &event.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan deployment event: %w", err)
		}
		if len(details) != 0 {
			if err := json.Unmarshal(details, &event.Details); err != nil {
				return nil, fmt.Errorf("decode deployment event details: %w", err)
			}
		}
		result = append(result, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read deployment events: %w", err)
	}
	return result, nil
}

func (s *Service) StartOperation(ctx context.Context, principal auth.Principal, kind string, request OperationRequest, idempotencyKey string) (Operation, bool, error) {
	if s.readOnly {
		return Operation{}, false, auth.ErrForbidden
	}
	capability := capabilityForKind(kind)
	if capability == "" {
		return Operation{}, false, fmt.Errorf("%w: unknown deployment operation", auth.ErrInvalid)
	}
	if _, err := s.Require(ctx, principal, capability); err != nil {
		return Operation{}, false, err
	}
	if strings.TrimSpace(idempotencyKey) == "" || len(idempotencyKey) > 128 {
		return Operation{}, false, fmt.Errorf("%w: Idempotency-Key is required", auth.ErrInvalid)
	}
	if kind != "preflight" && kind != "reconcile" && !request.Confirm {
		return Operation{}, false, fmt.Errorf("%w: deployment confirmation is required", auth.ErrInvalid)
	}
	if kind == "reconcile" && strings.TrimSpace(request.OperationID) == "" {
		return Operation{}, false, fmt.Errorf("%w: operation_id is required for reconcile", auth.ErrInvalid)
	}
	if (kind == "preflight" || kind == "stage" || kind == "promote" || kind == "rollback") && strings.TrimSpace(request.CandidateID) == "" {
		return Operation{}, false, fmt.Errorf("%w: candidate_id is required", auth.ErrInvalid)
	}
	requestData, err := json.Marshal(struct {
		Kind    string           `json:"kind"`
		Request OperationRequest `json:"request"`
	}{kind, request})
	if err != nil {
		return Operation{}, false, fmt.Errorf("hash deployment request: %w", err)
	}
	digest := sha256.Sum256(requestData)
	requestHash := hex.EncodeToString(digest[:])
	operationID, err := newOperationID()
	if err != nil {
		return Operation{}, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Operation{}, false, fmt.Errorf("begin deployment operation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtext('loomhelm:deployment-control'))`).Scan(&locked); err != nil {
		return Operation{}, false, fmt.Errorf("acquire deployment lock: %w", err)
	}
	if !locked {
		return Operation{}, false, ErrOperationLocked
	}
	var existing Operation
	if err := scanOperation(tx.QueryRow(ctx, `
		SELECT id, kind, status, COALESCE(candidate_id, ''), COALESCE(slot, ''), COALESCE(target_operation_id, ''), expected_fingerprint, error_code, error_message, created_at, started_at, finished_at, updated_at
		FROM deployment_operations WHERE actor_user_id = $1 AND idempotency_key = $2
	`, principal.UserID, idempotencyKey), &existing); err == nil {
		var storedHash string
		if err := tx.QueryRow(ctx, `SELECT request_hash FROM deployment_operations WHERE id = $1`, existing.ID).Scan(&storedHash); err != nil {
			return Operation{}, false, fmt.Errorf("load idempotent deployment request hash: %w", err)
		}
		if storedHash != requestHash {
			return Operation{}, false, ErrIdempotencyConflict
		}
		return existing, false, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Operation{}, false, fmt.Errorf("check idempotent deployment operation: %w", err)
	}
	if request.CandidateID != "" {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM deployment_candidates WHERE id = $1)`, request.CandidateID).Scan(&exists); err != nil {
			return Operation{}, false, fmt.Errorf("check deployment candidate: %w", err)
		}
		if !exists {
			return Operation{}, false, auth.ErrNotFound
		}
	}
	if requiresFingerprint(kind) || request.ExpectedFingerprint != "" {
		var current string
		if err := tx.QueryRow(ctx, `SELECT active_fingerprint FROM deployment_installations WHERE id = 'default'`).Scan(&current); err != nil {
			return Operation{}, false, fmt.Errorf("load deployment fingerprint: %w", err)
		}
		if current != request.ExpectedFingerprint {
			return Operation{}, false, ErrStaleFingerprint
		}
	}
	var activeOperationID string
	if err := tx.QueryRow(ctx, `
		SELECT active_operation_id FROM deployment_installations WHERE id = 'default' FOR UPDATE
	`).Scan(&activeOperationID); err != nil {
		return Operation{}, false, fmt.Errorf("load active deployment operation: %w", err)
	}
	if activeOperationID != "" {
		var activeKind, activeStatus, activeTargetOperationID, activeTargetStatus string
		if err := tx.QueryRow(ctx, `
			SELECT operation.kind, operation.status, COALESCE(operation.target_operation_id, ''), COALESCE(target.status, '')
			FROM deployment_operations AS operation
			LEFT JOIN deployment_operations AS target ON target.id = operation.target_operation_id
			WHERE operation.id = $1
		`, activeOperationID).Scan(&activeKind, &activeStatus, &activeTargetOperationID, &activeTargetStatus); err != nil {
			return Operation{}, false, fmt.Errorf("load active deployment operation status: %w", err)
		}
		canReconcileActive := kind == "reconcile" &&
			((activeStatus == "unknown" && request.OperationID == activeOperationID) ||
				(activeKind == "reconcile" && activeTargetOperationID == request.OperationID && activeTargetStatus == "unknown"))
		if !canReconcileActive {
			return Operation{}, false, ErrOperationLocked
		}
	}
	var operation Operation
	var inserted bool
	err = tx.QueryRow(ctx, `
		INSERT INTO deployment_operations (id, kind, candidate_id, slot, target_operation_id, actor_user_id, actor_credential_id, idempotency_key, request_hash, expected_fingerprint)
		VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, $7, $8, $9, $10)
		ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
		RETURNING id, kind, status, COALESCE(candidate_id, ''), COALESCE(slot, ''), COALESCE(target_operation_id, ''), expected_fingerprint, error_code, error_message, created_at, started_at, finished_at, updated_at
	`, operationID, kind, request.CandidateID, request.Slot, request.OperationID, principal.UserID, principal.CredentialID, idempotencyKey, requestHash, request.ExpectedFingerprint).Scan(&operation.ID, &operation.Kind, &operation.Status, &operation.CandidateID, &operation.Slot, &operation.TargetOperationID, &operation.ExpectedFingerprint, &operation.ErrorCode, &operation.ErrorMessage, &operation.CreatedAt, &operation.StartedAt, &operation.FinishedAt, &operation.UpdatedAt)
	if err == nil {
		inserted = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Operation{}, false, fmt.Errorf("create deployment operation: %w", err)
	}
	if !inserted {
		if err := scanOperation(tx.QueryRow(ctx, `
			SELECT id, kind, status, COALESCE(candidate_id, ''), COALESCE(slot, ''), COALESCE(target_operation_id, ''), expected_fingerprint, error_code, error_message, created_at, started_at, finished_at, updated_at
			FROM deployment_operations WHERE actor_user_id = $1 AND idempotency_key = $2
		`, principal.UserID, idempotencyKey), &operation); err != nil {
			return Operation{}, false, fmt.Errorf("load idempotent deployment operation: %w", err)
		}
		var operationHash string
		if hashErr := tx.QueryRow(ctx, `SELECT request_hash FROM deployment_operations WHERE id = $1`, operation.ID).Scan(&operationHash); hashErr != nil {
			return Operation{}, false, fmt.Errorf("load deployment request hash: %w", hashErr)
		} else if operationHash != requestHash {
			return Operation{}, false, ErrIdempotencyConflict
		}
		return operation, false, nil
	}
	if err := appendEventTx(ctx, tx, principal, operation, kind+"_accepted", nil); err != nil {
		return Operation{}, false, fmt.Errorf("record deployment acceptance: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE deployment_installations SET active_operation_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 'default'`, operation.ID); err != nil {
		return Operation{}, false, fmt.Errorf("claim deployment operation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Operation{}, false, fmt.Errorf("commit deployment operation: %w", err)
	}
	go func() {
		if err := s.execute(context.Background(), principal, operation); err != nil {
			s.logger.Error("deployment operation finalization failed", "operation_id", operation.ID, "error", err)
		}
	}()
	return operation, true, nil
}

// RecoverPending marks operations whose executor response could have been lost
// while the controller was stopped as unknown. A later reconcile must prove the
// external state before the original operation is allowed to become succeeded.
func (s *Service) RecoverPending(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `
		SELECT id, kind, status, COALESCE(candidate_id, ''), COALESCE(slot, ''), COALESCE(target_operation_id, ''), expected_fingerprint, error_code, error_message, created_at, started_at, finished_at, updated_at
		FROM deployment_operations
		WHERE status IN ('accepted', 'running', 'reconciling')
		ORDER BY created_at, id
	`)
	if err != nil {
		return fmt.Errorf("list pending deployment operations: %w", err)
	}
	var pending []Operation
	controller := auth.Principal{UserID: "deployment-controller"}
	for rows.Next() {
		var operation Operation
		if err := rows.Scan(&operation.ID, &operation.Kind, &operation.Status, &operation.CandidateID, &operation.Slot, &operation.TargetOperationID, &operation.ExpectedFingerprint, &operation.ErrorCode, &operation.ErrorMessage, &operation.CreatedAt, &operation.StartedAt, &operation.FinishedAt, &operation.UpdatedAt); err != nil {
			return fmt.Errorf("scan pending deployment operation: %w", err)
		}
		pending = append(pending, operation)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("read pending deployment operations: %w", err)
	}
	rows.Close()
	var recoveryErr error
	for _, operation := range pending {
		recoveryErr = errors.Join(recoveryErr, s.finishOperation(ctx, controller, operation, "unknown", "controller_restarted", "controller restarted before the operation result was durable", operation.Kind+"_unknown"))
	}
	return recoveryErr
}

func capabilityForKind(kind string) Capability {
	switch kind {
	case "preflight":
		return CapabilityPreflight
	case "stage":
		return CapabilityStage
	case "promote":
		return CapabilityPromote
	case "rollback":
		return CapabilityRollback
	case "drain":
		return CapabilityDrain
	case "reconcile":
		return CapabilityReconcile
	default:
		return ""
	}
}

func requiresFingerprint(kind string) bool {
	switch kind {
	case "stage", "promote", "rollback", "drain", "reconcile":
		return true
	default:
		return false
	}
}

func newOperationID() (string, error) {
	value := make([]byte, 12)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate deployment operation id: %w", err)
	}
	return "deploy-" + hex.EncodeToString(value), nil
}

func (s *Service) execute(ctx context.Context, principal auth.Principal, operation Operation) error {
	prepared, err := s.prepareOperation(ctx, operation)
	if err != nil {
		return s.finishOperation(ctx, principal, operation, "failed", "preparation_failed", err.Error(), operation.Kind+"_failed")
	}
	operation = prepared
	started := s.now()
	if _, err := s.pool.Exec(ctx, `UPDATE deployment_operations SET status = 'running', started_at = $2, updated_at = $2 WHERE id = $1`, operation.ID, started); err != nil {
		return s.finishOperation(ctx, principal, operation, "unknown", "state_commit_failed", err.Error(), operation.Kind+"_unknown")
	}
	if err := s.appendEvent(ctx, principal, operation, operation.Kind+"_started", nil); err != nil {
		return s.finishOperation(ctx, principal, operation, "unknown", "audit_failed", err.Error(), operation.Kind+"_unknown")
	}
	if err := s.executor.Execute(ctx, operation); err != nil {
		status, code := "failed", "executor_failed"
		var degraded *DegradedError
		if errors.As(err, &degraded) {
			if applyErr := s.applySuccess(ctx, principal, operation); applyErr != nil {
				return s.finishOperation(ctx, principal, operation, "unknown", "state_commit_failed", applyErr.Error(), operation.Kind+"_unknown")
			}
			return s.finishOperation(ctx, principal, operation, "degraded", "drain_timeout", err.Error(), operation.Kind+"_degraded")
		}
		var deterministic *DeterministicError
		if !errors.As(err, &deterministic) && operation.Kind != "preflight" {
			status, code = "unknown", "unknown_outcome"
		}
		if deterministic != nil && deterministic.RecoveredWorkerGeneration > 0 {
			if recoveryErr := s.recordRecoveredWorker(ctx, operation, deterministic.RecoveredWorkerGeneration); recoveryErr != nil {
				return s.finishOperation(ctx, principal, operation, "unknown", "state_commit_failed", recoveryErr.Error(), operation.Kind+"_unknown")
			}
		}
		if status != "unknown" {
			if failureErr := s.markFailure(ctx, operation); failureErr != nil {
				err = errors.Join(err, failureErr)
			}
		}
		return s.finishOperation(ctx, principal, operation, status, code, err.Error(), operation.Kind+"_"+status)
	}
	if err := s.applySuccess(ctx, principal, operation); err != nil {
		return s.finishOperation(ctx, principal, operation, "unknown", "state_commit_failed", err.Error(), operation.Kind+"_unknown")
	}
	return s.finishOperation(ctx, principal, operation, "succeeded", "", "", operation.Kind+"_succeeded")
}

func (s *Service) prepareOperation(ctx context.Context, operation Operation) (Operation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Operation{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtext('loomhelm:deployment-control'))`).Scan(&locked); err != nil {
		return Operation{}, err
	}
	if !locked {
		return Operation{}, ErrOperationLocked
	}
	var activeSlot, activeCandidateID string
	var nextGeneration int64
	if err := tx.QueryRow(ctx, `SELECT active_slot, active_candidate_id, next_worker_generation FROM deployment_installations WHERE id = 'default'`).Scan(&activeSlot, &activeCandidateID, &nextGeneration); err != nil {
		return Operation{}, err
	}
	if activeSlot != "" {
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(s.candidate_id, ''), COALESCE(s.worker_generation, 0),
			       COALESCE(c.source_sha, ''), COALESCE(c.artifact_digest, ''),
			       COALESCE(c.server_image, ''), COALESCE(c.worker_image, '')
			FROM deployment_slots AS s
			LEFT JOIN deployment_candidates AS c ON c.id = s.candidate_id
			WHERE s.slot = $1
		`, activeSlot).Scan(&operation.RetiringCandidateID, &operation.RetiringWorkerGeneration, &operation.RetiringCandidateSourceSHA, &operation.RetiringArtifactDigest, &operation.RetiringServerImage, &operation.RetiringWorkerImage); err != nil {
			return Operation{}, fmt.Errorf("load retiring Worker identity: %w", err)
		}
	}
	if operation.TargetOperationID != "" {
		var target Operation
		if err := scanOperation(tx.QueryRow(ctx, `
			SELECT id, kind, status, COALESCE(candidate_id, ''), COALESCE(slot, ''), COALESCE(target_operation_id, ''), expected_fingerprint, error_code, error_message, created_at, started_at, finished_at, updated_at
			FROM deployment_operations WHERE id = $1
		`, operation.TargetOperationID), &target); err != nil {
			return Operation{}, fmt.Errorf("load reconcile target operation: %w", err)
		}
		if target.Status != "unknown" && target.Status != "accepted" && target.Status != "running" && target.Status != "reconciling" {
			return Operation{}, fmt.Errorf("%w: operation %s is not awaiting reconciliation", auth.ErrConflict, target.ID)
		}
		operation.CandidateID = target.CandidateID
		operation.Slot = target.Slot
		operation.ExecutionKind = target.Kind
		operation.ExpectedFingerprint = target.ExpectedFingerprint
	}
	if operation.CandidateID != "" {
		if err := tx.QueryRow(ctx, `
			SELECT source_sha, artifact_digest, web_digest, server_image, worker_image
			FROM deployment_candidates WHERE id = $1
		`, operation.CandidateID).Scan(&operation.CandidateSourceSHA, &operation.ArtifactDigest, &operation.WebDigest, &operation.ServerImage, &operation.WorkerImage); err != nil {
			return Operation{}, fmt.Errorf("load deployment candidate identity: %w", err)
		}
		if operation.Kind != "reconcile" {
			if err := validateCandidateCompatibilityTx(ctx, tx, operation.CandidateID); err != nil {
				return Operation{}, err
			}
		}
	}
	operation.RetiringSlot = activeSlot
	if operation.Kind == "preflight" && operation.Slot == "" {
		if activeSlot == "blue" {
			operation.Slot = "green"
		} else {
			operation.Slot = "blue"
		}
	}
	retainedCandidates := make(map[string]struct{})
	if activeCandidateID != "" && activeCandidateID != operation.CandidateID {
		retainedCandidates[activeCandidateID] = struct{}{}
		operation.RetainedCandidates = append(operation.RetainedCandidates, activeCandidateID)
	}
	rows, err := tx.Query(ctx, `SELECT candidate_id FROM deployment_slots WHERE state = 'retained' AND candidate_id IS NOT NULL ORDER BY updated_at DESC`)
	if err != nil {
		return Operation{}, err
	}
	for rows.Next() {
		var candidateID string
		if err := rows.Scan(&candidateID); err != nil {
			rows.Close()
			return Operation{}, err
		}
		if _, exists := retainedCandidates[candidateID]; !exists && candidateID != operation.CandidateID {
			retainedCandidates[candidateID] = struct{}{}
			operation.RetainedCandidates = append(operation.RetainedCandidates, candidateID)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Operation{}, err
	}
	rows.Close()
	stageKind := operation.Kind == "stage" || (operation.Kind == "reconcile" && operation.ExecutionKind == "stage")
	if stageKind {
		slot := operation.Slot
		if slot == "" {
			if activeSlot == "blue" {
				slot = "green"
			} else {
				slot = "blue"
			}
		}
		if slot == activeSlot || (slot != "blue" && slot != "green") {
			return Operation{}, fmt.Errorf("%w: stage target must be the inactive slot", auth.ErrConflict)
		}
		var slotState, slotCandidate string
		var slotGeneration *int64
		if err := tx.QueryRow(ctx, `SELECT state, COALESCE(candidate_id, ''), worker_generation FROM deployment_slots WHERE slot = $1 FOR UPDATE`, slot).Scan(&slotState, &slotCandidate, &slotGeneration); err != nil {
			return Operation{}, err
		}
		if slotState == "staging" && slotCandidate == operation.CandidateID && slotGeneration != nil && *slotGeneration > 0 {
			operation.WorkerGeneration = *slotGeneration
		} else {
			if _, err := tx.Exec(ctx, `UPDATE deployment_slots SET state = 'staging', candidate_id = $2, worker_generation = $3, updated_at = CURRENT_TIMESTAMP WHERE slot = $1`, slot, operation.CandidateID, nextGeneration); err != nil {
				return Operation{}, err
			}
			if _, err := tx.Exec(ctx, `UPDATE deployment_installations SET next_worker_generation = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 'default'`, nextGeneration+1); err != nil {
				return Operation{}, err
			}
			operation.WorkerGeneration = nextGeneration
		}
		if operation.TargetOperationID != "" {
			if _, err := tx.Exec(ctx, `UPDATE deployment_operations SET slot = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND slot = ''`, operation.TargetOperationID, slot); err != nil {
				return Operation{}, err
			}
		}
		operation.Slot = slot
	}
	if operation.Kind == "promote" || operation.Kind == "rollback" || (operation.Kind == "reconcile" && (operation.ExecutionKind == "promote" || operation.ExecutionKind == "rollback")) {
		reconcileRollback := operation.Kind == "reconcile" && operation.ExecutionKind == "rollback"
		wantState := "staged"
		if operation.Kind == "rollback" || operation.ExecutionKind == "rollback" {
			wantState = "retained"
		}
		if reconcileRollback && operation.Slot != "" {
			wantState = "staging"
		}
		if operation.Slot == "" {
			lookupState := wantState
			if reconcileRollback {
				lookupState = "retained"
			}
			if err := tx.QueryRow(ctx, `SELECT slot FROM deployment_slots WHERE candidate_id = $1 AND state = $2 ORDER BY slot LIMIT 1`, operation.CandidateID, lookupState).Scan(&operation.Slot); err != nil {
				return Operation{}, fmt.Errorf("find %s candidate slot: %w", operation.Kind, err)
			}
		}
		if operation.Slot != "blue" && operation.Slot != "green" {
			return Operation{}, fmt.Errorf("%w: deployment slot must be blue or green", auth.ErrInvalid)
		}
		if operation.Slot == activeSlot {
			return Operation{}, fmt.Errorf("%w: deployment slot is already active", auth.ErrConflict)
		}
		var slotState, slotCandidate string
		if err := tx.QueryRow(ctx, `SELECT state, COALESCE(candidate_id, '') FROM deployment_slots WHERE slot = $1`, operation.Slot).Scan(&slotState, &slotCandidate); err != nil {
			return Operation{}, err
		}
		if slotCandidate != operation.CandidateID || (slotState != wantState && !(reconcileRollback && slotState == "retained")) {
			return Operation{}, fmt.Errorf("%w: candidate is not in the required %s slot state", auth.ErrConflict, wantState)
		}
		if err := tx.QueryRow(ctx, `SELECT COALESCE(worker_generation, 0) FROM deployment_slots WHERE slot = $1`, operation.Slot).Scan(&operation.WorkerGeneration); err != nil {
			return Operation{}, err
		}
		if operation.Kind == "rollback" || (reconcileRollback && slotState == "retained") {
			if _, err := tx.Exec(ctx, `UPDATE deployment_slots SET state = 'staging', worker_generation = $2, updated_at = CURRENT_TIMESTAMP WHERE slot = $1`, operation.Slot, nextGeneration); err != nil {
				return Operation{}, err
			}
			if _, err := tx.Exec(ctx, `UPDATE deployment_installations SET next_worker_generation = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 'default'`, nextGeneration+1); err != nil {
				return Operation{}, err
			}
			operation.WorkerGeneration = nextGeneration
		}
		if operation.TargetOperationID != "" && operation.Slot != "" {
			if _, err := tx.Exec(ctx, `UPDATE deployment_operations SET slot = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND slot = ''`, operation.TargetOperationID, operation.Slot); err != nil {
				return Operation{}, err
			}
		}
	}
	drainKind := operation.Kind == "drain" || (operation.Kind == "reconcile" && operation.ExecutionKind == "drain")
	if drainKind && operation.Slot == "" {
		operation.Slot = activeSlot
		if operation.Slot == "" {
			return Operation{}, fmt.Errorf("%w: no active slot is available to drain", auth.ErrConflict)
		}
	}
	if operation.Slot != "" && operation.Slot != "blue" && operation.Slot != "green" {
		return Operation{}, fmt.Errorf("%w: deployment slot must be blue or green", auth.ErrInvalid)
	}
	if drainKind {
		var slotState string
		if err := tx.QueryRow(ctx, `SELECT state FROM deployment_slots WHERE slot = $1 FOR UPDATE`, operation.Slot).Scan(&slotState); err != nil {
			return Operation{}, err
		}
		if slotState != "active" && slotState != "draining" && slotState != "retained" {
			return Operation{}, fmt.Errorf("%w: slot %s is not active, draining, or retained", auth.ErrConflict, operation.Slot)
		}
	}
	if operation.Slot != "" {
		if _, err := tx.Exec(ctx, `UPDATE deployment_operations SET slot = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, operation.ID, operation.Slot); err != nil {
			return Operation{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Operation{}, err
	}
	return operation, nil
}

func validateCandidateCompatibilityTx(ctx context.Context, tx pgx.Tx, candidateID string) error {
	var stateVersion, readMin, readMax int64
	var migrationMode, activeCandidateID string
	if err := tx.QueryRow(ctx, `
		SELECT c.state_version, c.read_min, c.read_max, c.migration_mode, i.active_candidate_id
		FROM deployment_candidates AS c CROSS JOIN deployment_installations AS i
		WHERE c.id = $1 AND i.id = 'default'
	`, candidateID).Scan(&stateVersion, &readMin, &readMax, &migrationMode, &activeCandidateID); err != nil {
		return fmt.Errorf("load deployment compatibility: %w", err)
	}
	if activeCandidateID == "" || activeCandidateID == candidateID {
		return nil
	}
	var currentStateVersion, currentReadMin, currentReadMax int64
	if err := tx.QueryRow(ctx, `
		SELECT state_version, read_min, read_max
		FROM deployment_candidates WHERE id = $1
	`, activeCandidateID).Scan(&currentStateVersion, &currentReadMin, &currentReadMax); err != nil {
		return fmt.Errorf("load active deployment compatibility: %w", err)
	}
	if currentStateVersion < readMin || currentStateVersion > readMax || stateVersion < currentReadMin || stateVersion > currentReadMax {
		return fmt.Errorf("%w: candidate compatibility range is not two-way with the active release", auth.ErrConflict)
	}
	if migrationMode == "none" && stateVersion != currentStateVersion {
		return fmt.Errorf("%w: migration_mode none requires the same state version", auth.ErrConflict)
	}
	return nil
}

func (s *Service) applySuccess(ctx context.Context, principal auth.Principal, operation Operation) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtext('loomhelm:deployment-control'))`).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return ErrOperationLocked
	}
	switch operation.Kind {
	case "preflight":
		_, err = tx.Exec(ctx, `UPDATE deployment_candidates SET status = 'preflight_passed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, operation.CandidateID)
	case "stage":
		_, err = tx.Exec(ctx, `UPDATE deployment_slots SET state = 'staged', updated_at = CURRENT_TIMESTAMP WHERE slot = $1 AND candidate_id = $2`, operation.Slot, operation.CandidateID)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE deployment_candidates SET status = 'staged', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, operation.CandidateID)
		}
	case "promote", "rollback":
		err = s.promoteTx(ctx, tx, operation)
	case "drain":
		_, err = tx.Exec(ctx, `UPDATE deployment_slots SET state = 'draining', updated_at = CURRENT_TIMESTAMP WHERE slot = $1`, operation.Slot)
	case "reconcile":
		err = s.reconcileTargetTx(ctx, tx, principal, operation)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) reconcileTargetTx(ctx context.Context, tx pgx.Tx, principal auth.Principal, operation Operation) error {
	if operation.TargetOperationID == "" {
		return fmt.Errorf("%w: reconcile target is required", auth.ErrInvalid)
	}
	var target Operation
	if err := scanOperation(tx.QueryRow(ctx, `
		SELECT id, kind, status, COALESCE(candidate_id, ''), COALESCE(slot, ''), COALESCE(target_operation_id, ''), expected_fingerprint, error_code, error_message, created_at, started_at, finished_at, updated_at
		FROM deployment_operations WHERE id = $1 FOR UPDATE
	`, operation.TargetOperationID), &target); err != nil {
		return fmt.Errorf("load reconcile target: %w", err)
	}
	if operation.ExecutionKind == "" {
		operation.ExecutionKind = target.Kind
	}
	switch target.Kind {
	case "preflight":
		_, err := tx.Exec(ctx, `UPDATE deployment_candidates SET status = 'preflight_passed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, target.CandidateID)
		if err != nil {
			return err
		}
	case "stage":
		if _, err := tx.Exec(ctx, `UPDATE deployment_slots SET state = 'staged', updated_at = CURRENT_TIMESTAMP WHERE slot = $1 AND candidate_id = $2`, target.Slot, target.CandidateID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE deployment_candidates SET status = 'staged', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, target.CandidateID); err != nil {
			return err
		}
	case "promote", "rollback":
		if err := s.promoteTx(ctx, tx, target); err != nil {
			return err
		}
	case "drain":
		if _, err := tx.Exec(ctx, `UPDATE deployment_slots SET state = 'draining', updated_at = CURRENT_TIMESTAMP WHERE slot = $1`, target.Slot); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%w: unsupported reconcile target kind %q", auth.ErrInvalid, target.Kind)
	}
	finished := s.now()
	_, err := tx.Exec(ctx, `
		UPDATE deployment_operations
		SET status = 'succeeded', error_code = '', error_message = '', finished_at = $2, updated_at = $2
		WHERE id = $1
	`, target.ID, finished)
	if err != nil {
		return err
	}
	target.Status = "succeeded"
	target.ErrorCode = ""
	target.ErrorMessage = ""
	target.FinishedAt = &finished
	target.UpdatedAt = finished
	if err := tx.QueryRow(ctx, `SELECT active_fingerprint FROM deployment_installations WHERE id = 'default'`).Scan(&target.ObservedFingerprint); err != nil {
		return fmt.Errorf("observe reconciled deployment fingerprint: %w", err)
	}
	if target.Slot != "" {
		var generation *int64
		if err := tx.QueryRow(ctx, `SELECT worker_generation FROM deployment_slots WHERE slot = $1`, target.Slot).Scan(&generation); err != nil {
			return fmt.Errorf("observe reconciled Worker generation: %w", err)
		}
		if generation != nil {
			target.WorkerGeneration = *generation
		}
	}
	if err := appendEventTx(ctx, tx, principal, target, target.Kind+"_succeeded", map[string]any{"reconciled_by": operation.ID}); err != nil {
		return fmt.Errorf("record reconciled operation result: %w", err)
	}
	return nil
}

func (s *Service) promoteTx(ctx context.Context, tx pgx.Tx, operation Operation) error {
	slot := operation.Slot
	if slot == "" {
		return fmt.Errorf("%w: deployment slot is required", auth.ErrInvalid)
	}
	var candidateID, sourceSHA, artifactDigest, webDigest, migrationMode, slotState string
	var stateVersion, readMin, readMax, workerGeneration int64
	if err := tx.QueryRow(ctx, `
		SELECT c.id, c.source_sha, c.artifact_digest, c.web_digest, c.state_version, c.read_min, c.read_max, c.migration_mode, s.state, s.worker_generation
		FROM deployment_candidates AS c JOIN deployment_slots AS s ON s.candidate_id = c.id
		WHERE c.id = $1 AND s.slot = $2
	`, operation.CandidateID, slot).Scan(&candidateID, &sourceSHA, &artifactDigest, &webDigest, &stateVersion, &readMin, &readMax, &migrationMode, &slotState, &workerGeneration); err != nil {
		return err
	}
	if candidateID != operation.CandidateID {
		return ErrInvalidCandidate
	}
	var activeSlot, activeCandidateID string
	if err := tx.QueryRow(ctx, `SELECT active_slot, active_candidate_id FROM deployment_installations WHERE id = 'default'`).Scan(&activeSlot, &activeCandidateID); err != nil {
		return err
	}
	if activeCandidateID != "" {
		var currentStateVersion, currentReadMin, currentReadMax int64
		if err := tx.QueryRow(ctx, `
			SELECT state_version, read_min, read_max
			FROM deployment_candidates WHERE id = $1
		`, activeCandidateID).Scan(&currentStateVersion, &currentReadMin, &currentReadMax); err != nil {
			return fmt.Errorf("load active deployment compatibility: %w", err)
		}
		if currentStateVersion < readMin || currentStateVersion > readMax || stateVersion < currentReadMin || stateVersion > currentReadMax {
			return fmt.Errorf("%w: candidate compatibility range is not two-way with the active release", auth.ErrConflict)
		}
		if migrationMode == "none" && stateVersion != currentStateVersion {
			return fmt.Errorf("%w: migration_mode none requires the same state version", auth.ErrConflict)
		}
	}
	if activeSlot == slot {
		return fmt.Errorf("%w: deployment slot is already active", auth.ErrConflict)
	}
	wantState := "staged"
	if operation.Kind == "rollback" {
		wantState = "staging"
	}
	if slotState != wantState || workerGeneration <= 0 {
		return fmt.Errorf("%w: candidate slot is not ready for %s", auth.ErrConflict, operation.Kind)
	}
	if _, err := tx.Exec(ctx, `UPDATE deployment_slots SET state = 'retained', updated_at = CURRENT_TIMESTAMP WHERE slot = $1 AND slot <> ''`, activeSlot); err != nil {
		return err
	}
	if activeSlot != "" {
		if _, err := tx.Exec(ctx, `UPDATE deployment_candidates SET status = 'retained', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT candidate_id FROM deployment_slots WHERE slot = $1) AND id <> $2`, activeSlot, operation.CandidateID); err != nil {
			return err
		}
	}
	fingerprint := fingerprintForCandidate(candidateID, sourceSHA, artifactDigest, webDigest, stateVersion, readMin, readMax, migrationMode, slot, workerGeneration)
	if _, err := tx.Exec(ctx, `UPDATE deployment_slots SET state = 'active', candidate_id = $2, updated_at = CURRENT_TIMESTAMP WHERE slot = $1`, slot, operation.CandidateID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE deployment_candidates SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, operation.CandidateID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE deployment_installations SET active_slot = $1, active_candidate_id = $2, active_fingerprint = $3, updated_at = CURRENT_TIMESTAMP WHERE id = 'default'`, slot, operation.CandidateID, fingerprint)
	return err
}

func (s *Service) markFailure(ctx context.Context, operation Operation) error {
	if (operation.Kind != "stage" && operation.Kind != "promote" && operation.Kind != "rollback") || operation.Slot == "" {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE deployment_slots SET state = 'failed', updated_at = CURRENT_TIMESTAMP WHERE slot = $1 AND candidate_id = $2`, operation.Slot, operation.CandidateID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE deployment_candidates SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, operation.CandidateID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) recordRecoveredWorker(ctx context.Context, operation Operation, generation int64) error {
	if operation.RetiringSlot == "" || operation.RetiringCandidateID == "" || generation <= 0 {
		return fmt.Errorf("recovered Worker identity is incomplete")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtext('loomhelm:deployment-control'))`).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return ErrOperationLocked
	}
	var updated int64
	if err := tx.QueryRow(ctx, `
		UPDATE deployment_slots
		SET worker_generation = $3, updated_at = CURRENT_TIMESTAMP
		WHERE slot = $1 AND state = 'active' AND candidate_id = $2
		RETURNING worker_generation
	`, operation.RetiringSlot, operation.RetiringCandidateID, generation).Scan(&updated); err != nil {
		return fmt.Errorf("record recovered Worker generation: %w", err)
	}
	if updated != generation {
		return fmt.Errorf("recorded Worker generation %d does not match %d", updated, generation)
	}
	if _, err := tx.Exec(ctx, `UPDATE deployment_installations SET next_worker_generation = GREATEST(next_worker_generation, $1), updated_at = CURRENT_TIMESTAMP WHERE id = 'default'`, generation+1); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) finishOperation(ctx context.Context, principal auth.Principal, operation Operation, status, code, _ string, eventType string) error {
	finished := s.now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	safeMessage := safeOperationMessage(code)
	if _, err := tx.Exec(ctx, `UPDATE deployment_operations SET status = $2, error_code = $3, error_message = $4, finished_at = $5, updated_at = $5 WHERE id = $1`, operation.ID, status, code, safeMessage, finished); err != nil {
		return err
	}
	if status == "unknown" {
		if _, err := tx.Exec(ctx, `UPDATE deployment_candidates SET status = 'unknown', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND $2 IN ('stage', 'promote', 'rollback')`, operation.CandidateID, operation.Kind); err != nil {
			return err
		}
	}
	operation.Status = status
	operation.ErrorCode = code
	operation.ErrorMessage = safeMessage
	operation.FinishedAt = &finished
	operation.UpdatedAt = finished
	var observedFingerprint string
	if err := tx.QueryRow(ctx, `SELECT active_fingerprint FROM deployment_installations WHERE id = 'default'`).Scan(&observedFingerprint); err == nil {
		operation.ObservedFingerprint = observedFingerprint
	}
	details := map[string]any{}
	if code != "" {
		details["error_code"] = code
	}
	if err := appendEventTx(ctx, tx, principal, operation, eventType, details); err != nil {
		return err
	}
	retainActiveOperation := status == "unknown"
	if !retainActiveOperation && operation.Kind == "reconcile" && operation.TargetOperationID != "" {
		var targetStatus string
		err := tx.QueryRow(ctx, `SELECT status FROM deployment_operations WHERE id = $1`, operation.TargetOperationID).Scan(&targetStatus)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("load reconciled target status: %w", err)
		}
		retainActiveOperation = err == nil && targetStatus == "unknown"
	}
	if _, err := tx.Exec(ctx, `
		UPDATE deployment_installations
		SET active_operation_id = CASE WHEN $2 THEN active_operation_id ELSE '' END,
		    updated_at = CURRENT_TIMESTAMP
		WHERE id = 'default' AND active_operation_id = $1
	`, operation.ID, retainActiveOperation); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func safeOperationMessage(code string) string {
	switch code {
	case "":
		return ""
	case "drain_timeout":
		return "deployment drain timed out"
	case "controller_restarted":
		return "controller restarted before the operation result was durable; reconcile is required"
	case "unknown_outcome":
		return "external deployment result is unknown; reconcile is required"
	case "state_commit_failed":
		return "deployment state commit failed; reconcile is required"
	case "audit_failed":
		return "deployment audit failed; reconcile is required"
	case "preparation_failed":
		return "deployment preparation failed"
	case "executor_failed":
		return "deployment executor failed"
	default:
		return "deployment operation failed with code " + code
	}
}

func fingerprintForCandidate(candidateID, sourceSHA, artifactDigest, webDigest string, stateVersion, readMin, readMax int64, migrationMode, slot string, workerGeneration int64) string {
	identity := fmt.Sprintf("%s:%s:%s:%s:%d:%d:%d:%s:%s:%d", candidateID, sourceSHA, artifactDigest, webDigest, stateVersion, readMin, readMax, migrationMode, slot, workerGeneration)
	digest := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(digest[:])
}

func (s *Service) operationHash(ctx context.Context, operationID string) (string, error) {
	var hash string
	if err := s.pool.QueryRow(ctx, `SELECT request_hash FROM deployment_operations WHERE id = $1`, operationID).Scan(&hash); err != nil {
		return "", fmt.Errorf("load deployment request hash: %w", err)
	}
	return hash, nil
}

func (s *Service) appendEvent(ctx context.Context, principal auth.Principal, operation Operation, eventType string, details map[string]any) error {
	payload, err := json.Marshal(details)
	if err != nil {
		return err
	}
	observedFingerprint := operation.ObservedFingerprint
	if observedFingerprint == "" {
		observedFingerprint = operation.ExpectedFingerprint
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO deployment_events (operation_id, actor_user_id, type, candidate_id, slot, worker_generation, observed_fingerprint, details)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, 0), $7, $8::jsonb)
	`, operation.ID, principal.UserID, eventType, operation.CandidateID, operation.Slot, operation.WorkerGeneration, observedFingerprint, payload)
	return err
}

func appendEventTx(ctx context.Context, tx pgx.Tx, principal auth.Principal, operation Operation, eventType string, details map[string]any) error {
	payload, err := json.Marshal(details)
	if err != nil {
		return err
	}
	observedFingerprint := operation.ObservedFingerprint
	if observedFingerprint == "" {
		observedFingerprint = operation.ExpectedFingerprint
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO deployment_events (operation_id, actor_user_id, type, candidate_id, slot, worker_generation, observed_fingerprint, details)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, 0), $7, $8::jsonb)
	`, operation.ID, principal.UserID, eventType, operation.CandidateID, operation.Slot, operation.WorkerGeneration, observedFingerprint, payload)
	return err
}

func scanOperation(row pgx.Row, operation *Operation) error {
	return row.Scan(&operation.ID, &operation.Kind, &operation.Status, &operation.CandidateID, &operation.Slot, &operation.TargetOperationID, &operation.ExpectedFingerprint, &operation.ErrorCode, &operation.ErrorMessage, &operation.CreatedAt, &operation.StartedAt, &operation.FinishedAt, &operation.UpdatedAt)
}
