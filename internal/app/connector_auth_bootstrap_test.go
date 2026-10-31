package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

func TestConnectorCredentialCacheIsPrivateAndBoundToServer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connector-credential.json")
	want := auth.ConnectorCredential{HostID: "host-cache", Token: "token-cache"}
	if err := saveConnectorCredential(path, "https://loomhelm.example.test/", want); err != nil {
		t.Fatalf("saveConnectorCredential() error = %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat cache: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("cache mode = %o, want 600", info.Mode().Perm())
	}
	got, ok, err := loadConnectorCredential(path, "https://loomhelm.example.test")
	if err != nil || !ok || got != want {
		t.Fatalf("loadConnectorCredential() = (%+v, %t, %v), want cached credential", got, ok, err)
	}
	if _, ok, err := loadConnectorCredential(path, "https://other.example.test"); err != nil || ok {
		t.Fatalf("cache from another server = (%t, %v), want miss", ok, err)
	}
}

func TestConnectorCredentialCacheRejectsSymlinkedDirectory(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("create target directory: %v", err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := saveConnectorCredential(filepath.Join(link, "connector-credential.json"), "https://loomhelm.example.test", auth.ConnectorCredential{HostID: "host", Token: "token"}); err == nil {
		t.Fatal("saveConnectorCredential() succeeded through a symlinked directory")
	}
}

func TestConnectorBrowserBootstrapUsesLoopbackCallbackAndCachesCredential(t *testing.T) {
	var callbackURL string
	var callbackState string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/auth/device/start":
			var payload struct {
				RedirectURI string `json:"redirect_uri"`
				State       string `json:"state"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				http.Error(writer, "bad request", http.StatusBadRequest)
				return
			}
			callbackURL, callbackState = payload.RedirectURI, payload.State
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"verification_uri":"/verify","user_code":"ABCD-2345","expires_in":600}`)
		case "/api/v1/auth/device/token":
			var payload struct {
				Code string `json:"code"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil || payload.Code != "authorization-code" {
				http.Error(writer, "bad token", http.StatusBadRequest)
				return
			}
			apiKey, _ := auth.EncodeConnectorAPIKey("host-browser", "token-browser")
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"api_key":"`+apiKey+`"}`)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	cachePath := filepath.Join(t.TempDir(), "connector-credential.json")
	bootstrapper := connectorCredentialBootstrapper{
		client: server.Client(),
		openBrowser: func(_ context.Context, verificationURL string) error {
			parsed, err := url.Parse(verificationURL)
			if err != nil || parsed.Path != "/verify" {
				t.Fatalf("verification URL = %q, error = %v", verificationURL, err)
			}
			callback := callbackURL + "?code=authorization-code&state=" + url.QueryEscape(callbackState)
			response, err := server.Client().Get(callback)
			if err != nil {
				return err
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				return io.ErrUnexpectedEOF
			}
			return nil
		},
	}
	credential, err := bootstrapper.bootstrap(context.Background(), platform.Config{
		ConnectorServerURL:      server.URL,
		ConnectorCredentialPath: cachePath,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("browser bootstrap error = %v", err)
	}
	if credential != (auth.ConnectorCredential{HostID: "host-browser", Token: "token-browser"}) {
		t.Fatalf("browser credential = %+v", credential)
	}
	if _, ok, err := loadConnectorCredential(cachePath, server.URL); err != nil || !ok {
		t.Fatalf("cached browser credential = (%t, %v), want hit", ok, err)
	}
}

func TestConnectorBootstrapRecoversRejectedCachedCredential(t *testing.T) {
	var callbackURL string
	var callbackState string
	var requestedHostID string
	identityCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/auth/connector/identity":
			identityCalls++
			writer.WriteHeader(http.StatusUnauthorized)
		case "/api/v1/auth/device/start":
			var payload struct {
				RedirectURI string `json:"redirect_uri"`
				State       string `json:"state"`
				HostID      string `json:"host_id"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				http.Error(writer, "bad request", http.StatusBadRequest)
				return
			}
			callbackURL, callbackState, requestedHostID = payload.RedirectURI, payload.State, payload.HostID
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"verification_uri":"/verify","user_code":"ABCD-2345","expires_in":600}`)
		case "/api/v1/auth/device/token":
			apiKey, _ := auth.EncodeConnectorAPIKey("host-cache", "token-recovered")
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"api_key":"`+apiKey+`"}`)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	cachePath := filepath.Join(t.TempDir(), "connector-credential.json")
	if err := saveConnectorCredential(cachePath, server.URL, auth.ConnectorCredential{HostID: "host-cache", Token: "token-revoked"}); err != nil {
		t.Fatalf("save cached credential: %v", err)
	}
	bootstrapper := connectorCredentialBootstrapper{
		client: server.Client(),
		openBrowser: func(_ context.Context, _ string) error {
			callback := callbackURL + "?code=authorization-code&state=" + url.QueryEscape(callbackState)
			response, err := server.Client().Get(callback)
			if err != nil {
				return err
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				return io.ErrUnexpectedEOF
			}
			return nil
		},
	}
	credential, err := bootstrapper.bootstrap(context.Background(), platform.Config{
		ConnectorServerURL:      server.URL,
		ConnectorCredentialPath: cachePath,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("cached credential recovery error = %v", err)
	}
	if credential != (auth.ConnectorCredential{HostID: "host-cache", Token: "token-recovered"}) {
		t.Fatalf("recovered credential = %+v", credential)
	}
	if identityCalls != 1 || requestedHostID != "host-cache" {
		t.Fatalf("recovery binding = identity calls %d, requested host %q", identityCalls, requestedHostID)
	}
}

func TestConnectorBootstrapValidatesOpaqueAPIKeyAndUsesRawTokenForGateway(t *testing.T) {
	apiKey, err := auth.EncodeConnectorAPIKey("host-api-key", "token-api-key")
	if err != nil {
		t.Fatalf("encode API key: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/auth/connector/identity" {
			http.NotFound(writer, request)
			return
		}
		if got := request.Header.Get("Authorization"); got != "Bearer "+apiKey {
			t.Fatalf("identity Authorization = %q, want opaque API key", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"host_id":"host-api-key"}`)
	}))
	defer server.Close()

	bootstrapper := connectorCredentialBootstrapper{client: server.Client()}
	credential, err := bootstrapper.bootstrap(context.Background(), platform.Config{
		ConnectorServerURL:      server.URL,
		ConnectorAPIKey:         apiKey,
		ConnectorCredentialPath: filepath.Join(t.TempDir(), "connector-credential.json"),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("API key bootstrap error = %v", err)
	}
	if credential != (auth.ConnectorCredential{HostID: "host-api-key", Token: "token-api-key"}) {
		t.Fatalf("API key credential = %+v", credential)
	}
}

func TestConnectorVerificationURLPreservesBasePath(t *testing.T) {
	got, err := resolveConnectorVerificationURL("https://loomhelm.example.test/loomhelm", "/api/v1/auth/device/verify")
	if err != nil {
		t.Fatalf("resolveConnectorVerificationURL() error = %v", err)
	}
	if got != "https://loomhelm.example.test/loomhelm/api/v1/auth/device/verify" {
		t.Fatalf("verification URL = %q", got)
	}
}

func TestConnectorVerificationURLRejectsExternalSchemeRelativeAddress(t *testing.T) {
	if _, err := resolveConnectorVerificationURL("https://loomhelm.example.test", "//evil.example.test/verify"); err == nil {
		t.Fatal("scheme-relative external verification URL was accepted")
	}
}
