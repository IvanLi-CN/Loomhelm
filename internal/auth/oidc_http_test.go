package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/alexedwards/scs/v2"
	"github.com/go-chi/chi/v5"
)

func TestOIDCCallbackRejectsStateMismatchBeforeExchange(t *testing.T) {
	provider := &oidcHTTPTestProvider{}
	sessions := scs.New()
	sessions.Cookie.Name = "oidc_http_test"
	sessions.Cookie.HttpOnly = true
	sessions.Cookie.SameSite = http.SameSiteLaxMode
	service := &Service{
		sessions: sessions,
		oidc:     provider,
		cfg:      Config{SuccessRedirect: "/"},
	}
	router := chi.NewRouter()
	service.Mount(router)
	handler := service.Middleware(router)

	startResponse := httptest.NewRecorder()
	handler.ServeHTTP(startResponse, httptest.NewRequest(http.MethodGet, "/auth/oidc/start", nil))
	if startResponse.Code != http.StatusFound {
		t.Fatalf("OIDC start status = %d, want %d", startResponse.Code, http.StatusFound)
	}
	cookies := startResponse.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].Value == "" {
		t.Fatalf("OIDC session cookie = %+v, want one HttpOnly cookie", cookies)
	}
	location, err := url.Parse(startResponse.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse OIDC authorization URL: %v", err)
	}
	if location.Query().Get("state") == "" || location.Query().Get("nonce") == "" {
		t.Fatalf("OIDC authorization URL query = %v, want state and nonce", location.Query())
	}

	callbackRequest := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=attacker-state&code=code", nil)
	callbackRequest.AddCookie(cookies[0])
	callbackResponse := httptest.NewRecorder()
	handler.ServeHTTP(callbackResponse, callbackRequest)
	if callbackResponse.Code != http.StatusBadRequest {
		t.Fatalf("state mismatch status = %d, want %d", callbackResponse.Code, http.StatusBadRequest)
	}
	if provider.exchangeCalls != 0 {
		t.Fatalf("OIDC exchange calls = %d, want 0 for state mismatch", provider.exchangeCalls)
	}
}

type oidcHTTPTestProvider struct {
	exchangeCalls int
}

func (p *oidcHTTPTestProvider) AuthorizationURL(state, nonce string) (string, error) {
	return "https://issuer.example.test/authorize?state=" + url.QueryEscape(state) + "&nonce=" + url.QueryEscape(nonce), nil
}

func (p *oidcHTTPTestProvider) Exchange(context.Context, string, string) (Identity, error) {
	p.exchangeCalls++
	return Identity{}, context.Canceled
}
