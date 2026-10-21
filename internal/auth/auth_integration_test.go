package auth

import (
	"context"
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
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		t.Fatalf("database.Migrate() error = %v", err)
	}
	defer db.Close()

	userID := "p01_session_" + strings.ReplaceAll(time.Now().UTC().Format("20060102T150405.000000000Z07:00"), ":", "")
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
	if len(cookies) != 1 || cookies[0].Name != sessionCookieName || cookies[0].Value == "" {
		t.Fatalf("session cookie = %+v", cookies)
	}
	sessionToken := cookies[0].Value

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
	if _, err := reopened.Pool().Exec(ctx, `DELETE FROM auth_sessions WHERE token = $1`, sessionToken); err != nil {
		t.Fatalf("delete test session: %v", err)
	}
	if _, err := reopened.Pool().Exec(ctx, `DELETE FROM auth_users WHERE id = $1`, userID); err != nil {
		t.Fatalf("delete test user: %v", err)
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
