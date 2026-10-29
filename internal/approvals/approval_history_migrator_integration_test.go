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

func TestApprovalHistoryMigratorPreservesLegacyProjectionCursorTimestamps(t *testing.T) {
	db, provider := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	ids := []string{fixture.approvalID + "-legacy-a", fixture.approvalID + "-legacy-b"}
	createdAt := []time.Time{
		time.Date(2025, 10, 27, 4, 30, 1, 0, time.UTC),
		time.Date(2025, 10, 27, 4, 30, 2, 0, time.UTC),
	}
	updatedAt := time.Date(2025, 10, 27, 4, 30, 3, 0, time.UTC)
	for index, approvalID := range ids {
		if _, err := db.Pool().Exec(ctx, `
			INSERT INTO execution_approvals (
				id, session_id, run_id, generation, kind, requested_at, revision,
				status, summary, context, requested_event_id, created_at, updated_at
			)
			VALUES ($1, $2, $3, $4, 'command', $5, 1, 'pending', 'legacy seed', $6, $7, $8, $8)
		`, approvalID, fixture.sessionID, fixture.runID, fixture.generation, fmt.Sprintf("2025-10-27T04:30:0%dZ", index+1), []byte(`{"legacy":true}`), approvalID+"-event", createdAt[index]); err != nil {
			t.Fatalf("seed legacy approval row %d: %v", index, err)
		}
	}
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("structural 00012 migration: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `
		UPDATE execution_approvals
		SET summary = 'legacy mutation before backfill', updated_at = $2
		WHERE id = $1
	`, ids[0], updatedAt); err != nil {
		t.Fatalf("mutate legacy projection during capture: %v", err)
	}
	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	options := database.ApprovalHistoryMigrationOptions{BatchSize: 8, WorkBudget: 100, PreDrainBatchSize: 8, PreDrainWorkBudget: 100}
	if _, err := migrator.RunBackfill(ctx, options); err != nil {
		t.Fatalf("run legacy timestamp backfill: %v", err)
	}
	var historyCreatedAt, historyUpdatedAt time.Time
	if err := db.Pool().QueryRow(ctx, `
		SELECT created_at, updated_at
		FROM execution_approval_revisions
		WHERE id = $1 AND revision = 1
	`, ids[0]).Scan(&historyCreatedAt, &historyUpdatedAt); err != nil {
		t.Fatalf("read legacy history timestamps: %v", err)
	}
	if !historyCreatedAt.Equal(createdAt[0]) || !historyUpdatedAt.Equal(updatedAt) {
		t.Fatalf("legacy history timestamps = created %s updated %s, want created %s updated %s", historyCreatedAt, historyUpdatedAt, createdAt[0], updatedAt)
	}

	type cursorKey struct {
		id        string
		createdAt time.Time
		revision  int64
	}
	readCursor := func(query string, args ...any) []cursorKey {
		t.Helper()
		rows, err := db.Pool().Query(ctx, query, args...)
		if err != nil {
			t.Fatalf("read approval cursor: %v", err)
		}
		defer rows.Close()
		var result []cursorKey
		for rows.Next() {
			var row cursorKey
			if err := rows.Scan(&row.id, &row.createdAt, &row.revision); err != nil {
				t.Fatalf("scan approval cursor: %v", err)
			}
			result = append(result, row)
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("read approval cursor rows: %v", err)
		}
		return result
	}
	projectionCursor := readCursor(`SELECT id, created_at, revision FROM execution_approvals ORDER BY created_at, id, revision`)
	historyCursor := readCursor(`SELECT id, created_at, revision FROM execution_approval_revisions WHERE id = ANY($1::text[]) ORDER BY created_at, id, revision`, ids)
	if len(projectionCursor) != len(historyCursor) {
		t.Fatalf("projection/history cursor lengths = %d/%d", len(projectionCursor), len(historyCursor))
	}
	for index := range projectionCursor {
		if projectionCursor[index].id != historyCursor[index].id || !projectionCursor[index].createdAt.Equal(historyCursor[index].createdAt) || projectionCursor[index].revision != historyCursor[index].revision {
			t.Fatalf("projection/history cursor row %d = %+v/%+v", index, projectionCursor[index], historyCursor[index])
		}
	}
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("validate legacy timestamp backfill: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("build legacy timestamp indexes: %v", err)
	}
	if _, err := migrator.Cutover(ctx, options); err != nil {
		t.Fatalf("cut over legacy timestamp migration: %v", err)
	}
}

func TestApprovalHistoryMigratorRepairsLegacyTriggerTimestampsAndCursor(t *testing.T) {
	db, provider := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	approvalID := fixture.approvalID + "-old-trigger"
	projectionCreatedAt := time.Date(2025, 10, 27, 4, 30, 1, 0, time.UTC)
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_approvals (
			id, session_id, run_id, generation, kind, requested_at, revision,
			status, summary, context, requested_event_id, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, 'command', $5, 1, 'pending', 'legacy projection', $6, $7, $8, $8)
	`, approvalID, fixture.sessionID, fixture.runID, fixture.generation, "2025-10-27T04:30:01Z", []byte(`{"legacy":true}`), approvalID+"-event", projectionCreatedAt); err != nil {
		t.Fatalf("seed legacy projection: %v", err)
	}
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("apply structural 00012: %v", err)
	}
	installLegacyApprovalCapture(t, ctx, db)
	for revision := int64(2); revision <= 3; revision++ {
		if _, err := db.Pool().Exec(ctx, `
			UPDATE execution_approvals
			SET revision = $2, summary = $3
			WHERE id = $1
		`, approvalID, revision, fmt.Sprintf("legacy revision %d", revision)); err != nil {
			t.Fatalf("capture legacy revision %d: %v", revision, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	before := readApprovalHistoryTimestampRows(t, ctx, db, approvalID)
	if len(before) != 2 || before[0].revision != 2 || before[1].revision != 3 {
		t.Fatalf("legacy trigger rows before repair = %+v, want revisions 2 and 3", before)
	}
	if before[0].createdAt.Equal(projectionCreatedAt) {
		t.Fatalf("legacy trigger unexpectedly preserved revision 2 created_at before repair: %s", before[0].createdAt)
	}

	migrator := database.NewApprovalHistoryMigrator(db.Pool(), database.ApprovalHistoryMigratorConfig{LeaseOwner: "legacy-trigger-reentry-owner"})
	options := database.ApprovalHistoryMigrationOptions{
		BatchSize:          1,
		WorkBudget:         1,
		PreDrainBatchSize:  1,
		PreDrainWorkBudget: 10,
		FinalRowBudget:     10,
		FinalWorkBudget:    30,
	}
	progress, err := migrator.RunBackfill(ctx, options)
	if err != nil {
		t.Fatalf("bounded legacy trigger backfill: %v", err)
	}
	if progress.Phase != database.ApprovalHistoryPhaseBackfillPaused {
		t.Fatalf("bounded legacy trigger phase = %q, want backfill_paused", progress.Phase)
	}
	assertApprovalHistoryLeaseReleased(t, ctx, db, database.ApprovalHistoryPhaseBackfillPaused)
	progress, err = migrator.RunBackfill(ctx, options)
	if err != nil {
		t.Fatalf("re-enter legacy trigger backfill: %v", err)
	}
	if progress.Phase != database.ApprovalHistoryPhaseBackfillComplete {
		t.Fatalf("re-entered legacy trigger phase = %q, want backfill_complete", progress.Phase)
	}
	assertApprovalHistoryLeaseReleased(t, ctx, db, database.ApprovalHistoryPhaseBackfillComplete)
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("validate repaired legacy trigger history: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("build repaired legacy trigger indexes: %v", err)
	}
	if _, err := migrator.Cutover(ctx, options); err != nil {
		t.Fatalf("cut over repaired legacy trigger history: %v", err)
	}

	after := readApprovalHistoryTimestampRows(t, ctx, db, approvalID)
	if len(after) != len(before) {
		t.Fatalf("legacy trigger rows after repair = %+v, want %d rows", after, len(before))
	}
	if !after[0].createdAt.Equal(projectionCreatedAt) {
		t.Fatalf("earliest legacy history created_at = %s, want projection baseline %s", after[0].createdAt, projectionCreatedAt)
	}
	if !after[0].updatedAt.Equal(before[0].updatedAt) {
		t.Fatalf("earliest legacy history updated_at = %s, want preserved %s", after[0].updatedAt, before[0].updatedAt)
	}
	if !after[1].createdAt.Equal(before[1].createdAt) || !after[1].updatedAt.Equal(before[1].updatedAt) {
		t.Fatalf("later legacy history timestamps = %+v, want unchanged %+v", after[1], before[1])
	}
	var revisionOneCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM execution_approval_revisions WHERE id = $1 AND revision = 1`, approvalID).Scan(&revisionOneCount); err != nil {
		t.Fatalf("count fabricated revision 1: %v", err)
	}
	if revisionOneCount != 0 {
		t.Fatalf("fabricated revision 1 count = %d, want 0", revisionOneCount)
	}
	var projectionRevision int64
	var currentCreatedAt time.Time
	if err := db.Pool().QueryRow(ctx, `SELECT revision, created_at FROM execution_approvals WHERE id = $1`, approvalID).Scan(&projectionRevision, &currentCreatedAt); err != nil {
		t.Fatalf("read repaired projection identity: %v", err)
	}
	if projectionRevision != 3 || !currentCreatedAt.Equal(projectionCreatedAt) {
		t.Fatalf("repaired projection = revision %d created_at %s, want revision 3 baseline %s", projectionRevision, currentCreatedAt, projectionCreatedAt)
	}

	store := NewStore(db.Pool())
	firstPage, err := store.ListByRun(ctx, fixture.runID, nil, 1)
	if err != nil {
		t.Fatalf("list repaired approval history: %v", err)
	}
	if len(firstPage.Items) != 1 || firstPage.Items[0].ID != approvalID || firstPage.Items[0].Revision != 2 || firstPage.NextCursor == nil {
		t.Fatalf("first repaired approval page = %+v, want revision 2 with cursor", firstPage)
	}
	legacyCursor := *firstPage.NextCursor
	legacyCursor.Version = 1
	legacyCursor.Revision = 0
	resumedPage, err := store.ListByRun(ctx, fixture.runID, &legacyCursor, 10)
	if err != nil {
		t.Fatalf("resume repaired approval history with legacy cursor: %v", err)
	}
	if len(resumedPage.Items) != 1 || resumedPage.Items[0].ID != approvalID || resumedPage.Items[0].Revision != 3 {
		t.Fatalf("resumed repaired approval page = %+v, want only revision 3", resumedPage)
	}

	if progress, err := migrator.RunBackfill(ctx, options); err != nil {
		t.Fatalf("idempotent legacy trigger backfill re-entry after cutover: %v", err)
	} else if progress.Phase != database.ApprovalHistoryPhaseCutoverComplete {
		t.Fatalf("post-cutover legacy trigger re-entry phase = %q, want cutover_complete", progress.Phase)
	}
	reentered := readApprovalHistoryTimestampRows(t, ctx, db, approvalID)
	for index := range after {
		if reentered[index] != after[index] {
			t.Fatalf("post-cutover re-entry changed history row %d = %+v, want %+v", index, reentered[index], after[index])
		}
	}
}

type approvalHistoryTimestampRow struct {
	revision  int64
	createdAt time.Time
	updatedAt time.Time
}

func readApprovalHistoryTimestampRows(t *testing.T, ctx context.Context, db *database.DB, approvalID string) []approvalHistoryTimestampRow {
	t.Helper()
	rows, err := db.Pool().Query(ctx, `
		SELECT revision, created_at, updated_at
		FROM execution_approval_revisions
		WHERE id = $1
		ORDER BY revision
	`, approvalID)
	if err != nil {
		t.Fatalf("read approval history timestamps: %v", err)
	}
	defer rows.Close()
	result := make([]approvalHistoryTimestampRow, 0, 2)
	for rows.Next() {
		var row approvalHistoryTimestampRow
		if err := rows.Scan(&row.revision, &row.createdAt, &row.updatedAt); err != nil {
			t.Fatalf("scan approval history timestamps: %v", err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read approval history timestamp rows: %v", err)
	}
	return result
}

func installLegacyApprovalCapture(t *testing.T, ctx context.Context, db *database.DB) {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate legacy approval capture fixture")
	}
	legacySQL, err := os.ReadFile(filepath.Join(filepath.Dir(filename), "testdata", "legacy_capture_00012.sql"))
	if err != nil {
		t.Fatalf("read legacy approval capture fixture: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, string(legacySQL)); err != nil {
		t.Fatalf("install legacy approval capture fixture: %v", err)
	}
}

func assertApprovalHistoryLeaseReleased(t *testing.T, ctx context.Context, db *database.DB, wantPhase database.ApprovalHistoryMigrationPhase) {
	t.Helper()
	var phase database.ApprovalHistoryMigrationPhase
	var owner string
	if err := db.Pool().QueryRow(ctx, `
		SELECT phase, lease_owner
		FROM execution_approval_history_migrations
		WHERE migration_key = 'approval-revision-history'
	`).Scan(&phase, &owner); err != nil {
		t.Fatalf("read approval history lease state: %v", err)
	}
	if phase != wantPhase || owner != "" {
		t.Fatalf("approval history lease state = phase %q owner %q, want phase %q with no owner", phase, owner, wantPhase)
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

func TestApprovalHistoryMigratorRejectsMarkerOnlyWriterGuard(t *testing.T) {
	t.Run("adoption", func(t *testing.T) {
		db, _ := openApprovalFixtureDatabaseThrough(t, 11)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		applyAtomicApprovalHistoryFixture(t, ctx, db, false)
		installMarkerOnlyWriterGuardNearMiss(t, ctx, db)

		migrator := database.NewApprovalHistoryMigrator(db.Pool())
		if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); !errors.Is(err, database.ErrApprovalHistoryAtomicAdoption) {
			t.Fatalf("marker-only writer guard adoption error = %v, want ErrApprovalHistoryAtomicAdoption", err)
		}
		var stateTable string
		if err := db.Pool().QueryRow(ctx, `SELECT COALESCE(to_regclass(format('%I.%I', current_schema(), 'execution_approval_history_migrations'))::text, '')`).Scan(&stateTable); err != nil {
			t.Fatalf("inspect marker-only adoption state table: %v", err)
		}
		if stateTable != "" {
			t.Fatalf("marker-only writer guard adoption created state table %q", stateTable)
		}
	})

	t.Run("readiness", func(t *testing.T) {
		db, _ := openApprovalFixtureDatabaseThrough(t, 11)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		applyAtomicApprovalHistoryFixture(t, ctx, db, false)

		migrator := database.NewApprovalHistoryMigrator(db.Pool())
		if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); err != nil {
			t.Fatalf("adopt official writer guard before near-miss readiness: %v", err)
		}
		installMarkerOnlyWriterGuardNearMiss(t, ctx, db)
		if err := migrator.Readiness(ctx); !errors.Is(err, database.ErrApprovalHistoryMigrationUnavailable) {
			t.Fatalf("marker-only migrator readiness error = %v, want ErrApprovalHistoryMigrationUnavailable", err)
		}
		store := NewStore(db.Pool())
		if err := store.CheckHistoryReadiness(ctx); !errors.Is(err, ErrApprovalHistoryUnavailable) {
			t.Fatalf("marker-only store readiness error = %v, want ErrApprovalHistoryUnavailable", err)
		}
		if err := store.CheckHistoryConsistency(ctx); !errors.Is(err, ErrApprovalHistoryUnavailable) {
			t.Fatalf("marker-only store consistency error = %v, want ErrApprovalHistoryUnavailable", err)
		}
	})
}

func TestApprovalHistoryMigratorRejectsCommentOnlyWriterGuard(t *testing.T) {
	t.Run("adoption", func(t *testing.T) {
		db, _ := openApprovalFixtureDatabaseThrough(t, 11)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		applyAtomicApprovalHistoryFixture(t, ctx, db, false)
		installCommentOnlyWriterGuardNearMiss(t, ctx, db)

		migrator := database.NewApprovalHistoryMigrator(db.Pool())
		if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); !errors.Is(err, database.ErrApprovalHistoryAtomicAdoption) {
			t.Fatalf("comment-only writer guard adoption error = %v, want ErrApprovalHistoryAtomicAdoption", err)
		}
	})

	t.Run("readiness", func(t *testing.T) {
		db, _ := openApprovalFixtureDatabaseThrough(t, 11)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		applyAtomicApprovalHistoryFixture(t, ctx, db, false)

		migrator := database.NewApprovalHistoryMigrator(db.Pool())
		if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); err != nil {
			t.Fatalf("adopt official writer guard before comment-only readiness: %v", err)
		}
		installCommentOnlyWriterGuardNearMiss(t, ctx, db)
		if err := migrator.Readiness(ctx); !errors.Is(err, database.ErrApprovalHistoryMigrationUnavailable) {
			t.Fatalf("comment-only migrator readiness error = %v, want ErrApprovalHistoryMigrationUnavailable", err)
		}
		store := NewStore(db.Pool())
		if err := store.CheckHistoryReadiness(ctx); !errors.Is(err, ErrApprovalHistoryUnavailable) {
			t.Fatalf("comment-only store readiness error = %v, want ErrApprovalHistoryUnavailable", err)
		}
		if err := store.CheckHistoryConsistency(ctx); !errors.Is(err, ErrApprovalHistoryUnavailable) {
			t.Fatalf("comment-only store consistency error = %v, want ErrApprovalHistoryUnavailable", err)
		}
	})
}

func TestApprovalHistoryMigratorRejectsAtomicLayoutWithCaptureModes(t *testing.T) {
	modes := []struct {
		name  string
		alter string
		want  string
	}{
		{name: "origin", want: "O"},
		{name: "always", alter: "ALTER TABLE execution_approvals ENABLE ALWAYS TRIGGER execution_approvals_history_capture", want: "A"},
		{name: "replica", alter: "ALTER TABLE execution_approvals ENABLE REPLICA TRIGGER execution_approvals_history_capture", want: "R"},
		{name: "disabled", alter: "ALTER TABLE execution_approvals DISABLE TRIGGER execution_approvals_history_capture", want: "D"},
	}
	for _, mode := range modes {
		mode := mode
		t.Run("adopt/"+mode.name, func(t *testing.T) {
			db, _ := openApprovalFixtureDatabaseThrough(t, 11)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			applyAtomicApprovalHistoryFixture(t, ctx, db, false)
			installAtomicCaptureNearMiss(t, ctx, db, mode.alter)

			assertApprovalHistoryTriggerState(t, ctx, db, true, true)
			var triggerMode string
			if err := db.Pool().QueryRow(ctx, `SELECT trigger_row.tgenabled
				FROM pg_trigger AS trigger_row
				JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
				JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				WHERE namespace.nspname = current_schema()
				  AND relation.relname = 'execution_approvals'
				  AND trigger_row.tgname = 'execution_approvals_history_capture'
				  AND NOT trigger_row.tgisinternal`).Scan(&triggerMode); err != nil {
				t.Fatalf("read %s capture trigger mode: %v", mode.name, err)
			}
			if triggerMode != mode.want {
				t.Fatalf("%s capture trigger mode = %q, want %q", mode.name, triggerMode, mode.want)
			}

			migrator := database.NewApprovalHistoryMigrator(db.Pool())
			if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); !errors.Is(err, database.ErrApprovalHistoryAtomicAdoption) {
				t.Fatalf("%s-capture atomic layout error = %v, want ErrApprovalHistoryAtomicAdoption", mode.name, err)
			}
			var stateTable string
			if err := db.Pool().QueryRow(ctx, `SELECT COALESCE(to_regclass(format('%I.%I', current_schema(), 'execution_approval_history_migrations'))::text, '')`).Scan(&stateTable); err != nil {
				t.Fatalf("inspect %s-capture adoption state table: %v", mode.name, err)
			}
			if stateTable != "" {
				t.Fatalf("%s-capture near miss created migration state table %q", mode.name, stateTable)
			}
		})
	}
}

func TestApprovalHistoryGuardsRequireExactWriterTriggerShape(t *testing.T) {
	shapes := []struct {
		name       string
		definition string
	}{
		{name: "insert-only-row-before", definition: "BEFORE INSERT ON execution_approvals FOR EACH ROW"},
		{name: "statement-level", definition: "BEFORE INSERT OR UPDATE OR DELETE ON execution_approvals FOR EACH STATEMENT"},
		{name: "after-row", definition: "AFTER INSERT OR UPDATE OR DELETE ON execution_approvals FOR EACH ROW"},
		{name: "column-filtered-update", definition: "BEFORE INSERT OR UPDATE OF summary OR DELETE ON execution_approvals FOR EACH ROW"},
		{name: "conditional", definition: "BEFORE INSERT OR UPDATE OR DELETE ON execution_approvals FOR EACH ROW WHEN (true)"},
	}
	for _, shape := range shapes {
		shape := shape
		t.Run("adopt/"+shape.name, func(t *testing.T) {
			db, _ := openApprovalFixtureDatabaseThrough(t, 11)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			applyAtomicApprovalHistoryFixture(t, ctx, db, false)
			setApprovalHistoryWriterGuardShape(t, ctx, db, shape.definition)

			migrator := database.NewApprovalHistoryMigrator(db.Pool())
			if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); !errors.Is(err, database.ErrApprovalHistoryAtomicAdoption) {
				t.Fatalf("%s atomic layout error = %v, want ErrApprovalHistoryAtomicAdoption", shape.name, err)
			}
			var stateTable string
			if err := db.Pool().QueryRow(ctx, `SELECT COALESCE(to_regclass(format('%I.%I', current_schema(), 'execution_approval_history_migrations'))::text, '')`).Scan(&stateTable); err != nil {
				t.Fatalf("inspect rejected %s adoption state table: %v", shape.name, err)
			}
			if stateTable != "" {
				t.Fatalf("rejected %s adoption created state table %q", shape.name, stateTable)
			}
		})
	}

	db, _ := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	applyAtomicApprovalHistoryFixture(t, ctx, db, false)
	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); err != nil {
		t.Fatalf("adopt correct atomic layout: %v", err)
	}
	store := NewStore(db.Pool())
	for _, shape := range shapes {
		shape := shape
		t.Run("readiness/"+shape.name, func(t *testing.T) {
			setApprovalHistoryWriterGuardShape(t, ctx, db, shape.definition)
			if err := migrator.Readiness(ctx); !errors.Is(err, database.ErrApprovalHistoryMigrationUnavailable) {
				t.Fatalf("%s migrator readiness error = %v, want ErrApprovalHistoryMigrationUnavailable", shape.name, err)
			}
			if err := store.CheckHistoryReadiness(ctx); !errors.Is(err, ErrApprovalHistoryUnavailable) {
				t.Fatalf("%s store readiness error = %v, want ErrApprovalHistoryUnavailable", shape.name, err)
			}
		})
	}
	setApprovalHistoryWriterGuardShape(t, ctx, db, "BEFORE INSERT OR UPDATE OR DELETE ON execution_approvals FOR EACH ROW")
	if err := migrator.Readiness(ctx); err != nil {
		t.Fatalf("migrator readiness after correct guard restore: %v", err)
	}
	if err := store.CheckHistoryReadiness(ctx); err != nil {
		t.Fatalf("store readiness after correct guard restore: %v", err)
	}
}

func TestApprovalHistoryGuardsRejectFunctionWriterConfig(t *testing.T) {
	t.Run("adoption", func(t *testing.T) {
		db, _ := openApprovalFixtureDatabaseThrough(t, 11)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		applyAtomicApprovalHistoryFixture(t, ctx, db, false)
		setApprovalHistoryWriterFunctionConfig(t, ctx, db)

		migrator := database.NewApprovalHistoryMigrator(db.Pool())
		if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); !errors.Is(err, database.ErrApprovalHistoryAtomicAdoption) {
			t.Fatalf("function-configured writer guard adoption error = %v, want ErrApprovalHistoryAtomicAdoption", err)
		}
		var stateTable string
		if err := db.Pool().QueryRow(ctx, `SELECT COALESCE(to_regclass(format('%I.%I', current_schema(), 'execution_approval_history_migrations'))::text, '')`).Scan(&stateTable); err != nil {
			t.Fatalf("inspect function-configured adoption state table: %v", err)
		}
		if stateTable != "" {
			t.Fatalf("function-configured writer guard adoption created state table %q", stateTable)
		}
	})

	t.Run("readiness", func(t *testing.T) {
		db, _ := openApprovalFixtureDatabaseThrough(t, 11)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		applyAtomicApprovalHistoryFixture(t, ctx, db, false)

		migrator := database.NewApprovalHistoryMigrator(db.Pool())
		if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); err != nil {
			t.Fatalf("adopt official writer guard before function-configured readiness: %v", err)
		}
		setApprovalHistoryWriterFunctionConfig(t, ctx, db)
		if err := migrator.Readiness(ctx); !errors.Is(err, database.ErrApprovalHistoryMigrationUnavailable) {
			t.Fatalf("function-configured migrator readiness error = %v, want ErrApprovalHistoryMigrationUnavailable", err)
		}
		store := NewStore(db.Pool())
		if err := store.CheckHistoryReadiness(ctx); !errors.Is(err, ErrApprovalHistoryUnavailable) {
			t.Fatalf("function-configured store readiness error = %v, want ErrApprovalHistoryUnavailable", err)
		}
		if err := store.CheckHistoryConsistency(ctx); !errors.Is(err, ErrApprovalHistoryUnavailable) {
			t.Fatalf("function-configured store consistency error = %v, want ErrApprovalHistoryUnavailable", err)
		}
	})
}

func setApprovalHistoryWriterGuardShape(t *testing.T, ctx context.Context, db *database.DB, definition string) {
	t.Helper()
	query := fmt.Sprintf(`
		DROP TRIGGER execution_approvals_history_writer_guard ON execution_approvals;
		CREATE TRIGGER execution_approvals_history_writer_guard
		%s
		EXECUTE FUNCTION loomhelm_require_approval_history_writer();
	`, definition)
	if _, err := db.Pool().Exec(ctx, query); err != nil {
		t.Fatalf("install writer guard shape %q: %v", definition, err)
	}
}

func setApprovalHistoryWriterFunctionConfig(t *testing.T, ctx context.Context, db *database.DB) {
	t.Helper()
	if _, err := db.Pool().Exec(ctx, `ALTER FUNCTION loomhelm_require_approval_history_writer() SET loomhelm.approval_writer_capability = 'revision-history-v1'`); err != nil {
		t.Fatalf("install writer guard function config: %v", err)
	}
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

func TestApprovalHistoryMigratorRejectsAtomicLayoutWithWrongPrimaryKey(t *testing.T) {
	db, _ := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	applyAtomicApprovalHistoryFixture(t, ctx, db, false)
	if _, err := db.Pool().Exec(ctx, `
		ALTER TABLE execution_approval_revisions DROP CONSTRAINT execution_approval_revisions_pkey;
		ALTER TABLE execution_approval_revisions ADD CONSTRAINT execution_approval_revisions_pkey PRIMARY KEY (revision, id)
	`); err != nil {
		t.Fatalf("install wrong approval history primary key: %v", err)
	}

	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	if _, err := migrator.AdoptAtomic00012(ctx, database.ApprovalHistoryMigrationOptions{}); !errors.Is(err, database.ErrApprovalHistoryAtomicAdoption) {
		t.Fatalf("wrong-primary-key atomic layout error = %v, want ErrApprovalHistoryAtomicAdoption", err)
	}
	var stateTable string
	if err := db.Pool().QueryRow(ctx, `SELECT COALESCE(to_regclass(format('%I.%I', current_schema(), 'execution_approval_history_migrations'))::text, '')`).Scan(&stateTable); err != nil {
		t.Fatalf("inspect wrong-primary-key adoption state table: %v", err)
	}
	if stateTable != "" {
		t.Fatalf("wrong-primary-key adoption created state table %q", stateTable)
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

func installAtomicCaptureNearMiss(t *testing.T, ctx context.Context, db *database.DB, alterSQL string) {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate capture near-miss fixture")
	}
	fixtureSQL, err := os.ReadFile(filepath.Join(filepath.Dir(filename), "testdata", "atomic_00012_enabled_capture_near_miss.sql"))
	if err != nil {
		t.Fatalf("read capture near-miss fixture: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, string(fixtureSQL)); err != nil {
		t.Fatalf("install capture near-miss fixture: %v", err)
	}
	if alterSQL != "" {
		if _, err := db.Pool().Exec(ctx, alterSQL); err != nil {
			t.Fatalf("set capture near-miss trigger mode with %q: %v", alterSQL, err)
		}
	}
}

func installMarkerOnlyWriterGuardNearMiss(t *testing.T, ctx context.Context, db *database.DB) {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate marker-only writer guard near-miss fixture")
	}
	fixtureSQL, err := os.ReadFile(filepath.Join(filepath.Dir(filename), "testdata", "atomic_00012_marker_only_guard_near_miss.sql"))
	if err != nil {
		t.Fatalf("read marker-only writer guard near-miss fixture: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, string(fixtureSQL)); err != nil {
		t.Fatalf("install marker-only writer guard near-miss fixture: %v", err)
	}
}

func installCommentOnlyWriterGuardNearMiss(t *testing.T, ctx context.Context, db *database.DB) {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate comment-only writer guard near-miss fixture")
	}
	fixtureSQL, err := os.ReadFile(filepath.Join(filepath.Dir(filename), "testdata", "atomic_00012_comment_only_guard_near_miss.sql"))
	if err != nil {
		t.Fatalf("read comment-only writer guard near-miss fixture: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, string(fixtureSQL)); err != nil {
		t.Fatalf("install comment-only writer guard near-miss fixture: %v", err)
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
