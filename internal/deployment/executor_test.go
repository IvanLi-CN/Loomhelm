package deployment

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCommandExecutorUsesOnlyAllowlistedArguments(t *testing.T) {
	var binary string
	var args []string
	executor := &CommandExecutor{
		ComposeBinary:  "docker",
		ComposeFile:    "/srv/loomhelm/compose.yaml",
		ComposeEnvFile: "/srv/loomhelm/.env",
		ProjectName:    "loomhelm",
		CaddyBinary:    "caddy",
		CaddyFile:      "/etc/caddy/Caddyfile",
		Run: func(_ context.Context, gotBinary string, gotArgs ...string) error {
			binary = gotBinary
			args = append([]string(nil), gotArgs...)
			return nil
		},
	}
	if err := executor.Execute(context.Background(), Operation{Kind: "preflight"}); err != nil {
		t.Fatal(err)
	}
	if binary != "docker" || !reflect.DeepEqual(args, []string{"compose", "--env-file", "/srv/loomhelm/.env", "-f", "/srv/loomhelm/compose.yaml", "-p", "loomhelm", "config", "--quiet"}) {
		t.Fatalf("preflight command = %s %v", binary, args)
	}
	if strings.Contains(strings.Join(args, " "), "shell") || strings.Contains(strings.Join(args, " "), ";") {
		t.Fatalf("command unexpectedly contains shell syntax: %v", args)
	}
}

func TestNewCommandExecutorRejectsBinaryOverrides(t *testing.T) {
	t.Setenv("LOOMHELM_DEPLOYMENT_COMPOSE_BINARY", "/tmp/compose-wrapper")
	if _, err := NewCommandExecutorFromEnvironment(); err == nil {
		t.Fatal("NewCommandExecutorFromEnvironment() accepted an untrusted Compose binary")
	}
	t.Setenv("LOOMHELM_DEPLOYMENT_COMPOSE_BINARY", "")
	t.Setenv("LOOMHELM_DEPLOYMENT_CADDY_BINARY", "/tmp/caddy-wrapper")
	if _, err := NewCommandExecutorFromEnvironment(); err == nil {
		t.Fatal("NewCommandExecutorFromEnvironment() accepted an untrusted Caddy binary")
	}
}

func TestNewCommandExecutorPassesCaddyHostToCLI(t *testing.T) {
	t.Setenv("LOOMHELM_DEPLOYMENT_CADDY_ADMIN_URL", "http://caddy-control:2019")
	executor, err := NewCommandExecutorFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	args := executor.caddyArguments("reload")
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "http://") || !strings.Contains(joined, "--address caddy-control:2019") {
		t.Fatalf("Caddy CLI arguments = %v", args)
	}
}

func TestCommandExecutorStagesAndDrainsWithFixedHTTPContracts(t *testing.T) {
	var draining atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/readyz":
			if draining.Load() {
				writer.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			writer.WriteHeader(http.StatusOK)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	commands := make([][]string, 0, 2)
	executor := &CommandExecutor{
		ComposeBinary: "docker",
		ComposeFile:   "/srv/compose.yaml",
		ProjectName:   "loomhelm",
		CaddyFile:     "/etc/caddy/Caddyfile",
		SlotURLs:      map[string]string{"green": server.URL},
		WorkerURLs:    map[string]string{"green": server.URL},
		DrainToken:    "drain-secret",
		Run: func(_ context.Context, _ string, args ...string) error {
			commands = append(commands, append([]string(nil), args...))
			if len(args) > 0 && args[0] == "compose" {
				for _, argument := range args {
					if argument == "exec" {
						draining.Store(true)
						break
					}
				}
			}
			return nil
		},
	}
	operation := Operation{Kind: "stage", Slot: "green"}
	if err := executor.Execute(context.Background(), operation); err != nil {
		t.Fatalf("stage error = %v", err)
	}
	if err := executor.Execute(context.Background(), Operation{Kind: "drain", Slot: "green"}); err != nil {
		t.Fatalf("drain error = %v", err)
	}
	if !reflect.DeepEqual(commands[0], []string{"compose", "-f", "/srv/compose.yaml", "-p", "loomhelm", "up", "--detach", "--force-recreate", "--no-deps", "server-green"}) {
		t.Fatalf("stage command = %v", commands[0])
	}
	if len(commands) != 3 {
		t.Fatalf("commands = %v, want stage plus server and worker drain", commands)
	}
	for _, command := range commands[1:] {
		joined := strings.Join(command, " ")
		if !strings.Contains(joined, "exec -T") || !strings.Contains(joined, "Authorization: Bearer drain-secret") || !strings.Contains(joined, "/-/drain") {
			t.Fatalf("drain command = %v", command)
		}
	}
}

func TestCommandExecutorRejectsUntrustedSlot(t *testing.T) {
	executor := &CommandExecutor{ComposeBinary: "docker", ComposeFile: "/srv/compose.yaml", ProjectName: "loomhelm"}
	if err := executor.Execute(context.Background(), Operation{Kind: "stage", Slot: "green; touch /tmp/pwned"}); err == nil {
		t.Fatal("Execute() accepted an untrusted slot")
	}
}

func TestCommandExecutorRendersCaddyRouteBeforeReload(t *testing.T) {
	directory := t.TempDir()
	templatePath := filepath.Join(directory, "Caddyfile.tmpl")
	configPath := filepath.Join(directory, "Caddyfile")
	if err := os.WriteFile(templatePath, []byte("reverse_proxy server-__ACTIVE_SLOT__:8080\ntry_files __RETAINED_PATHS__\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var validated, reloaded bool
	executor := &CommandExecutor{
		CaddyBinary:   "caddy",
		CaddyFile:     configPath,
		CaddyTemplate: templatePath,
		Run: func(_ context.Context, _ string, args ...string) error {
			if len(args) == 0 {
				t.Fatalf("unexpected Caddy arguments: %v", args)
			}
			switch args[0] {
			case "validate":
				validated = true
			case "reload":
				reloaded = true
			default:
				t.Fatalf("unexpected Caddy action: %v", args)
			}
			return nil
		},
	}
	if err := executor.Execute(context.Background(), Operation{Kind: "promote", Slot: "green"}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "reverse_proxy server-green:8080\ntry_files /retained{path}\n" || !validated || !reloaded {
		t.Fatalf("rendered Caddy config = %q, validated = %v, reloaded = %v", content, validated, reloaded)
	}
}

func TestCommandExecutorValidatesCaddyBeforeInstallingIt(t *testing.T) {
	directory := t.TempDir()
	templatePath := filepath.Join(directory, "Caddyfile.tmpl")
	configPath := filepath.Join(directory, "Caddyfile")
	if err := os.WriteFile(templatePath, []byte("reverse_proxy server-green:8080\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("old configuration\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	executor := &CommandExecutor{
		CaddyBinary:   "caddy",
		CaddyFile:     configPath,
		CaddyTemplate: templatePath,
		Run: func(_ context.Context, _ string, args ...string) error {
			if args[0] == "validate" {
				return context.Canceled
			}
			return nil
		},
	}
	if err := executor.Execute(context.Background(), Operation{Kind: "promote", Slot: "green"}); err == nil {
		t.Fatal("Execute() accepted invalid Caddy configuration")
	}
	content, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "old configuration\n" {
		t.Fatalf("live Caddy configuration changed after validation failure: %q", content)
	}
	if _, err := os.Stat(configPath + ".next"); !os.IsNotExist(err) {
		t.Fatalf("staged Caddy configuration was retained after validation failure: %v", err)
	}
}

func TestCommandExecutorRunsCaddyValidationBeforeWorkerAdmission(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/readyz", "/version":
			writer.Header().Set("Content-Type", "application/json")
			if request.URL.Path == "/version" {
				_, _ = writer.Write([]byte(`{"candidate_source_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","artifact_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`))
				return
			}
			_, _ = writer.Write([]byte(`{"ready":true}`))
		default:
			writer.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer server.Close()
	var commands []string
	executor := &CommandExecutor{
		ComposeBinary: "docker",
		ComposeFile:   "/srv/compose.yaml",
		ProjectName:   "loomhelm",
		CaddyBinary:   "caddy",
		CaddyFile:     "/etc/caddy/Caddyfile",
		SlotURLs:      map[string]string{"green": server.URL},
		WorkerURLs:    map[string]string{"green": server.URL},
		PublicURL:     server.URL,
		Run: func(_ context.Context, _ string, args ...string) error {
			if len(args) > 0 {
				commands = append(commands, args[0]+" "+strings.Join(args[1:], " "))
			}
			return nil
		},
	}
	operation := Operation{
		Kind:               "promote",
		Slot:               "green",
		CandidateID:        strings.Repeat("a", 64),
		CandidateSourceSHA: strings.Repeat("a", 40),
		ArtifactDigest:     "sha256:" + strings.Repeat("b", 64),
		ServerImage:        "ghcr.io/example/server@sha256:" + strings.Repeat("a", 64),
		WorkerImage:        "ghcr.io/example/worker@sha256:" + strings.Repeat("b", 64),
		WorkerGeneration:   2,
	}
	if err := executor.Execute(context.Background(), operation); err != nil {
		t.Fatal(err)
	}
	validateIndex, workerIndex := -1, -1
	for index, command := range commands {
		if strings.HasPrefix(command, "validate ") {
			validateIndex = index
		}
		if strings.Contains(command, "worker-green") {
			workerIndex = index
		}
	}
	if validateIndex < 0 || workerIndex < 0 || validateIndex >= workerIndex {
		t.Fatalf("commands = %v, want Caddy validation before Worker admission", commands)
	}
}
