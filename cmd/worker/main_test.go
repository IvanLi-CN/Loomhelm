package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/testsupport"
)

func TestWorkerEntrypointExitsOnSignal(t *testing.T) {
	for _, test := range []struct {
		name   string
		signal os.Signal
	}{
		{name: "interrupt", signal: os.Interrupt},
		{name: "sigterm", signal: syscall.SIGTERM},
	} {
		t.Run(test.name, func(t *testing.T) {
			runWorkerSignalTest(t, test.signal)
		})
	}
}

func runWorkerSignalTest(t *testing.T, signal os.Signal) {
	t.Helper()
	databaseURL := testsupport.CutoverReadyDatabase(t)
	databaseValues := databaseEnvironmentForTest(t)
	binary := buildWorkerEntrypoint(t)
	logPath := filepath.Join(t.TempDir(), "worker.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatalf("create log file: %v", err)
	}
	defer logFile.Close()

	command := exec.Command(binary)
	for key, value := range map[string]string{
		"LOOMHELM_DATABASE_URL":      databaseURL,
		"LOOMHELM_VERSION":           "test",
		"LOOMHELM_WORKER_GENERATION": "9",
	} {
		databaseValues[key] = value
	}
	command.Env = commandEnv(databaseValues)
	command.Stdout = logFile
	command.Stderr = logFile
	if err := command.Start(); err != nil {
		t.Fatalf("start worker: %v", err)
	}
	t.Cleanup(func() {
		if command.ProcessState == nil && command.Process != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	waitForLog(t, logPath, "worker started")
	if err := command.Process.Signal(signal); err != nil {
		t.Fatalf("signal worker: %v", err)
	}
	if err := waitForExit(command); err != nil {
		t.Fatalf("worker exit error = %v", err)
	}
	assertLogContains(t, logPath, "worker started", "worker stopped")
}

func TestWorkerEntrypointRejectsMissingDatabase(t *testing.T) {
	binary := buildWorkerEntrypoint(t)
	command := exec.Command(binary)
	command.Env = commandEnv(nil)
	output, err := command.CombinedOutput()
	assertExitCode(t, err, 2)
	if !strings.Contains(string(output), "LOOMHELM_DATABASE_URL") {
		t.Fatalf("missing database configuration output = %q", output)
	}
}

func TestWorkerEntrypointRejectsInvalidConfiguration(t *testing.T) {
	binary := buildWorkerEntrypoint(t)
	command := exec.Command(binary)
	command.Env = commandEnv(map[string]string{
		"LOOMHELM_WORKER_GENERATION": "0",
		"LOOMHELM_DATABASE_URL":      "postgres://loomhelm:secret@127.0.0.1:55432/loomhelm?sslmode=disable",
		"LOOMHELM_POSTGRES_PORT":     "55432",
	})
	output, err := command.CombinedOutput()
	assertExitCode(t, err, 2)
	if !strings.Contains(string(output), "invalid configuration: LOOMHELM_WORKER_GENERATION must be greater than zero") {
		t.Fatalf("invalid configuration output = %q", output)
	}
}

func databaseEnvironmentForTest(t *testing.T) map[string]string {
	t.Helper()
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
			t.Skip("real process integration requires LOOMHELM_DATABASE_URL")
		}
		t.Fatalf("load database configuration: %v", err)
	}
	values := map[string]string{
		"LOOMHELM_DATABASE_URL":       config.URL,
		"LOOMHELM_DATABASE_MIN_CONNS": strconv.FormatInt(int64(config.MinConns), 10),
		"LOOMHELM_DATABASE_MAX_CONNS": strconv.FormatInt(int64(config.MaxConns), 10),
	}
	if port := strings.TrimSpace(os.Getenv("LOOMHELM_POSTGRES_PORT")); port != "" {
		values["LOOMHELM_POSTGRES_PORT"] = port
	}
	return values
}

func buildWorkerEntrypoint(t *testing.T) string {
	t.Helper()
	outputPath := filepath.Join(t.TempDir(), "worker")
	command := exec.Command("go", "build", "-o", outputPath, "./cmd/worker")
	command.Dir = repositoryRoot()
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build worker: %v\n%s", err, output)
	}
	return outputPath
}

func repositoryRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func commandEnv(values map[string]string) []string {
	env := make([]string, 0, len(os.Environ())+len(values))
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "LOOMHELM_") {
			env = append(env, value)
		}
	}
	for key, value := range values {
		env = append(env, key+"="+value)
	}
	return env
}

func waitForLog(t *testing.T, path, marker string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), marker) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	data, _ := os.ReadFile(path)
	t.Fatalf("timed out waiting for log %q: %s", marker, data)
}

func waitForExit(command *exec.Cmd) error {
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		_ = command.Process.Kill()
		return <-done
	}
}

func assertLogContains(t *testing.T, path string, markers ...string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	for _, marker := range markers {
		if !strings.Contains(string(data), marker) {
			t.Fatalf("log %q does not contain %q", data, marker)
		}
	}
}

func assertExitCode(t *testing.T, err error, want int) {
	t.Helper()
	if err == nil {
		t.Fatalf("command exit = nil, want %d", want)
	}
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != want {
		t.Fatalf("command error = %v, want exit code %d", err, want)
	}
}
