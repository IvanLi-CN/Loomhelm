package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestServerEntrypointExitsOnSignal(t *testing.T) {
	for _, test := range []struct {
		name   string
		signal os.Signal
	}{
		{name: "interrupt", signal: os.Interrupt},
		{name: "sigterm", signal: syscall.SIGTERM},
	} {
		t.Run(test.name, func(t *testing.T) {
			runServerSignalTest(t, test.signal)
		})
	}
}

func runServerSignalTest(t *testing.T, signal os.Signal) {
	t.Helper()
	binary := buildServerEntrypoint(t)
	logPath := filepath.Join(t.TempDir(), "server.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatalf("create log file: %v", err)
	}
	defer logFile.Close()

	command := exec.Command(binary)
	command.Env = commandEnv(map[string]string{
		"LOOMHELM_VERSION":     "test",
		"LOOMHELM_HTTP_ADDR":   "127.0.0.1:0",
		"LOOMHELM_DRAIN_TOKEN": "test-token",
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
	waitForLog(t, logPath, "server started")
	if err := command.Process.Signal(signal); err != nil {
		t.Fatalf("signal server: %v", err)
	}
	if err := waitForExit(command); err != nil {
		t.Fatalf("server exit error = %v", err)
	}
	assertLogContains(t, logPath, "server entering drain", "server stopped")
}

func TestServerEntrypointServesHealthVersionAndDrain(t *testing.T) {
	binary := buildServerEntrypoint(t)
	logPath := filepath.Join(t.TempDir(), "server.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatalf("create log file: %v", err)
	}
	defer logFile.Close()

	command := exec.Command(binary)
	command.Env = commandEnv(map[string]string{
		"LOOMHELM_VERSION":     "test",
		"LOOMHELM_HTTP_ADDR":   "127.0.0.1:0",
		"LOOMHELM_DRAIN_TOKEN": "test-token",
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
	waitForLog(t, logPath, "server started")

	client := &http.Client{Timeout: time.Second}
	baseURL := "http://" + serverAddressFromLog(t, logPath)
	waitForHTTPStatus(t, client, baseURL+"/readyz", http.StatusOK)
	ready := getHTTPJSON(t, client, baseURL+"/readyz")
	if ready["status"] != "ready" || ready["ready"] != true || ready["version"] != "test" {
		t.Fatalf("unexpected ready response: %+v", ready)
	}
	live := getHTTPJSON(t, client, baseURL+"/livez")
	if live["status"] != "alive" || live["live"] != true {
		t.Fatalf("unexpected live response: %+v", live)
	}
	version := getHTTPJSON(t, client, baseURL+"/version")
	if version["component"] != "server" || version["version"] != "test" {
		t.Fatalf("unexpected version response: %+v", version)
	}

	request, err := http.NewRequest(http.MethodPost, baseURL+"/-/drain", nil)
	if err != nil {
		t.Fatalf("create drain request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer test-token")
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("POST /-/drain error = %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("POST /-/drain status = %d, want %d", response.StatusCode, http.StatusAccepted)
	}
	var drain map[string]any
	if err := json.NewDecoder(response.Body).Decode(&drain); err != nil {
		t.Fatalf("decode drain response: %v", err)
	}
	if drain["state"] != "draining" || drain["ready"] != false {
		t.Fatalf("unexpected drain response: %+v", drain)
	}
	if err := waitForExit(command); err != nil {
		t.Fatalf("server drain exit error = %v", err)
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

func TestServerEntrypointReturnsRuntimeFailure(t *testing.T) {
	binary := buildServerEntrypoint(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve server address: %v", err)
	}
	defer listener.Close()

	command := exec.Command(binary)
	command.Env = commandEnv(map[string]string{"LOOMHELM_HTTP_ADDR": listener.Addr().String()})
	output, err := command.CombinedOutput()
	assertExitCode(t, err, 1)
	if !strings.Contains(string(output), "server exited with error") {
		t.Fatalf("runtime failure output = %q", output)
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

func serverAddressFromLog(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read server log: %v", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		var entry struct {
			Address string `json:"address"`
		}
		if json.Unmarshal([]byte(line), &entry) == nil && entry.Address != "" {
			return entry.Address
		}
	}
	t.Fatalf("server start address missing from log %q", data)
	return ""
}

func waitForHTTPStatus(t *testing.T, client *http.Client, endpoint string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.Get(endpoint)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == want {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("endpoint %s did not return status %d", endpoint, want)
}

func getHTTPJSON(t *testing.T, client *http.Client, endpoint string) map[string]any {
	t.Helper()
	response, err := client.Get(endpoint)
	if err != nil {
		t.Fatalf("GET %s error = %v", endpoint, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		t.Fatalf("GET %s status = %d", endpoint, response.StatusCode)
	}
	var value map[string]any
	if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
		t.Fatalf("decode %s response: %v", endpoint, err)
	}
	return value
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
