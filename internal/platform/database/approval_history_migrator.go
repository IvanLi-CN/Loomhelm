package database

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const approvalHistoryMigrationKey = "approval-revision-history"

type ApprovalHistoryMigrationPhase string

const (
	ApprovalHistoryPhaseStructureReady   ApprovalHistoryMigrationPhase = "structure_ready"
	ApprovalHistoryPhaseBackfillRunning  ApprovalHistoryMigrationPhase = "backfill_running"
	ApprovalHistoryPhaseBackfillPaused   ApprovalHistoryMigrationPhase = "backfill_paused"
	ApprovalHistoryPhaseBackfillComplete ApprovalHistoryMigrationPhase = "backfill_complete"
	ApprovalHistoryPhaseFailed           ApprovalHistoryMigrationPhase = "failed"
	ApprovalHistoryPhaseValidated        ApprovalHistoryMigrationPhase = "validated"
	ApprovalHistoryPhaseIndexesReady     ApprovalHistoryMigrationPhase = "indexes_ready"
	ApprovalHistoryPhaseCutoverRequested ApprovalHistoryMigrationPhase = "cutover_requested"
	ApprovalHistoryPhaseCutoverComplete  ApprovalHistoryMigrationPhase = "cutover_complete"
	ApprovalHistoryPhaseRepairRequired   ApprovalHistoryMigrationPhase = "repair_required"
)

var (
	ErrApprovalHistoryMigrationUnavailable = errors.New("approval history migration is unavailable")
	ErrApprovalHistoryMigrationBusy        = errors.New("approval history migration is leased by another operation")
	ErrApprovalHistoryMigrationBudget      = errors.New("approval history migration work budget exceeded")
	ErrApprovalHistoryMigrationNotReady    = errors.New("approval history migration is not ready for this operation")
	ErrApprovalHistoryAtomicAdoption       = errors.New("atomic approval history migration layout is not recognized")
)

type ApprovalHistoryMigrationOptions struct {
	BatchSize          int
	WorkBudget         int64
	PreDrainBatchSize  int
	PreDrainWorkBudget int64
	FinalRowBudget     int64
	FinalWorkBudget    int64
	LockTimeout        time.Duration
	StatementTimeout   time.Duration
	LeaseDuration      time.Duration
	LeaseOwner         string
}

type ApprovalHistoryMigratorConfig struct {
	Now        func() time.Time
	LeaseOwner string
}

type ApprovalHistoryMigrationProgress struct {
	Phase               ApprovalHistoryMigrationPhase
	CheckpointID        string
	RowsScanned         int64
	RowsCopied          int64
	DirtyRowsReconciled int64
	DirtyRowsPending    int64
	LastError           string
}

type ApprovalHistoryMigrator struct {
	pool                *pgxpool.Pool
	now                 func() time.Time
	leaseOwner          string
	beforeBackfillClaim func()
}

type approvalHistoryMigrationState struct {
	phase               ApprovalHistoryMigrationPhase
	checkpointID        string
	rowsScanned         int64
	rowsCopied          int64
	dirtyRowsReconciled int64
	leaseOwner          string
	leaseExpiresAt      *time.Time
	lastError           string
}

type approvalHistoryMigrationRow interface {
	Scan(...any) error
}

var approvalHistoryOwnerSequence atomic.Uint64

func NewApprovalHistoryMigrator(pool *pgxpool.Pool, configs ...ApprovalHistoryMigratorConfig) *ApprovalHistoryMigrator {
	now := time.Now
	owner := ""
	if len(configs) > 0 {
		if configs[0].Now != nil {
			now = configs[0].Now
		}
		owner = strings.TrimSpace(configs[0].LeaseOwner)
	}
	if owner == "" {
		owner = fmt.Sprintf("approval-history-%d-%d", os.Getpid(), approvalHistoryOwnerSequence.Add(1))
	}
	return &ApprovalHistoryMigrator{pool: pool, now: now, leaseOwner: owner}
}

func (m *ApprovalHistoryMigrator) Prepare(ctx context.Context) (ApprovalHistoryMigrationProgress, error) {
	if err := m.validate(ctx); err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	if err := m.requireStructuralLayout(ctx); err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	state, err := m.loadState(ctx)
	if err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	if state.phase == ApprovalHistoryPhaseRepairRequired {
		return progressFromState(state), fmt.Errorf("%w: %s", ErrApprovalHistoryMigrationUnavailable, state.lastError)
	}
	return m.progress(ctx)
}

func (m *ApprovalHistoryMigrator) Progress(ctx context.Context) (ApprovalHistoryMigrationProgress, error) {
	if err := m.validate(ctx); err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	return m.progress(ctx)
}

func (m *ApprovalHistoryMigrator) Readiness(ctx context.Context) error {
	if err := m.validate(ctx); err != nil {
		return err
	}
	if err := m.requireHistoryLayout(ctx); err != nil {
		return err
	}
	if !m.writerGuardReady(ctx) {
		return fmt.Errorf("%w: writer guard is not installed", ErrApprovalHistoryMigrationUnavailable)
	}
	if err := m.historyIndexesReady(ctx); err != nil {
		return err
	}
	state, err := m.loadState(ctx)
	if err != nil {
		return err
	}
	if state.phase != ApprovalHistoryPhaseCutoverComplete {
		return fmt.Errorf("%w: phase is %s", ErrApprovalHistoryMigrationUnavailable, state.phase)
	}
	pending, err := m.pendingDirtyRows(ctx)
	if err != nil {
		return err
	}
	if pending != 0 {
		return fmt.Errorf("%w: %d dirty rows remain", ErrApprovalHistoryMigrationUnavailable, pending)
	}
	return nil
}

func (m *ApprovalHistoryMigrator) RunBackfill(ctx context.Context, options ApprovalHistoryMigrationOptions) (ApprovalHistoryMigrationProgress, error) {
	if err := m.validate(ctx); err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	opts := options.normalized(m.leaseOwner)
	state, err := m.loadState(ctx)
	if err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	if state.phase == ApprovalHistoryPhaseCutoverComplete || state.phase == ApprovalHistoryPhaseIndexesReady || state.phase == ApprovalHistoryPhaseValidated {
		return progressFromState(state), nil
	}
	if state.phase == ApprovalHistoryPhaseRepairRequired {
		return progressFromState(state), fmt.Errorf("%w: %s", ErrApprovalHistoryMigrationUnavailable, state.lastError)
	}
	if state.phase != ApprovalHistoryPhaseStructureReady && state.phase != ApprovalHistoryPhaseBackfillRunning && state.phase != ApprovalHistoryPhaseBackfillPaused && state.phase != ApprovalHistoryPhaseBackfillComplete && state.phase != ApprovalHistoryPhaseFailed {
		return progressFromState(state), fmt.Errorf("%w: phase is %s", ErrApprovalHistoryMigrationNotReady, state.phase)
	}

	var processed int64
	for {
		if err := ctx.Err(); err != nil {
			return m.progress(ctx)
		}
		state, err = m.loadState(ctx)
		if err != nil {
			return ApprovalHistoryMigrationProgress{}, err
		}
		switch state.phase {
		case ApprovalHistoryPhaseBackfillComplete, ApprovalHistoryPhaseValidated, ApprovalHistoryPhaseIndexesReady, ApprovalHistoryPhaseCutoverComplete:
			return m.progress(ctx)
		case ApprovalHistoryPhaseCutoverRequested:
			return progressFromState(state), fmt.Errorf("%w: phase is %s", ErrApprovalHistoryMigrationNotReady, state.phase)
		case ApprovalHistoryPhaseRepairRequired:
			return progressFromState(state), fmt.Errorf("%w: %s", ErrApprovalHistoryMigrationUnavailable, state.lastError)
		case ApprovalHistoryPhaseStructureReady, ApprovalHistoryPhaseBackfillRunning, ApprovalHistoryPhaseBackfillPaused, ApprovalHistoryPhaseFailed:
		default:
			return progressFromState(state), fmt.Errorf("%w: phase is %s", ErrApprovalHistoryMigrationNotReady, state.phase)
		}
		if processed >= opts.WorkBudget {
			if err := m.setPhase(ctx, state.phase, ApprovalHistoryPhaseBackfillPaused, ""); err != nil {
				return progressFromState(state), err
			}
			return m.progress(ctx)
		}

		batchSize := opts.BatchSize
		remaining := opts.WorkBudget - processed
		if int64(batchSize) > remaining {
			batchSize = int(remaining)
		}
		if m.beforeBackfillClaim != nil {
			m.beforeBackfillClaim()
		}
		tx, err := m.pool.Begin(ctx)
		if err != nil {
			return progressFromState(state), fmt.Errorf("begin approval history backfill batch: %w", err)
		}
		batchState, err := m.claimLeaseTx(ctx, tx, opts)
		if err != nil {
			_ = tx.Rollback(ctx)
			return progressFromState(state), err
		}
		switch batchState.phase {
		case ApprovalHistoryPhaseBackfillComplete, ApprovalHistoryPhaseValidated, ApprovalHistoryPhaseIndexesReady, ApprovalHistoryPhaseCutoverComplete:
			_ = tx.Rollback(ctx)
			return m.progress(ctx)
		case ApprovalHistoryPhaseCutoverRequested:
			_ = tx.Rollback(ctx)
			return progressFromState(batchState), fmt.Errorf("%w: phase is %s", ErrApprovalHistoryMigrationNotReady, batchState.phase)
		case ApprovalHistoryPhaseRepairRequired:
			_ = tx.Rollback(ctx)
			return progressFromState(batchState), fmt.Errorf("%w: %s", ErrApprovalHistoryMigrationUnavailable, batchState.lastError)
		case ApprovalHistoryPhaseStructureReady, ApprovalHistoryPhaseBackfillRunning, ApprovalHistoryPhaseBackfillPaused, ApprovalHistoryPhaseFailed:
			// The lease claim and this phase check are one transaction. A later
			// operation may have advanced the phase after the caller's initial
			// read; never let that stale caller write a backward transition.
		default:
			_ = tx.Rollback(ctx)
			return progressFromState(batchState), fmt.Errorf("%w: phase is %s", ErrApprovalHistoryMigrationNotReady, batchState.phase)
		}
		if err := setLocalTimeouts(ctx, tx, opts); err != nil {
			_ = tx.Rollback(ctx)
			return progressFromState(batchState), err
		}
		ids, err := selectBackfillIDs(ctx, tx, batchState.checkpointID, batchSize)
		if err != nil {
			_ = tx.Rollback(ctx)
			return m.failOperation(ctx, batchState, err)
		}
		if len(ids) == 0 {
			if err := updateStateTx(ctx, tx, batchState.phase, batchState.leaseOwner, ApprovalHistoryPhaseBackfillComplete, batchState.checkpointID, batchState.rowsScanned, batchState.rowsCopied, batchState.dirtyRowsReconciled, "", ""); err != nil {
				_ = tx.Rollback(ctx)
				return progressFromState(batchState), err
			}
			if err := tx.Commit(ctx); err != nil {
				return progressFromState(batchState), fmt.Errorf("commit completed approval history backfill: %w", err)
			}
			return m.progress(ctx)
		}
		if err := insertBackfillSnapshotsTx(ctx, tx, ids); err != nil {
			_ = tx.Rollback(ctx)
			return m.failOperation(ctx, batchState, err)
		}
		drift, err := projectionHistoryDriftTx(ctx, tx, ids)
		if err != nil {
			_ = tx.Rollback(ctx)
			return m.failOperation(ctx, batchState, err)
		}
		if drift {
			_ = tx.Rollback(ctx)
			return m.failOperation(ctx, batchState, errors.New("backfill snapshot disagrees with current projection"))
		}
		if err := deleteDirtyIDsTx(ctx, tx, ids); err != nil {
			_ = tx.Rollback(ctx)
			return m.failOperation(ctx, batchState, err)
		}
		lastID := ids[len(ids)-1]
		processed += int64(len(ids))
		phase := ApprovalHistoryPhaseBackfillRunning
		if processed >= opts.WorkBudget {
			phase = ApprovalHistoryPhaseBackfillPaused
		}
		if err := updateStateTx(ctx, tx, batchState.phase, batchState.leaseOwner, phase, lastID, batchState.rowsScanned+int64(len(ids)), batchState.rowsCopied+int64(len(ids)), batchState.dirtyRowsReconciled, "", ""); err != nil {
			_ = tx.Rollback(ctx)
			return progressFromState(batchState), err
		}
		if err := tx.Commit(ctx); err != nil {
			return progressFromState(batchState), fmt.Errorf("commit approval history backfill batch: %w", err)
		}
		if phase == ApprovalHistoryPhaseBackfillPaused {
			return m.progress(ctx)
		}
	}
}

func (m *ApprovalHistoryMigrator) Validate(ctx context.Context, options ApprovalHistoryMigrationOptions) (ApprovalHistoryMigrationProgress, error) {
	if err := m.validate(ctx); err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	opts := options.normalized(m.leaseOwner)
	state, err := m.loadState(ctx)
	if err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	if state.phase != ApprovalHistoryPhaseBackfillComplete && state.phase != ApprovalHistoryPhaseValidated && state.phase != ApprovalHistoryPhaseIndexesReady && state.phase != ApprovalHistoryPhaseFailed {
		return progressFromState(state), fmt.Errorf("%w: phase is %s", ErrApprovalHistoryMigrationNotReady, state.phase)
	}
	if _, err := m.drainDirty(ctx, opts, opts.PreDrainWorkBudget); err != nil {
		return m.progressWithError(ctx, err)
	}
	if err := m.validateProjectionHistory(ctx, opts.StatementTimeout); err != nil {
		return m.failOperation(ctx, state, err)
	}
	pending, err := m.pendingDirtyRows(ctx)
	if err != nil {
		return m.failOperation(ctx, state, err)
	}
	if pending != 0 {
		return m.failBudget(ctx, state, fmt.Sprintf("%d dirty rows appeared during validation", pending))
	}
	if err := m.setPhase(ctx, state.phase, ApprovalHistoryPhaseValidated, ""); err != nil {
		return m.progressWithError(ctx, err)
	}
	return m.progress(ctx)
}

func (m *ApprovalHistoryMigrator) BuildIndexes(ctx context.Context, options ApprovalHistoryMigrationOptions) (ApprovalHistoryMigrationProgress, error) {
	if err := m.validate(ctx); err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	opts := options.normalized(m.leaseOwner)
	state, err := m.loadState(ctx)
	if err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	if state.phase == ApprovalHistoryPhaseIndexesReady || state.phase == ApprovalHistoryPhaseCutoverRequested || state.phase == ApprovalHistoryPhaseCutoverComplete {
		return progressFromState(state), nil
	}
	if state.phase != ApprovalHistoryPhaseValidated && state.phase != ApprovalHistoryPhaseRepairRequired && state.phase != ApprovalHistoryPhaseFailed {
		return progressFromState(state), fmt.Errorf("%w: phase is %s", ErrApprovalHistoryMigrationNotReady, state.phase)
	}
	if err := m.acquireLease(ctx, opts); err != nil {
		return progressFromState(state), err
	}
	indexes := []struct {
		name string
		ddl  string
		want string
	}{
		{
			name: "execution_approval_revisions_run_cursor_idx",
			ddl:  "CREATE INDEX CONCURRENTLY IF NOT EXISTS execution_approval_revisions_run_cursor_idx ON execution_approval_revisions (run_id, created_at, id, revision)",
			want: "(run_id, created_at, id, revision)",
		},
		{
			name: "execution_approval_revisions_requested_event_idx",
			ddl:  "CREATE INDEX CONCURRENTLY IF NOT EXISTS execution_approval_revisions_requested_event_idx ON execution_approval_revisions (requested_event_id) WHERE requested_event_id <> ''",
			want: "(requested_event_id) WHERE (requested_event_id <> ''::text)",
		},
	}
	for _, index := range indexes {
		if err := m.ensureConcurrentIndex(ctx, index.name, index.ddl, index.want, opts); err != nil {
			return m.failOperation(ctx, state, err)
		}
	}
	if err := m.setPhase(ctx, state.phase, ApprovalHistoryPhaseIndexesReady, ""); err != nil {
		return m.progressWithError(ctx, err)
	}
	return m.progress(ctx)
}

func (m *ApprovalHistoryMigrator) Cutover(ctx context.Context, options ApprovalHistoryMigrationOptions) (ApprovalHistoryMigrationProgress, error) {
	if err := m.validate(ctx); err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	opts := options.normalized(m.leaseOwner)
	state, err := m.loadState(ctx)
	if err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	if state.phase == ApprovalHistoryPhaseCutoverComplete {
		return progressFromState(state), nil
	}
	if state.phase != ApprovalHistoryPhaseIndexesReady && state.phase != ApprovalHistoryPhaseCutoverRequested {
		return progressFromState(state), fmt.Errorf("%w: phase is %s", ErrApprovalHistoryMigrationNotReady, state.phase)
	}
	primaryKeyReady, err := m.historyPrimaryKeyReady(ctx)
	if err != nil {
		return progressFromState(state), err
	}
	if !primaryKeyReady {
		return progressFromState(state), fmt.Errorf("%w: approval history primary key is not (id, revision)", ErrApprovalHistoryMigrationUnavailable)
	}
	if _, err := m.drainDirty(ctx, opts, opts.PreDrainWorkBudget); err != nil {
		return m.progressWithError(ctx, err)
	}
	if err := m.validateProjectionHistory(ctx, opts.StatementTimeout); err != nil {
		return m.failOperation(ctx, state, err)
	}
	if pending, err := m.pendingDirtyRows(ctx); err != nil {
		return m.failOperation(ctx, state, err)
	} else if pending != 0 {
		return m.failBudget(ctx, state, fmt.Sprintf("%d dirty rows remain before cutover", pending))
	}
	if state.phase == ApprovalHistoryPhaseIndexesReady {
		if err := m.setPhase(ctx, state.phase, ApprovalHistoryPhaseCutoverRequested, ""); err != nil {
			return m.progressWithError(ctx, err)
		}
	}

	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return m.resetCutover(ctx, fmt.Errorf("begin approval history cutover: %w", err))
	}
	cutoverState, err := m.claimLeaseTx(ctx, tx, opts)
	if err != nil {
		_ = tx.Rollback(ctx)
		return m.resetCutover(ctx, err)
	}
	if err := setLocalTimeouts(ctx, tx, opts); err != nil {
		_ = tx.Rollback(ctx)
		return m.resetCutover(ctx, err)
	}
	if _, err := tx.Exec(ctx, "LOCK TABLE execution_approvals IN SHARE MODE"); err != nil {
		_ = tx.Rollback(ctx)
		return m.resetCutover(ctx, fmt.Errorf("acquire bounded approval history cutover lock: %w", err))
	}
	probeLimit := opts.FinalRowBudget + 1
	ids, err := selectDirtyIDsTx(ctx, tx, int(probeLimit))
	if err != nil {
		_ = tx.Rollback(ctx)
		return m.resetCutover(ctx, err)
	}
	if int64(len(ids)) > opts.FinalRowBudget || int64(len(ids))*3 > opts.FinalWorkBudget {
		_ = tx.Rollback(ctx)
		return m.resetCutover(ctx, fmt.Errorf("%w: final dirty rows=%d row_budget=%d work_budget=%d", ErrApprovalHistoryMigrationBudget, len(ids), opts.FinalRowBudget, opts.FinalWorkBudget))
	}
	if len(ids) > 0 {
		if err := reconcileDirtyIDsTx(ctx, tx, ids); err != nil {
			_ = tx.Rollback(ctx)
			return m.resetCutover(ctx, err)
		}
	}
	remaining, err := dirtyRowsRemainTx(ctx, tx)
	if err != nil {
		_ = tx.Rollback(ctx)
		return m.resetCutover(ctx, err)
	}
	if remaining {
		_ = tx.Rollback(ctx)
		return m.resetCutover(ctx, fmt.Errorf("%w: dirty rows remain after final drain", ErrApprovalHistoryMigrationBudget))
	}
	if !captureTriggerExistsTx(ctx, tx) {
		_ = tx.Rollback(ctx)
		return m.resetCutover(ctx, errors.New("approval history capture trigger is missing before cutover"))
	}
	if !writerGuardTriggerExistsTx(ctx, tx) {
		if _, err := tx.Exec(ctx, `CREATE TRIGGER execution_approvals_history_writer_guard
BEFORE INSERT OR UPDATE OR DELETE ON execution_approvals
FOR EACH ROW
EXECUTE FUNCTION loomhelm_require_approval_history_writer()`); err != nil {
			_ = tx.Rollback(ctx)
			return m.resetCutover(ctx, fmt.Errorf("install approval history writer guard: %w", err))
		}
	}
	if _, err := tx.Exec(ctx, `DROP TRIGGER execution_approvals_history_capture ON execution_approvals`); err != nil {
		_ = tx.Rollback(ctx)
		return m.resetCutover(ctx, fmt.Errorf("remove approval history capture trigger: %w", err))
	}
	if err := updateStateTx(ctx, tx, cutoverState.phase, cutoverState.leaseOwner, ApprovalHistoryPhaseCutoverComplete, cutoverState.checkpointID, cutoverState.rowsScanned, cutoverState.rowsCopied, cutoverState.dirtyRowsReconciled+int64(len(ids)), "", ""); err != nil {
		_ = tx.Rollback(ctx)
		return m.resetCutover(ctx, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return m.resetCutover(ctx, fmt.Errorf("commit approval history cutover: %w", err))
	}
	return m.progress(ctx)
}

func (m *ApprovalHistoryMigrator) AdoptAtomic00012(ctx context.Context, options ApprovalHistoryMigrationOptions) (ApprovalHistoryMigrationProgress, error) {
	if err := m.validate(ctx); err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	opts := options.normalized(m.leaseOwner)
	state, err := m.loadStateIfPresent(ctx)
	if err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	if state != nil && state.phase == ApprovalHistoryPhaseCutoverComplete {
		return progressFromState(*state), nil
	}
	recognized, err := m.recognizedAtomicLayout(ctx)
	if err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	if !recognized {
		return ApprovalHistoryMigrationProgress{}, ErrApprovalHistoryAtomicAdoption
	}
	if err := m.validateProjectionHistory(ctx, opts.StatementTimeout); err != nil {
		return ApprovalHistoryMigrationProgress{}, fmt.Errorf("%w: %v", ErrApprovalHistoryAtomicAdoption, err)
	}
	if err := ensureApprovalHistoryControlTables(ctx, m.pool); err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	var count int64
	if err := m.pool.QueryRow(ctx, `SELECT count(*) FROM execution_approvals`).Scan(&count); err != nil {
		return ApprovalHistoryMigrationProgress{}, fmt.Errorf("count adopted approval projections: %w", err)
	}
	result, err := m.pool.Exec(ctx, `
		INSERT INTO execution_approval_history_migrations (
			migration_key, phase, rows_scanned, rows_copied, last_error, updated_at
		)
		VALUES ($1, 'cutover_complete', $2, $2, '', CURRENT_TIMESTAMP)
		ON CONFLICT (migration_key) DO UPDATE SET
			phase = 'cutover_complete',
			rows_scanned = EXCLUDED.rows_scanned,
			rows_copied = EXCLUDED.rows_copied,
			last_error = '',
			lease_owner = '',
			lease_expires_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE execution_approval_history_migrations.phase <> 'cutover_complete'
		  AND (
			execution_approval_history_migrations.lease_owner = ''
			OR execution_approval_history_migrations.lease_owner = $3
			OR execution_approval_history_migrations.lease_expires_at IS NULL
			OR execution_approval_history_migrations.lease_expires_at <= CURRENT_TIMESTAMP
		  )
	`, approvalHistoryMigrationKey, count, m.leaseOwner)
	if err != nil {
		return ApprovalHistoryMigrationProgress{}, fmt.Errorf("adopt atomic approval history state: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ApprovalHistoryMigrationProgress{}, ErrApprovalHistoryMigrationBusy
	}
	return m.progress(ctx)
}

func (m *ApprovalHistoryMigrator) drainDirty(ctx context.Context, options normalizedApprovalHistoryMigrationOptions, budget int64) (int64, error) {
	var processed int64
	for {
		if err := ctx.Err(); err != nil {
			return processed, err
		}
		if processed >= budget {
			pending, pendingErr := m.pendingDirtyRows(ctx)
			if pendingErr != nil {
				return processed, pendingErr
			}
			if pending != 0 {
				return processed, fmt.Errorf("%w: pre-drain rows=%d budget=%d", ErrApprovalHistoryMigrationBudget, pending, budget)
			}
			return processed, nil
		}
		batchSize := options.PreDrainBatchSize
		remaining := budget - processed
		if int64(batchSize) > remaining {
			batchSize = int(remaining)
		}
		tx, err := m.pool.Begin(ctx)
		if err != nil {
			return processed, fmt.Errorf("begin approval history dirty drain: %w", err)
		}
		state, err := m.claimLeaseTx(ctx, tx, options)
		if err != nil {
			_ = tx.Rollback(ctx)
			return processed, err
		}
		if err := setLocalTimeouts(ctx, tx, options); err != nil {
			_ = tx.Rollback(ctx)
			return processed, err
		}
		ids, err := selectDirtyIDsTx(ctx, tx, batchSize)
		if err != nil {
			_ = tx.Rollback(ctx)
			return processed, err
		}
		if len(ids) == 0 {
			if err := releaseLeaseTx(ctx, tx, state, state.phase, state.lastError); err != nil {
				_ = tx.Rollback(ctx)
				return processed, err
			}
			if err := tx.Commit(ctx); err != nil {
				return processed, err
			}
			return processed, nil
		}
		if err := reconcileDirtyIDsTx(ctx, tx, ids); err != nil {
			_ = tx.Rollback(ctx)
			return processed, err
		}
		if err := updateStateTx(ctx, tx, state.phase, state.leaseOwner, state.phase, state.checkpointID, state.rowsScanned, state.rowsCopied, state.dirtyRowsReconciled+int64(len(ids)), "", ""); err != nil {
			_ = tx.Rollback(ctx)
			return processed, err
		}
		if err := tx.Commit(ctx); err != nil {
			return processed, fmt.Errorf("commit approval history dirty drain: %w", err)
		}
		processed += int64(len(ids))
	}
}

func (m *ApprovalHistoryMigrator) validateProjectionHistory(ctx context.Context, timeout time.Duration) error {
	conn, err := m.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire approval history validation connection: %w", err)
	}
	defer conn.Release()
	if err := setConnectionTimeouts(ctx, conn, timeout); err != nil {
		return err
	}
	defer func() { _, _ = conn.Exec(context.Background(), `SELECT set_config('statement_timeout', '0', false)`) }()
	var drift bool
	if err := conn.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM execution_approvals AS current
			LEFT JOIN execution_approval_revisions AS history
			  ON history.id = current.id AND history.revision = current.revision
			WHERE history.id IS NULL
			   OR history.session_id IS DISTINCT FROM current.session_id
			   OR history.run_id IS DISTINCT FROM current.run_id
			   OR history.generation IS DISTINCT FROM current.generation
			   OR history.kind IS DISTINCT FROM current.kind
			   OR history.requested_at IS DISTINCT FROM current.requested_at
			   OR history.status IS DISTINCT FROM current.status
			   OR history.summary IS DISTINCT FROM current.summary
			   OR history.context IS DISTINCT FROM current.context
			   OR history.resolved_by_command_id IS DISTINCT FROM current.resolved_by_command_id
			   OR history.requested_event_id IS DISTINCT FROM current.requested_event_id
			   OR history.resolved_at IS DISTINCT FROM current.resolved_at
		)
	`).Scan(&drift); err != nil {
		return fmt.Errorf("validate approval projection/history: %w", err)
	}
	if drift {
		return errors.New("approval projection/history drift detected")
	}
	return nil
}

func (m *ApprovalHistoryMigrator) ensureConcurrentIndex(ctx context.Context, name, ddl, wanted string, options normalizedApprovalHistoryMigrationOptions) error {
	conn, err := m.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection for index %s: %w", name, err)
	}
	defer conn.Release()
	if err := setConnectionTimeouts(ctx, conn, options.StatementTimeout); err != nil {
		return err
	}
	defer func() { _, _ = conn.Exec(context.Background(), `SELECT set_config('statement_timeout', '0', false)`) }()
	info, err := indexInfo(ctx, conn, name)
	if err != nil {
		return err
	}
	if info.exists && !info.valid {
		if _, err := conn.Exec(ctx, "DROP INDEX CONCURRENTLY IF EXISTS "+quoteIdentifier(name)); err != nil {
			return fmt.Errorf("drop invalid approval history index %s: %w", name, err)
		}
		info.exists = false
	}
	if info.exists {
		if !info.valid || !info.ready || !strings.Contains(info.definition, wanted) {
			return fmt.Errorf("%w: index %s has unexpected definition or validity", ErrApprovalHistoryMigrationUnavailable, name)
		}
		return nil
	}
	if _, err := conn.Exec(ctx, ddl); err != nil {
		return fmt.Errorf("create approval history index %s concurrently: %w", name, err)
	}
	info, err = indexInfo(ctx, conn, name)
	if err != nil {
		return err
	}
	if !info.exists || !info.valid || !info.ready || !strings.Contains(info.definition, wanted) {
		return fmt.Errorf("%w: index %s did not become valid", ErrApprovalHistoryMigrationUnavailable, name)
	}
	return nil
}

func (m *ApprovalHistoryMigrator) acquireLease(ctx context.Context, options normalizedApprovalHistoryMigrationOptions) error {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin approval history lease: %w", err)
	}
	if _, err := m.claimLeaseTx(ctx, tx, options); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit approval history lease: %w", err)
	}
	return nil
}

func (m *ApprovalHistoryMigrator) claimLeaseTx(ctx context.Context, tx pgx.Tx, options normalizedApprovalHistoryMigrationOptions) (approvalHistoryMigrationState, error) {
	var state approvalHistoryMigrationState
	var leaseExpiry *time.Time
	err := tx.QueryRow(ctx, `
		UPDATE execution_approval_history_migrations
		SET lease_owner = $2,
		    lease_expires_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'),
		    updated_at = CURRENT_TIMESTAMP
		WHERE migration_key = $1
		  AND phase <> 'cutover_complete'
		  AND (
			lease_owner = ''
			OR lease_expires_at IS NULL
			OR lease_expires_at <= CURRENT_TIMESTAMP
			OR lease_owner = $2
		  )
		RETURNING phase, checkpoint_id, rows_scanned, rows_copied,
		          dirty_rows_reconciled, lease_owner, lease_expires_at, last_error
	`, approvalHistoryMigrationKey, options.LeaseOwner, options.LeaseDuration.Milliseconds()).Scan(
		&state.phase, &state.checkpointID, &state.rowsScanned, &state.rowsCopied,
		&state.dirtyRowsReconciled, &state.leaseOwner, &leaseExpiry, &state.lastError,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, ErrApprovalHistoryMigrationBusy
	}
	if err != nil {
		return state, fmt.Errorf("claim approval history migration lease: %w", err)
	}
	state.leaseExpiresAt = leaseExpiry
	return state, nil
}

func (m *ApprovalHistoryMigrator) failOperation(ctx context.Context, state approvalHistoryMigrationState, cause error) (ApprovalHistoryMigrationProgress, error) {
	if cause == nil {
		cause = ErrApprovalHistoryMigrationUnavailable
	}
	if ctx.Err() != nil {
		return m.progress(ctx)
	}
	message := cause.Error()
	if err := m.setPhase(ctx, state.phase, ApprovalHistoryPhaseFailed, message); err != nil {
		return m.progressWithError(ctx, errors.Join(cause, err))
	}
	return m.progressWithError(ctx, cause)
}

func (m *ApprovalHistoryMigrator) failBudget(ctx context.Context, state approvalHistoryMigrationState, message string) (ApprovalHistoryMigrationProgress, error) {
	if err := m.setPhase(ctx, state.phase, state.phase, message); err != nil {
		return progressFromState(state), err
	}
	progress, err := m.progress(ctx)
	if err != nil {
		return progress, err
	}
	return progress, fmt.Errorf("%w: %s", ErrApprovalHistoryMigrationBudget, message)
}

func (m *ApprovalHistoryMigrator) resetCutover(ctx context.Context, cause error) (ApprovalHistoryMigrationProgress, error) {
	_, _ = m.pool.Exec(ctx, `
		UPDATE execution_approval_history_migrations
		SET phase = 'indexes_ready', lease_owner = '', lease_expires_at = NULL,
		    last_error = $2, updated_at = CURRENT_TIMESTAMP
		WHERE migration_key = $1
		  AND phase = 'cutover_requested'
		  AND (lease_owner = '' OR lease_owner = $3)
	`, approvalHistoryMigrationKey, cause.Error(), m.leaseOwner)
	progress, err := m.progress(ctx)
	if err != nil {
		return progress, cause
	}
	return progress, cause
}

func (m *ApprovalHistoryMigrator) setPhase(ctx context.Context, expectedPhase, phase ApprovalHistoryMigrationPhase, lastError string) error {
	result, err := m.pool.Exec(ctx, `
		UPDATE execution_approval_history_migrations
		SET phase = $2, last_error = $3, lease_owner = '', lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE migration_key = $1
		  AND phase = $4
		  AND phase <> 'cutover_complete'
		  AND (lease_owner = '' OR lease_owner = $5)
	`, approvalHistoryMigrationKey, phase, lastError, expectedPhase, m.leaseOwner)
	if err != nil {
		return fmt.Errorf("set approval history migration phase %s: %w", phase, err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("%w: phase %q changed or is leased by another owner", ErrApprovalHistoryMigrationBusy, expectedPhase)
	}
	return nil
}

func updateStateTx(ctx context.Context, tx pgx.Tx, expectedPhase ApprovalHistoryMigrationPhase, expectedLeaseOwner string, phase ApprovalHistoryMigrationPhase, checkpointID string, rowsScanned, rowsCopied, dirtyRowsReconciled int64, leaseOwner, lastError string) error {
	result, err := tx.Exec(ctx, `
		UPDATE execution_approval_history_migrations
		SET phase = $2,
		    checkpoint_id = $3,
		    rows_scanned = $4,
		    rows_copied = $5,
		    dirty_rows_reconciled = $6,
		    lease_owner = $7,
		    lease_expires_at = CASE WHEN $7 = '' THEN NULL ELSE lease_expires_at END,
		    last_error = $8,
		    updated_at = CURRENT_TIMESTAMP
		WHERE migration_key = $1
		  AND phase = $9
		  AND lease_owner = $10
	`, approvalHistoryMigrationKey, phase, checkpointID, rowsScanned, rowsCopied, dirtyRowsReconciled, leaseOwner, lastError, expectedPhase, expectedLeaseOwner)
	if err != nil {
		return fmt.Errorf("update approval history migration state: %w", err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("%w: phase %q or lease owner changed", ErrApprovalHistoryMigrationBusy, expectedPhase)
	}
	return nil
}

func releaseLeaseTx(ctx context.Context, tx pgx.Tx, state approvalHistoryMigrationState, phase ApprovalHistoryMigrationPhase, lastError string) error {
	return updateStateTx(ctx, tx, state.phase, state.leaseOwner, phase, state.checkpointID, state.rowsScanned, state.rowsCopied, state.dirtyRowsReconciled, "", lastError)
}

func (m *ApprovalHistoryMigrator) progress(ctx context.Context) (ApprovalHistoryMigrationProgress, error) {
	state, err := m.loadState(ctx)
	if err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	pending, err := m.pendingDirtyRows(ctx)
	if err != nil {
		return ApprovalHistoryMigrationProgress{}, err
	}
	result := progressFromState(state)
	result.DirtyRowsPending = pending
	return result, nil
}

func (m *ApprovalHistoryMigrator) progressWithError(ctx context.Context, cause error) (ApprovalHistoryMigrationProgress, error) {
	progress, err := m.progress(ctx)
	if err != nil {
		return progress, cause
	}
	return progress, cause
}

func progressFromState(state approvalHistoryMigrationState) ApprovalHistoryMigrationProgress {
	return ApprovalHistoryMigrationProgress{
		Phase:               state.phase,
		CheckpointID:        state.checkpointID,
		RowsScanned:         state.rowsScanned,
		RowsCopied:          state.rowsCopied,
		DirtyRowsReconciled: state.dirtyRowsReconciled,
		LastError:           state.lastError,
	}
}

func (m *ApprovalHistoryMigrator) loadState(ctx context.Context) (approvalHistoryMigrationState, error) {
	state, err := loadApprovalHistoryMigrationState(ctx, m.pool)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, fmt.Errorf("%w: migration state row is missing", ErrApprovalHistoryMigrationUnavailable)
	}
	if err != nil {
		return state, err
	}
	return state, nil
}

func (m *ApprovalHistoryMigrator) loadStateIfPresent(ctx context.Context) (*approvalHistoryMigrationState, error) {
	var tableName string
	if err := m.pool.QueryRow(ctx, `SELECT COALESCE(to_regclass(format('%I.%I', current_schema(), 'execution_approval_history_migrations'))::text, '')`).Scan(&tableName); err != nil {
		return nil, fmt.Errorf("inspect approval history migration state table: %w", err)
	}
	if tableName == "" {
		return nil, nil
	}
	state, err := loadApprovalHistoryMigrationState(ctx, m.pool)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &state, nil
}

func loadApprovalHistoryMigrationState(ctx context.Context, queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (approvalHistoryMigrationState, error) {
	var state approvalHistoryMigrationState
	var leaseExpiry *time.Time
	err := queryer.QueryRow(ctx, `
		SELECT phase, checkpoint_id, rows_scanned, rows_copied,
		       dirty_rows_reconciled, lease_owner, lease_expires_at, last_error
		FROM execution_approval_history_migrations
		WHERE migration_key = $1
	`, approvalHistoryMigrationKey).Scan(
		&state.phase, &state.checkpointID, &state.rowsScanned, &state.rowsCopied,
		&state.dirtyRowsReconciled, &state.leaseOwner, &leaseExpiry, &state.lastError,
	)
	state.leaseExpiresAt = leaseExpiry
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return state, pgx.ErrNoRows
		}
		return state, fmt.Errorf("read approval history migration state: %w", err)
	}
	return state, nil
}

func (m *ApprovalHistoryMigrator) validate(ctx context.Context) error {
	if m == nil || m.pool == nil {
		return ErrApprovalHistoryMigrationUnavailable
	}
	if ctx == nil {
		return errors.New("approval history migration context must not be nil")
	}
	return nil
}

func (m *ApprovalHistoryMigrator) requireStructuralLayout(ctx context.Context) error {
	if err := m.requireHistoryLayout(ctx); err != nil {
		return err
	}
	var complete bool
	if err := m.pool.QueryRow(ctx, `
		SELECT
			EXISTS (
				SELECT 1 FROM pg_trigger AS trigger_row
				JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
				WHERE namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approvals'
				  AND trigger_row.tgname = 'execution_approvals_history_capture'
				  AND function_row.proname = 'loomhelm_capture_approval_history'
				  AND trigger_row.tgenabled = 'O'
			)
	`).Scan(&complete); err != nil {
		return fmt.Errorf("inspect approval history structural migration: %w", err)
	}
	if !complete {
		return fmt.Errorf("%w: structural migration is incomplete", ErrApprovalHistoryMigrationUnavailable)
	}
	return nil
}

func (m *ApprovalHistoryMigrator) requireHistoryLayout(ctx context.Context) error {
	var complete bool
	if err := m.pool.QueryRow(ctx, `
		SELECT
			EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'execution_approval_revisions')
			AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'execution_approval_history_migrations')
			AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'execution_approval_history_dirty')
	`).Scan(&complete); err != nil {
		return fmt.Errorf("inspect approval history layout: %w", err)
	}
	if !complete {
		return fmt.Errorf("%w: history layout is incomplete", ErrApprovalHistoryMigrationUnavailable)
	}
	return nil
}

func ensureApprovalHistoryControlTables(ctx context.Context, pool *pgxpool.Pool) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS execution_approval_history_migrations (
			migration_key TEXT PRIMARY KEY CHECK (length(trim(migration_key)) > 0),
			phase TEXT NOT NULL CHECK (phase IN ('structure_ready', 'backfill_running', 'backfill_paused', 'backfill_complete', 'failed', 'validated', 'indexes_ready', 'cutover_requested', 'cutover_complete', 'repair_required')),
			checkpoint_id TEXT NOT NULL DEFAULT '',
			rows_scanned BIGINT NOT NULL DEFAULT 0 CHECK (rows_scanned >= 0),
			rows_copied BIGINT NOT NULL DEFAULT 0 CHECK (rows_copied >= 0),
			dirty_rows_reconciled BIGINT NOT NULL DEFAULT 0 CHECK (dirty_rows_reconciled >= 0),
			lease_owner TEXT NOT NULL DEFAULT '',
			lease_expires_at TIMESTAMPTZ,
			last_error TEXT NOT NULL DEFAULT '',
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS execution_approval_history_dirty (
			id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
			queued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`INSERT INTO execution_approval_history_migrations (migration_key, phase)
		 VALUES ('approval-revision-history', 'structure_ready')
		 ON CONFLICT (migration_key) DO NOTHING`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			return fmt.Errorf("ensure approval history control tables: %w", err)
		}
	}
	return nil
}

func (m *ApprovalHistoryMigrator) recognizedAtomicLayout(ctx context.Context) (bool, error) {
	var recognized bool
	err := m.pool.QueryRow(ctx, `
		SELECT
			EXISTS (SELECT 1 FROM goose_db_version WHERE version_id = 12 AND is_applied)
			AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'execution_approval_revisions')
			AND (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'execution_approval_revisions' AND column_name IN ('id', 'revision', 'session_id', 'run_id', 'generation', 'kind', 'requested_at', 'status', 'summary', 'context', 'resolved_by_command_id', 'requested_event_id', 'resolved_at', 'created_at', 'updated_at')) = 15
			AND EXISTS (
				SELECT 1 FROM pg_class AS relation
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				JOIN pg_index AS index_row ON index_row.indexrelid = relation.oid
				WHERE namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approval_revisions_run_cursor_idx'
				  AND index_row.indisvalid AND index_row.indisready
			)
			AND EXISTS (
				SELECT 1 FROM pg_class AS relation
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				JOIN pg_index AS index_row ON index_row.indexrelid = relation.oid
				WHERE namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approval_revisions_requested_event_idx'
				  AND index_row.indisvalid AND index_row.indisready
			)
			AND EXISTS (
				SELECT 1
				FROM pg_trigger AS trigger_row
				JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
				WHERE namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approvals'
				  AND trigger_row.tgname = 'execution_approvals_history_writer_guard'
				  AND NOT trigger_row.tgisinternal
				  AND trigger_row.tgtype = 31
				  AND function_row.proname = 'loomhelm_require_approval_history_writer'
				  AND pg_get_functiondef(function_row.oid) LIKE '%revision-history-v1%'
				  AND trigger_row.tgenabled = 'O'
			)
	`).Scan(&recognized)
	if err != nil {
		return false, fmt.Errorf("inspect atomic approval history layout: %w", err)
	}
	if !recognized {
		return false, nil
	}
	primaryKeyReady, err := m.historyPrimaryKeyReady(ctx)
	if err != nil {
		return false, err
	}
	if !primaryKeyReady {
		return false, nil
	}
	for _, index := range []struct {
		name string
		want string
	}{
		{name: "execution_approval_revisions_run_cursor_idx", want: "(run_id, created_at, id, revision)"},
		{name: "execution_approval_revisions_requested_event_idx", want: "(requested_event_id) WHERE (requested_event_id <> ''::text)"},
	} {
		info, err := indexInfo(ctx, m.pool, index.name)
		if err != nil {
			return false, err
		}
		if !info.exists || !info.valid || !info.ready || !strings.Contains(info.definition, index.want) {
			return false, nil
		}
	}
	return recognized, nil
}

func (m *ApprovalHistoryMigrator) writerGuardReady(ctx context.Context) bool {
	return writerGuardTriggerExists(ctx, m.pool)
}

func (m *ApprovalHistoryMigrator) historyIndexesReady(ctx context.Context) error {
	primaryKeyReady, err := m.historyPrimaryKeyReady(ctx)
	if err != nil {
		return err
	}
	if !primaryKeyReady {
		return fmt.Errorf("%w: approval history primary key is not (id, revision)", ErrApprovalHistoryMigrationUnavailable)
	}
	var ready bool
	if err := m.pool.QueryRow(ctx, `
		SELECT NOT EXISTS (
			SELECT 1
			FROM unnest(ARRAY[
				'execution_approval_revisions_pkey',
				'execution_approval_revisions_run_cursor_idx',
				'execution_approval_revisions_requested_event_idx'
			]) AS required(index_name)
			WHERE NOT EXISTS (
				SELECT 1
				FROM pg_class AS relation
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				JOIN pg_index AS index_row ON index_row.indexrelid = relation.oid
				WHERE namespace.nspname = current_schema()
				  AND relation.relname = required.index_name
				  AND relation.relkind = 'i'
				  AND index_row.indisvalid
				  AND index_row.indisready
			)
		)
	`).Scan(&ready); err != nil {
		return fmt.Errorf("%w: inspect approval history indexes: %v", ErrApprovalHistoryMigrationUnavailable, err)
	}
	if !ready {
		return fmt.Errorf("%w: required history indexes are not ready", ErrApprovalHistoryMigrationUnavailable)
	}
	return nil
}

func (m *ApprovalHistoryMigrator) historyPrimaryKeyReady(ctx context.Context) (bool, error) {
	var definition string
	err := m.pool.QueryRow(ctx, `
		SELECT pg_get_indexdef(constraint_row.conindid)
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
		JOIN pg_class AS index_relation ON index_relation.oid = constraint_row.conindid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = current_schema()
		  AND relation.relname = 'execution_approval_revisions'
		  AND index_relation.relname = 'execution_approval_revisions_pkey'
		  AND constraint_row.contype = 'p'
	`).Scan(&definition)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect approval history primary key: %w", err)
	}
	return strings.HasSuffix(strings.TrimSpace(definition), "(id, revision)"), nil
}

func writerGuardTriggerExists(ctx context.Context, queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) bool {
	var exists bool
	err := queryer.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM pg_trigger AS trigger_row
			JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
			JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
			WHERE namespace.nspname = current_schema()
			  AND relation.relname = 'execution_approvals'
			  AND trigger_row.tgname = 'execution_approvals_history_writer_guard'
			  AND function_row.proname = 'loomhelm_require_approval_history_writer'
			  AND pg_get_functiondef(function_row.oid) LIKE '%revision-history-v1%'
			  AND trigger_row.tgtype = 31
			  AND trigger_row.tgenabled = 'O'
		)
	`).Scan(&exists)
	return err == nil && exists
}

func captureTriggerExistsTx(ctx context.Context, tx pgx.Tx) bool {
	var exists bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM pg_trigger AS trigger_row
			JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
			JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
			WHERE namespace.nspname = current_schema()
			  AND relation.relname = 'execution_approvals'
			  AND trigger_row.tgname = 'execution_approvals_history_capture'
			  AND function_row.proname = 'loomhelm_capture_approval_history'
			  AND trigger_row.tgenabled = 'O'
		)
	`).Scan(&exists)
	return err == nil && exists
}

func writerGuardTriggerExistsTx(ctx context.Context, tx pgx.Tx) bool {
	return writerGuardTriggerExists(ctx, tx)
}

func selectBackfillIDs(ctx context.Context, tx pgx.Tx, checkpoint string, limit int) ([]string, error) {
	query := `SELECT id FROM execution_approvals ORDER BY id LIMIT $1 FOR UPDATE`
	args := []any{limit}
	if checkpoint != "" {
		query = `SELECT id FROM execution_approvals WHERE id > $1 ORDER BY id LIMIT $2 FOR UPDATE`
		args = []any{checkpoint, limit}
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("select approval history backfill batch: %w", err)
	}
	defer rows.Close()
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan approval history backfill id: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read approval history backfill batch: %w", err)
	}
	return ids, nil
}

func selectDirtyIDsTx(ctx context.Context, tx pgx.Tx, limit int) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM execution_approval_history_dirty ORDER BY id LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("select approval history dirty rows: %w", err)
	}
	defer rows.Close()
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan approval history dirty row: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read approval history dirty rows: %w", err)
	}
	return ids, nil
}

func insertBackfillSnapshotsTx(ctx context.Context, tx pgx.Tx, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO execution_approval_revisions (
			id, revision, session_id, run_id, generation, kind, requested_at,
			status, summary, context, resolved_by_command_id, requested_event_id,
			resolved_at, created_at, updated_at
		)
		SELECT id, revision, session_id, run_id, generation, kind, requested_at,
		       status, summary, context, resolved_by_command_id, requested_event_id,
		       resolved_at, created_at, updated_at
		FROM execution_approvals
		WHERE id = ANY($1::text[])
		ON CONFLICT (id, revision) DO UPDATE SET
			created_at = CASE
				WHEN NOT EXISTS (
					SELECT 1
					FROM execution_approval_revisions AS prior
					WHERE prior.id = EXCLUDED.id AND prior.revision < EXCLUDED.revision
				) THEN EXCLUDED.created_at
				ELSE execution_approval_revisions.created_at
			END,
			updated_at = CASE
				WHEN NOT EXISTS (
					SELECT 1
					FROM execution_approval_revisions AS prior
					WHERE prior.id = EXCLUDED.id AND prior.revision < EXCLUDED.revision
				) THEN EXCLUDED.updated_at
				ELSE execution_approval_revisions.updated_at
			END
	`, ids)
	if err != nil {
		return fmt.Errorf("insert approval history backfill snapshots: %w", err)
	}
	if err := repairLegacyEarliestCreatedAtTx(ctx, tx, ids); err != nil {
		return err
	}
	return nil
}

func reconcileDirtyIDsTx(ctx context.Context, tx pgx.Tx, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	var currentCount int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM execution_approvals WHERE id = ANY($1::text[])`, ids).Scan(&currentCount); err != nil {
		return fmt.Errorf("count dirty approval projections: %w", err)
	}
	if currentCount != int64(len(ids)) {
		return errors.New("dirty approval row is missing from current projection")
	}
	rows, err := tx.Query(ctx, `
		SELECT id FROM execution_approvals WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE
	`, ids)
	if err != nil {
		return fmt.Errorf("lock dirty approval projections: %w", err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("scan dirty approval projection lock: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("read dirty approval projection locks: %w", err)
	}
	rows.Close()
	if _, err := tx.Exec(ctx, `
		INSERT INTO execution_approval_revisions (
			id, revision, session_id, run_id, generation, kind, requested_at,
			status, summary, context, resolved_by_command_id, requested_event_id,
			resolved_at, created_at, updated_at
		)
		SELECT id, revision, session_id, run_id, generation, kind, requested_at,
		       status, summary, context, resolved_by_command_id, requested_event_id,
		       resolved_at, created_at, updated_at
		FROM execution_approvals
		WHERE id = ANY($1::text[])
		ON CONFLICT (id, revision) DO UPDATE SET
			session_id = EXCLUDED.session_id,
			run_id = EXCLUDED.run_id,
			generation = EXCLUDED.generation,
			kind = EXCLUDED.kind,
			requested_at = EXCLUDED.requested_at,
			status = EXCLUDED.status,
			summary = EXCLUDED.summary,
			context = EXCLUDED.context,
			resolved_by_command_id = EXCLUDED.resolved_by_command_id,
			requested_event_id = EXCLUDED.requested_event_id,
			resolved_at = EXCLUDED.resolved_at,
			created_at = CASE
				WHEN NOT EXISTS (
					SELECT 1
					FROM execution_approval_revisions AS prior
					WHERE prior.id = EXCLUDED.id AND prior.revision < EXCLUDED.revision
				) THEN EXCLUDED.created_at
				ELSE execution_approval_revisions.created_at
			END,
			updated_at = CASE
				WHEN NOT EXISTS (
					SELECT 1
					FROM execution_approval_revisions AS prior
					WHERE prior.id = EXCLUDED.id AND prior.revision < EXCLUDED.revision
				) THEN EXCLUDED.updated_at
				ELSE execution_approval_revisions.updated_at
			END
	`, ids); err != nil {
		return fmt.Errorf("reconcile approval history dirty rows: %w", err)
	}
	if err := repairLegacyEarliestCreatedAtTx(ctx, tx, ids); err != nil {
		return err
	}
	return deleteDirtyIDsTx(ctx, tx, ids)
}

func repairLegacyEarliestCreatedAtTx(ctx context.Context, tx pgx.Tx, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_approval_revisions AS history
		SET created_at = current.created_at
		FROM execution_approvals AS current
		WHERE current.id = ANY($1::text[])
		  AND history.id = current.id
		  AND history.revision = (
				SELECT MIN(candidate.revision)
				FROM execution_approval_revisions AS candidate
				WHERE candidate.id = current.id
			)
		  AND history.revision > 1
		  AND NOT EXISTS (
				SELECT 1
				FROM execution_approval_revisions AS revision_one
				WHERE revision_one.id = current.id AND revision_one.revision = 1
			)
		  AND history.created_at IS DISTINCT FROM current.created_at
	`, ids); err != nil {
		return fmt.Errorf("repair legacy approval history created timestamps: %w", err)
	}
	return nil
}

func deleteDirtyIDsTx(ctx context.Context, tx pgx.Tx, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `DELETE FROM execution_approval_history_dirty WHERE id = ANY($1::text[])`, ids); err != nil {
		return fmt.Errorf("delete reconciled approval history dirty rows: %w", err)
	}
	return nil
}

func projectionHistoryDriftTx(ctx context.Context, tx pgx.Tx, ids []string) (bool, error) {
	if len(ids) == 0 {
		return false, nil
	}
	var drift bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM execution_approvals AS current
			LEFT JOIN execution_approval_revisions AS history
			  ON history.id = current.id AND history.revision = current.revision
			WHERE current.id = ANY($1::text[])
			  AND (
				history.id IS NULL
				OR history.session_id IS DISTINCT FROM current.session_id
				OR history.run_id IS DISTINCT FROM current.run_id
				OR history.generation IS DISTINCT FROM current.generation
				OR history.kind IS DISTINCT FROM current.kind
				OR history.requested_at IS DISTINCT FROM current.requested_at
				OR history.status IS DISTINCT FROM current.status
				OR history.summary IS DISTINCT FROM current.summary
				OR history.context IS DISTINCT FROM current.context
				OR history.resolved_by_command_id IS DISTINCT FROM current.resolved_by_command_id
				OR history.requested_event_id IS DISTINCT FROM current.requested_event_id
				OR history.resolved_at IS DISTINCT FROM current.resolved_at
			  )
		)
	`, ids).Scan(&drift)
	if err != nil {
		return false, fmt.Errorf("verify approval history batch: %w", err)
	}
	return drift, nil
}

func dirtyRowsRemainTx(ctx context.Context, tx pgx.Tx) (bool, error) {
	var marker int
	err := tx.QueryRow(ctx, `SELECT 1 FROM execution_approval_history_dirty LIMIT 1`).Scan(&marker)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("probe approval history dirty rows: %w", err)
	}
	return true, nil
}

func (m *ApprovalHistoryMigrator) pendingDirtyRows(ctx context.Context) (int64, error) {
	var count int64
	if err := m.pool.QueryRow(ctx, `SELECT count(*) FROM execution_approval_history_dirty`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count pending approval history dirty rows: %w", err)
	}
	return count, nil
}

type approvalHistoryIndexInfo struct {
	exists     bool
	valid      bool
	ready      bool
	definition string
}

func indexInfo(ctx context.Context, queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, name string) (approvalHistoryIndexInfo, error) {
	var info approvalHistoryIndexInfo
	err := queryer.QueryRow(ctx, `
		SELECT index_row.indisvalid, index_row.indisready, pg_get_indexdef(index_row.indexrelid)
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		JOIN pg_index AS index_row ON index_row.indexrelid = relation.oid
		WHERE namespace.nspname = current_schema() AND relation.relname = $1
	`, name).Scan(&info.valid, &info.ready, &info.definition)
	if errors.Is(err, pgx.ErrNoRows) {
		return info, nil
	}
	if err != nil {
		return info, fmt.Errorf("inspect approval history index %s: %w", name, err)
	}
	info.exists = true
	return info, nil
}

func setLocalTimeouts(ctx context.Context, tx pgx.Tx, options normalizedApprovalHistoryMigrationOptions) error {
	_, err := tx.Exec(ctx, `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`, postgresTimeout(options.LockTimeout), postgresTimeout(options.StatementTimeout))
	if err != nil {
		return fmt.Errorf("set approval history migration timeouts: %w", err)
	}
	return nil
}

func setConnectionTimeouts(ctx context.Context, conn *pgxpool.Conn, statementTimeout time.Duration) error {
	if _, err := conn.Exec(ctx, `SELECT set_config('statement_timeout', $1, false)`, postgresTimeout(statementTimeout)); err != nil {
		return fmt.Errorf("set approval history index statement timeout: %w", err)
	}
	return nil
}

func postgresTimeout(value time.Duration) string {
	if value <= 0 {
		return "0"
	}
	return fmt.Sprintf("%dms", value.Milliseconds())
}

func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

type normalizedApprovalHistoryMigrationOptions struct {
	BatchSize          int
	WorkBudget         int64
	PreDrainBatchSize  int
	PreDrainWorkBudget int64
	FinalRowBudget     int64
	FinalWorkBudget    int64
	LockTimeout        time.Duration
	StatementTimeout   time.Duration
	LeaseDuration      time.Duration
	LeaseOwner         string
}

func (options ApprovalHistoryMigrationOptions) normalized(defaultOwner string) normalizedApprovalHistoryMigrationOptions {
	result := normalizedApprovalHistoryMigrationOptions{
		BatchSize:          options.BatchSize,
		WorkBudget:         options.WorkBudget,
		PreDrainBatchSize:  options.PreDrainBatchSize,
		PreDrainWorkBudget: options.PreDrainWorkBudget,
		FinalRowBudget:     options.FinalRowBudget,
		FinalWorkBudget:    options.FinalWorkBudget,
		LockTimeout:        options.LockTimeout,
		StatementTimeout:   options.StatementTimeout,
		LeaseDuration:      options.LeaseDuration,
		LeaseOwner:         strings.TrimSpace(options.LeaseOwner),
	}
	if result.BatchSize <= 0 {
		result.BatchSize = 100
	}
	if result.WorkBudget <= 0 {
		result.WorkBudget = 1000
	}
	if result.PreDrainBatchSize <= 0 {
		result.PreDrainBatchSize = result.BatchSize
	}
	if result.PreDrainWorkBudget <= 0 {
		result.PreDrainWorkBudget = result.WorkBudget
	}
	if result.FinalRowBudget <= 0 {
		result.FinalRowBudget = 100
	}
	if result.FinalWorkBudget <= 0 {
		result.FinalWorkBudget = result.FinalRowBudget * 3
	}
	if result.LockTimeout <= 0 {
		result.LockTimeout = 750 * time.Millisecond
	}
	if result.StatementTimeout <= 0 {
		result.StatementTimeout = 5 * time.Second
	}
	if result.LeaseDuration <= 0 {
		result.LeaseDuration = 30 * time.Second
	}
	if result.LeaseOwner == "" {
		result.LeaseOwner = defaultOwner
	}
	return result
}
