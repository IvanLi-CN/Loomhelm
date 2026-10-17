package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestServerEntrypointExitsOnInterrupt(t *testing.T) {
	binary := buildServerEntrypoint(t)
	logPath := filepath.Join(t.TempDir(), "server.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatalf("create log file: %v", err)
	}
	defer logFile.Close()

	command := exec.Command(binary)
	command.Env = commandEnv(map[string]string{
		"LOOMHELM_VERSION":   "test",
		"LOOMHELM_HTTP_ADDR": "127.0.0.1:0",
	})
	command.Stdout = logFile
	command.Stderr = logFile
	if err := command.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(func() {
		if command.ProcessState == nil && command.Process != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	waitForLog(t, command, logPath, "server started")
	if err := command.Process.Signal(os.Interrupt); err != nil {
		t.Fatalf("interrupt server: %v", err)
	}
	if err := waitForExit(command); err != nil {
		t.Fatalf("server exit error = %v", err)
	}
	assertLogContains(t, logPath, "server entering drain", "server stopped")
}

func TestServerEntrypointRejectsInvalidConfiguration(t *testing.T) {
	binary := buildServerEntrypoint(t)
	command := exec.Command(binary)
	command.Env = commandEnv(map[string]string{"LOOMHELM_HTTP_ADDR": "invalid"})
	output, err := command.CombinedOutput()
	assertExitCode(t, err, 2)
	if !strings.Contains(string(output), "invalid configuration: invalid LOOMHELM_HTTP_ADDR") {
		t.Fatalf("invalid configuration output = %q", output)
	}
}

func buildServerEntrypoint(t *testing.T) string {
	t.Helper()
	return buildEntrypoint(t, "./cmd/server", "server")
}

func buildEntrypoint(t *testing.T, packagePath, name string) string {
	t.Helper()
	outputPath := filepath.Join(t.TempDir(), name)
	command := exec.Command("go", "build", "-o", outputPath, packagePath)
	command.Dir = repositoryRoot()
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build %s: %v\n%s", packagePath, err, output)
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

func waitForLog(t *testing.T, command *exec.Cmd, path, marker string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), marker) {
			return
		}
		if command.ProcessState != nil {
			t.Fatalf("process exited before log %q: %s", marker, data)
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
