package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
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

func TestOIDCProviderAcceptsAndRejectsRealIssuerTokens(t *testing.T) {
	const (
		clientID      = "loomhelm-test"
		expectedNonce = "nonce-test"
	)
	signingKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate signing key: %v", err)
	}
	wrongSigningKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate wrong signing key: %v", err)
	}
	var issuer string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(writer).Encode(map[string]string{
				"issuer":                 issuer,
				"authorization_endpoint": issuer + "/authorize",
				"token_endpoint":         issuer + "/token",
				"userinfo_endpoint":      issuer + "/userinfo",
				"jwks_uri":               issuer + "/jwks",
			})
		case "/jwks":
			_ = json.NewEncoder(writer).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{
				Key:       &signingKey.PublicKey,
				KeyID:     "test-key",
				Algorithm: string(jose.RS256),
				Use:       "sig",
			}}})
		case "/token":
			key := signingKey
			if request.FormValue("code") == "bad_signature" {
				key = wrongSigningKey
			}
			token, tokenErr := signOIDCTestToken(issuer, clientID, expectedNonce, request.FormValue("code"), key)
			if tokenErr != nil {
				http.Error(writer, tokenErr.Error(), http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(writer).Encode(map[string]string{
				"access_token": "access-token",
				"token_type":   "Bearer",
				"id_token":     token,
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	issuer = server.URL

	provider, err := NewOIDCProvider(context.Background(), OIDCConfig{
		IssuerURL:    issuer,
		ClientID:     clientID,
		ClientSecret: "secret",
		RedirectURL:  issuer + "/callback",
	})
	if err != nil {
		t.Fatalf("NewOIDCProvider() error = %v", err)
	}
	identity, err := provider.Exchange(context.Background(), "valid", expectedNonce)
	if err != nil {
		t.Fatalf("valid OIDC exchange error = %v", err)
	}
	if identity.Issuer != issuer || identity.Subject != "subject-valid" || identity.Email != "user@example.test" || identity.DisplayName != "Test User" || !identity.EmailVerified {
		t.Fatalf("valid OIDC identity = %+v", identity)
	}

	for _, test := range []struct {
		name string
		code string
	}{
		{name: "nonce", code: "bad_nonce"},
		{name: "audience", code: "bad_audience"},
		{name: "issuer", code: "bad_issuer"},
		{name: "signature", code: "bad_signature"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := provider.Exchange(context.Background(), test.code, expectedNonce); err == nil {
				t.Fatalf("OIDC exchange error = nil for %s token", test.name)
			}
		})
	}
}

func signOIDCTestToken(issuer, clientID, nonce, code string, key *rsa.PrivateKey) (string, error) {
	claims := map[string]any{
		"iss":            issuer,
		"sub":            "subject-" + code,
		"aud":            clientID,
		"exp":            time.Now().Add(time.Hour).Unix(),
		"iat":            time.Now().Add(-time.Minute).Unix(),
		"nonce":          nonce,
		"email":          "user@example.test",
		"email_verified": true,
		"name":           "Test User",
	}
	switch code {
	case "bad_nonce":
		claims["nonce"] = "unexpected-nonce"
	case "bad_audience":
		claims["aud"] = "other-client"
	case "bad_issuer":
		claims["iss"] = issuer + "/other"
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithHeader(jose.HeaderKey("kid"), "test-key"))
	if err != nil {
		return "", err
	}
	signed, err := signer.Sign(payload)
	if err != nil {
		return "", err
	}
	return signed.CompactSerialize()
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
