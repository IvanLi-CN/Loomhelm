package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestAppServerInvocationDetection(t *testing.T) {
	if isAppServerInvocation([]string{"-c", "features.example=true", "app-server", "--analytics-default-enabled"}) != true {
		t.Fatal("app-server invocation was not detected")
	}
	if isAppServerInvocation([]string{"exec", "--", "app-server"}) != true {
		t.Fatal("app-server invocation after a command boundary was not detected")
	}
	if isAppServerInvocation([]string{"exec", "--help"}) {
		t.Fatal("non-app-server invocation was detected as app-server")
	}
}

func TestTransparentInvocationReplacesTheWrapper(t *testing.T) {
	binary := buildProxyEntrypoint(t)
	command := exec.Command(binary, "-c", "printf TRANSPARENT_PROXY_OK")
	command.Env = append(os.Environ(), "LOOMHELM_STDIO_PROXY_REAL_CLI=/bin/sh")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("transparent wrapper invocation error = %v\n%s", err, output)
	}
	if string(output) != "TRANSPARENT_PROXY_OK" {
		t.Fatalf("transparent output = %q", output)
	}
}

func TestEntrypointRejectsRecursiveChild(t *testing.T) {
	binary := buildProxyEntrypoint(t)
	command := exec.Command(binary, "--help")
	command.Env = append(os.Environ(), "LOOMHELM_STDIO_PROXY_REAL_CLI="+binary)
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatal("recursive child was accepted")
	}
	if !strings.Contains(string(output), "must not point to the stdio proxy itself") {
		t.Fatalf("recursive child output = %q", output)
	}
	if exitError, ok := err.(*exec.ExitError); !ok || exitError.ExitCode() != 2 {
		t.Fatalf("recursive child exit = %v, want code 2", err)
	}
}

func buildProxyEntrypoint(t *testing.T) string {
	t.Helper()
	outputPath := filepath.Join(t.TempDir(), "stdio-proxy")
	command := exec.Command("go", "build", "-o", outputPath, ".")
	command.Dir = filepath.Join(repositoryRoot(), "experiments", "codex", "stdio_proxy", "cmd", "stdio-proxy")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build stdio proxy: %v\n%s", err, output)
	}
	return outputPath
}

func repositoryRoot() string {
	workingDirectory, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	return filepath.Clean(filepath.Join(workingDirectory, "..", "..", "..", "..", ".."))
}
