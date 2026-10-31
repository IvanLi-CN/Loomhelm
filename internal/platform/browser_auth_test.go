package platform

import (
	"strings"
	"testing"
)

func TestBrowserAuthConfigurationIsServerOnly(t *testing.T) {
	base := map[string]string{"LOOMHELM_DATABASE_URL": "postgres://test@localhost/loomhelm", "LOOMHELM_DRAIN_TOKEN": "test"}
	cfg, err := LoadConfigWithLookup(ComponentServer, envLookup(base))
	if err != nil || cfg.BrowserAuth.OIDCEnabled() || !cfg.BrowserAuth.SecureCookies {
		t.Fatalf("unconfigured OIDC must keep secure cookies and leave login disabled: %v", err)
	}
	base["LOOMHELM_OIDC_ISSUER_URL"] = "https://issuer.example.test"
	base["LOOMHELM_OIDC_CLIENT_ID"] = "loomhelm"
	base["LOOMHELM_OIDC_REDIRECT_URL"] = "https://app.example.test/api/v1/auth/oidc/callback"
	base["LOOMHELM_OIDC_CLIENT_SECRET"] = "opaque-secret"
	base["LOOMHELM_SESSION_COOKIE_SECURE"] = "false"
	cfg, err = LoadConfigWithLookup(ComponentServer, envLookup(base))
	if err != nil || !cfg.BrowserAuth.OIDCEnabled() || cfg.BrowserAuth.SecureCookies || cfg.BrowserAuth.OIDCClientSecret != "opaque-secret" {
		t.Fatalf("explicit OIDC configuration was not consumed: %v", err)
	}
	for key, value := range map[string]string{
		"LOOMHELM_OIDC_CLIENT_ID": "", "LOOMHELM_OIDC_ISSUER_URL": "https://user:secret@issuer.example.test",
		"LOOMHELM_OIDC_REDIRECT_URL": "https://app.example.test/auth/callback", "LOOMHELM_SESSION_COOKIE_SECURE": "invalid-secret",
	} {
		original := base[key]
		base[key] = value
		_, err := LoadConfigWithLookup(ComponentServer, envLookup(base))
		if err == nil || strings.Contains(err.Error(), "opaque-secret") || strings.Contains(err.Error(), "invalid-secret") || strings.Contains(err.Error(), "user:secret") {
			t.Fatalf("%s invalid configuration must fail without echoing its value: %v", key, err)
		}
		base[key] = original
	}
	base["LOOMHELM_OIDC_ISSUER_URL"] = "invalid"
	base["LOOMHELM_SESSION_COOKIE_SECURE"] = "invalid"
	worker, err := LoadConfigWithLookup(ComponentWorker, envLookup(base))
	if err != nil || worker.BrowserAuth.OIDCEnabled() {
		t.Fatalf("Worker consumed Server identity configuration: %v", err)
	}
}
