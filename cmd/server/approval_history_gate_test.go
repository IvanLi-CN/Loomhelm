package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/jackc/pgx/v5"
)

func TestServerAndWorkerEntrypointsFailClosedBeforeApprovalHistoryCutover(t *testing.T) {
	databaseURL := isolatedEntrypointDatabase(t)
	serverBinary := buildServerEntrypoint(t)
	workerBinary := buildEntrypoint(t, "./cmd/worker", "worker")
	serverLogPath := t.TempDir() + "/server.log"
	workerLogPath := t.TempDir() + "/worker.log"
	serverLog, err := os.Create(serverLogPath)
	if err != nil {
		t.Fatalf("create server log: %v", err)
	}
	defer serverLog.Close()
	workerLog, err := os.Create(workerLogPath)
	if err != nil {
		t.Fatalf("create worker log: %v", err)
	}
	defer workerLog.Close()

	server := commandWithLog(serverBinary, serverLog, map[string]string{
		"LOOMHELM_DATABASE_URL": databaseURL,
		"LOOMHELM_VERSION":      "approval-history-gate-test",
		"LOOMHELM_HTTP_ADDR":    "127.0.0.1:0",
		"LOOMHELM_DRAIN_TOKEN":  "test-token",
	})
	worker := commandWithLog(workerBinary, workerLog, map[string]string{
		"LOOMHELM_DATABASE_URL":      databaseURL,
		"LOOMHELM_VERSION":           "approval-history-gate-test",
		"LOOMHELM_WORKER_GENERATION": "1",
	})
	if err := server.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	if err := worker.Start(); err != nil {
		_ = server.Process.Kill()
		_ = server.Wait()
		t.Fatalf("start worker: %v", err)
	}
	t.Cleanup(func() {
		for _, command := range []*os.Process{server.Process, worker.Process} {
			if command != nil {
				_ = command.Kill()
			}
		}
	})

	assertExitCode(t, waitForExit(server), 1)
	assertExitCode(t, waitForExit(worker), 1)
	assertLogContains(t, serverLogPath, "server exited with error", "approval history migration is unavailable")
	assertLogContains(t, workerLogPath, "worker exited with error", "approval history migration is unavailable")
	assertLogNotContains(t, serverLogPath, "server started")
	assertLogNotContains(t, workerLogPath, "worker started")
}

func commandWithLog(binary string, logFile *os.File, values map[string]string) *exec.Cmd {
	command := exec.Command(binary)
	command.Env = commandEnv(values)
	command.Stdout = logFile
	command.Stderr = logFile
	return command
}

func isolatedEntrypointDatabase(t *testing.T) string {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("real process integration requires LOOMHELM_DATABASE_URL")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
	schema := "entrypoint_gate_" + hex.EncodeToString(suffix)
	if _, err := admin.Pool().Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatalf("create entrypoint gate schema: %v", err)
	}
	t.Cleanup(func() {
		defer admin.Close()
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Pool().Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Errorf("drop entrypoint gate schema: %v", err)
		}
	})
	return entrypointDatabaseWithSchema(config.URL, schema, t)
}

func entrypointDatabaseWithSchema(raw, schema string, t *testing.T) string {
	t.Helper()
	raw = strings.TrimSpace(raw)
	if _, err := pgx.ParseConfig(raw); err != nil {
		t.Fatalf("parse entrypoint database URL: %v", err)
	}
	if strings.HasPrefix(raw, "postgres://") || strings.HasPrefix(raw, "postgresql://") {
		parsed, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("parse entrypoint database URL: %v", err)
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		return parsed.String()
	}
	return raw + " search_path='" + schema + "'"
}

func assertLogNotContains(t *testing.T, path string, markers ...string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	for _, marker := range markers {
		if strings.Contains(string(data), marker) {
			t.Fatalf("log unexpectedly contains %q: %s", marker, data)
		}
	}
}
