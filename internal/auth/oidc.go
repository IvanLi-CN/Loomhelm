package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type OIDCConfig struct {
	IssuerURL    string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	HTTPClient   *http.Client
}

// OIDCProvider adapts go-oidc and oauth2 to the auth.Provider boundary. The
// verifier owns discovery, key rotation, JWT signature checks and standard
// issuer, audience and time-claim validation.
type OIDCProvider struct {
	config   OIDCConfig
	client   *http.Client
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
}

func NewOIDCProvider(ctx context.Context, config OIDCConfig) (*OIDCProvider, error) {
	if ctx == nil {
		return nil, errors.New("OIDC discovery context must not be nil")
	}
	if strings.TrimSpace(config.IssuerURL) == "" || strings.TrimSpace(config.ClientID) == "" || strings.TrimSpace(config.RedirectURL) == "" {
		return nil, errors.New("OIDC issuer, client ID, and redirect URL are required")
	}
	providerContext := ctx
	if config.HTTPClient != nil {
		providerContext = oidc.ClientContext(ctx, config.HTTPClient)
	}
	provider, err := oidc.NewProvider(providerContext, strings.TrimRight(config.IssuerURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("discover OIDC provider: %w", err)
	}
	verifier := provider.Verifier(&oidc.Config{ClientID: config.ClientID})
	return &OIDCProvider{
		config: config,
		client: clientForConfig(config),
		oauth: oauth2.Config{
			ClientID:     config.ClientID,
			ClientSecret: config.ClientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  config.RedirectURL,
			Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
		},
		verifier: verifier,
	}, nil
}

func (p *OIDCProvider) AuthorizationURL(state, nonce string) (string, error) {
	if p == nil {
		return "", errors.New("OIDC provider is nil")
	}
	if strings.TrimSpace(state) == "" || strings.TrimSpace(nonce) == "" {
		return "", errors.New("OIDC state and nonce are required")
	}
	return p.oauth.AuthCodeURL(state, oauth2.SetAuthURLParam("nonce", nonce)), nil
}

func (p *OIDCProvider) Exchange(ctx context.Context, code, nonce string) (Identity, error) {
	if p == nil || p.verifier == nil {
		return Identity{}, errors.New("OIDC provider is not configured")
	}
	if ctx == nil {
		return Identity{}, errors.New("OIDC exchange context must not be nil")
	}
	if strings.TrimSpace(code) == "" || strings.TrimSpace(nonce) == "" {
		return Identity{}, errors.New("OIDC authorization code and nonce are required")
	}
	exchangeContext := ctx
	if p.client != nil {
		exchangeContext = oidc.ClientContext(ctx, p.client)
	}
	token, err := p.oauth.Exchange(exchangeContext, code)
	if err != nil {
		return Identity{}, fmt.Errorf("exchange OIDC authorization code: %w", err)
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || strings.TrimSpace(rawIDToken) == "" {
		return Identity{}, errors.New("OIDC token response did not contain an ID token")
	}
	idToken, err := p.verifier.Verify(exchangeContext, rawIDToken)
	if err != nil {
		return Identity{}, fmt.Errorf("verify OIDC ID token: %w", err)
	}
	if idToken.Nonce != nonce {
		return Identity{}, errors.New("OIDC ID token nonce is invalid")
	}
	var claims struct {
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return Identity{}, fmt.Errorf("decode OIDC ID token claims: %w", err)
	}
	return Identity{
		Issuer:        idToken.Issuer,
		Subject:       idToken.Subject,
		Email:         claims.Email,
		DisplayName:   claims.Name,
		EmailVerified: claims.EmailVerified,
	}, nil
}

func clientForConfig(config OIDCConfig) *http.Client {
	if config.HTTPClient != nil {
		return config.HTTPClient
	}
	return http.DefaultClient
}
