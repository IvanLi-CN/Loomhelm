package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestConnectorInitializationErrorClassOmitsPrivateDetails(t *testing.T) {
	privatePath := filepath.Join(t.TempDir(), "connector-journal-secret")
	err := fmt.Errorf("open connector journal: %w", &os.PathError{Op: "open", Path: privatePath, Err: os.ErrPermission})
	got := connectorInitializationErrorClass(err)
	if got != "permission_denied" {
		t.Fatalf("permission error class = %q, want permission_denied", got)
	}
	if strings.Contains(got, privatePath) {
		t.Fatalf("permission error class leaked private path %q", privatePath)
	}
	if got := connectorInitializationErrorClass(fmt.Errorf("journal missing: %w", os.ErrNotExist)); got != "not_found" {
		t.Fatalf("not-found error class = %q, want not_found", got)
	}
}

func TestConnectorEntrypointExitsOnSignal(t *testing.T) {
	for _, test := range []struct {
		name   string
		signal os.Signal
	}{
		{name: "interrupt", signal: os.Interrupt},
		{name: "sigterm", signal: syscall.SIGTERM},
	} {
		t.Run(test.name, func(t *testing.T) {
			runConnectorSignalTest(t, test.signal)
		})
	}
}

func runConnectorSignalTest(t *testing.T, signal os.Signal) {
	t.Helper()
	binary := buildConnectorEntrypoint(t)
	logPath := filepath.Join(t.TempDir(), "connector.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatalf("create log file: %v", err)
	}
	defer logFile.Close()
	if err := os.Chmod(filepath.Dir(logPath), 0o700); err != nil {
		t.Fatalf("secure connector test directory: %v", err)
	}

	command := exec.Command(binary)
	command.Env = commandEnv(map[string]string{
		"LOOMHELM_VERSION":                      "test",
		"LOOMHELM_CONNECTOR_BASE_URL":           "https://platform.example.test",
		"LOOMHELM_CONNECTOR_API_KEY":            "lhk_" + base64.RawURLEncoding.EncodeToString([]byte("host-test\x00token-test")),
		"XDG_CONFIG_HOME": filepath.Dir(logPath),
	})
	command.Stdout = logFile
	command.Stderr = logFile
	if err := command.Start(); err != nil {
		t.Fatalf("start connector: %v", err)
	}
	t.Cleanup(func() {
		if command.ProcessState == nil && command.Process != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	waitForLog(t, logPath, "connector started")
	if err := command.Process.Signal(signal); err != nil {
		t.Fatalf("signal connector: %v", err)
	}
	if err := waitForExit(command); err != nil {
		t.Fatalf("connector exit error = %v", err)
	}
	assertLogContains(t, logPath, "connector started", "connector stopped")
}

func TestConnectorEntrypointRejectsInvalidConfiguration(t *testing.T) {
	binary := buildConnectorEntrypoint(t)
	command := exec.Command(binary)
	command.Env = commandEnv(map[string]string{"LOOMHELM_CONNECTOR_BASE_URL": "ftp://platform.example.test"})
	output, err := command.CombinedOutput()
	assertExitCode(t, err, 2)
	if !strings.Contains(string(output), "invalid configuration: invalid LOOMHELM_CONNECTOR_BASE_URL") {
		t.Fatalf("invalid configuration output = %q", output)
	}
}

func buildConnectorEntrypoint(t *testing.T) string {
	t.Helper()
	outputPath := filepath.Join(t.TempDir(), "connector")
	command := exec.Command("go", "build", "-o", outputPath, "./cmd/connector")
	command.Dir = repositoryRoot()
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build connector: %v\n%s", err, output)
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
		name := value
		if index := strings.IndexByte(name, '='); index >= 0 {
			name = name[:index]
		}
		if !strings.HasPrefix(value, "LOOMHELM_") {
			if _, overridden := values[name]; overridden {
				continue
			}
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
