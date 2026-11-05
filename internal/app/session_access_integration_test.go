package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
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
	registration, err := hosts.NewService(db.Pool()).RegisterForUser(ctx, aliceIdentity.UserID, hosts.RegisterRequest{Name: "isolated session test", CredentialName: "test-only"})
	if err != nil {
		t.Fatal(err)
	}
	store := sessions.NewStore(db.Pool())
	seedWithHost := func(id, projectID, hostID string, confirmed bool) {
		t.Helper()
		_, err := store.CreateIntent(ctx, sessions.CreationIntentInput{
			SessionID: id, CommandID: "create-" + id, CreatorUserID: aliceIdentity.UserID,
			HostID: hostID, Path: protocol.SessionPathNew, ProjectID: projectID,
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
	seed := func(id, projectID string, confirmed bool) {
		seedWithHost(id, projectID, registration.Host.ID, confirmed)
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
	list := func(client *http.Client, headers map[string]string, status int) protocol.SessionListResponse {
		t.Helper()
		response := applicationRequest(t, client, http.MethodGet, baseURL+"/api/v1/sessions?limit=50", nil, headers, status)
		defer response.Body.Close()
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("session list response can be cached")
		}
		var result protocol.SessionListResponse
		if status == http.StatusOK {
			decodeApplicationResponse(t, response, &result)
		}
		return result
	}
	listPage := func(client *http.Client, headers map[string]string, limit int, afterCursor string, status int) protocol.SessionListResponse {
		t.Helper()
		path := baseURL + "/api/v1/sessions?limit=" + strconv.Itoa(limit)
		if afterCursor != "" {
			path += "&after_cursor=" + url.QueryEscape(afterCursor)
		}
		response := applicationRequest(t, client, http.MethodGet, path, nil, headers, status)
		defer response.Body.Close()
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("session page response can be cached")
		}
		var result protocol.SessionListResponse
		if status == http.StatusOK {
			decodeApplicationResponse(t, response, &result)
		}
		return result
	}
	seed("private", "", true)
	var private protocol.SessionResponse
	decodeApplicationResponse(t, read(alice, "private", nil, http.StatusOK), &private)
	if private.Session.ID != "private" || private.Session.ExternalThreadRef != "fixture-thread-private" {
		t.Fatalf("wrong persisted session: %+v", private.Session)
	}
	read(bob, "private", nil, http.StatusNotFound).Body.Close()
	if listed := list(alice, nil, http.StatusOK); len(listed.Items) != 1 || listed.Items[0].ID != "private" {
		t.Fatalf("alice session list = %+v, want only private session", listed.Items)
	}
	if listed := list(bob, nil, http.StatusOK); len(listed.Items) != 0 {
		t.Fatalf("bob session list exposed private session: %+v", listed.Items)
	}
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
	otherRegistration, err := hosts.NewService(db.Pool()).RegisterForUser(ctx, aliceIdentity.UserID, hosts.RegisterRequest{Name: "isolated second host", CredentialName: "second-test-only"})
	if err != nil {
		t.Fatal(err)
	}
	seed("shared", project.Project.ID, true)
	seed("visible-a", project.Project.ID, true)
	seed("visible-b", project.Project.ID, true)
	seedWithHost("hidden-newer", project.Project.ID, otherRegistration.Host.ID, true)
	for _, item := range []struct {
		id        string
		updatedAt string
	}{
		{id: "hidden-newer", updatedAt: "2099-01-04T00:00:00Z"},
		{id: "visible-a", updatedAt: "2099-01-03T00:00:00Z"},
		{id: "visible-b", updatedAt: "2099-01-03T00:00:00Z"},
		{id: "shared", updatedAt: "2099-01-02T00:00:00Z"},
	} {
		if _, err := db.Pool().Exec(ctx, `UPDATE execution_sessions SET updated_at = $2::timestamptz WHERE id = $1`, item.id, item.updatedAt); err != nil {
			t.Fatal(err)
		}
	}
	read(bob, "shared", nil, http.StatusNotFound).Body.Close()
	if listed := list(bob, nil, http.StatusOK); len(listed.Items) != 0 {
		t.Fatalf("bob session list exposed unshared Host session: %+v", listed.Items)
	}
	memberURL := baseURL + "/api/v1/projects/" + project.Project.ID + "/members/" + bobIdentity.UserID
	applicationRequest(t, alice, http.MethodPut, memberURL, map[string]string{"role": "viewer"}, nil, http.StatusOK).Body.Close()
	read(bob, "shared", nil, http.StatusNotFound).Body.Close()
	if listed := list(bob, nil, http.StatusOK); len(listed.Items) != 0 {
		t.Fatalf("bob session list exposed session before Host share: %+v", listed.Items)
	}
	hostShareURL := baseURL + "/api/v1/hosts/" + registration.Host.ID + "/shares/" + bobIdentity.UserID
	applicationRequest(t, alice, http.MethodPut, hostShareURL, nil, nil, http.StatusOK).Body.Close()
	read(bob, "shared", nil, http.StatusOK).Body.Close()
	if listed := list(bob, nil, http.StatusOK); len(listed.Items) != 3 {
		t.Fatalf("bob session list = %+v, want shared session", listed.Items)
	}
	pageOne := listPage(bob, nil, 1, "", http.StatusOK)
	if len(pageOne.Items) != 1 || pageOne.Items[0].ID != "visible-b" || !pageOne.HasMore || pageOne.NextCursor == nil {
		t.Fatalf("first paged session response = %+v, want visible-b with a next cursor", pageOne)
	}
	pageTwo := listPage(bob, nil, 1, *pageOne.NextCursor, http.StatusOK)
	if len(pageTwo.Items) != 1 || pageTwo.Items[0].ID != "visible-a" || !pageTwo.HasMore || pageTwo.NextCursor == nil {
		t.Fatalf("second paged session response = %+v, want visible-a with a next cursor", pageTwo)
	}
	pageThree := listPage(bob, nil, 1, *pageTwo.NextCursor, http.StatusOK)
	if len(pageThree.Items) != 1 || pageThree.Items[0].ID != "shared" || pageThree.HasMore || pageThree.NextCursor != nil {
		t.Fatalf("third paged session response = %+v, want shared as the final page", pageThree)
	}
	applicationRequest(t, alice, http.MethodDelete, memberURL, nil, nil, http.StatusNoContent).Body.Close()
	read(bob, "shared", nil, http.StatusNotFound).Body.Close()
	if listed := list(bob, nil, http.StatusOK); len(listed.Items) != 0 {
		t.Fatalf("bob session list retained revoked project session: %+v", listed.Items)
	}
	applicationRequest(t, alice, http.MethodDelete, hostShareURL, nil, nil, http.StatusNoContent).Body.Close()
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
