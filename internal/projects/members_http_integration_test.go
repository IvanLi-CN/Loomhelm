package projects_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/IvanLi-CN/Loomhelm/internal/tasks"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProjectMemberHTTPAuthorization(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	db := openMembersDatabase(t, ctx)
	pool := db.Pool()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	viewerID := "p01_member_http_viewer_" + suffix
	operatorID := "p01_member_http_operator_" + suffix
	outsiderID := "p01_member_http_outsider_" + suffix
	projectIDs := make([]string, 0, 2)
	taskIDs := make([]string, 0, 1)
	sessionCookieName := "p01_member_http_session_" + suffix
	var sessionToken string
	var creatorID string
	defer func() {
		cleanupMemberHTTPState(t, ctx, pool, projectIDs, taskIDs, sessionToken, []string{creatorID, viewerID, operatorID, outsiderID})
		db.Close()
	}()
	seedMemberUser(t, ctx, pool, viewerID)
	seedMemberUser(t, ctx, pool, operatorID)
	seedMemberUser(t, ctx, pool, outsiderID)

	provider := &memberHTTPProvider{identity: auth.Identity{
		Issuer:      "https://members-http.example.test/" + suffix,
		Subject:     "creator-" + suffix,
		Email:       "creator-" + suffix + "@example.test",
		DisplayName: "HTTP Member Creator",
	}}
	authService, err := auth.NewService(pool, auth.Config{
		SessionCookieName: sessionCookieName,
		SessionLifetime:   time.Hour,
		SuccessRedirect:   "/",
	}, provider)
	if err != nil {
		t.Fatalf("auth.NewService() error = %v", err)
	}
	projectService := projects.NewService(pool, authService)
	taskService := tasks.NewService(pool, authService, projectService)
	root := chi.NewRouter()
	authService.Mount(root)
	api := chi.NewRouter()
	projectService.Mount(api)
	taskService.Mount(api)
	root.Mount("/api/v1", api)
	handler := authService.Middleware(root)

	sessionCookie := loginMemberHTTP(t, handler, sessionCookieName)
	sessionToken = sessionCookie.Value
	if provider.exchangeCalls != 1 || provider.exchangeCode != "creator-code" || provider.exchangeNonce == "" {
		t.Fatalf("OIDC exchange = calls:%d code:%q nonce:%q", provider.exchangeCalls, provider.exchangeCode, provider.exchangeNonce)
	}
	if provider.exchangeNonce != provider.authorizationNonce {
		t.Fatalf("OIDC nonce mismatch: authorization=%q exchange=%q", provider.authorizationNonce, provider.exchangeNonce)
	}
	creatorResponse := serveMemberHTTP(handler, http.MethodGet, "/auth/me", "", "", sessionCookie)
	requireMemberHTTPStatus(t, creatorResponse, http.StatusOK)
	var creatorBody struct {
		User auth.User `json:"user"`
	}
	decodeMemberHTTPJSON(t, creatorResponse, &creatorBody)
	creatorID = creatorBody.User.ID
	if creatorID == "" {
		t.Fatal("OIDC session resolved an empty creator ID")
	}
	creatorPrincipal := auth.Principal{UserID: creatorID}

	projectA := createMemberHTTPProject(t, handler, sessionCookie, "Member HTTP A")
	projectIDs = append(projectIDs, projectA.ID)
	projectB := createMemberHTTPProject(t, handler, sessionCookie, "Member HTTP B")
	projectIDs = append(projectIDs, projectB.ID)

	memberTaskService := tasks.NewService(pool, nil, projectService)
	memberTask, err := memberTaskService.Create(ctx, creatorPrincipal, tasks.CreateRequest{
		ProjectID: projectA.ID,
		Title:     "Member ownership task",
		Goal:      "must survive member changes",
	})
	if err != nil {
		t.Fatalf("create ownership task: %v", err)
	}
	taskIDs = append(taskIDs, memberTask.ID)
	if err := memberTaskService.SetExecutionProtection(ctx, creatorPrincipal, memberTask.ID, false, true); err != nil {
		t.Fatalf("retain ownership task history: %v", err)
	}

	creatorCredential, err := authService.CreateCredential(ctx, creatorPrincipal, auth.CreateCredentialRequest{
		Name:       "HTTP member creator",
		ProjectIDs: []string{projectA.ID},
	})
	if err != nil {
		t.Fatalf("create scoped creator credential: %v", err)
	}
	creatorCredentialRequest := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	creatorCredentialRequest.Header.Set("Authorization", "Bearer "+creatorCredential.Token)
	scopedCreatorPrincipal, err := authService.ResolvePrincipal(ctx, creatorCredentialRequest)
	if err != nil {
		t.Fatalf("resolve scoped creator credential: %v", err)
	}
	if scopedCreatorPrincipal.UserID != creatorID || !scopedCreatorPrincipal.HasProjectScope(projectA.ID) || scopedCreatorPrincipal.HasProjectScope(projectB.ID) {
		t.Fatalf("resolved creator scope = %+v", scopedCreatorPrincipal)
	}
	if _, err := authService.CreateCredential(ctx, scopedCreatorPrincipal, auth.CreateCredentialRequest{
		Name:       "HTTP member derived cross-project",
		ProjectIDs: []string{projectB.ID},
	}); !errors.Is(err, auth.ErrForbidden) {
		t.Fatalf("create scoped cross-project credential error = %v, want forbidden", err)
	}

	listPath := "/api/v1/projects/" + url.PathEscape(projectA.ID) + "/members"
	listResponse := serveMemberHTTP(handler, http.MethodGet, listPath, "", creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, listResponse, http.StatusOK)
	var listBody struct {
		Items []projects.Member `json:"items"`
	}
	decodeMemberHTTPJSON(t, listResponse, &listBody)
	if len(listBody.Items) != 1 || listBody.Items[0].UserID != creatorID || listBody.Items[0].Role != projects.RoleOwner {
		t.Fatalf("initial member list = %+v, want owner only", listBody.Items)
	}
	if listBody.Items == nil {
		t.Fatal("member list items is nil; response must contain an explicit array")
	}

	grantPath := "/api/v1/projects/" + url.PathEscape(projectA.ID) + "/members/" + url.PathEscape(viewerID)
	grantViewerResponse := serveMemberHTTP(handler, http.MethodPut, grantPath, `{"role":"viewer"}`, creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, grantViewerResponse, http.StatusOK)
	var grantBody struct {
		Member projects.Member `json:"member"`
	}
	decodeMemberHTTPJSON(t, grantViewerResponse, &grantBody)
	if grantBody.Member.ProjectID != projectA.ID || grantBody.Member.UserID != viewerID || grantBody.Member.Role != projects.RoleViewer || grantBody.Member.CreatedAt == "" {
		t.Fatalf("viewer grant = %+v", grantBody.Member)
	}

	missingUserPath := "/api/v1/projects/" + url.PathEscape(projectA.ID) + "/members/missing-member-" + suffix
	missingUserResponse := serveMemberHTTP(handler, http.MethodPut, missingUserPath, `{"role":"viewer"}`, creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, missingUserResponse, http.StatusNotFound)

	ownerGrantResponse := serveMemberHTTP(handler, http.MethodPut, "/api/v1/projects/"+url.PathEscape(projectA.ID)+"/members/"+url.PathEscape(operatorID), `{"role":"owner"}`, creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, ownerGrantResponse, http.StatusBadRequest)
	creatorRevokeResponse := serveMemberHTTP(handler, http.MethodDelete, "/api/v1/projects/"+url.PathEscape(projectA.ID)+"/members/"+url.PathEscape(creatorID), "", creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, creatorRevokeResponse, http.StatusConflict)
	grantOperatorResponse := serveMemberHTTP(handler, http.MethodPut, "/api/v1/projects/"+url.PathEscape(projectA.ID)+"/members/"+url.PathEscape(operatorID), `{"role":"operator"}`, creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, grantOperatorResponse, http.StatusOK)

	viewerCredential, err := authService.CreateCredential(ctx, auth.Principal{UserID: viewerID}, auth.CreateCredentialRequest{
		Name:       "HTTP member viewer",
		ProjectIDs: []string{projectA.ID},
	})
	if err != nil {
		t.Fatalf("create viewer credential: %v", err)
	}
	operatorCredential, err := authService.CreateCredential(ctx, auth.Principal{UserID: operatorID}, auth.CreateCredentialRequest{
		Name:       "HTTP member operator",
		ProjectIDs: []string{projectA.ID},
	})
	if err != nil {
		t.Fatalf("create operator credential: %v", err)
	}

	for _, test := range []struct {
		name  string
		token string
	}{
		{name: "viewer", token: viewerCredential.Token},
		{name: "operator", token: operatorCredential.Token},
	} {
		t.Run(test.name+" cannot manage members", func(t *testing.T) {
			grantResponse := serveMemberHTTP(handler, http.MethodPut, grantPath, `{"role":"viewer"}`, test.token, nil)
			requireMemberHTTPStatus(t, grantResponse, http.StatusForbidden)
			revokeResponse := serveMemberHTTP(handler, http.MethodDelete, grantPath, "", test.token, nil)
			requireMemberHTTPStatus(t, revokeResponse, http.StatusForbidden)
		})
	}
	updatedViewerResponse := serveMemberHTTP(handler, http.MethodPut, grantPath, `{"role":"operator"}`, creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, updatedViewerResponse, http.StatusOK)
	var updatedViewerBody struct {
		Member projects.Member `json:"member"`
	}
	decodeMemberHTTPJSON(t, updatedViewerResponse, &updatedViewerBody)
	if updatedViewerBody.Member.UserID != viewerID || updatedViewerBody.Member.Role != projects.RoleOperator {
		t.Fatalf("updated viewer member = %+v, want operator", updatedViewerBody.Member)
	}

	operatorListResponse := serveMemberHTTP(handler, http.MethodGet, listPath, "", operatorCredential.Token, nil)
	requireMemberHTTPStatus(t, operatorListResponse, http.StatusOK)
	operatorGrantResponse := serveMemberHTTP(handler, http.MethodPut, grantPath, `{"role":"operator"}`, operatorCredential.Token, nil)
	requireMemberHTTPStatus(t, operatorGrantResponse, http.StatusForbidden)

	crossProjectListResponse := serveMemberHTTP(handler, http.MethodGet, "/api/v1/projects/"+url.PathEscape(projectB.ID)+"/members", "", creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, crossProjectListResponse, http.StatusNotFound)
	crossProjectGrantResponse := serveMemberHTTP(handler, http.MethodPut, "/api/v1/projects/"+url.PathEscape(projectB.ID)+"/members/"+url.PathEscape(viewerID), `{"role":"viewer"}`, creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, crossProjectGrantResponse, http.StatusForbidden)

	revokeViewerResponse := serveMemberHTTP(handler, http.MethodDelete, grantPath, "", creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, revokeViewerResponse, http.StatusNoContent)
	if revokeViewerResponse.Body.Len() != 0 {
		t.Fatalf("member revoke body = %q, want empty", revokeViewerResponse.Body.String())
	}
	operatorRevokeResponse := serveMemberHTTP(handler, http.MethodDelete, "/api/v1/projects/"+url.PathEscape(projectA.ID)+"/members/"+url.PathEscape(operatorID), "", creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, operatorRevokeResponse, http.StatusNoContent)
	finalListResponse := serveMemberHTTP(handler, http.MethodGet, listPath, "", creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, finalListResponse, http.StatusOK)
	var finalListBody struct {
		Items []projects.Member `json:"items"`
	}
	decodeMemberHTTPJSON(t, finalListResponse, &finalListBody)
	if len(finalListBody.Items) != 1 || finalListBody.Items[0].UserID != creatorID || finalListBody.Items[0].Role != projects.RoleOwner {
		t.Fatalf("member list after revocations = %+v, want owner only", finalListBody.Items)
	}

	operatorAfterRevokeResponse := serveMemberHTTP(handler, http.MethodGet, listPath, "", operatorCredential.Token, nil)
	requireMemberHTTPStatus(t, operatorAfterRevokeResponse, http.StatusNotFound)
	if err := authService.RevokeCredential(ctx, creatorPrincipal, creatorCredential.ID); err != nil {
		t.Fatalf("revoke creator credential: %v", err)
	}
	revokedCreatorResponse := serveMemberHTTP(handler, http.MethodGet, listPath, "", creatorCredential.Token, nil)
	requireMemberHTTPStatus(t, revokedCreatorResponse, http.StatusUnauthorized)

	retainedTask, err := memberTaskService.Get(ctx, creatorPrincipal, memberTask.ID)
	if err != nil {
		t.Fatalf("get task after member changes: %v", err)
	}
	if retainedTask.ProjectID != projectA.ID || retainedTask.ID != memberTask.ID {
		t.Fatalf("task after member changes = %+v", retainedTask)
	}
	var activeExecution, retainedHistory bool
	if err := pool.QueryRow(ctx, `
		SELECT active_execution, retained_history
		FROM task_execution_refs WHERE task_id = $1
	`, memberTask.ID).Scan(&activeExecution, &retainedHistory); err != nil {
		t.Fatalf("read task result protection after member changes: %v", err)
	}
	if activeExecution || !retainedHistory {
		t.Fatalf("task result protection after member changes = active:%v retained:%v", activeExecution, retainedHistory)
	}
}

type memberHTTPProvider struct {
	identity           auth.Identity
	authorizationNonce string
	exchangeCode       string
	exchangeNonce      string
	exchangeCalls      int
}

func (p *memberHTTPProvider) AuthorizationURL(state, nonce string) (string, error) {
	p.authorizationNonce = nonce
	values := url.Values{}
	values.Set("state", state)
	values.Set("nonce", nonce)
	return "https://members-http.example.test/authorize?" + values.Encode(), nil
}

func (p *memberHTTPProvider) Exchange(_ context.Context, code, nonce string) (auth.Identity, error) {
	p.exchangeCalls++
	p.exchangeCode = code
	p.exchangeNonce = nonce
	if code != "creator-code" || nonce == "" || nonce != p.authorizationNonce {
		return auth.Identity{}, errors.New("unexpected test OIDC exchange")
	}
	return p.identity, nil
}

func loginMemberHTTP(t *testing.T, handler http.Handler, cookieName string) *http.Cookie {
	t.Helper()
	startResponse := serveMemberHTTP(handler, http.MethodGet, "/auth/oidc/start", "", "", nil)
	requireMemberHTTPStatus(t, startResponse, http.StatusFound)
	startCookies := startResponse.Result().Cookies()
	if len(startCookies) != 1 || startCookies[0].Name != cookieName || startCookies[0].Value == "" || !startCookies[0].HttpOnly {
		t.Fatalf("OIDC start cookies = %+v", startCookies)
	}
	location, err := url.Parse(startResponse.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse OIDC authorization URL: %v", err)
	}
	state := location.Query().Get("state")
	nonce := location.Query().Get("nonce")
	if state == "" || nonce == "" {
		t.Fatalf("OIDC authorization URL query = %v", location.Query())
	}
	callbackValues := url.Values{}
	callbackValues.Set("state", state)
	callbackValues.Set("code", "creator-code")
	callbackResponse := serveMemberHTTP(handler, http.MethodGet, "/auth/oidc/callback?"+callbackValues.Encode(), "", "", startCookies[0])
	requireMemberHTTPStatus(t, callbackResponse, http.StatusFound)
	for _, cookie := range callbackResponse.Result().Cookies() {
		if cookie.Name == cookieName && cookie.Value != "" {
			copy := *cookie
			return &copy
		}
	}
	t.Fatalf("OIDC callback did not issue session cookie: %+v", callbackResponse.Result().Cookies())
	return nil
}

func createMemberHTTPProject(t *testing.T, handler http.Handler, cookie *http.Cookie, name string) projects.Project {
	t.Helper()
	response := serveMemberHTTP(handler, http.MethodPost, "/api/v1/projects/", fmt.Sprintf(`{"name":%q}`, name), "", cookie)
	requireMemberHTTPStatus(t, response, http.StatusCreated)
	var body struct {
		Project projects.Project `json:"project"`
	}
	decodeMemberHTTPJSON(t, response, &body)
	if body.Project.ID == "" {
		t.Fatalf("created project = %+v", body.Project)
	}
	return body.Project
}

func serveMemberHTTP(handler http.Handler, method, path, body, bearer string, cookie *http.Cookie) *httptest.ResponseRecorder {
	var request *http.Request
	if body == "" {
		request = httptest.NewRequest(method, path, nil)
	} else {
		request = httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func requireMemberHTTPStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()
	if response.Code != want {
		t.Fatalf("HTTP status = %d, want %d; body = %s", response.Code, want, response.Body.String())
	}
}

func decodeMemberHTTPJSON(t *testing.T, response *httptest.ResponseRecorder, destination any) {
	t.Helper()
	if err := json.NewDecoder(response.Body).Decode(destination); err != nil {
		t.Fatalf("decode HTTP response: %v; body = %s", err, response.Body.String())
	}
}

func cleanupMemberHTTPState(t *testing.T, ctx context.Context, pool *pgxpool.Pool, projectIDs, taskIDs []string, sessionToken string, userIDs []string) {
	t.Helper()
	if pool == nil {
		return
	}
	if sessionToken != "" {
		if _, err := pool.Exec(ctx, `DELETE FROM auth_sessions WHERE token = $1`, sessionToken); err != nil {
			t.Errorf("cleanup session: %v", err)
		}
	}
	if len(taskIDs) > 0 {
		for _, statement := range []struct {
			query string
			args  []any
		}{
			{`DELETE FROM task_parent_links WHERE parent_task_id = ANY($1::text[]) OR child_task_id = ANY($1::text[])`, []any{taskIDs}},
			{`DELETE FROM task_dependency_links WHERE prerequisite_task_id = ANY($1::text[]) OR dependent_task_id = ANY($1::text[])`, []any{taskIDs}},
			{`DELETE FROM task_execution_refs WHERE task_id = ANY($1::text[])`, []any{taskIDs}},
			{`DELETE FROM tasks WHERE id = ANY($1::text[])`, []any{taskIDs}},
		} {
			if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
				t.Errorf("cleanup query %q: %v", statement.query, err)
			}
		}
	}
	if len(projectIDs) > 0 {
		for _, statement := range []struct {
			query string
			args  []any
		}{
			{`DELETE FROM auth_api_credential_project_scopes WHERE project_id = ANY($1::text[])`, []any{projectIDs}},
			{`DELETE FROM project_members WHERE project_id = ANY($1::text[])`, []any{projectIDs}},
			{`DELETE FROM projects WHERE id = ANY($1::text[])`, []any{projectIDs}},
		} {
			if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
				t.Errorf("cleanup query %q: %v", statement.query, err)
			}
		}
	}
	if len(userIDs) > 0 {
		for _, statement := range []struct {
			query string
			args  []any
		}{
			{`DELETE FROM auth_api_credentials WHERE user_id = ANY($1::text[])`, []any{userIDs}},
			{`DELETE FROM auth_users WHERE id = ANY($1::text[])`, []any{userIDs}},
		} {
			if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
				t.Errorf("cleanup query %q: %v", statement.query, err)
			}
		}
	}
}
