package deployment

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
)

var ErrDrainTimeout = errors.New("deployment drain timed out")

const (
	allowlistedComposeBinary = "/usr/bin/docker"
	allowlistedCaddyBinary   = "/usr/local/bin/caddy"
)

type DegradedError struct{ Err error }

func (e *DegradedError) Error() string {
	if e == nil || e.Err == nil {
		return "deployment completed with degraded drain"
	}
	return e.Err.Error()
}

func (e *DegradedError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// CommandExecutor is deliberately a closed command set. Request data selects
// only a registered candidate and slot; it can never provide a shell string,
// Compose flag, binary path or Caddy endpoint.
type CommandExecutor struct {
	ComposeBinary     string
	ComposeFile       string
	ComposeEnvFile    string
	ProjectName       string
	CaddyBinary       string
	CaddyFile         string
	CaddyTemplate     string
	CaddyAdminAddress string
	PublicURL         string
	DrainToken        string
	WebRoot           string
	SlotURLs          map[string]string
	WorkerURLs        map[string]string
	HTTPClient        *http.Client
	DrainTimeout      time.Duration
	Run               func(context.Context, string, ...string) error

	observationMu     sync.Mutex
	observationSample *observationSample
	lastObservation   *Observation
}

func NewCommandExecutorFromEnvironment() (*CommandExecutor, error) {
	composeFile := strings.TrimSpace(os.Getenv("LOOMHELM_DEPLOYMENT_COMPOSE_FILE"))
	if composeFile == "" {
		composeFile = "/opt/loomhelm/deploy/production/compose.yaml"
	}
	projectName := strings.TrimSpace(os.Getenv("LOOMHELM_DEPLOYMENT_COMPOSE_PROJECT"))
	if projectName == "" {
		projectName = "loomhelm-production"
	}
	caddyFile := strings.TrimSpace(os.Getenv("LOOMHELM_DEPLOYMENT_CADDY_FILE"))
	if caddyFile == "" {
		caddyFile = "/etc/caddy/Caddyfile"
	}
	caddyTemplate := strings.TrimSpace(os.Getenv("LOOMHELM_DEPLOYMENT_CADDY_TEMPLATE"))
	for name, value := range map[string]string{"compose file": composeFile, "Caddy file": caddyFile} {
		if !filepath.IsAbs(value) {
			return nil, fmt.Errorf("deployment %s must be an absolute path", name)
		}
	}
	if caddyTemplate != "" && !filepath.IsAbs(caddyTemplate) {
		return nil, errors.New("deployment Caddy template must be an absolute path")
	}
	composeEnvFile := strings.TrimSpace(os.Getenv("LOOMHELM_DEPLOYMENT_ENV_FILE"))
	if composeEnvFile != "" && !filepath.IsAbs(composeEnvFile) {
		return nil, errors.New("deployment Compose env file must be an absolute path")
	}
	webRoot := envOrDefault("LOOMHELM_DEPLOYMENT_WEB_ROOT", "/opt/loomhelm/web")
	if !filepath.IsAbs(webRoot) {
		return nil, errors.New("deployment Web root must be an absolute path")
	}
	if configured := strings.TrimSpace(os.Getenv("LOOMHELM_DEPLOYMENT_COMPOSE_BINARY")); configured != "" && configured != allowlistedComposeBinary {
		return nil, fmt.Errorf("deployment Compose binary must be %s", allowlistedComposeBinary)
	}
	if configured := strings.TrimSpace(os.Getenv("LOOMHELM_DEPLOYMENT_CADDY_BINARY")); configured != "" && configured != allowlistedCaddyBinary {
		return nil, fmt.Errorf("deployment Caddy binary must be %s", allowlistedCaddyBinary)
	}
	drainTimeout, err := durationFromEnvironment("LOOMHELM_DEPLOYMENT_DRAIN_TIMEOUT", 30*time.Second)
	if err != nil {
		return nil, err
	}
	publicURL := envOrDefault("LOOMHELM_DEPLOYMENT_PUBLIC_URL", "http://caddy:80")
	adminURL := envOrDefault("LOOMHELM_DEPLOYMENT_CADDY_ADMIN_URL", "http://caddy-control:2019")
	var adminAddress string
	for name, value := range map[string]string{"deployment public URL": publicURL, "Caddy admin URL": adminURL} {
		parsed, parseErr := url.Parse(value)
		if parseErr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, fmt.Errorf("deployment %s must be an absolute credential-free HTTP URL", name)
		}
		if name == "Caddy admin URL" {
			adminAddress = parsed.Host
		}
	}
	return &CommandExecutor{
		ComposeBinary:     allowlistedComposeBinary,
		ComposeFile:       composeFile,
		ComposeEnvFile:    composeEnvFile,
		ProjectName:       projectName,
		CaddyBinary:       allowlistedCaddyBinary,
		CaddyFile:         caddyFile,
		CaddyTemplate:     caddyTemplate,
		CaddyAdminAddress: adminAddress,
		PublicURL:         strings.TrimRight(publicURL, "/"),
		DrainToken:        os.Getenv("LOOMHELM_DRAIN_TOKEN"),
		WebRoot:           webRoot,
		SlotURLs: map[string]string{
			"blue":  strings.TrimRight(os.Getenv("LOOMHELM_DEPLOYMENT_BLUE_URL"), "/"),
			"green": strings.TrimRight(os.Getenv("LOOMHELM_DEPLOYMENT_GREEN_URL"), "/"),
		},
		WorkerURLs: map[string]string{
			"blue":  strings.TrimRight(os.Getenv("LOOMHELM_DEPLOYMENT_BLUE_WORKER_URL"), "/"),
			"green": strings.TrimRight(os.Getenv("LOOMHELM_DEPLOYMENT_GREEN_WORKER_URL"), "/"),
		},
		HTTPClient:   &http.Client{Timeout: 5 * time.Second},
		DrainTimeout: drainTimeout,
	}, nil
}

func durationFromEnvironment(key string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive Go duration", key)
	}
	return value, nil
}

func (e *CommandExecutor) Execute(ctx context.Context, operation Operation) error {
	if e == nil {
		return ErrExecutorUnavailable
	}
	kind := operation.ExecutionKind
	if kind == "" {
		kind = operation.Kind
	}
	if operation.CandidateID != "" {
		if !validCandidateID(operation.CandidateID) || !validImageReference(operation.ServerImage) || !validImageReference(operation.WorkerImage) {
			return ErrInvalidCandidate
		}
		if err := e.verifyCandidateWeb(operation); err != nil {
			return err
		}
	}
	switch kind {
	case "preflight":
		if err := e.prepareCaddy(ctx, operation, false); err != nil {
			return err
		}
		return e.run(ctx, &operation, e.ComposeBinary, e.composeArguments("config", "--quiet")...)
	case "stage":
		if err := requireSlot(operation.Slot); err != nil {
			return err
		}
		if operation.CandidateID != "" && operation.WorkerGeneration <= 0 {
			return fmt.Errorf("%w: staged candidate has no worker generation", ErrInvalidCandidate)
		}
		if err := e.run(ctx, &operation, e.ComposeBinary, e.composeArguments("up", "--detach", "--force-recreate", "--no-deps", "server-"+operation.Slot)...); err != nil {
			return err
		}
		return e.waitServerIdentity(ctx, operation)
	case "promote", "rollback":
		if err := requireSlot(operation.Slot); err != nil {
			return err
		}
		if operation.CandidateID != "" && operation.WorkerGeneration <= 0 {
			return fmt.Errorf("%w: promoted candidate has no worker generation", ErrInvalidCandidate)
		}
		if err := e.prepareCaddy(ctx, operation, true); err != nil {
			return err
		}
		if operation.CandidateID != "" {
			if err := e.run(ctx, &operation, e.ComposeBinary, e.composeArguments("up", "--detach", "--force-recreate", "--no-deps", "worker-"+operation.Slot)...); err != nil {
				return err
			}
			if err := e.waitWorkerIdentity(ctx, operation); err != nil {
				return err
			}
		}
		if err := e.run(ctx, nil, e.CaddyBinary, e.caddyArguments("reload")...); err != nil {
			return err
		}
		if operation.CandidateID != "" {
			if err := e.probePublic(ctx, operation); err != nil {
				return err
			}
		}
		if operation.RetiringSlot != "" && operation.RetiringSlot != operation.Slot {
			if err := e.drain(ctx, operation.RetiringSlot); err != nil {
				return &DegradedError{Err: err}
			}
		}
		return nil
	case "drain":
		if err := requireSlot(operation.Slot); err != nil {
			return err
		}
		return e.drain(ctx, operation.Slot)
	case "reconcile":
		switch operation.ExecutionKind {
		case "stage":
			return e.waitServerIdentity(ctx, operation)
		case "promote", "rollback":
			if err := e.waitServerIdentity(ctx, operation); err != nil {
				return err
			}
			if err := e.waitWorkerIdentity(ctx, operation); err != nil {
				return err
			}
			if err := e.prepareCaddy(ctx, operation, true); err != nil {
				return err
			}
			if err := e.run(ctx, nil, e.CaddyBinary, e.caddyArguments("reload")...); err != nil {
				return err
			}
			if err := e.probePublic(ctx, operation); err != nil {
				return err
			}
			if operation.RetiringSlot != "" && operation.RetiringSlot != operation.Slot {
				if err := e.drain(ctx, operation.RetiringSlot); err != nil {
					return &DegradedError{Err: err}
				}
			}
			return nil
		case "drain":
			return e.waitDrained(ctx, operation.Slot)
		default:
			return fmt.Errorf("unsupported reconcile target %q", operation.ExecutionKind)
		}
	default:
		return fmt.Errorf("unsupported deployment operation %q", kind)
	}
}

func (e *CommandExecutor) composeArguments(arguments ...string) []string {
	result := []string{"compose"}
	if e.ComposeEnvFile != "" {
		result = append(result, "--env-file", e.ComposeEnvFile)
	}
	result = append(result, "-f", e.ComposeFile, "-p", e.ProjectName)
	return append(result, arguments...)
}

func (e *CommandExecutor) caddyArguments(action string) []string {
	return e.caddyArgumentsFor(action, e.CaddyFile)
}

func (e *CommandExecutor) caddyArgumentsFor(action, configFile string) []string {
	args := []string{action}
	if e.CaddyAdminAddress != "" {
		args = append(args, "--address", e.CaddyAdminAddress)
	}
	return append(args, "--config", configFile, "--adapter", "caddyfile")
}

func (e *CommandExecutor) run(ctx context.Context, operation *Operation, binary string, arguments ...string) error {
	if e.Run != nil {
		return e.Run(ctx, binary, arguments...)
	}
	if binary != allowlistedComposeBinary && binary != allowlistedCaddyBinary {
		return fmt.Errorf("deployment command binary is not allowlisted: %q", binary)
	}
	environment := os.Environ()
	if operation != nil && operation.Slot != "" && operation.CandidateID != "" {
		prefix := strings.ToUpper(operation.Slot)
		environment = setEnvironment(environment, "LOOMHELM_"+prefix+"_SERVER_IMAGE", operation.ServerImage)
		environment = setEnvironment(environment, "LOOMHELM_"+prefix+"_WORKER_IMAGE", operation.WorkerImage)
		environment = setEnvironment(environment, "LOOMHELM_"+prefix+"_SOURCE_SHA", operation.CandidateSourceSHA)
		environment = setEnvironment(environment, "LOOMHELM_"+prefix+"_ARTIFACT_DIGEST", operation.ArtifactDigest)
		environment = setEnvironment(environment, fmt.Sprintf("LOOMHELM_%s_WORKER_GENERATION", prefix), fmt.Sprintf("%d", operation.WorkerGeneration))
	}
	command := exec.CommandContext(ctx, binary, arguments...)
	command.Env = environment
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return fmt.Errorf("run allowlisted deployment command %q: %w", filepath.Base(binary), err)
	}
	return nil
}

func setEnvironment(environment []string, key, value string) []string {
	prefix := key + "="
	filtered := environment[:0]
	for _, entry := range environment {
		if !strings.HasPrefix(entry, prefix) {
			filtered = append(filtered, entry)
		}
	}
	return append(filtered, prefix+value)
}

func (e *CommandExecutor) renderedCaddyPath() string {
	return e.CaddyFile + ".next"
}

func (e *CommandExecutor) prepareCaddy(ctx context.Context, operation Operation, install bool) error {
	configFile := e.CaddyFile
	if e.CaddyTemplate != "" {
		if err := e.renderCaddy(operation); err != nil {
			return err
		}
		configFile = e.renderedCaddyPath()
		defer func() { _ = os.Remove(configFile) }()
	}
	if err := e.run(ctx, nil, e.CaddyBinary, e.caddyArgumentsFor("validate", configFile)...); err != nil {
		return err
	}
	if !install || e.CaddyTemplate == "" {
		return nil
	}
	if err := os.Rename(configFile, e.CaddyFile); err != nil {
		return fmt.Errorf("install deployment Caddy file: %w", err)
	}
	return nil
}

func (e *CommandExecutor) renderCaddy(operation Operation) error {
	if e.CaddyTemplate == "" {
		return nil
	}
	content, err := os.ReadFile(e.CaddyTemplate)
	if err != nil {
		return fmt.Errorf("read deployment Caddy template: %w", err)
	}
	rendered := strings.ReplaceAll(string(content), "__ACTIVE_SLOT__", operation.Slot)
	activeCandidate := "/current"
	if operation.CandidateID != "" {
		activeCandidate = "/candidates/" + operation.CandidateID
	}
	rendered = strings.ReplaceAll(rendered, "__ACTIVE_CANDIDATE__", activeCandidate)
	retained := make([]string, 0, len(operation.RetainedCandidates))
	for _, candidateID := range operation.RetainedCandidates {
		if validCandidateID(candidateID) && candidateID != operation.CandidateID {
			retained = append(retained, "/candidates/"+candidateID+"{path}")
		}
	}
	if len(retained) == 0 && operation.CandidateID == "" {
		retained = append(retained, "/retained{path}")
	}
	rendered = strings.ReplaceAll(rendered, "__RETAINED_PATHS__", strings.Join(retained, " "))
	if strings.Contains(rendered, "__ACTIVE_SLOT__") || strings.Contains(rendered, "__ACTIVE_CANDIDATE__") || strings.Contains(rendered, "__RETAINED_PATHS__") {
		return errors.New("deployment Caddy template contains an unsupported placeholder")
	}
	directory := filepath.Dir(e.CaddyFile)
	temporary, err := os.CreateTemp(directory, ".Caddyfile.*")
	if err != nil {
		return fmt.Errorf("create temporary deployment Caddy file: %w", err)
	}
	temporaryName := temporary.Name()
	defer func() { _ = os.Remove(temporaryName) }()
	if _, err := temporary.WriteString(rendered); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write deployment Caddy file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync deployment Caddy file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close deployment Caddy file: %w", err)
	}
	if err := os.Rename(temporaryName, e.renderedCaddyPath()); err != nil {
		return fmt.Errorf("stage deployment Caddy file: %w", err)
	}
	return nil
}

func (e *CommandExecutor) verifyCandidateWeb(operation Operation) error {
	if e.WebRoot == "" || operation.CandidateID == "" {
		return nil
	}
	if !validCandidateID(operation.CandidateID) {
		return ErrInvalidCandidate
	}
	root := filepath.Join(e.WebRoot, "candidates", operation.CandidateID)
	info, err := os.Stat(root)
	if err != nil {
		return fmt.Errorf("candidate Web tree is unavailable: %w", err)
	}
	if !info.IsDir() {
		return errors.New("candidate Web root is not a directory")
	}
	digest, err := webTreeDigest(root)
	if err != nil {
		return err
	}
	if operation.WebDigest != "" && digest != operation.WebDigest {
		return fmt.Errorf("candidate Web digest %s does not match registered %s", digest, operation.WebDigest)
	}
	return nil
}

func webTreeDigest(root string) (string, error) {
	type record struct {
		path string
		hash string
		size int64
		mode os.FileMode
	}
	var records []record
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("candidate Web tree contains a symlink: %s", path)
		}
		if info.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(data)
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		records = append(records, record{path: filepath.ToSlash(relative), hash: hex.EncodeToString(digest[:]), size: info.Size(), mode: info.Mode() & 0o7777})
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("hash candidate Web tree: %w", err)
	}
	if len(records) == 0 {
		return "", errors.New("candidate Web tree is empty")
	}
	sort.Slice(records, func(i, j int) bool { return records[i].path < records[j].path })
	hash := sha256.New()
	for _, record := range records {
		_, _ = fmt.Fprintf(hash, "%s\x00%s\x00%d\x00%d\n", record.path, record.hash, record.size, record.mode)
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

func (e *CommandExecutor) waitServerIdentity(ctx context.Context, operation Operation) error {
	if err := e.waitReady(ctx, operation.Slot, false); err != nil {
		return err
	}
	return e.verifyVersion(ctx, e.SlotURLs[operation.Slot], operation, "server")
}

func (e *CommandExecutor) waitWorkerIdentity(ctx context.Context, operation Operation) error {
	if err := e.waitReady(ctx, operation.Slot, true); err != nil {
		return err
	}
	return e.verifyVersion(ctx, e.WorkerURLs[operation.Slot], operation, "worker")
}

func (e *CommandExecutor) waitReady(ctx context.Context, slot string, worker bool) error {
	baseURL := e.SlotURLs[slot]
	component := "Server"
	if worker {
		baseURL = e.WorkerURLs[slot]
		component = "Worker"
	}
	if baseURL == "" {
		return ErrExecutorUnavailable
	}
	return e.requestStatus(ctx, http.MethodGet, baseURL+"/readyz", nil, func(status int, body []byte) error {
		if status < http.StatusOK || status >= http.StatusMultipleChoices {
			return fmt.Errorf("deployment %s readiness returned HTTP %d: %s", component, status, strings.TrimSpace(string(body)))
		}
		return nil
	})
}

func (e *CommandExecutor) verifyVersion(ctx context.Context, baseURL string, operation Operation, component string) error {
	if baseURL == "" || operation.CandidateSourceSHA == "" || operation.ArtifactDigest == "" {
		return nil
	}
	var version struct {
		CandidateSourceSHA string `json:"candidate_source_sha"`
		ArtifactDigest     string `json:"artifact_digest"`
	}
	err := e.requestStatus(ctx, http.MethodGet, baseURL+"/version", nil, func(status int, body []byte) error {
		if status != http.StatusOK {
			return fmt.Errorf("deployment %s version returned HTTP %d", component, status)
		}
		return json.Unmarshal(body, &version)
	})
	if err != nil {
		return err
	}
	if version.CandidateSourceSHA != operation.CandidateSourceSHA || version.ArtifactDigest != operation.ArtifactDigest {
		return fmt.Errorf("deployment %s identity does not match candidate", component)
	}
	return nil
}

func (e *CommandExecutor) probePublic(ctx context.Context, operation Operation) error {
	baseURL := strings.TrimRight(e.PublicURL, "/")
	if baseURL == "" {
		return ErrExecutorUnavailable
	}
	if err := e.verifyVersion(ctx, baseURL, operation, "public Server"); err != nil {
		return err
	}
	for _, path := range []string{"/readyz", "/mcp", "/gateway"} {
		if err := e.requestStatus(ctx, http.MethodGet, baseURL+path, nil, func(status int, _ []byte) error {
			if status == http.StatusNotFound || status >= http.StatusInternalServerError {
				return fmt.Errorf("public deployment route %s returned HTTP %d", path, status)
			}
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

func (e *CommandExecutor) drain(ctx context.Context, slot string) error {
	if e.SlotURLs[slot] == "" || e.WorkerURLs[slot] == "" || e.DrainToken == "" {
		return ErrExecutorUnavailable
	}
	for _, target := range []struct {
		service string
		port    string
	}{
		{service: "server-" + slot, port: "8080"},
		{service: "worker-" + slot, port: "8081"},
	} {
		arguments := e.composeArguments("exec", "-T", target.service, "/bin/busybox", "wget", "-q", "-O", "-", "--header", "Authorization: Bearer "+e.DrainToken, "--post-data", "", "http://127.0.0.1:"+target.port+"/-/drain")
		if err := e.run(ctx, nil, e.ComposeBinary, arguments...); err != nil {
			return err
		}
	}
	return e.waitDrained(ctx, slot)
}

func (e *CommandExecutor) waitDrained(ctx context.Context, slot string) error {
	timeout := e.DrainTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	drainCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	acceptedDrain := true
	for {
		err := e.requestStatus(drainCtx, http.MethodGet, e.SlotURLs[slot]+"/readyz", nil, func(status int, _ []byte) error {
			if status >= http.StatusOK && status < http.StatusMultipleChoices {
				return errServerRemainsReady
			}
			if status == http.StatusServiceUnavailable {
				return nil
			}
			return fmt.Errorf("drain readiness returned HTTP %d", status)
		})
		if err == nil {
			return nil
		}
		if acceptedDrain && isClosedDrainEndpoint(err) {
			return nil
		}
		if !errors.Is(err, errServerRemainsReady) {
			if errors.Is(drainCtx.Err(), context.DeadlineExceeded) {
				return fmt.Errorf("%w for slot %s", ErrDrainTimeout, slot)
			}
			return err
		}
		select {
		case <-drainCtx.Done():
			return fmt.Errorf("%w for slot %s", ErrDrainTimeout, slot)
		case <-ticker.C:
		}
	}
}

func isClosedDrainEndpoint(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, io.EOF)
}

var errServerRemainsReady = errors.New("server remains ready")

func (e *CommandExecutor) requestStatus(ctx context.Context, method, rawURL string, body io.Reader, check func(int, []byte) error) error {
	request, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return err
	}
	return e.request(ctx, request, check)
}

func (e *CommandExecutor) request(_ context.Context, request *http.Request, check func(int, []byte) error) error {
	client := e.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("deployment HTTP request failed: %w", err)
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if readErr != nil {
		return readErr
	}
	return check(response.StatusCode, body)
}

func validCandidateID(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func requireSlot(slot string) error {
	if slot != "blue" && slot != "green" {
		return fmt.Errorf("%w: deployment slot must be blue or green", auth.ErrInvalid)
	}
	return nil
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
