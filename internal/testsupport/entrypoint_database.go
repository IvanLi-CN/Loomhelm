package testsupport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/jackc/pgx/v5"
)

// IsolatedDatabase creates a schema-owned DSN without changing the shared
// database. Callers choose whether to leave the schema before cutover or
// prepare it for a successful process startup.
func IsolatedDatabase(t testing.TB, prefix string) string {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("real process integration requires LOOMHELM_DATABASE_URL")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: config.MinConns, MaxConns: config.MaxConns})
	if err != nil {
		t.Fatal(err)
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	schema := prefix + "_" + hex.EncodeToString(suffix)
	if _, err := admin.Pool().Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatalf("create isolated test schema: %v", err)
	}
	t.Cleanup(func() {
		defer admin.Close()
		cleanup, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		if _, err := admin.Pool().Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Errorf("drop isolated test schema: %v", err)
		}
	})
	connectionURL, err := databaseURLWithSchema(config.URL, schema)
	if err != nil {
		t.Fatal(err)
	}
	return connectionURL
}

// CutoverReadyDatabase prepares the exact durable approval-history state that
// server and worker startup require before they can report ready.
func CutoverReadyDatabase(t testing.TB) string {
	t.Helper()
	connectionURL := IsolatedDatabase(t, "entrypoint_ready")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	probe, err := database.Open(ctx, database.Config{URL: connectionURL, MaxConns: 1})
	if err != nil {
		t.Fatalf("open cutover-ready test database: %v", err)
	}
	t.Cleanup(probe.Close)
	if err := probe.Migrate(ctx); err != nil {
		t.Fatalf("migrate cutover-ready test database: %v", err)
	}
	migrator := database.NewApprovalHistoryMigrator(probe.Pool(), database.ApprovalHistoryMigratorConfig{LeaseOwner: "entrypoint-test"})
	options := database.ApprovalHistoryMigrationOptions{
		BatchSize:          32,
		WorkBudget:         10000,
		PreDrainBatchSize:  32,
		PreDrainWorkBudget: 10000,
		FinalRowBudget:     100,
		FinalWorkBudget:    300,
	}
	if _, err := migrator.RunBackfill(ctx, options); err != nil {
		t.Fatalf("backfill cutover-ready test database: %v", err)
	}
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("validate cutover-ready test database: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("build cutover-ready test database indexes: %v", err)
	}
	if _, err := migrator.Cutover(ctx, options); err != nil {
		t.Fatalf("cut over cutover-ready test database: %v", err)
	}
	return connectionURL
}

func databaseURLWithSchema(raw, schema string) (string, error) {
	raw = strings.TrimSpace(raw)
	if schema == "" || strings.Trim(schema, "abcdefghijklmnopqrstuvwxyz0123456789_") != "" || (schema[0] >= '0' && schema[0] <= '9') {
		return "", &invalidDatabaseSchemaError{}
	}
	if _, err := pgx.ParseConfig(raw); err != nil {
		return "", err
	}
	if strings.HasPrefix(raw, "postgres://") || strings.HasPrefix(raw, "postgresql://") {
		parsed, err := url.Parse(raw)
		if err != nil {
			return "", err
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		return parsed.String(), nil
	}
	return raw + " search_path='" + schema + "'", nil
}

type invalidDatabaseSchemaError struct{}

func (*invalidDatabaseSchemaError) Error() string {
	return "invalid isolated database schema"
}
