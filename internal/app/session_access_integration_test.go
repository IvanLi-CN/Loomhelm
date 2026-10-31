package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
)

// This proves the production read/authorization boundary with actual OIDC,
// cookies, credentials and PostgreSQL. Seeded thread references are fixtures;
// the test does not claim Codex creation or command execution.
func TestServerSessionAccessWithPersistentIdentity(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	cfg := platform.Config{
		Component: platform.ComponentServer, Version: "session-integration", DrainToken: "session-test-drain",
		ShutdownTimeout: 5 * time.Second, StartupTimeout: 30 * time.Second,
		DatabaseURL: databaseURL, DatabaseMaxConns: 4,
		BrowserAuth: platform.BrowserAuthConfig{OIDCIssuerURL: issuer.URL, OIDCClientID: "loomhelm-test", SecureCookies: false},
	}
	baseURL, stop := startApplicationTestServer(t, cfg)
	alice, bob := applicationBrowser(t), applicationBrowser(t)
	loginApplicationBrowser(t, alice, baseURL, "alice")
	loginApplicationBrowser(t, bob, baseURL, "bob")
	var aliceIdentity, bobIdentity protocol.BrowserSessionResponse
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &aliceIdentity)
	decodeApplicationResponse(t, applicationRequest(t, bob, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &bobIdentity)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MaxConns: 4})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	registration, err := hosts.NewService(db.Pool()).Register(ctx, hosts.RegisterRequest{Name: "isolated session test", CredentialName: "test-only"})
	if err != nil {
		t.Fatal(err)
	}
	store := sessions.NewStore(db.Pool())
	seed := func(id, projectID string, confirmed bool) {
		t.Helper()
		_, err := store.CreateIntent(ctx, sessions.CreationIntentInput{
			SessionID: id, CommandID: "create-" + id, CreatorUserID: aliceIdentity.UserID,
			HostID: registration.Host.ID, Path: protocol.SessionPathNew, ProjectID: projectID,
			Parameters: []byte(`{"fixture":true}`),
		})
		if err != nil {
			t.Fatal(err)
		}
		if confirmed {
			_, err = store.ActivateIntent(ctx, sessions.ActivationInput{SessionID: id, ExternalThreadRef: "fixture-thread-" + id, ExecutionGeneration: "fixture-execution"})
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	read := func(client *http.Client, id string, headers map[string]string, status int) *http.Response {
		t.Helper()
		response := applicationRequest(t, client, http.MethodGet, baseURL+"/api/v1/sessions/"+id, nil, headers, status)
		if response.Header.Get("Cache-Control") != "no-store" {
			response.Body.Close()
			t.Fatal("conversation response can be cached")
		}
		return response
	}
	seed("private", "", true)
	var private protocol.SessionResponse
	decodeApplicationResponse(t, read(alice, "private", nil, http.StatusOK), &private)
	if private.Session.ID != "private" || private.Session.ExternalThreadRef != "fixture-thread-private" {
		t.Fatalf("wrong persisted session: %+v", private.Session)
	}
	read(bob, "private", nil, http.StatusNotFound).Body.Close()
	read(applicationBrowser(t), "private", nil, http.StatusUnauthorized).Body.Close()
	seed("unknown", "", false)
	var unknown protocol.ApiError
	decodeApplicationResponse(t, read(alice, "unknown", nil, http.StatusConflict), &unknown)
	if unknown.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("unconfirmed session error = %q", unknown.Code)
	}
	read(bob, "unknown", nil, http.StatusNotFound).Body.Close()
	var project struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/projects", map[string]string{"name": "Session access"}, nil, http.StatusCreated), &project)
	seed("shared", project.Project.ID, true)
	read(bob, "shared", nil, http.StatusNotFound).Body.Close()
	memberURL := baseURL + "/api/v1/projects/" + project.Project.ID + "/members/" + bobIdentity.UserID
	applicationRequest(t, alice, http.MethodPut, memberURL, map[string]string{"role": "viewer"}, nil, http.StatusOK).Body.Close()
	read(bob, "shared", nil, http.StatusOK).Body.Close()
	applicationRequest(t, alice, http.MethodDelete, memberURL, nil, nil, http.StatusNoContent).Body.Close()
	read(bob, "shared", nil, http.StatusNotFound).Body.Close()
	var credential struct {
		Credential struct {
			Token string `json:"token"`
		} `json:"credential"`
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/credentials", map[string]any{"name": "project-only", "project_ids": []string{project.Project.ID}}, nil, http.StatusCreated), &credential)
	if credential.Credential.Token == "" {
		t.Fatal("project-scoped credential was not returned")
	}
	bearer := map[string]string{"Authorization": "Bearer " + credential.Credential.Token}
	read(applicationBrowser(t), "shared", bearer, http.StatusOK).Body.Close()
	read(applicationBrowser(t), "private", bearer, http.StatusNotFound).Body.Close()
	if _, err := store.Create(ctx, sessions.NewInput{ID: "legacy", Path: protocol.SessionPathNew, ProjectID: project.Project.ID, ExternalThreadRef: "fixture-legacy", Generation: "legacy"}); err != nil {
		t.Fatal(err)
	}
	read(alice, "legacy", nil, http.StatusNotFound).Body.Close()
	stop()
	baseURL, _ = startApplicationTestServer(t, cfg)
	var reopened protocol.SessionResponse
	decodeApplicationResponse(t, read(alice, "private", nil, http.StatusOK), &reopened)
	if reopened.Session != private.Session {
		before, _ := json.Marshal(private)
		after, _ := json.Marshal(reopened)
		t.Fatalf("session changed across server restart: %s -> %s", before, after)
	}
	read(bob, "shared", nil, http.StatusNotFound).Body.Close()
}
