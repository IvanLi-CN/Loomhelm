package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/go-jose/go-jose/v4"
	"github.com/jackc/pgx/v5"
)

// This exercise uses the production Server lifecycle, actual discovery/JWKS/
// signed token exchange, PostgreSQL sessions and the real domain HTTP handlers.
// Only the issuer is disposable; no login or authorization bypass is injected.
func TestServerBrowserAuthenticationAndCRUD(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	cfg := platform.Config{
		Component: platform.ComponentServer, Version: "integration", DrainToken: "test-drain",
		ShutdownTimeout: 5 * time.Second, StartupTimeout: 30 * time.Second,
		DatabaseURL: databaseURL, DatabaseMaxConns: 4,
		BrowserAuth: platform.BrowserAuthConfig{OIDCIssuerURL: issuer.URL, OIDCClientID: "loomhelm-test", SecureCookies: false},
	}
	baseURL, stop := startApplicationTestServer(t, cfg)
	alice := applicationBrowser(t)
	bob := applicationBrowser(t)

	session := applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusUnauthorized)
	if session.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("unauthenticated session response was cacheable")
	}
	applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/projects", map[string]string{"name": "Denied"}, nil, http.StatusUnauthorized)
	applicationRequest(t, alice, http.MethodGet, baseURL+"/auth/oidc/start", nil, nil, http.StatusNotFound)
	loginApplicationBrowser(t, alice, baseURL, "alice")
	loginApplicationBrowser(t, bob, baseURL, "bob")
	session = applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK)
	var identity struct {
		UserID string `json:"user_id"`
		CSRF   string `json:"csrf_protection"`
	}
	decodeApplicationResponse(t, session, &identity)
	if identity.UserID == "" || identity.CSRF != "same_origin" {
		t.Fatalf("browser bootstrap did not return authenticated capability: %+v", identity)
	}
	for _, headers := range []map[string]string{
		{"Origin": "https://other.example.test"},
		{"Sec-Fetch-Site": "cross-site"},
	} {
		applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/projects", map[string]string{"name": "Forged"}, headers, http.StatusForbidden)
		applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/auth/logout", nil, headers, http.StatusForbidden)
	}
	projectsResponse := applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/projects", nil, nil, http.StatusOK)
	var empty struct {
		Items []json.RawMessage `json:"items"`
	}
	decodeApplicationResponse(t, projectsResponse, &empty)
	if empty.Items == nil || len(empty.Items) != 0 {
		t.Fatal("rejected cross-origin mutations created project state")
	}
	var project struct {
		Project struct {
			ID          string `json:"id"`
			Description string `json:"description"`
		} `json:"project"`
	}
	sameOrigin := map[string]string{"Origin": baseURL}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/projects", map[string]string{"name": "Real project"}, sameOrigin, http.StatusCreated), &project)
	if project.Project.ID == "" {
		t.Fatal("project create response omitted identity")
	}
	projectURL := "/api/v1/projects/" + project.Project.ID
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPatch, baseURL+projectURL, map[string]string{"description": "persisted"}, sameOrigin, http.StatusOK), &project)
	applicationRequest(t, bob, http.MethodGet, baseURL+projectURL, nil, nil, http.StatusNotFound)
	applicationRequest(t, alice, http.MethodGet, baseURL+projectURL+"/members", nil, nil, http.StatusOK)
	var task struct {
		Task struct {
			ID     string `json:"id"`
			Goal   string `json:"goal"`
			Status string `json:"status"`
		} `json:"task"`
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/tasks", map[string]string{"project_id": project.Project.ID, "title": "Real task", "goal": "persist me"}, sameOrigin, http.StatusCreated), &task)
	if task.Task.ID == "" {
		t.Fatal("task create response omitted identity")
	}
	taskURL := "/api/v1/tasks/" + task.Task.ID
	applicationRequest(t, bob, http.MethodPatch, baseURL+taskURL, map[string]string{"status": "done"}, nil, http.StatusNotFound)
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPatch, baseURL+taskURL, map[string]string{"status": "in_progress"}, sameOrigin, http.StatusOK), &task)
	var credential struct {
		Credential struct {
			Token string `json:"token"`
		} `json:"credential"`
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/credentials", map[string]string{"name": "native-client"}, sameOrigin, http.StatusCreated), &credential)
	if credential.Credential.Token == "" {
		t.Fatal("credential create response omitted one-time token")
	}
	bearer := map[string]string{"Authorization": "Bearer " + credential.Credential.Token}
	// Native API authentication works; the same token cannot impersonate a
	// browser bootstrap or destroy a browser session, even with a valid cookie.
	applicationRequest(t, http.DefaultClient, http.MethodGet, baseURL+"/api/v1/projects", nil, bearer, http.StatusOK)
	applicationRequest(t, http.DefaultClient, http.MethodGet, baseURL+"/api/v1/auth/session", nil, bearer, http.StatusUnauthorized)
	applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, bearer, http.StatusUnauthorized)
	applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/auth/logout", nil, bearer, http.StatusUnauthorized)

	stop()
	baseURL, stop = startApplicationTestServer(t, cfg)
	defer stop()
	resumed := applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK)
	var afterRestart struct {
		UserID string `json:"user_id"`
	}
	decodeApplicationResponse(t, resumed, &afterRestart)
	if afterRestart.UserID != identity.UserID {
		t.Fatal("Server restart changed persisted browser identity")
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodGet, baseURL+projectURL, nil, nil, http.StatusOK), &project)
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodGet, baseURL+taskURL, nil, nil, http.StatusOK), &task)
	if project.Project.Description != "persisted" || task.Task.Status != "in_progress" || task.Task.Goal != "persist me" {
		t.Fatal("Server restart did not retain actual project/task state")
	}
	applicationRequest(t, alice, http.MethodDelete, baseURL+taskURL, nil, map[string]string{"Origin": baseURL}, http.StatusNoContent)
	applicationRequest(t, alice, http.MethodDelete, baseURL+projectURL, nil, map[string]string{"Origin": baseURL}, http.StatusNoContent)
	applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/auth/logout", nil, map[string]string{"Origin": baseURL}, http.StatusNoContent)
	applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusUnauthorized)
	applicationRequest(t, http.DefaultClient, http.MethodGet, baseURL+"/api/v1/projects", nil, bearer, http.StatusOK)

	stop()
	cfg.BrowserAuth = platform.BrowserAuthConfig{SecureCookies: false}
	baseURL, _ = startApplicationTestServer(t, cfg)
	applicationRequest(t, applicationBrowser(t), http.MethodGet, baseURL+"/api/v1/auth/oidc/start", nil, nil, http.StatusServiceUnavailable)
	applicationRequest(t, applicationBrowser(t), http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusUnauthorized)
}

func TestExpectedPrincipalBindingRejectsCookiePrincipalMismatch(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	cfg := platform.Config{
		Component: platform.ComponentServer, Version: "integration", DrainToken: "test-drain",
		ShutdownTimeout: 5 * time.Second, StartupTimeout: 30 * time.Second,
		DatabaseURL: databaseURL, DatabaseMaxConns: 4,
		BrowserAuth: platform.BrowserAuthConfig{OIDCIssuerURL: issuer.URL, OIDCClientID: "loomhelm-test", SecureCookies: false},
	}
	baseURL, stop := startApplicationTestServer(t, cfg)
	defer stop()
	alice := applicationBrowser(t)
	bob := applicationBrowser(t)
	loginApplicationBrowser(t, alice, baseURL, "alice")
	loginApplicationBrowser(t, bob, baseURL, "bob")

	var aliceSession, bobSession struct {
		UserID string `json:"user_id"`
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &aliceSession)
	decodeApplicationResponse(t, applicationRequest(t, bob, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &bobSession)
	if aliceSession.UserID == "" || bobSession.UserID == "" || aliceSession.UserID == bobSession.UserID {
		t.Fatalf("test login did not establish distinct browser principals: alice=%q bob=%q", aliceSession.UserID, bobSession.UserID)
	}

	aliceBinding := map[string]string{auth.ExpectedPrincipalHeader: aliceSession.UserID}
	bobBinding := map[string]string{auth.ExpectedPrincipalHeader: bobSession.UserID}
	applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/projects", nil, aliceBinding, http.StatusOK)
	applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, aliceBinding, http.StatusUnauthorized)
	for _, test := range []struct {
		value  string
		status int
	}{
		{value: "", status: http.StatusUnauthorized},
		// net/http trims optional header whitespace before the application sees it.
		{value: " " + aliceSession.UserID, status: http.StatusOK},
		{value: aliceSession.UserID + ",other", status: http.StatusUnauthorized},
		{value: bobSession.UserID, status: http.StatusUnauthorized},
	} {
		applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/projects", nil, map[string]string{auth.ExpectedPrincipalHeader: test.value}, test.status)
	}

	duplicate, err := http.NewRequest(http.MethodGet, baseURL+"/api/v1/projects", nil)
	if err != nil {
		t.Fatal(err)
	}
	duplicate.Header.Add(auth.ExpectedPrincipalHeader, aliceSession.UserID)
	duplicate.Header.Add(auth.ExpectedPrincipalHeader, bobSession.UserID)
	duplicateResponse, err := alice.Do(duplicate)
	if err != nil {
		t.Fatal(err)
	}
	duplicateBody, err := io.ReadAll(duplicateResponse.Body)
	duplicateResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if duplicateResponse.StatusCode != http.StatusUnauthorized || strings.Contains(string(duplicateBody), aliceSession.UserID) || strings.Contains(string(duplicateBody), bobSession.UserID) {
		t.Fatalf("duplicate expected-principal header was not rejected safely: status=%d body=%q", duplicateResponse.StatusCode, duplicateBody)
	}

	base, err := url.Parse(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	aliceCookies := append([]*http.Cookie(nil), alice.Jar.Cookies(base)...)
	bobCookies := append([]*http.Cookie(nil), bob.Jar.Cookies(base)...)
	alice.Jar.SetCookies(base, bobCookies)
	staleMutationHeaders := map[string]string{"Origin": baseURL, auth.ExpectedPrincipalHeader: aliceSession.UserID}
	applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/projects", nil, aliceBinding, http.StatusUnauthorized)
	applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/projects", map[string]string{"name": "stale must not persist"}, staleMutationHeaders, http.StatusUnauthorized)
	alice.Jar.SetCookies(base, aliceCookies)

	projectsResponse := applicationRequest(t, bob, http.MethodGet, baseURL+"/api/v1/projects", nil, bobBinding, http.StatusOK)
	var projects struct {
		Items []json.RawMessage `json:"items"`
	}
	decodeApplicationResponse(t, projectsResponse, &projects)
	if len(projects.Items) != 0 {
		t.Fatalf("rejected stale mutation created project state: %d projects", len(projects.Items))
	}
}

func isolatedApplicationDatabase(t *testing.T) string {
	t.Helper()
	if os.Getenv("LOOMHELM_DATABASE_URL") == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	cfg, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := database.Open(ctx, database.Config{URL: cfg.URL, MinConns: cfg.MinConns, MaxConns: cfg.MaxConns})
	if err != nil {
		t.Fatal(err)
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	schema := "app_composition_" + hex.EncodeToString(suffix)
	if _, err := admin.Pool().Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		defer admin.Close()
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Pool().Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Errorf("drop owned application test schema: %v", err)
		}
	})
	connectionURL, err := applicationDatabaseWithSchema(cfg.URL, schema)
	if err != nil {
		t.Fatal(err)
	}
	probe, err := database.Open(ctx, database.Config{URL: connectionURL, MaxConns: 1})
	if err != nil {
		t.Fatal("open isolated application test connection")
	}
	defer probe.Close()
	var actualSchema string
	if err := probe.Pool().QueryRow(ctx, "SELECT current_schema()").Scan(&actualSchema); err != nil {
		t.Fatal("verify application test schema")
	}
	if actualSchema != schema {
		t.Fatal("application test connection escaped its owned schema")
	}
	if err := probe.Migrate(ctx); err != nil {
		t.Fatalf("migrate application test schema: %v", err)
	}
	migrator := database.NewApprovalHistoryMigrator(probe.Pool(), database.ApprovalHistoryMigratorConfig{LeaseOwner: "application-integration-test"})
	options := database.ApprovalHistoryMigrationOptions{
		BatchSize:          32,
		WorkBudget:         10000,
		PreDrainBatchSize:  32,
		PreDrainWorkBudget: 10000,
		FinalRowBudget:     100,
		FinalWorkBudget:    300,
	}
	if _, err := migrator.RunBackfill(ctx, options); err != nil {
		t.Fatalf("backfill application test schema: %v", err)
	}
	if _, err := migrator.Validate(ctx, options); err != nil {
		t.Fatalf("validate application test schema: %v", err)
	}
	if _, err := migrator.BuildIndexes(ctx, options); err != nil {
		t.Fatalf("build application test schema indexes: %v", err)
	}
	if _, err := migrator.Cutover(ctx, options); err != nil {
		t.Fatalf("cut over application test schema: %v", err)
	}
	return connectionURL
}

// pgx.ConnConfig.ConnString returns its original input; changing RuntimeParams
// does not change that string. Encode the owned schema into the actual DSN
// used by every production connection opened during this exercise.
func applicationDatabaseWithSchema(raw, schema string) (string, error) {
	if schema == "" || strings.Trim(schema, "abcdefghijklmnopqrstuvwxyz0123456789_") != "" || (schema[0] >= '0' && schema[0] <= '9') {
		return "", fmt.Errorf("invalid owned application test schema")
	}
	raw = strings.TrimSpace(raw)
	if _, err := pgx.ParseConfig(raw); err != nil {
		return "", fmt.Errorf("invalid application test database configuration")
	}
	if strings.HasPrefix(raw, "postgres://") || strings.HasPrefix(raw, "postgresql://") {
		parsed, err := url.Parse(raw)
		if err != nil {
			return "", fmt.Errorf("invalid application test database URL")
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		return parsed.String(), nil
	}
	// Schema is restricted above to an owned, unquoted PostgreSQL identifier.
	// A final keyword replaces an earlier search_path in a keyword/value DSN.
	return raw + " search_path='" + schema + "'", nil
}

func startApplicationTestServer(t *testing.T, cfg platform.Config) (string, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	baseURL := "http://" + listener.Addr().String()
	cfg.HTTPAddr = listener.Addr().String()
	if cfg.BrowserAuth.OIDCEnabled() {
		cfg.BrowserAuth.OIDCRedirectURL = baseURL + "/api/v1/auth/oidc/callback"
	}
	server, err := NewServer(cfg, nil)
	if err != nil {
		listener.Close()
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, listener) }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("stop actual Server: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Error("actual Server did not stop")
			}
		})
	}
	t.Cleanup(stop)
	deadline := time.Now().Add(35 * time.Second)
	for !server.Lifecycle().Ready {
		select {
		case err := <-done:
			cancel()
			listener.Close()
			once.Do(func() {})
			t.Fatalf("start actual Server: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("actual Server readiness deadline exceeded")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return baseURL, stop
}

func applicationBrowser(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func applicationRequest(t *testing.T, client *http.Client, method, target string, body any, headers map[string]string, status int) *http.Response {
	t.Helper()
	var input io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		input = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, target, input)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	response.Body = io.NopCloser(bytes.NewReader(data))
	if response.StatusCode != status {
		// Avoid printing credential/session payloads on a failing assertion.
		t.Fatalf("%s %s returned %d, want %d", method, request.URL.Path, response.StatusCode, status)
	}
	if strings.HasPrefix(request.URL.Path, "/api/v1/") && response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("%s response was cacheable", request.URL.Path)
	}
	if strings.HasPrefix(request.URL.Path, "/api/v1/") && status >= 400 {
		var failure struct {
			Code      string `json:"code"`
			RequestID string `json:"request_id"`
		}
		if json.Unmarshal(data, &failure) != nil || failure.Code == "" || failure.RequestID == "" {
			t.Fatalf("%s returned an invalid API error envelope", request.URL.Path)
		}
	}
	if status == http.StatusNoContent && len(data) != 0 {
		t.Fatal("bodyless operation returned content")
	}
	return response
}

func decodeApplicationResponse(t *testing.T, response *http.Response, target any) {
	t.Helper()
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		t.Fatal(err)
	}
}

func loginApplicationBrowser(t *testing.T, browser *http.Client, baseURL, subject string) {
	t.Helper()
	start := applicationRequest(t, browser, http.MethodGet, baseURL+"/api/v1/auth/oidc/start", nil, nil, http.StatusFound)
	if cookies := start.Cookies(); len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Secure {
		t.Fatal("test login did not issue the configured HttpOnly/SameSite cookie")
	}
	authorizeURL, err := url.Parse(start.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	query := authorizeURL.Query()
	query.Set("test_subject", subject)
	authorizeURL.RawQuery = query.Encode()
	authorize := applicationRequest(t, browser, http.MethodGet, authorizeURL.String(), nil, nil, http.StatusFound)
	applicationRequest(t, browser, http.MethodGet, authorize.Header.Get("Location"), nil, nil, http.StatusFound)
}

func applicationTestIssuer(t *testing.T) *httptest.Server {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		t.Fatal(err)
	}
	type grant struct{ subject, nonce string }
	var mu sync.Mutex
	grants := map[string]grant{}
	var issuer string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(writer).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/jwks", "response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/authorize":
			query := request.URL.Query()
			if query.Get("state") == "" || query.Get("nonce") == "" || query.Get("client_id") != "loomhelm-test" || query.Get("test_subject") == "" {
				http.Error(writer, "invalid disposable issuer request", http.StatusBadRequest)
				return
			}
			mu.Lock()
			code := fmt.Sprintf("grant-%d", len(grants)+1)
			grants[code] = grant{query.Get("test_subject"), query.Get("nonce")}
			mu.Unlock()
			callback, err := url.Parse(query.Get("redirect_uri"))
			if err != nil {
				http.Error(writer, "invalid callback", http.StatusBadRequest)
				return
			}
			callbackQuery := callback.Query()
			callbackQuery.Set("state", query.Get("state"))
			callbackQuery.Set("code", code)
			callback.RawQuery = callbackQuery.Encode()
			http.Redirect(writer, request, callback.String(), http.StatusFound)
		case "/token":
			mu.Lock()
			grant, ok := grants[request.FormValue("code")]
			delete(grants, request.FormValue("code"))
			mu.Unlock()
			if !ok {
				http.Error(writer, "invalid grant", http.StatusBadRequest)
				return
			}
			claims, _ := json.Marshal(map[string]any{"iss": issuer, "sub": grant.subject, "aud": "loomhelm-test", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(), "nonce": grant.nonce})
			signed, err := signer.Sign(claims)
			if err != nil {
				http.Error(writer, "sign disposable identity", http.StatusInternalServerError)
				return
			}
			token, err := signed.CompactSerialize()
			if err != nil {
				http.Error(writer, "serialize disposable identity", http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(writer).Encode(map[string]string{"access_token": "test-only", "token_type": "Bearer", "id_token": token})
		case "/jwks":
			_ = json.NewEncoder(writer).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, Algorithm: string(jose.RS256), Use: "sig"}}})
		default:
			http.NotFound(writer, request)
		}
	}))
	issuer = server.URL
	t.Cleanup(server.Close)
	return server
}
