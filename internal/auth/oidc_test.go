package auth

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

const oidcTestIssuer = "https://issuer.example.test"

func TestOIDCProviderBuildsAuthorizationURLFromDiscovery(t *testing.T) {
	provider, err := NewOIDCProvider(context.Background(), OIDCConfig{
		IssuerURL:   oidcTestIssuer,
		ClientID:    "loomhelm-test",
		RedirectURL: "http://localhost/callback",
		HTTPClient:  oidcTestHTTPClient(false),
	})
	if err != nil {
		t.Fatalf("NewOIDCProvider() error = %v", err)
	}
	authorizationURL, err := provider.AuthorizationURL("state-test", "nonce-test")
	if err != nil {
		t.Fatalf("AuthorizationURL() error = %v", err)
	}
	parsed, err := url.Parse(authorizationURL)
	if err != nil {
		t.Fatalf("parse authorization URL: %v", err)
	}
	query := parsed.Query()
	if query.Get("client_id") != "loomhelm-test" || query.Get("state") != "state-test" || query.Get("nonce") != "nonce-test" {
		t.Fatalf("authorization query = %v", query)
	}
	if query.Get("scope") != "openid profile email" {
		t.Fatalf("authorization scope = %q", query.Get("scope"))
	}
}

func TestOIDCProviderRejectsInvalidIDTokenThroughLibraryVerifier(t *testing.T) {
	provider, err := NewOIDCProvider(context.Background(), OIDCConfig{
		IssuerURL:    oidcTestIssuer,
		ClientID:     "loomhelm-test",
		ClientSecret: "secret",
		RedirectURL:  "http://localhost/callback",
		HTTPClient:   oidcTestHTTPClient(true),
	})
	if err != nil {
		t.Fatalf("NewOIDCProvider() error = %v", err)
	}
	_, err = provider.Exchange(context.Background(), "code", "nonce-test")
	if err == nil || !strings.Contains(err.Error(), "verify OIDC ID token") {
		t.Fatalf("Exchange() error = %v, want verifier error", err)
	}
}

func TestOIDCProviderRequiresStateAndNonce(t *testing.T) {
	provider, err := NewOIDCProvider(context.Background(), OIDCConfig{
		IssuerURL:   oidcTestIssuer,
		ClientID:    "loomhelm-test",
		RedirectURL: "http://localhost/callback",
		HTTPClient:  oidcTestHTTPClient(false),
	})
	if err != nil {
		t.Fatalf("NewOIDCProvider() error = %v", err)
	}
	if _, err := provider.AuthorizationURL("", "nonce"); err == nil {
		t.Fatal("AuthorizationURL() error = nil for missing state")
	}
	if _, err := provider.AuthorizationURL("state", ""); err == nil {
		t.Fatal("AuthorizationURL() error = nil for missing nonce")
	}
}

func oidcTestHTTPClient(invalidToken bool) *http.Client {
	return &http.Client{Transport: oidcRoundTripper{invalidToken: invalidToken}}
}

type oidcRoundTripper struct {
	invalidToken bool
}

func (r oidcRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	body := ""
	switch request.URL.Path {
	case "/.well-known/openid-configuration":
		body = `{"issuer":"https://issuer.example.test","authorization_endpoint":"https://issuer.example.test/authorize","token_endpoint":"https://issuer.example.test/token","jwks_uri":"https://issuer.example.test/jwks"}`
	case "/token":
		if r.invalidToken {
			body = `{"access_token":"access","token_type":"Bearer","id_token":"not-a-jwt"}`
		} else {
			body = `{"access_token":"access","token_type":"Bearer"}`
		}
	case "/jwks":
		body = `{"keys":[]}`
	default:
		return nil, &url.Error{Op: "GET", URL: request.URL.String(), Err: io.ErrUnexpectedEOF}
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    request,
	}, nil
}
