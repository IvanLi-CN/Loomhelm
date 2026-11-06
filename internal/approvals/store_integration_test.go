package approvals

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/db/migrations"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

func TestApprovalHistoryMigrationExecutesGoosePLpgSQLBlocks(t *testing.T) {
	db := openApprovalFixtureDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var applied, functionCount, triggerCount int
	if err := db.Pool().QueryRow(ctx, `
		SELECT count(*)
		FROM goose_db_version
		WHERE version_id = 12 AND is_applied
	`).Scan(&applied); err != nil {
		t.Fatalf("read applied 00012 migration: %v", err)
	}
	if applied != 1 {
		t.Fatalf("applied 00012 migration count = %d, want 1", applied)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT count(*)
		FROM pg_proc AS proc
		JOIN pg_namespace AS ns ON ns.oid = proc.pronamespace
		WHERE ns.nspname = current_schema()
		  AND proc.proname = 'loomhelm_require_approval_history_writer'
	`).Scan(&functionCount); err != nil {
		t.Fatalf("read approval history writer function: %v", err)
	}
	if functionCount != 1 {
		t.Fatalf("approval history writer function count = %d, want 1", functionCount)
	}
	if err := db.Pool().QueryRow(ctx, `
		SELECT count(*)
		FROM pg_trigger AS trg
		JOIN pg_class AS rel ON rel.oid = trg.tgrelid
		JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
		WHERE ns.nspname = current_schema()
		  AND rel.relname = 'execution_approvals'
		  AND trg.tgname = 'execution_approvals_history_writer_guard'
	`).Scan(&triggerCount); err != nil {
		t.Fatalf("read approval history writer trigger: %v", err)
	}
	if triggerCount != 1 {
		t.Fatalf("approval history writer trigger count = %d, want 1", triggerCount)
	}
}

func TestApprovalHistoryStoreWritesAllTransitionsWithLocalCapability(t *testing.T) {
	db := openApprovalFixtureDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	store := NewStore(db.Pool(), StoreConfig{Now: func() time.Time {
		return time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	}})

	created, err := store.Create(ctx, CreateRequest{
		NewInput: NewInput{
			ID:          fixture.approvalID,
			RunID:       fixture.runID,
			SessionID:   fixture.sessionID,
			Generation:  fixture.generation,
			Revision:    1,
			Kind:        "command",
			Summary:     "initial approval",
			RequestedAt: "2026-10-27T04:00:00Z",
		},
		Context:          json.RawMessage(`{"step":1,"unknown":"retain"}`),
		RequestedEventID: fixture.approvalID + "-event-1",
	})
	if err != nil {
		t.Fatalf("create approval: %v", err)
	}
	if created.ID != fixture.approvalID || created.Revision != 1 {
		t.Fatalf("created approval = %+v", created)
	}

	advanced, err := store.AdvanceRevision(ctx, fixture.approvalID, fixture.generation, 2, "revised approval", "2026-10-27T04:01:00Z")
	if err != nil {
		t.Fatalf("advance approval revision: %v", err)
	}
	if advanced.Revision != 2 || advanced.Status != protocol.ApprovalStatusPending || advanced.RequestedEventID != "" {
		t.Fatalf("advanced approval = %+v", advanced)
	}

	resolved, err := store.Resolve(ctx, ResolveRequest{
		ApprovalID: fixture.approvalID,
		RunID:      fixture.runID,
		SessionID:  fixture.sessionID,
		Generation: fixture.generation,
		Request: protocol.ResolveApprovalRequest{
			CommandID: fixture.approvalID + "-resolve",
			Decision:  protocol.ApprovalDecisionApprove,
			Revision:  2,
		},
	})
	if err != nil {
		t.Fatalf("resolve approval: %v", err)
	}
	if resolved.Approval.Status != protocol.ApprovalStatusApproved || resolved.Deduplicated {
		t.Fatalf("resolved approval = %+v", resolved)
	}

	expiringID := fixture.approvalID + "-expire"
	if _, err := store.Create(ctx, CreateRequest{
		NewInput: NewInput{
			ID:          expiringID,
			RunID:       fixture.runID,
			SessionID:   fixture.sessionID,
			Generation:  fixture.generation,
			Revision:    1,
			Kind:        "command",
			Summary:     "expire approval",
			RequestedAt: "2026-10-27T04:02:00Z",
		},
		Context: json.RawMessage(`{"step":2}`),
	}); err != nil {
		t.Fatalf("create expiring approval: %v", err)
	}
	expired, err := store.Expire(ctx, expiringID, fixture.generation)
	if err != nil {
		t.Fatalf("expire approval: %v", err)
	}
	if expired.Status != protocol.ApprovalStatusExpired {
		t.Fatalf("expired approval = %+v", expired)
	}

	var revisionCount int
	if err := db.Pool().QueryRow(ctx, `
		SELECT count(*)
		FROM execution_approval_revisions
		WHERE id = $1
	`, fixture.approvalID).Scan(&revisionCount); err != nil {
		t.Fatalf("count approval revisions: %v", err)
	}
	if revisionCount != 2 {
		t.Fatalf("approval revision count = %d, want 2", revisionCount)
	}

	var firstStatus, secondStatus, secondEvent string
	var secondContext []byte
	if err := db.Pool().QueryRow(ctx, `
		SELECT first.status, second.status, second.context, second.requested_event_id
		FROM execution_approval_revisions AS first
		JOIN execution_approval_revisions AS second
		  ON second.id = first.id AND second.revision = 2
		WHERE first.id = $1 AND first.revision = 1
	`, fixture.approvalID).Scan(&firstStatus, &secondStatus, &secondContext, &secondEvent); err != nil {
		t.Fatalf("read approval revision history: %v", err)
	}
	originalContext := []byte(`{"step":1,"unknown":"retain"}`)
	if firstStatus != string(protocol.ApprovalStatusPending) || secondStatus != string(protocol.ApprovalStatusApproved) || !bytes.Equal(secondContext, originalContext) || secondEvent != "" {
		t.Fatalf("approval history = first %q second %q context %q event %q", firstStatus, secondStatus, secondContext, secondEvent)
	}

	var expiredProjectionStatus, expiredHistoryStatus string
	if err := db.Pool().QueryRow(ctx, `
		SELECT projection.status, history.status
		FROM execution_approvals AS projection
		JOIN execution_approval_revisions AS history
		  ON history.id = projection.id AND history.revision = projection.revision
		WHERE projection.id = $1
	`, expiringID).Scan(&expiredProjectionStatus, &expiredHistoryStatus); err != nil {
		t.Fatalf("read expired projection/history: %v", err)
	}
	if expiredProjectionStatus != string(protocol.ApprovalStatusExpired) || expiredHistoryStatus != string(protocol.ApprovalStatusExpired) {
		t.Fatalf("expired projection/history = %q/%q", expiredProjectionStatus, expiredHistoryStatus)
	}
	if err := store.CheckHistoryReadiness(ctx); err != nil {
		t.Fatalf("complete approval history readiness error = %v", err)
	}
}

func TestApprovalHistoryRejectsProjectionOnlyWriterAndDetectsDrift(t *testing.T) {
	db := openApprovalFixtureDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	store := NewStore(db.Pool())

	created, err := store.Create(ctx, CreateRequest{
		NewInput: NewInput{
			ID:          fixture.approvalID,
			RunID:       fixture.runID,
			SessionID:   fixture.sessionID,
			Generation:  fixture.generation,
			Revision:    1,
			Kind:        "command",
			Summary:     "immutable projection check",
			RequestedAt: "2026-10-27T04:10:00Z",
		},
		Context: json.RawMessage(`{"guard":true}`),
	})
	if err != nil {
		t.Fatalf("create approval: %v", err)
	}

	legacyWrites := []struct {
		name  string
		query string
	}{
		{name: "insert", query: `
			INSERT INTO execution_approvals (id, session_id, run_id, generation, kind, requested_at, revision)
			VALUES ($1, $2, $3, $4, 'command', '2026-10-27T04:10:01Z', 1)
		`},
		{name: "update", query: `UPDATE execution_approvals SET summary = 'legacy writer must fail' WHERE id = $1`},
		{name: "delete", query: `DELETE FROM execution_approvals WHERE id = $1`},
	}
	for _, legacyWrite := range legacyWrites {
		t.Run(legacyWrite.name, func(t *testing.T) {
			tx, err := db.Pool().Begin(ctx)
			if err != nil {
				t.Fatalf("begin legacy writer transaction: %v", err)
			}
			defer tx.Rollback(ctx)
			var args []any
			if legacyWrite.name == "insert" {
				args = []any{fixture.approvalID + "-legacy", fixture.sessionID, fixture.runID, fixture.generation}
			} else {
				args = []any{fixture.approvalID}
			}
			if _, err := tx.Exec(ctx, legacyWrite.query, args...); err == nil {
				t.Fatal("projection-only writer unexpectedly succeeded after cutover")
			}
		})
	}

	got, err := store.Get(ctx, fixture.approvalID)
	if err != nil {
		t.Fatalf("read projection after rejected writer: %v", err)
	}
	if got.Summary != created.Summary {
		t.Fatalf("projection summary after rejected writer = %q, want %q", got.Summary, created.Summary)
	}

	if _, err := db.Pool().Exec(ctx, `UPDATE execution_approval_revisions SET summary = 'drift' WHERE id = $1 AND revision = 1`, fixture.approvalID); err != nil {
		t.Fatalf("create projection/history drift: %v", err)
	}
	if err := store.CheckHistoryConsistency(ctx); !errors.Is(err, ErrApprovalHistoryUnavailable) {
		t.Fatalf("drift readiness error = %v, want ErrApprovalHistoryUnavailable", err)
	}
	if _, err := db.Pool().Exec(ctx, `UPDATE execution_approval_revisions SET summary = $2 WHERE id = $1 AND revision = 1`, fixture.approvalID, created.Summary); err != nil {
		t.Fatalf("repair projection/history drift: %v", err)
	}
	if err := store.CheckHistoryConsistency(ctx); err != nil {
		t.Fatalf("readiness after drift repair = %v", err)
	}
}

func TestApprovalHistoryTransactionRollbackLeavesNoHalfWrite(t *testing.T) {
	db := openApprovalFixtureDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	store := NewStore(db.Pool())
	base, err := store.Create(ctx, CreateRequest{
		NewInput: NewInput{
			ID:          fixture.approvalID,
			RunID:       fixture.runID,
			SessionID:   fixture.sessionID,
			Generation:  fixture.generation,
			Revision:    1,
			Kind:        "command",
			Summary:     "base approval",
			RequestedAt: "2026-10-27T04:20:00Z",
		},
		Context: json.RawMessage(`{"revision":1}`),
	})
	if err != nil {
		t.Fatalf("create base approval: %v", err)
	}

	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin revision transaction: %v", err)
	}
	updated, err := store.CreateTx(ctx, tx, CreateRequest{
		NewInput: NewInput{
			ID:          fixture.approvalID,
			RunID:       fixture.runID,
			SessionID:   fixture.sessionID,
			Generation:  fixture.generation,
			Revision:    2,
			Kind:        "command",
			Summary:     "rolled back revision",
			RequestedAt: "2026-10-27T04:21:00Z",
		},
		Context:          json.RawMessage(`{"revision":2}`),
		RequestedEventID: fixture.approvalID + "-event-2",
	})
	if err != nil {
		t.Fatalf("create revision in transaction: %v", err)
	}
	if updated.Revision != 2 {
		t.Fatalf("transactional revision = %+v", updated)
	}
	var capability string
	if err := tx.QueryRow(ctx, `SELECT current_setting('loomhelm.approval_writer_capability', true)`).Scan(&capability); err != nil {
		t.Fatalf("read transaction-local writer capability: %v", err)
	}
	if capability != approvalWriterCapability {
		t.Fatalf("transaction-local writer capability = %q, want %q", capability, approvalWriterCapability)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback revision transaction: %v", err)
	}

	var currentRevision int64
	var currentSummary string
	if err := db.Pool().QueryRow(ctx, `SELECT revision, summary FROM execution_approvals WHERE id = $1`, fixture.approvalID).Scan(&currentRevision, &currentSummary); err != nil {
		t.Fatalf("read projection after rollback: %v", err)
	}
	if currentRevision != base.Revision || currentSummary != base.Summary {
		t.Fatalf("projection after rollback = revision %d summary %q, want revision %d summary %q", currentRevision, currentSummary, base.Revision, base.Summary)
	}
	var historyCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM execution_approval_revisions WHERE id = $1`, fixture.approvalID).Scan(&historyCount); err != nil {
		t.Fatalf("count history after rollback: %v", err)
	}
	if historyCount != 1 {
		t.Fatalf("history rows after rollback = %d, want 1", historyCount)
	}

	rolledBackID := fixture.approvalID + "-new"
	tx, err = db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin new approval transaction: %v", err)
	}
	if _, err := store.CreateTx(ctx, tx, CreateRequest{
		NewInput: NewInput{
			ID:          rolledBackID,
			RunID:       fixture.runID,
			SessionID:   fixture.sessionID,
			Generation:  fixture.generation,
			Revision:    1,
			Kind:        "command",
			Summary:     "rolled back create",
			RequestedAt: "2026-10-27T04:22:00Z",
		},
		Context: json.RawMessage(`{"new":true}`),
	}); err != nil {
		t.Fatalf("create new approval in transaction: %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback new approval transaction: %v", err)
	}
	var projectionCount, rolledBackHistoryCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM execution_approvals WHERE id = $1`, rolledBackID).Scan(&projectionCount); err != nil {
		t.Fatalf("count rolled-back projection: %v", err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM execution_approval_revisions WHERE id = $1`, rolledBackID).Scan(&rolledBackHistoryCount); err != nil {
		t.Fatalf("count rolled-back history: %v", err)
	}
	if projectionCount != 0 || rolledBackHistoryCount != 0 {
		t.Fatalf("rolled-back approval rows = projection %d/history %d, want 0/0", projectionCount, rolledBackHistoryCount)
	}
}

func TestApprovalHistoryMigrationStagesAndFencesProjectionWriter(t *testing.T) {
	db, provider := openApprovalFixtureDatabaseThrough(t, 11)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fixture := seedApprovalFixture(t, ctx, db)
	const legacySummary = "legacy projection before staged cutover"
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_approvals (id, session_id, run_id, generation, kind, requested_at, revision, status, summary, context, requested_event_id)
		VALUES ($1, $2, $3, $4, 'command', '2026-10-27T04:30:00Z', 1, 'pending', $5, decode('7b226f6c64223a747275657d', 'hex'), $6)
	`, fixture.approvalID, fixture.sessionID, fixture.runID, fixture.generation, legacySummary, fixture.approvalID+"-legacy-event"); err != nil {
		t.Fatalf("seed pre-cutover projection: %v", err)
	}
	if _, err := provider.UpTo(ctx, 12); err != nil {
		t.Fatalf("structural 00012 migration: %v", err)
	}
	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	pausedOptions := database.ApprovalHistoryMigrationOptions{BatchSize: 1, WorkBudget: 1, PreDrainBatchSize: 1, PreDrainWorkBudget: 10, FinalRowBudget: 10, FinalWorkBudget: 30}
	paused, err := migrator.RunBackfill(ctx, pausedOptions)
	if err != nil {
		t.Fatalf("pause approval history backfill: %v", err)
	}
	if paused.Phase != database.ApprovalHistoryPhaseBackfillPaused || paused.RowsCopied != 1 {
		t.Fatalf("paused backfill progress = %+v, want one copied row and backfill_paused", paused)
	}
	if _, err := db.Pool().Exec(ctx, `UPDATE execution_approvals SET summary = 'legacy projection during capture', context = decode('7b226e6577223a747275657d', 'hex') WHERE id = $1`, fixture.approvalID); err != nil {
		t.Fatalf("capture legacy projection update: %v", err)
	}
	var capturedSummary string
	var capturedContext []byte
	if err := db.Pool().QueryRow(ctx, `SELECT summary, context FROM execution_approval_revisions WHERE id = $1 AND revision = 1`, fixture.approvalID).Scan(&capturedSummary, &capturedContext); err != nil {
		t.Fatalf("read captured legacy projection update: %v", err)
	}
	if capturedSummary != "legacy projection during capture" || !bytes.Equal(capturedContext, []byte(`{"new":true}`)) {
		t.Fatalf("captured projection = summary %q context %x, want updated values", capturedSummary, capturedContext)
	}
	resumedOptions := pausedOptions
	resumedOptions.WorkBudget = 10
	if _, err := migrator.RunBackfill(ctx, resumedOptions); err != nil {
		t.Fatalf("resume approval history backfill: %v", err)
	}
	if _, err := migrator.Validate(ctx, resumedOptions); err != nil {
		t.Fatalf("validate staged approval history: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, resumedOptions); err != nil {
		t.Fatalf("build staged approval history indexes: %v", err)
	}
	if _, err := migrator.Cutover(ctx, resumedOptions); err != nil {
		t.Fatalf("cut over staged approval history: %v", err)
	}
	if err := migrator.Readiness(ctx); err != nil {
		t.Fatalf("read staged approval history readiness: %v", err)
	}

	_, err = db.Pool().Exec(ctx, `UPDATE execution_approvals SET summary = 'legacy writer after cutover' WHERE id = $1`, fixture.approvalID)
	if err == nil {
		t.Fatal("projection-only writer unexpectedly committed after cutover")
	}

	var summary string
	if err := db.Pool().QueryRow(ctx, `SELECT summary FROM execution_approvals WHERE id = $1`, fixture.approvalID).Scan(&summary); err != nil {
		t.Fatalf("read projection after writer rejection: %v", err)
	}
	if summary != "legacy projection during capture" {
		t.Fatalf("projection summary after writer rejection = %q, want captured update", summary)
	}
	var historyCount int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM execution_approval_revisions WHERE id = $1 AND revision = 1`, fixture.approvalID).Scan(&historyCount); err != nil {
		t.Fatalf("read history after writer rejection: %v", err)
	}
	if historyCount != 1 {
		t.Fatalf("history rows = %d, want 1", historyCount)
	}
}

type approvalFixture struct {
	sessionID  string
	runID      string
	generation string
	approvalID string
}

func openApprovalFixtureDatabase(t *testing.T) *database.DB {
	db, _ := openApprovalFixtureDatabaseThrough(t, 12)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	migrator := database.NewApprovalHistoryMigrator(db.Pool())
	options := database.ApprovalHistoryMigrationOptions{BatchSize: 32, WorkBudget: 10000, PreDrainBatchSize: 32, PreDrainWorkBudget: 10000, FinalRowBudget: 100, FinalWorkBudget: 300}
	if _, err := migrator.RunBackfill(ctx, options); err != nil {
		t.Fatalf("run approval history backfill: %v", err)
	}
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("validate approval history backfill: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("build approval history indexes: %v", err)
	}
	if _, err := migrator.Cutover(ctx, options); err != nil {
		t.Fatalf("cut over approval history: %v", err)
	}
	return db
}

func openApprovalFixtureDatabaseThrough(t *testing.T, targetVersion int64) (*database.DB, *goose.Provider) {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatalf("load database configuration: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	root, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 2})
	if err != nil {
		t.Fatalf("open root approval fixture database: %v", err)
	}
	schema := fmt.Sprintf("e01_approval_store_%d", time.Now().UnixNano())
	if _, err := root.Pool().Exec(ctx, "CREATE SCHEMA "+quoteApprovalFixtureIdentifier(schema)); err != nil {
		root.Close()
		t.Fatalf("create approval fixture schema: %v", err)
	}
	scopedURL, err := approvalFixtureURLWithSearchPath(config.URL, schema)
	if err != nil {
		_, _ = root.Pool().Exec(context.Background(), "DROP SCHEMA "+quoteApprovalFixtureIdentifier(schema)+" CASCADE")
		root.Close()
		t.Fatalf("scope approval fixture database URL: %v", err)
	}
	scoped, err := database.Open(ctx, database.Config{URL: scopedURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		_, _ = root.Pool().Exec(context.Background(), "DROP SCHEMA "+quoteApprovalFixtureIdentifier(schema)+" CASCADE")
		root.Close()
		t.Fatalf("open scoped approval fixture database: %v", err)
	}
	sqlDB := stdlib.OpenDBFromPool(scoped.Pool())
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		sqlDB.Close()
		scoped.Close()
		_, _ = root.Pool().Exec(context.Background(), "DROP SCHEMA "+quoteApprovalFixtureIdentifier(schema)+" CASCADE")
		root.Close()
		t.Fatalf("create approval fixture migration provider: %v", err)
	}
	if _, err := provider.UpTo(ctx, targetVersion); err != nil {
		provider.Close()
		sqlDB.Close()
		scoped.Close()
		_, _ = root.Pool().Exec(context.Background(), "DROP SCHEMA "+quoteApprovalFixtureIdentifier(schema)+" CASCADE")
		root.Close()
		t.Fatalf("migrate approval fixture to %d: %v", targetVersion, err)
	}
	t.Cleanup(func() {
		provider.Close()
		sqlDB.Close()
		scoped.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := root.Pool().Exec(cleanupCtx, "DROP SCHEMA "+quoteApprovalFixtureIdentifier(schema)+" CASCADE"); err != nil {
			t.Errorf("drop approval fixture schema: %v", err)
		}
		root.Close()
	})
	return scoped, provider
}

func seedApprovalFixture(t *testing.T, ctx context.Context, db *database.DB) approvalFixture {
	t.Helper()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	fixture := approvalFixture{
		sessionID:  "e01-approval-store-session-" + suffix,
		runID:      "e01-approval-store-run-" + suffix,
		generation: "e01-approval-store-generation-" + suffix,
		approvalID: "e01-approval-store-approval-" + suffix,
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_sessions (id, external_thread_ref, path, generation)
		VALUES ($1, $2, 'new', $3)
	`, fixture.sessionID, fixture.sessionID+"-thread", fixture.generation); err != nil {
		t.Fatalf("seed approval fixture session: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_runs (id, session_id, command_id, generation)
		VALUES ($1, $2, $3, $4)
	`, fixture.runID, fixture.sessionID, fixture.runID+"-command", fixture.generation); err != nil {
		t.Fatalf("seed approval fixture run: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := db.Pool().Begin(cleanupCtx)
		if err != nil {
			t.Errorf("begin approval fixture cleanup: %v", err)
			return
		}
		defer tx.Rollback(cleanupCtx)
		if _, err := tx.Exec(cleanupCtx, `SET LOCAL loomhelm.approval_writer_capability = 'revision-history-v1'`); err != nil {
			t.Errorf("set approval fixture cleanup capability: %v", err)
			return
		}
		cleanupQueries := []struct {
			label string
			query string
		}{
			{label: "approval history", query: `DELETE FROM execution_approval_revisions WHERE session_id = $1`},
			{label: "approvals", query: `DELETE FROM execution_approvals WHERE session_id = $1`},
			{label: "runs", query: `DELETE FROM execution_runs WHERE session_id = $1`},
			{label: "sessions", query: `DELETE FROM execution_sessions WHERE id = $1`},
		}
		for _, cleanup := range cleanupQueries {
			if _, err := tx.Exec(cleanupCtx, cleanup.query, fixture.sessionID); err != nil {
				t.Errorf("cleanup %s: %v", cleanup.label, err)
				return
			}
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit approval fixture cleanup: %v", err)
		}
	})
	return fixture
}

func approvalFixtureURLWithSearchPath(rawURL, schema string) (string, error) {
	if strings.Contains(rawURL, "://") {
		parsed, err := url.Parse(rawURL)
		if err != nil {
			return "", err
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		return parsed.String(), nil
	}
	return strings.TrimSpace(rawURL) + " search_path=" + schema, nil
}

func quoteApprovalFixtureIdentifier(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}
