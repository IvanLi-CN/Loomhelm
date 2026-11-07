package buildinfo

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVersionGuardRejectsBeforeSideEffects(t *testing.T) {
	for _, version := range []string{"", "dev", "1.0.1", "malformed"} {
		request := httptest.NewRequest("POST", "/api/v1/tasks", nil)
		request.Header.Set(Header, version)
		called := false
		response := httptest.NewRecorder()
		Guard("1.0.0", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })).ServeHTTP(response, request)
		if called || response.Code != 426 {
			t.Fatalf("version %q reached business handler", version)
		}
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/mcp", nil)
	request.Header.Set(Header, "1.0.0")
	Guard("1.0.0", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })).ServeHTTP(response, request)
	if response.Code != 204 {
		t.Fatal("same version rejected")
	}
}

func TestImmutableIdentityCannotBeOverridden(t *testing.T) {
	oldVersion, oldSHA := Version, SourceSHA
	defer func() { Version, SourceSHA = oldVersion, oldSHA }()
	Version, SourceSHA = "1.0.0", strings.Repeat("a", 40)
	if ValidateOverride("2.0.0", SourceSHA) == nil || ValidateOverride(Version, strings.Repeat("b", 40)) == nil {
		t.Fatal("identity override accepted")
	}
	if err := ValidateOverride(Version, SourceSHA); err != nil {
		t.Fatal(err)
	}
}

func TestAuthenticationNavigationDoesNotExemptBusinessPaths(t *testing.T) {
	for _, path := range []string{"/api/v1/auth/session", "/api/v1/auth/oidc/start/tasks", "/api/v1/tasks", "/api/v1/auth/logout"} {
		called := false
		handler := ApplicationGuard("1.0.0", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", path, nil))
		if called {
			t.Fatalf("versionless business path exempted: %s", path)
		}
	}
}
