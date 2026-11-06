package platform

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// BrowserAuthConfig belongs to Server. Worker and Connector never discover an
// identity provider or consume its credentials.
type BrowserAuthConfig struct {
	OIDCIssuerURL    string
	OIDCClientID     string
	OIDCClientSecret string
	OIDCRedirectURL  string
	SecureCookies    bool
}

func browserAuthFromLookup(lookup func(string) (string, bool)) (BrowserAuthConfig, error) {
	cfg := BrowserAuthConfig{
		OIDCIssuerURL:    strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_OIDC_ISSUER_URL", "")),
		OIDCClientID:     strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_OIDC_CLIENT_ID", "")),
		OIDCClientSecret: lookupOrDefault(lookup, "LOOMHELM_OIDC_CLIENT_SECRET", ""),
		OIDCRedirectURL:  strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_OIDC_REDIRECT_URL", "")),
	}
	var err error
	cfg.SecureCookies, err = strconv.ParseBool(lookupOrDefault(lookup, "LOOMHELM_SESSION_COOKIE_SECURE", "true"))
	if err != nil {
		return BrowserAuthConfig{}, fmt.Errorf("LOOMHELM_SESSION_COOKIE_SECURE must be a boolean")
	}
	return cfg, cfg.Validate()
}

func (c BrowserAuthConfig) OIDCEnabled() bool { return c.OIDCIssuerURL != "" }

func (c BrowserAuthConfig) Validate() error {
	if c.OIDCIssuerURL == "" && c.OIDCClientID == "" && c.OIDCClientSecret == "" && c.OIDCRedirectURL == "" {
		return nil
	}
	if strings.TrimSpace(c.OIDCIssuerURL) == "" || strings.TrimSpace(c.OIDCClientID) == "" || strings.TrimSpace(c.OIDCRedirectURL) == "" {
		return fmt.Errorf("LOOMHELM_OIDC_ISSUER_URL, LOOMHELM_OIDC_CLIENT_ID and LOOMHELM_OIDC_REDIRECT_URL must be configured together")
	}
	issuer, err := browserAuthURL(c.OIDCIssuerURL)
	if err != nil || issuer.RawQuery != "" || issuer.ForceQuery {
		return fmt.Errorf("invalid LOOMHELM_OIDC_ISSUER_URL")
	}
	redirect, err := browserAuthURL(c.OIDCRedirectURL)
	if err != nil || redirect.Path != "/api/v1/auth/oidc/callback" || redirect.RawQuery != "" || redirect.ForceQuery {
		return fmt.Errorf("LOOMHELM_OIDC_REDIRECT_URL must be an absolute HTTP(S) URL ending in /api/v1/auth/oidc/callback")
	}
	return nil
}

func browserAuthURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || u.Fragment != "" || strings.ContainsAny(raw, " \t\r\n") {
		return nil, fmt.Errorf("invalid HTTP(S) URL")
	}
	return u, nil
}
