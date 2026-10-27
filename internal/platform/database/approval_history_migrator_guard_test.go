package database

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/jackc/pgx/v5"
)

func TestApprovalHistoryMigratorPhaseAndOwnerGuards(t *testing.T) {
	db := openApprovalHistoryGuardDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	migrator := NewApprovalHistoryMigrator(db.Pool(), ApprovalHistoryMigratorConfig{LeaseOwner: "phase-guard-owner"})
	options := ApprovalHistoryMigrationOptions{
		BatchSize:          8,
		WorkBudget:         100,
		PreDrainBatchSize:  8,
		PreDrainWorkBudget: 100,
		FinalRowBudget:     10,
		FinalWorkBudget:    30,
	}
	if _, err := migrator.RunBackfill(ctx, options); err != nil {
		t.Fatalf("run phase-guard backfill: %v", err)
	}
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("validate phase-guard backfill: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("build phase-guard indexes: %v", err)
	}

	if _, err := db.Pool().Exec(ctx, `
		UPDATE execution_approval_history_migrations
		SET lease_owner = 'other-owner',
		    lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '1 minute'
		WHERE migration_key = 'approval-revision-history'
	`); err != nil {
		t.Fatalf("install competing phase-guard lease: %v", err)
	}
	stale := NewApprovalHistoryMigrator(db.Pool(), ApprovalHistoryMigratorConfig{LeaseOwner: "phase-guard-owner"})
	if err := stale.setPhase(ctx, ApprovalHistoryPhaseIndexesReady, ApprovalHistoryPhaseCutoverRequested, "late validation"); !errors.Is(err, ErrApprovalHistoryMigrationBusy) {
		t.Fatalf("stale phase write with competing owner = %v, want ErrApprovalHistoryMigrationBusy", err)
	}
	assertApprovalHistoryMigrationState(t, ctx, db, ApprovalHistoryPhaseIndexesReady, "other-owner")

	if _, err := db.Pool().Exec(ctx, `
		UPDATE execution_approval_history_migrations
		SET lease_owner = '', lease_expires_at = NULL
		WHERE migration_key = 'approval-revision-history'
	`); err != nil {
		t.Fatalf("release competing phase-guard lease: %v", err)
	}
	if _, err := migrator.Cutover(ctx, options); err != nil {
		t.Fatalf("complete phase-guard cutover: %v", err)
	}
	if err := migrator.Readiness(ctx); err != nil {
		t.Fatalf("readiness after phase-guard cutover: %v", err)
	}
	if err := stale.setPhase(ctx, ApprovalHistoryPhaseBackfillComplete, ApprovalHistoryPhaseValidated, "late validation after cutover"); !errors.Is(err, ErrApprovalHistoryMigrationBusy) {
		t.Fatalf("stale phase write after cutover = %v, want ErrApprovalHistoryMigrationBusy", err)
	}
	assertApprovalHistoryMigrationState(t, ctx, db, ApprovalHistoryPhaseCutoverComplete, "")
	if err := migrator.Readiness(ctx); err != nil {
		t.Fatalf("readiness after rejected stale phase write: %v", err)
	}
}

func assertApprovalHistoryMigrationState(t *testing.T, ctx context.Context, db *DB, wantPhase ApprovalHistoryMigrationPhase, wantOwner string) {
	t.Helper()
	var phase ApprovalHistoryMigrationPhase
	var owner string
	if err := db.Pool().QueryRow(ctx, `
		SELECT phase, lease_owner
		FROM execution_approval_history_migrations
		WHERE migration_key = 'approval-revision-history'
	`).Scan(&phase, &owner); err != nil {
		t.Fatalf("read phase-guard migration state: %v", err)
	}
	if phase != wantPhase || owner != wantOwner {
		t.Fatalf("phase-guard migration state = phase %q owner %q, want phase %q owner %q", phase, owner, wantPhase, wantOwner)
	}
}

func openApprovalHistoryGuardDatabase(t *testing.T) *DB {
	t.Helper()
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
			t.Skip("LOOMHELM_DATABASE_URL is not set")
		}
		t.Fatalf("load phase-guard database configuration: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := Open(ctx, Config{URL: config.URL, MinConns: 1, MaxConns: 1})
	if err != nil {
		t.Fatalf("open phase-guard admin database: %v", err)
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		admin.Close()
		t.Fatalf("generate phase-guard schema: %v", err)
	}
	schema := "phase_guard_" + hex.EncodeToString(suffix)
	if _, err := admin.Pool().Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatalf("create phase-guard schema: %v", err)
	}
	databaseURL, err := approvalHistoryGuardDatabaseURL(config.URL, schema)
	if err != nil {
		admin.Close()
		t.Fatalf("build phase-guard database URL: %v", err)
	}
	db, err := Open(ctx, Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		admin.Close()
		t.Fatalf("open phase-guard database: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		if _, err := admin.Pool().Exec(cleanupCtx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Errorf("drop phase-guard schema: %v", err)
		}
		admin.Close()
	})
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate phase-guard database: %v", err)
	}
	return db
}

func approvalHistoryGuardDatabaseURL(raw, schema string) (string, error) {
	if strings.Contains(raw, "://") {
		parsed, err := url.Parse(raw)
		if err != nil {
			return "", err
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		return parsed.String(), nil
	}
	return strings.TrimSpace(raw) + " search_path='" + schema + "'", nil
}
