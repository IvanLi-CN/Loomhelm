package approvals

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
)

func TestApprovalHistoryMigratorKeepsCaptureOnFinalBudgetOverflow(t *testing.T) {
	db, provider := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	approvalIDs := insertMigratorApprovalRows(t, ctx, db, fixture, 2)
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("structural 00012 migration: %v", err)
	}

	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	options := database.ApprovalHistoryMigrationOptions{
		BatchSize:          8,
		WorkBudget:         100,
		PreDrainBatchSize:  8,
		PreDrainWorkBudget: 100,
		FinalRowBudget:     10,
		FinalWorkBudget:    30,
	}
	if _, err := migrator.RunBackfill(ctx, options); err != nil {
		t.Fatalf("run approval history backfill: %v", err)
	}
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("validate approval history backfill: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("build approval history indexes: %v", err)
	}

	writerTransactions := make([]interface {
		Commit(context.Context) error
		Rollback(context.Context) error
	}, 0, len(approvalIDs))
	for _, approvalID := range approvalIDs {
		tx, err := db.Pool().Begin(ctx)
		if err != nil {
			t.Fatalf("begin held projection writer: %v", err)
		}
		writerTransactions = append(writerTransactions, tx)
		if _, err := tx.Exec(ctx, `UPDATE execution_approvals SET summary = $2 WHERE id = $1`, approvalID, "held dirty update"); err != nil {
			t.Fatalf("hold dirty projection update: %v", err)
		}
	}
	defer func() {
		for _, tx := range writerTransactions {
			_ = tx.Rollback(context.Background())
		}
	}()

	cutoverOptions := options
	cutoverOptions.FinalRowBudget = 1
	cutoverOptions.FinalWorkBudget = 3
	cutoverDone := make(chan error, 1)
	go func() {
		_, err := migrator.Cutover(ctx, cutoverOptions)
		cutoverDone <- err
	}()
	if err := waitForApprovalShareLock(ctx, db); err != nil {
		t.Fatalf("wait for bounded cutover lock: %v", err)
	}
	for _, tx := range writerTransactions {
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit held projection writer: %v", err)
		}
	}
	if err := <-cutoverDone; !errors.Is(err, database.ErrApprovalHistoryMigrationBudget) {
		t.Fatalf("final budget overflow error = %v, want ErrApprovalHistoryMigrationBudget", err)
	}

	var phase database.ApprovalHistoryMigrationPhase
	if err := db.Pool().QueryRow(ctx, `SELECT phase FROM execution_approval_history_migrations WHERE migration_key = 'approval-revision-history'`).Scan(&phase); err != nil {
		t.Fatalf("read phase after final budget overflow: %v", err)
	}
	if phase != database.ApprovalHistoryPhaseIndexesReady {
		t.Fatalf("phase after final budget overflow = %q, want indexes_ready", phase)
	}
	assertApprovalHistoryTriggerState(t, ctx, db, true, false)

	options.FinalRowBudget = 10
	options.FinalWorkBudget = 30
	if _, err := migrator.Cutover(ctx, options); err != nil {
		t.Fatalf("retry approval history cutover after budget overflow: %v", err)
	}
	if err := migrator.Readiness(ctx); err != nil {
		t.Fatalf("readiness after successful retry: %v", err)
	}
}

func TestApprovalHistoryMigratorCapturesWriterBlockedByBackfill(t *testing.T) {
	db, provider := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	approvalID := insertMigratorApprovalRows(t, ctx, db, fixture, 1)[0]
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("structural 00012 migration: %v", err)
	}

	writerTx, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin concurrent projection writer: %v", err)
	}
	defer writerTx.Rollback(context.Background())
	if _, err := writerTx.Exec(ctx, `UPDATE execution_approvals SET summary = 'writer committed behind backfill', context = decode('7b22626c6f636b6564223a747275657d', 'hex') WHERE id = $1`, approvalID); err != nil {
		t.Fatalf("update concurrent projection writer: %v", err)
	}

	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	backfillDone := make(chan error, 1)
	go func() {
		_, err := migrator.RunBackfill(ctx, database.ApprovalHistoryMigrationOptions{BatchSize: 1, WorkBudget: 10, PreDrainBatchSize: 1, PreDrainWorkBudget: 10, FinalRowBudget: 10, FinalWorkBudget: 30})
		backfillDone <- err
	}()
	if err := waitForApprovalRowShareLock(ctx, db); err != nil {
		t.Fatalf("wait for backfill row lock: %v", err)
	}
	if err := writerTx.Commit(ctx); err != nil {
		t.Fatalf("commit concurrent projection writer: %v", err)
	}
	if err := <-backfillDone; err != nil {
		t.Fatalf("backfill after concurrent projection writer: %v", err)
	}

	var summary string
	var contextPayload []byte
	if err := db.Pool().QueryRow(ctx, `SELECT summary, context FROM execution_approval_revisions WHERE id = $1 AND revision = 1`, approvalID).Scan(&summary, &contextPayload); err != nil {
		t.Fatalf("read history after concurrent writer: %v", err)
	}
	if summary != "writer committed behind backfill" || string(contextPayload) != `{"blocked":true}` {
		t.Fatalf("history after concurrent writer = summary %q context %s", summary, contextPayload)
	}
	var dirty int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM execution_approval_history_dirty`).Scan(&dirty); err != nil {
		t.Fatalf("count dirty rows after concurrent backfill: %v", err)
	}
	if dirty != 0 {
		t.Fatalf("dirty rows after concurrent backfill = %d, want 0", dirty)
	}
	options := database.ApprovalHistoryMigrationOptions{BatchSize: 1, WorkBudget: 10, PreDrainBatchSize: 1, PreDrainWorkBudget: 10, FinalRowBudget: 10, FinalWorkBudget: 30}
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("validate history after concurrent writer: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("build indexes after concurrent writer: %v", err)
	}
	finishApprovalHistoryCutover(t, ctx, migrator, options)
}

func TestApprovalHistoryMigratorRecoversFailedValidation(t *testing.T) {
	db, provider := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	approvalID := insertMigratorApprovalRows(t, ctx, db, fixture, 1)[0]
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("structural 00012 migration: %v", err)
	}
	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	options := database.ApprovalHistoryMigrationOptions{BatchSize: 1, WorkBudget: 10, PreDrainBatchSize: 1, PreDrainWorkBudget: 10, FinalRowBudget: 10, FinalWorkBudget: 30}
	if _, err := migrator.RunBackfill(ctx, options); err != nil {
		t.Fatalf("run approval history backfill: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `UPDATE execution_approval_revisions SET summary = 'corrupt history' WHERE id = $1 AND revision = 1`, approvalID); err != nil {
		t.Fatalf("introduce history drift: %v", err)
	}
	if _, err := migrator.Validate(ctx, options); err == nil {
		t.Fatal("validation unexpectedly accepted drift")
	}
	progress, err := migrator.Progress(ctx)
	if err != nil {
		t.Fatalf("read failed validation progress: %v", err)
	}
	if progress.Phase != database.ApprovalHistoryPhaseFailed {
		t.Fatalf("failed validation phase = %q, want failed", progress.Phase)
	}
	if _, err := db.Pool().Exec(ctx, `UPDATE execution_approval_revisions AS history SET summary = current.summary FROM execution_approvals AS current WHERE history.id = current.id AND history.revision = current.revision AND history.id = $1`, approvalID); err != nil {
		t.Fatalf("repair history drift: %v", err)
	}
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("re-enter validation after repair: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("build indexes after validation repair: %v", err)
	}
	finishApprovalHistoryCutover(t, ctx, migrator, options)
}

func TestApprovalHistoryMigratorRepairsInvalidConcurrentIndex(t *testing.T) {
	db, provider := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	insertMigratorApprovalRows(t, ctx, db, fixture, 1)
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("structural 00012 migration: %v", err)
	}
	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	options := database.ApprovalHistoryMigrationOptions{BatchSize: 1, WorkBudget: 10, PreDrainBatchSize: 1, PreDrainWorkBudget: 10, FinalRowBudget: 10, FinalWorkBudget: 30, StatementTimeout: 5 * time.Second}
	if _, err := migrator.RunBackfill(ctx, options); err != nil {
		t.Fatalf("run approval history backfill: %v", err)
	}
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("validate approval history backfill: %v", err)
	}
	blockTx, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin index blocker: %v", err)
	}
	if _, err := blockTx.Exec(ctx, `LOCK TABLE execution_approval_revisions IN ACCESS EXCLUSIVE MODE`); err != nil {
		blockTx.Rollback(ctx)
		t.Fatalf("lock history table for index failure: %v", err)
	}
	failedOptions := options
	failedOptions.StatementTimeout = 100 * time.Millisecond
	if _, err := migrator.BuildIndexes(ctx, failedOptions); err == nil {
		t.Fatal("concurrent index build unexpectedly succeeded while table was blocked")
	}
	if err := blockTx.Rollback(ctx); err != nil {
		t.Fatalf("release index blocker: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("repair and rebuild concurrent indexes: %v", err)
	}
	var invalid int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace JOIN pg_index AS index_row ON index_row.indexrelid = relation.oid WHERE namespace.nspname = current_schema() AND relation.relname IN ('execution_approval_revisions_run_cursor_idx', 'execution_approval_revisions_requested_event_idx') AND (NOT index_row.indisvalid OR NOT index_row.indisready)`).Scan(&invalid); err != nil {
		t.Fatalf("inspect rebuilt concurrent indexes: %v", err)
	}
	if invalid != 0 {
		t.Fatalf("invalid approval history indexes after repair = %d, want 0", invalid)
	}
	finishApprovalHistoryCutover(t, ctx, migrator, options)
}

func TestApprovalHistoryMigratorKeepsCaptureOnCutoverLockTimeout(t *testing.T) {
	db, provider := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	approvalID := insertMigratorApprovalRows(t, ctx, db, fixture, 1)[0]
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("structural 00012 migration: %v", err)
	}
	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	options := database.ApprovalHistoryMigrationOptions{BatchSize: 1, WorkBudget: 10, PreDrainBatchSize: 1, PreDrainWorkBudget: 10, FinalRowBudget: 10, FinalWorkBudget: 30}
	if _, err := migrator.RunBackfill(ctx, options); err != nil {
		t.Fatalf("run approval history backfill: %v", err)
	}
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("validate approval history backfill: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("build approval history indexes: %v", err)
	}
	blockTx, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin cutover blocker: %v", err)
	}
	defer blockTx.Rollback(context.Background())
	if _, err := blockTx.Exec(ctx, `UPDATE execution_approvals SET summary = 'uncommitted blocker' WHERE id = $1`, approvalID); err != nil {
		t.Fatalf("hold projection writer during cutover: %v", err)
	}
	timeoutOptions := options
	timeoutOptions.LockTimeout = 50 * time.Millisecond
	if _, err := migrator.Cutover(ctx, timeoutOptions); err == nil {
		t.Fatal("cutover unexpectedly acquired blocked SHARE lock")
	}
	if err := blockTx.Rollback(ctx); err != nil {
		t.Fatalf("release cutover blocker: %v", err)
	}
	progress, err := migrator.Progress(ctx)
	if err != nil {
		t.Fatalf("read cutover timeout progress: %v", err)
	}
	if progress.Phase != database.ApprovalHistoryPhaseIndexesReady {
		t.Fatalf("phase after cutover lock timeout = %q, want indexes_ready", progress.Phase)
	}
	assertApprovalHistoryTriggerState(t, ctx, db, true, false)
	if _, err := db.Pool().Exec(ctx, `UPDATE execution_approval_history_migrations SET phase = 'cutover_requested' WHERE migration_key = 'approval-revision-history'`); err != nil {
		t.Fatalf("simulate interrupted cutover state: %v", err)
	}
	finishApprovalHistoryCutover(t, ctx, migrator, options)
}

func TestApprovalHistoryMigratorAdoptsAtomic00012(t *testing.T) {
	db, _ := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	insertMigratorApprovalRows(t, ctx, db, fixture, 1)
	applyAtomicApprovalHistoryFixture(t, ctx, db, false)

	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	progress, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{})
	if err != nil {
		t.Fatalf("adopt atomic approval history layout: %v", err)
	}
	if progress.Phase != database.ApprovalHistoryPhaseCutoverComplete || progress.RowsCopied != 1 {
		t.Fatalf("atomic adoption progress = %+v, want cutover_complete with one copied row", progress)
	}
	if err := migrator.Readiness(ctx); err != nil {
		t.Fatalf("readiness after atomic adoption: %v", err)
	}
	var applied int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM goose_db_version WHERE version_id = 12 AND is_applied`).Scan(&applied); err != nil {
		t.Fatalf("read adopted goose version: %v", err)
	}
	if applied != 1 {
		t.Fatalf("adopted goose version count = %d, want 1", applied)
	}
	assertApprovalHistoryTriggerState(t, ctx, db, false, true)
}

func TestApprovalHistoryMigratorRejectsUnrecognizedAtomicLayout(t *testing.T) {
	db, _ := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	applyAtomicApprovalHistoryFixture(t, ctx, db, true)

	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); !errors.Is(err, database.ErrApprovalHistoryAtomicAdoption) {
		t.Fatalf("unrecognized atomic layout error = %v, want ErrApprovalHistoryAtomicAdoption", err)
	}
	var stateTable string
	if err := db.Pool().QueryRow(ctx, `SELECT COALESCE(to_regclass(format('%I.%I', current_schema(), 'execution_approval_history_migrations'))::text, '')`).Scan(&stateTable); err != nil {
		t.Fatalf("inspect rejected adoption state table: %v", err)
	}
	if stateTable != "" {
		t.Fatalf("rejected adoption created state table %q", stateTable)
	}
}

func insertMigratorApprovalRows(t *testing.T, ctx context.Context, db *database.DB, fixture approvalFixture, count int) []string {
	t.Helper()
	ids := make([]string, 0, count)
	for index := 0; index < count; index++ {
		approvalID := fmt.Sprintf("%s-migrator-%d", fixture.approvalID, index)
		if _, err := db.Pool().Exec(ctx, `
			INSERT INTO execution_approvals (id, session_id, run_id, generation, kind, requested_at, revision, status, summary, context, requested_event_id)
			VALUES ($1, $2, $3, $4, 'command', $5, 1, 'pending', $6, $7, $8)
		`, approvalID, fixture.sessionID, fixture.runID, fixture.generation, fmt.Sprintf("2026-10-27T04:40:%02dZ", index), "migrator seed", []byte(fmt.Sprintf(`{"index":%d}`, index)), approvalID+"-event"); err != nil {
			t.Fatalf("seed migrator approval row %d: %v", index, err)
		}
		ids = append(ids, approvalID)
	}
	return ids
}

func finishApprovalHistoryCutover(t *testing.T, ctx context.Context, migrator *database.ApprovalHistoryMigrator, options database.ApprovalHistoryMigrationOptions) {
	t.Helper()
	if _, err := migrator.Cutover(ctx, options); err != nil {
		t.Fatalf("finish approval history cutover for test cleanup: %v", err)
	}
}

func applyAtomicApprovalHistoryFixture(t *testing.T, ctx context.Context, db *database.DB, removeGuard bool) {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate atomic approval history fixture")
	}
	fixtureSQL, err := os.ReadFile(filepath.Join(filepath.Dir(filename), "testdata", "atomic_00012_up.sql"))
	if err != nil {
		t.Fatalf("read atomic approval history fixture: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, string(fixtureSQL)); err != nil {
		t.Fatalf("apply atomic approval history fixture: %v", err)
	}
	if removeGuard {
		if _, err := db.Pool().Exec(ctx, `DROP TRIGGER execution_approvals_history_writer_guard ON execution_approvals; DROP FUNCTION loomhelm_require_approval_history_writer();`); err != nil {
			t.Fatalf("remove atomic approval history writer guard: %v", err)
		}
	}
	if _, err := db.Pool().Exec(ctx, `INSERT INTO goose_db_version (version_id, is_applied) VALUES (12, true)`); err != nil {
		t.Fatalf("record atomic goose version: %v", err)
	}
}

func assertApprovalHistoryTriggerState(t *testing.T, ctx context.Context, db *database.DB, capture, guard bool) {
	t.Helper()
	var captureExists, guardExists bool
	if err := db.Pool().QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_trigger AS trigger_row JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = current_schema() AND relation.relname = 'execution_approvals' AND trigger_row.tgname = 'execution_approvals_history_capture')`).Scan(&captureExists); err != nil {
		t.Fatalf("read capture trigger state: %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_trigger AS trigger_row JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = current_schema() AND relation.relname = 'execution_approvals' AND trigger_row.tgname = 'execution_approvals_history_writer_guard')`).Scan(&guardExists); err != nil {
		t.Fatalf("read writer guard trigger state: %v", err)
	}
	if captureExists != capture || guardExists != guard {
		t.Fatalf("approval history trigger state = capture %t/guard %t, want capture %t/guard %t", captureExists, guardExists, capture, guard)
	}
}

func waitForApprovalShareLock(ctx context.Context, db *database.DB) error {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := db.Pool().QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE relation = to_regclass(current_schema() || '.execution_approvals') AND mode = 'ShareLock' AND granted = false)`).Scan(&waiting); err != nil {
			return err
		}
		if waiting {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func waitForApprovalRowShareLock(ctx context.Context, db *database.DB) error {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var held bool
		if err := db.Pool().QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE relation = to_regclass(current_schema() || '.execution_approvals') AND mode = 'RowShareLock' AND granted)`).Scan(&held); err != nil {
			return err
		}
		if held {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
