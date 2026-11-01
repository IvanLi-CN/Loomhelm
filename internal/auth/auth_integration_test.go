package auth

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
)

func TestPostgresSessionStoreSurvivesDatabaseReopen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	config := authDatabaseConfigForTest(t)
	db, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()
	userID := "p01_session_" + strings.ReplaceAll(time.Now().UTC().Format("20060102T150405.000000000Z07:00"), ":", "")
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("database.Migrate() error = %v", err)
	}
	var sessionToken string
	t.Cleanup(func() {
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanupDB, cleanupErr := database.Open(cleanupContext, config)
		if cleanupErr != nil {
			t.Errorf("open auth cleanup database: %v", cleanupErr)
			return
		}
		defer cleanupDB.Close()
		if sessionToken != "" {
			if _, cleanupErr := cleanupDB.Pool().Exec(cleanupContext, `DELETE FROM auth_sessions WHERE token = $1`, sessionToken); cleanupErr != nil {
				t.Errorf("delete test session: %v", cleanupErr)
			}
		}
		if _, cleanupErr := cleanupDB.Pool().Exec(cleanupContext, `DELETE FROM auth_users WHERE id = $1`, userID); cleanupErr != nil {
			t.Errorf("delete test user: %v", cleanupErr)
		}
	})
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject)
		VALUES ($1, 'integration-session', $1)
	`, userID); err != nil {
		t.Fatalf("seed session user: %v", err)
	}
	sessionCookieName := "p01_session_" + strings.ReplaceAll(userID, "+", "")
	service, err := NewService(db.Pool(), Config{
		SessionCookieName: sessionCookieName,
		SessionLifetime:   time.Hour,
	}, nil)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	setHandler := service.Middleware(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		service.sessions.Put(request.Context(), "user_id", userID)
		writer.WriteHeader(http.StatusNoContent)
	}))
	setResponse := httptest.NewRecorder()
	setHandler.ServeHTTP(setResponse, httptest.NewRequest(http.MethodGet, "/set", nil))
	if setResponse.Code != http.StatusNoContent {
		t.Fatalf("session set status = %d, want %d", setResponse.Code, http.StatusNoContent)
	}
	cookies := setResponse.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != sessionCookieName || cookies[0].Value == "" || !cookies[0].HttpOnly {
		t.Fatalf("session cookie = %+v", cookies)
	}
	sessionToken = cookies[0].Value

	db.Close()
	reopened, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	defer reopened.Close()
	if err := reopened.Migrate(ctx); err != nil {
		t.Fatalf("migrate after reopen: %v", err)
	}
	reopenedService, err := NewService(reopened.Pool(), Config{
		SessionCookieName: sessionCookieName,
		SessionLifetime:   time.Hour,
	}, nil)
	if err != nil {
		t.Fatalf("NewService() after reopen error = %v", err)
	}
	getHandler := reopenedService.Middleware(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		principal, err := reopenedService.ResolvePrincipal(request.Context(), request)
		if err != nil {
			http.Error(writer, err.Error(), http.StatusUnauthorized)
			return
		}
		writer.Header().Set("X-Test-User-ID", principal.UserID)
		writer.WriteHeader(http.StatusNoContent)
	}))
	getRequest := httptest.NewRequest(http.MethodGet, "/me", nil)
	getRequest.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionToken})
	getResponse := httptest.NewRecorder()
	getHandler.ServeHTTP(getResponse, getRequest)
	if getResponse.Code != http.StatusNoContent || getResponse.Header().Get("X-Test-User-ID") != userID {
		t.Fatalf("session after reopen status = %d, user = %q", getResponse.Code, getResponse.Header().Get("X-Test-User-ID"))
	}
}

func TestPostgresConnectorDeviceStoreReplaysCompletedCodeDuringCleanupGrace(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	config := authDatabaseConfigForTest(t)
	db, err := database.Open(ctx, config)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("database.Migrate() error = %v", err)
	}

	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102T150405.000000000Z07:00"), ":", "")
	userID := "p01_device_replay_" + suffix
	authorizationID := "p01_device_auth_" + suffix
	userCodeHash := sha256.Sum256([]byte("user-code-" + suffix))
	authorizationCodeHash := sha256.Sum256([]byte("authorization-code-" + suffix))
	now := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	expiresAt := now.Add(connectorDeviceLifetime)
	t.Cleanup(func() {
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanupDB, cleanupErr := database.Open(cleanupContext, config)
		if cleanupErr != nil {
			t.Errorf("open device replay cleanup database: %v", cleanupErr)
			return
		}
		defer cleanupDB.Close()
		if _, cleanupErr := cleanupDB.Pool().Exec(cleanupContext, `DELETE FROM connector_device_authorizations WHERE id = $1`, authorizationID); cleanupErr != nil {
			t.Errorf("delete test device authorization: %v", cleanupErr)
		}
		if _, cleanupErr := cleanupDB.Pool().Exec(cleanupContext, `DELETE FROM auth_users WHERE id = $1`, userID); cleanupErr != nil {
			t.Errorf("delete test device user: %v", cleanupErr)
		}
	})
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject)
		VALUES ($1, 'device-replay-integration', $1)
	`, userID); err != nil {
		t.Fatalf("seed device user: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO connector_device_authorizations (
			id, user_code_hash, redirect_uri, state, expires_at,
			authorized_user_id, authorization_code_hash, authorized_at
		) VALUES ($1, $2, 'http://127.0.0.1:43123/callback', $3, $4, $5, $6, $7)
	`, authorizationID, userCodeHash[:], strings.Repeat("s", 32), expiresAt, userID, authorizationCodeHash[:], now); err != nil {
		t.Fatalf("seed device authorization: %v", err)
	}

	store := &postgresConnectorDeviceStore{pool: db.Pool()}
	if _, err := store.Claim(ctx, authorizationCodeHash[:], now); err != nil {
		t.Fatalf("claim device authorization: %v", err)
	}
	if err := store.Complete(ctx, authorizationCodeHash[:], now); err != nil {
		t.Fatalf("complete device authorization: %v", err)
	}
	replayed, err := store.Claim(ctx, authorizationCodeHash[:], expiresAt.Add(time.Minute))
	if err != nil {
		t.Fatalf("replay completed device authorization after nominal expiry: %v", err)
	}
	if replayed.ID != authorizationID || !replayed.Consumed || replayed.AuthorizedUserID != userID {
		t.Fatalf("replayed device authorization = %+v", replayed)
	}
}

func authDatabaseConfigForTest(t *testing.T) database.Config {
	t.Helper()
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
			t.Skip("LOOMHELM_DATABASE_URL is not set")
		}
		t.Fatalf("load database configuration: %v", err)
	}
	config.MinConns = 1
	config.MaxConns = 4
	return database.Config{URL: config.URL, MinConns: config.MinConns, MaxConns: config.MaxConns}
}
