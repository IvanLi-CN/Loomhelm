package app

import (
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestApplicationDatabaseSchemaSurvivesDSNRoundTrip(t *testing.T) {
	const schema = "app_composition_0123456789abcdef"
	for _, raw := range []string{
		"postgres://test:fixture@127.0.0.1:5432/app?sslmode=disable",
		"postgresql://test:fixture@127.0.0.1:5432/app?search_path=public&sslmode=disable",
		"host=127.0.0.1 port=5432 user=test password=fixture dbname=app sslmode=disable",
		"host=127.0.0.1 port=5432 user=test password='fixture value' dbname=app sslmode=disable search_path=public",
	} {
		encoded, err := applicationDatabaseWithSchema(raw, schema)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := pgx.ParseConfig(encoded)
		if err != nil {
			t.Fatal("schema DSN could not be parsed")
		}
		if got := parsed.RuntimeParams["search_path"]; got != schema {
			t.Fatalf("actual connection search_path = %q, want %q", got, schema)
		}
		original, err := pgx.ParseConfig(raw)
		if err != nil {
			t.Fatal("original fixture DSN could not be parsed")
		}
		if parsed.Host != original.Host || parsed.Port != original.Port || parsed.Database != original.Database || parsed.User != original.User || parsed.Password != original.Password {
			t.Fatal("schema isolation changed the connection target or identity")
		}
	}
}

func TestApplicationDatabaseRejectsUnsafeSchema(t *testing.T) {
	for _, schema := range []string{"", "public,other", "schema'; RESET ALL; --", "../other", "1schema"} {
		if _, err := applicationDatabaseWithSchema("postgres://localhost/app", schema); err == nil {
			t.Fatalf("accepted unsafe schema %q", schema)
		}
	}
}
