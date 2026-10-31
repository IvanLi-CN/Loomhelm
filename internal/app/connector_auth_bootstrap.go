package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

const connectorCredentialCacheVersion = 1

type connectorCredentialCache struct {
	Version   int    `json:"version"`
	ServerURL string `json:"server_url"`
	HostID    string `json:"host_id"`
	Token     string `json:"token"`
}

type connectorCredentialBootstrapper struct {
	client      *http.Client
	openBrowser func(context.Context, string) error
}

func connectorCredentialFromConfig(cfg platform.Config) (auth.ConnectorCredential, bool, error) {
	if cfg.ConnectorHostID != "" || cfg.ConnectorToken != "" {
		return auth.ConnectorCredential{HostID: cfg.ConnectorHostID, Token: cfg.ConnectorToken}, true, nil
	}
	apiKey := strings.TrimSpace(cfg.ConnectorAPIKey)
	if apiKey == "" {
		return auth.ConnectorCredential{}, false, nil
	}
	if strings.HasPrefix(apiKey, "lhk_") {
		credential, err := auth.DecodeConnectorAPIKey(apiKey)
		if err != nil {
			return auth.ConnectorCredential{}, false, err
		}
		return credential, true, nil
	}
	return auth.ConnectorCredential{}, false, nil
}

func newConnectorPlatformClient(cfg platform.Config, credential auth.ConnectorCredential) (*gateway.Client, error) {
	platformURL, err := connectorGatewayURL(cfg.ConnectorServerURL)
	if err != nil {
		return nil, fmt.Errorf("build connector gateway URL: %w", err)
	}
	client, err := gateway.NewClient(gateway.ClientOptions{
		URL:    platformURL,
		HostID: credential.HostID,
		Token:  credential.Token,
	})
	if err != nil {
		return nil, fmt.Errorf("initialize connector platform gateway: %w", err)
	}
	return client, nil
}

func bootstrapConnectorCredential(ctx context.Context, cfg platform.Config, logger *slog.Logger) (auth.ConnectorCredential, error) {
	bootstrapper := connectorCredentialBootstrapper{
		client:      http.DefaultClient,
		openBrowser: openConnectorBrowser,
	}
	return bootstrapper.bootstrap(ctx, cfg, logger)
}

func (b connectorCredentialBootstrapper) bootstrap(ctx context.Context, cfg platform.Config, logger *slog.Logger) (auth.ConnectorCredential, error) {
	if b.client == nil {
		b.client = http.DefaultClient
	}
	if b.openBrowser == nil {
		b.openBrowser = openConnectorBrowser
	}
	cachePath := strings.TrimSpace(cfg.ConnectorCredentialPath)
	if cachePath == "" {
		_, defaultCachePath, err := platform.DefaultConnectorStatePaths()
		if err != nil {
			return auth.ConnectorCredential{}, fmt.Errorf("resolve Connector credential cache path: %w", err)
		}
		cachePath = defaultCachePath
	}
	apiKey := strings.TrimSpace(cfg.ConnectorAPIKey)
	if apiKey != "" {
		credential, err := b.resolveAPIKey(ctx, cfg.ConnectorServerURL, apiKey)
		if err != nil {
			return auth.ConnectorCredential{}, err
		}
		return credential, nil
	}
	if credential, ok, err := loadConnectorCredential(cachePath, cfg.ConnectorServerURL); err != nil {
		return auth.ConnectorCredential{}, err
	} else if ok {
		return credential, nil
	}
	if logger != nil {
		parsed, _ := url.Parse(cfg.ConnectorServerURL)
		logger.Info("connector browser authorization required", "server_host", parsed.Host)
	}
	credential, err := b.authorizeInBrowser(ctx, cfg.ConnectorServerURL)
	if err != nil {
		return auth.ConnectorCredential{}, err
	}
	if err := saveConnectorCredential(cachePath, cfg.ConnectorServerURL, credential); err != nil {
		return auth.ConnectorCredential{}, err
	}
	if logger != nil {
		logger.Info("connector browser authorization completed")
	}
	return credential, nil
}

func (b connectorCredentialBootstrapper) resolveAPIKey(ctx context.Context, baseURL, apiKey string) (auth.ConnectorCredential, error) {
	endpoint, err := connectorHTTPURL(baseURL, "/api/v1/auth/connector/identity")
	if err != nil {
		return auth.ConnectorCredential{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return auth.ConnectorCredential{}, fmt.Errorf("create Connector identity request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	response, err := b.client.Do(request)
	if err != nil {
		return auth.ConnectorCredential{}, fmt.Errorf("request Connector identity: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return auth.ConnectorCredential{}, fmt.Errorf("Connector identity request failed with status %d", response.StatusCode)
	}
	var payload struct {
		HostID string `json:"host_id"`
	}
	if err := decodeConnectorJSON(response.Body, &payload); err != nil {
		return auth.ConnectorCredential{}, fmt.Errorf("decode Connector identity response: %w", err)
	}
	if strings.TrimSpace(payload.HostID) == "" {
		return auth.ConnectorCredential{}, errors.New("Connector identity response omitted host id")
	}
	return auth.ConnectorCredential{HostID: payload.HostID, Token: apiKey}, nil
}

func (b connectorCredentialBootstrapper) authorizeInBrowser(ctx context.Context, baseURL string) (auth.ConnectorCredential, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return auth.ConnectorCredential{}, fmt.Errorf("listen for Connector authorization callback: %w", err)
	}
	defer listener.Close()
	state, err := randomConnectorState()
	if err != nil {
		return auth.ConnectorCredential{}, err
	}
	callbackURL := "http://" + listener.Addr().String() + "/callback"
	codeResult := make(chan string, 1)
	callbackServer := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/callback" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		if subtle.ConstantTimeCompare([]byte(request.URL.Query().Get("state")), []byte(state)) != 1 {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		code := strings.TrimSpace(request.URL.Query().Get("code"))
		if code == "" {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		select {
		case codeResult <- code:
		default:
		}
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(writer, "<!doctype html><html><head><title>Loomhelm Connector</title></head><body><p>Connector authorization completed. You may close this window.</p></body></html>")
	})}
	serverDone := make(chan struct{})
	go func() {
		_ = callbackServer.Serve(listener)
		close(serverDone)
	}()
	defer func() {
		_ = callbackServer.Shutdown(context.Background())
		<-serverDone
	}()

	startEndpoint, err := connectorHTTPURL(baseURL, "/api/v1/auth/device/start")
	if err != nil {
		return auth.ConnectorCredential{}, err
	}
	startPayload := struct {
		RedirectURI string `json:"redirect_uri"`
		State       string `json:"state"`
	}{RedirectURI: callbackURL, State: state}
	var startResponse struct {
		VerificationURI string `json:"verification_uri"`
		UserCode        string `json:"user_code"`
		ExpiresIn       int    `json:"expires_in"`
	}
	if err := b.postConnectorJSON(ctx, startEndpoint, startPayload, &startResponse); err != nil {
		return auth.ConnectorCredential{}, fmt.Errorf("start Connector browser authorization: %w", err)
	}
	if strings.TrimSpace(startResponse.VerificationURI) == "" {
		return auth.ConnectorCredential{}, errors.New("Connector browser authorization response omitted verification URL")
	}
	verificationURL, err := resolveConnectorVerificationURL(baseURL, startResponse.VerificationURI)
	if err != nil {
		return auth.ConnectorCredential{}, err
	}
	if err := b.openBrowser(ctx, verificationURL); err != nil {
		return auth.ConnectorCredential{}, fmt.Errorf("open Connector browser authorization: %w", err)
	}
	waitCtx, cancel := context.WithTimeout(ctx, connectorDeviceAuthorizationTimeout)
	defer cancel()
	var authorizationCode string
	select {
	case authorizationCode = <-codeResult:
	case <-waitCtx.Done():
		return auth.ConnectorCredential{}, fmt.Errorf("wait for Connector browser authorization: %w", waitCtx.Err())
	}

	tokenEndpoint, err := connectorHTTPURL(baseURL, "/api/v1/auth/device/token")
	if err != nil {
		return auth.ConnectorCredential{}, err
	}
	var tokenResponse struct {
		APIKey string `json:"api_key"`
	}
	if err := b.postConnectorJSON(ctx, tokenEndpoint, struct {
		Code string `json:"code"`
	}{Code: authorizationCode}, &tokenResponse); err != nil {
		return auth.ConnectorCredential{}, fmt.Errorf("exchange Connector browser authorization: %w", err)
	}
	credential, err := auth.DecodeConnectorAPIKey(tokenResponse.APIKey)
	if err != nil {
		return auth.ConnectorCredential{}, fmt.Errorf("decode Connector browser authorization: %w", err)
	}
	return credential, nil
}

const connectorDeviceAuthorizationTimeout = 10 * time.Minute

func (b connectorCredentialBootstrapper) postConnectorJSON(ctx context.Context, endpoint string, payload any, destination any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := b.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("server returned status %d", response.StatusCode)
	}
	return decodeConnectorJSON(response.Body, destination)
}

func decodeConnectorJSON(reader io.Reader, destination any) error {
	decoder := json.NewDecoder(io.LimitReader(reader, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("response contained more than one JSON value")
	}
	return nil
}

func connectorHTTPURL(baseURL, path string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return "", errors.New("connector server URL is invalid")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + path
	parsed.RawPath = ""
	return parsed.String(), nil
}

func resolveConnectorVerificationURL(baseURL, raw string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || (base.Scheme != "https" && base.Scheme != "http") {
		return "", errors.New("connector server URL is invalid")
	}
	verification, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || verification.User != nil || verification.Path == "" {
		return "", errors.New("Connector verification URL is invalid")
	}
	if verification.IsAbs() {
		if verification.Scheme != base.Scheme || verification.Host != base.Host {
			return "", errors.New("Connector verification URL is invalid")
		}
	} else {
		if verification.Scheme != "" || verification.Host != "" {
			return "", errors.New("Connector verification URL is invalid")
		}
		basePath := strings.TrimRight(base.Path, "/")
		verification.Path = basePath + "/" + strings.TrimLeft(verification.Path, "/")
		verification = base.ResolveReference(verification)
	}
	return verification.String(), nil
}

func randomConnectorState() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate Connector authorization state: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func loadConnectorCredential(path, serverURL string) (auth.ConnectorCredential, bool, error) {
	if strings.TrimSpace(path) == "" {
		return auth.ConnectorCredential{}, false, nil
	}
	cachePath, err := connectorCredentialCachePath(path)
	if err != nil {
		return auth.ConnectorCredential{}, false, err
	}
	info, err := os.Lstat(cachePath)
	if errors.Is(err, os.ErrNotExist) {
		return auth.ConnectorCredential{}, false, nil
	}
	if err != nil {
		return auth.ConnectorCredential{}, false, fmt.Errorf("inspect Connector credential cache: %w", err)
	}
	if err := validateConnectorCredentialDirectory(filepath.Dir(cachePath)); err != nil {
		return auth.ConnectorCredential{}, false, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return auth.ConnectorCredential{}, false, errors.New("Connector credential cache must be a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return auth.ConnectorCredential{}, false, errors.New("Connector credential cache permissions are too broad")
	}
	file, err := os.Open(cachePath)
	if err != nil {
		return auth.ConnectorCredential{}, false, fmt.Errorf("open Connector credential cache: %w", err)
	}
	defer file.Close()
	var cached connectorCredentialCache
	if err := decodeConnectorJSON(file, &cached); err != nil {
		return auth.ConnectorCredential{}, false, fmt.Errorf("decode Connector credential cache: %w", err)
	}
	if cached.Version != connectorCredentialCacheVersion || !sameConnectorBaseURL(cached.ServerURL, serverURL) {
		return auth.ConnectorCredential{}, false, nil
	}
	if cached.HostID == "" || cached.Token == "" {
		return auth.ConnectorCredential{}, false, errors.New("Connector credential cache is incomplete")
	}
	return auth.ConnectorCredential{HostID: cached.HostID, Token: cached.Token}, true, nil
}

func saveConnectorCredential(path, serverURL string, credential auth.ConnectorCredential) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("Connector credential cache path is empty")
	}
	cachePath, err := connectorCredentialCachePath(path)
	if err != nil {
		return err
	}
	directory := filepath.Dir(cachePath)
	if err := ensureConnectorCredentialDirectory(directory); err != nil {
		return err
	}
	if info, err := os.Lstat(cachePath); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return errors.New("Connector credential cache must be a regular file")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect Connector credential cache: %w", err)
	}
	data, err := json.Marshal(connectorCredentialCache{
		Version: connectorCredentialCacheVersion, ServerURL: normalizeConnectorBaseURL(serverURL), HostID: credential.HostID, Token: credential.Token,
	})
	if err != nil {
		return fmt.Errorf("encode Connector credential cache: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".connector-credential-*")
	if err != nil {
		return fmt.Errorf("create Connector credential cache temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("secure Connector credential cache temporary file: %w", err)
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		temporary.Close()
		return fmt.Errorf("write Connector credential cache: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync Connector credential cache: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close Connector credential cache: %w", err)
	}
	if err := os.Rename(temporaryPath, cachePath); err != nil {
		return fmt.Errorf("publish Connector credential cache: %w", err)
	}
	return nil
}

func connectorCredentialCachePath(raw string) (string, error) {
	path := strings.TrimSpace(raw)
	if path == "" {
		return "", errors.New("Connector credential cache path is empty")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve Connector credential cache path: %w", err)
	}
	return filepath.Clean(absPath), nil
}

func ensureConnectorCredentialDirectory(path string) error {
	if err := walkConnectorCredentialDirectory(path, true); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect Connector credential cache directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("Connector credential cache directory must be a regular directory")
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("secure Connector credential cache directory: %w", err)
	}
	return validateConnectorCredentialDirectory(path)
}

func validateConnectorCredentialDirectory(path string) error {
	if err := walkConnectorCredentialDirectory(path, false); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect Connector credential cache directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("Connector credential cache directory must be a regular directory")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("Connector credential cache directory permissions are too broad")
	}
	return nil
}

func walkConnectorCredentialDirectory(path string, create bool) error {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve Connector credential cache directory: %w", err)
	}
	cleanPath := filepath.Clean(absPath)
	root := filepath.VolumeName(cleanPath) + string(filepath.Separator)
	relative, err := filepath.Rel(root, cleanPath)
	if err != nil {
		return fmt.Errorf("resolve Connector credential cache directory: %w", err)
	}
	if relative == "." {
		return errors.New("Connector credential cache directory must not be the filesystem root")
	}
	current := root
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		current = filepath.Join(current, component)
		info, statErr := os.Lstat(current)
		if errors.Is(statErr, os.ErrNotExist) && create {
			if mkdirErr := os.Mkdir(current, 0o700); mkdirErr != nil && !errors.Is(mkdirErr, os.ErrExist) {
				return fmt.Errorf("create Connector credential cache directory: %w", mkdirErr)
			}
			info, statErr = os.Lstat(current)
		}
		if statErr != nil {
			return fmt.Errorf("inspect Connector credential cache directory: %w", statErr)
		}
		isAllowedSymlink := info.Mode()&os.ModeSymlink != 0 && allowedConnectorCredentialAncestorSymlink(current)
		if (info.Mode()&os.ModeSymlink != 0 && !isAllowedSymlink) || (!info.IsDir() && !isAllowedSymlink) {
			return errors.New("Connector credential cache directory must not contain symlinks or non-directories")
		}
	}
	return nil
}

func allowedConnectorCredentialAncestorSymlink(path string) bool {
	if runtime.GOOS != "darwin" || filepath.Clean(path) != "/var" {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	return err == nil && filepath.Clean(resolved) == "/private/var"
}

func sameConnectorBaseURL(left, right string) bool {
	return normalizeConnectorBaseURL(left) == normalizeConnectorBaseURL(right)
}

func normalizeConnectorBaseURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return strings.TrimRight(strings.TrimSpace(raw), "/")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func openConnectorBrowser(ctx context.Context, verificationURL string) error {
	var command string
	var arguments []string
	switch runtime.GOOS {
	case "darwin":
		command, arguments = "open", []string{verificationURL}
	case "linux":
		command, arguments = "xdg-open", []string{verificationURL}
	case "windows":
		command, arguments = "rundll32", []string{"url.dll,FileProtocolHandler", verificationURL}
	default:
		return fmt.Errorf("automatic browser opening is unsupported on %s", runtime.GOOS)
	}
	return exec.CommandContext(ctx, command, arguments...).Run()
}
