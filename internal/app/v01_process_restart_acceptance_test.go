package app

import (
	"crypto/x509"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
)

// This is a process-boundary readiness and gateway-reconnect check only. It
// does not create durable command/session state. The Connector app-server is
// the deterministic /bin/true fixture; no Codex credentials or Desktop
// session is loaded by the test.
func TestV01ServerWorkerConnectorProcessRestartReadinessAndReconnectWithFixtures(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	serverBinary := buildV01Entrypoint(t, "./cmd/server", "server")
	workerBinary := buildV01Entrypoint(t, "./cmd/worker", "worker")
	connectorBinary := buildV01Entrypoint(t, "./cmd/connector", "connector")

	serverAddress := reserveV01ListenAddress(t)
	serverValues := map[string]string{
		"LOOMHELM_DATABASE_URL":         databaseURL,
		"LOOMHELM_DATABASE_MAX_CONNS":   "4",
		"LOOMHELM_VERSION":              "v01-server-restart",
		"LOOMHELM_CANDIDATE_SOURCE_SHA": "v01-process-restart",
		"LOOMHELM_ARTIFACT_DIGEST":      "sha256:" + strings.Repeat("1", 64),
		"LOOMHELM_HTTP_ADDR":            serverAddress,
		"LOOMHELM_DRAIN_TOKEN":          "v01-drain-token",
		"LOOMHELM_STARTUP_TIMEOUT":      "30s",
		"LOOMHELM_SHUTDOWN_TIMEOUT":     "5s",
	}
	server := startV01Process(t, serverBinary, "server-first", serverValues)
	waitForV01Log(t, server.logPath, "server started")
	requireV01Ready(t, "http://"+serverAddress)
	stopV01Process(t, server)
	assertV01LogContains(t, server.logPath, "server started", "server stopped")

	serverValues["LOOMHELM_VERSION"] = "v01-server-restart-again"
	server = startV01Process(t, serverBinary, "server-second", serverValues)
	waitForV01Log(t, server.logPath, "server started")
	requireV01Ready(t, "http://"+serverAddress)
	stopV01Process(t, server)
	assertV01LogContains(t, server.logPath, "server started", "server stopped")

	workerAddress := reserveV01ListenAddress(t)
	workerValues := map[string]string{
		"LOOMHELM_DATABASE_URL":         databaseURL,
		"LOOMHELM_DATABASE_MAX_CONNS":   "4",
		"LOOMHELM_VERSION":              "v01-worker-restart",
		"LOOMHELM_CANDIDATE_SOURCE_SHA": "v01-process-restart",
		"LOOMHELM_ARTIFACT_DIGEST":      "sha256:" + strings.Repeat("2", 64),
		"LOOMHELM_WORKER_HTTP_ADDR":     workerAddress,
		"LOOMHELM_DRAIN_TOKEN":          "v01-drain-token",
		"LOOMHELM_WORKER_GENERATION":    "41",
		"LOOMHELM_WORKER_LEASE_KEY":     "v01-process-restart-worker",
		"LOOMHELM_STARTUP_TIMEOUT":      "30s",
		"LOOMHELM_SHUTDOWN_TIMEOUT":     "5s",
	}
	worker := startV01Process(t, workerBinary, "worker-first", workerValues)
	waitForV01Log(t, worker.logPath, "worker started")
	requireV01Ready(t, "http://"+workerAddress)
	stopV01Process(t, worker)
	assertV01LogContains(t, worker.logPath, "worker started", "worker stopped")

	workerValues["LOOMHELM_VERSION"] = "v01-worker-restart-again"
	workerValues["LOOMHELM_WORKER_GENERATION"] = "42"
	worker = startV01Process(t, workerBinary, "worker-second", workerValues)
	waitForV01Log(t, worker.logPath, "worker started")
	requireV01Ready(t, "http://"+workerAddress)
	stopV01Process(t, worker)
	assertV01LogContains(t, worker.logPath, "worker started", "worker stopped")

	registry := newConnectorGatewayRegistry()
	gatewayServer, err := gateway.NewServer(registry)
	if err != nil {
		t.Fatalf("gateway.NewServer() error = %v", err)
	}
	tlsServer := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/v1/auth/connector/identity" {
			raw := strings.TrimSpace(strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "))
			credential, decodeErr := auth.DecodeConnectorAPIKey(raw)
			if decodeErr != nil || credential.HostID != registry.credential.HostID || credential.Token != registry.token {
				http.Error(writer, http.StatusText(http.StatusUnauthorized), http.StatusUnauthorized)
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"host_id":"`+credential.HostID+`"}`)
			return
		}
		gatewayServer.ServeHTTP(writer, request)
	}))
	t.Cleanup(tlsServer.Close)
	certPath := writeV01GatewayCertificate(t, tlsServer.Certificate())
	connectorConfigDir := t.TempDir()
	if err := os.Chmod(connectorConfigDir, 0o700); err != nil {
		t.Fatalf("secure Connector config directory: %v", err)
	}
	connectorBinDir := t.TempDir()
	if err := os.Symlink("/bin/true", filepath.Join(connectorBinDir, "codex")); err != nil {
		t.Fatalf("create deterministic codex command: %v", err)
	}
	apiKey, err := auth.EncodeConnectorAPIKey(registry.credential.HostID, registry.token)
	if err != nil {
		t.Fatalf("encode Connector API key: %v", err)
	}
	connectorValues := map[string]string{
		"LOOMHELM_VERSION":            "v01-connector-restart",
		"LOOMHELM_CONNECTOR_BASE_URL": tlsServer.URL,
		"LOOMHELM_CONNECTOR_API_KEY":  apiKey,
		"HOME":                        connectorConfigDir,
		"XDG_CONFIG_HOME":             connectorConfigDir,
		"PATH":                        connectorBinDir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"SSL_CERT_FILE":               certPath,
	}
	connector := startV01Process(t, connectorBinary, "connector-first", connectorValues)
	waitForV01Log(t, connector.logPath, "connector started")
	waitForV01GatewayGeneration(t, registry, 1)
	stopV01Process(t, connector)
	assertV01LogContains(t, connector.logPath, "connector started", "connector stopped")

	connectorValues["LOOMHELM_VERSION"] = "v01-connector-restart-again"
	connector = startV01Process(t, connectorBinary, "connector-second", connectorValues)
	waitForV01Log(t, connector.logPath, "connector started")
	waitForV01GatewayGeneration(t, registry, 2)
	stopV01Process(t, connector)
	assertV01LogContains(t, connector.logPath, "connector started", "connector stopped")
}

type v01Process struct {
	command *exec.Cmd
	logFile *os.File
	logPath string
}

func buildV01Entrypoint(t *testing.T, packagePath, name string) string {
	t.Helper()
	root := v01RepositoryRoot()
	outputPath := filepath.Join(t.TempDir(), name)
	command := exec.Command("go", "build", "-o", outputPath, packagePath)
	command.Dir = root
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build %s: %v\n%s", name, err, output)
	}
	return outputPath
}

func startV01Process(t *testing.T, binary, name string, values map[string]string) *v01Process {
	t.Helper()
	logPath := filepath.Join(t.TempDir(), name+".log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatalf("create %s log: %v", name, err)
	}
	command := exec.Command(binary)
	command.Env = v01CommandEnv(values)
	command.Stdout = logFile
	command.Stderr = logFile
	if err := command.Start(); err != nil {
		logFile.Close()
		t.Fatalf("start %s: %v", name, err)
	}
	process := &v01Process{command: command, logFile: logFile, logPath: logPath}
	t.Cleanup(func() {
		if command.ProcessState == nil && command.Process != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
		_ = logFile.Close()
	})
	return process
}

func stopV01Process(t *testing.T, process *v01Process) {
	t.Helper()
	if process.command.ProcessState != nil {
		return
	}
	if err := process.command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("stop process: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- process.command.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("process exit error = %v", err)
		}
	case <-time.After(15 * time.Second):
		_ = process.command.Process.Kill()
		<-done
		t.Fatal("process did not stop after SIGTERM")
	}
	if err := process.logFile.Close(); err != nil {
		t.Fatalf("close process log: %v", err)
	}
}

func waitForV01Log(t *testing.T, path, marker string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), marker) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	data, _ := os.ReadFile(path)
	t.Fatalf("timed out waiting for log %q: %s", marker, data)
}

func assertV01LogContains(t *testing.T, path string, markers ...string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read process log: %v", err)
	}
	for _, marker := range markers {
		if !strings.Contains(string(data), marker) {
			t.Fatalf("process log %q does not contain %q", data, marker)
		}
	}
}

func requireV01Ready(t *testing.T, baseURL string) {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(baseURL + "/readyz")
	if err != nil {
		t.Fatalf("GET %s/readyz: %v", baseURL, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("GET %s/readyz status = %d, body = %s", baseURL, response.StatusCode, body)
	}
}

func waitForV01GatewayGeneration(t *testing.T, registry *connectorGatewayRegistry, want int64) {
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		registry.mu.Lock()
		generation := registry.generation
		registry.mu.Unlock()
		if generation >= want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	t.Fatalf("Connector gateway generation = %d, want at least %d", registry.generation, want)
}

func writeV01GatewayCertificate(t *testing.T, certificate *x509.Certificate) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "gateway-ca.pem")
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write gateway certificate: %v", err)
	}
	return path
}

func reserveV01ListenAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve process listener: %v", err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("release reserved process listener: %v", err)
	}
	return address
}

func v01CommandEnv(values map[string]string) []string {
	env := make([]string, 0, len(os.Environ())+len(values))
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if !strings.HasPrefix(key, "LOOMHELM_") {
			if _, overridden := values[key]; overridden {
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

func v01RepositoryRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}
