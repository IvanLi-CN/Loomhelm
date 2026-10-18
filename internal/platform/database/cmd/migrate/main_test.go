package main

import (
	"context"
	"strings"
	"testing"
)

func TestRunRejectsMismatchedDevelopmentDatabasePortBeforeConnection(t *testing.T) {
	t.Setenv("LOOMHELM_DATABASE_URL", "postgres://loomhelm:secret@127.0.0.1:55432/loomhelm?sslmode=disable")
	t.Setenv("LOOMHELM_POSTGRES_PORT", "55441")

	err := run(context.Background())
	if err == nil {
		t.Fatal("run() accepted mismatched development database port")
	}
	if !strings.Contains(err.Error(), "must match LOOMHELM_POSTGRES_PORT") {
		t.Fatalf("run() error = %v, want port mismatch", err)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("run() error leaked database credentials: %v", err)
	}
}
