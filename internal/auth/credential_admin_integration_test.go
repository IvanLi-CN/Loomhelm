package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCredentialAdministrationIsAccountLevelAndSecretFreeOnList(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db, err := openCredentialDatabase(t, ctx)
	if err != nil {
		t.Fatalf("open credential database: %v", err)
	}
	pool := db.Pool()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	ownerID := "p01_credential_owner_" + suffix
	foreignID := "p01_credential_foreign_" + suffix
	projectID := "p01_credential_project_" + suffix
	t.Cleanup(func() {
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for _, statement := range []struct {
			query string
			args  []any
		}{
			{`DELETE FROM auth_api_credential_project_scopes WHERE project_id = $1`, []any{projectID}},
			{`DELETE FROM auth_api_credentials WHERE user_id = ANY($1::text[])`, []any{[]string{ownerID, foreignID}}},
			{`DELETE FROM project_members WHERE project_id = $1`, []any{projectID}},
			{`DELETE FROM projects WHERE id = $1`, []any{projectID}},
			{`DELETE FROM auth_users WHERE id = ANY($1::text[])`, []any{[]string{ownerID, foreignID}}},
		} {
			if _, cleanupErr := pool.Exec(cleanupContext, statement.query, statement.args...); cleanupErr != nil {
				t.Errorf("credential cleanup query %q: %v", statement.query, cleanupErr)
			}
		}
		pool.Close()
	})
	seedCredentialUser(t, ctx, pool, ownerID)
	seedCredentialUser(t, ctx, pool, foreignID)
	owner := Principal{UserID: ownerID}
	if _, err := pool.Exec(ctx, `
		INSERT INTO projects (id, name, created_by)
		VALUES ($1, 'Credential admin project', $2)
	`, projectID, ownerID); err != nil {
		t.Fatalf("create credential project: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO project_members (project_id, user_id, role)
		VALUES ($1, $2, 'owner')
	`, projectID, ownerID); err != nil {
		t.Fatalf("create credential project membership: %v", err)
	}
	authService, err := NewService(pool, Config{}, nil)
	if err != nil {
		t.Fatalf("create auth service: %v", err)
	}
	scoped, err := authService.CreateCredential(ctx, owner, CreateCredentialRequest{Name: "scoped", ProjectIDs: []string{projectID}})
	if err != nil {
		t.Fatalf("create scoped credential: %v", err)
	}
	ownerCredential, err := authService.CreateCredential(ctx, owner, CreateCredentialRequest{Name: "owner"})
	if err != nil {
		t.Fatalf("create owner credential: %v", err)
	}
	foreignCredential, err := authService.CreateCredential(ctx, Principal{UserID: foreignID}, CreateCredentialRequest{Name: "foreign"})
	if err != nil {
		t.Fatalf("create foreign credential: %v", err)
	}

	router := chi.NewRouter()
	authService.MountAPI(router)
	httpCreatedResponse := credentialHTTP(router, http.MethodPost, "/credentials", ownerCredential.Token, `{"name":"HTTP created","project_ids":[]}`)
	if httpCreatedResponse.Code != http.StatusCreated {
		t.Fatalf("HTTP credential create status = %d; body = %s", httpCreatedResponse.Code, httpCreatedResponse.Body.String())
	}
	var createdBody struct {
		Credential Credential `json:"credential"`
	}
	if err := json.NewDecoder(httpCreatedResponse.Body).Decode(&createdBody); err != nil {
		t.Fatalf("decode HTTP credential create: %v", err)
	}
	if createdBody.Credential.Token == "" || createdBody.Credential.ProjectIDs == nil {
		t.Fatalf("HTTP created credential = %+v, want secret and explicit project_ids", createdBody.Credential)
	}

	listResponse := credentialHTTP(router, http.MethodGet, "/credentials", ownerCredential.Token, "")
	if listResponse.Code != http.StatusOK {
		t.Fatalf("HTTP credential list status = %d; body = %s", listResponse.Code, listResponse.Body.String())
	}
	listBodyText := listResponse.Body.String()
	for _, secret := range []string{ownerCredential.Token, scoped.Token, foreignCredential.Token, createdBody.Credential.Token} {
		if strings.Contains(listBodyText, secret) {
			t.Fatalf("credential list leaked token %q", secret)
		}
	}
	var listBody struct {
		Items []Credential `json:"items"`
	}
	if err := json.Unmarshal([]byte(listBodyText), &listBody); err != nil {
		t.Fatalf("decode HTTP credential list: %v", err)
	}
	if listBody.Items == nil || len(listBody.Items) < 3 {
		t.Fatalf("credential list items = %+v, want account credentials", listBody.Items)
	}
	for _, item := range listBody.Items {
		if item.Token != "" || item.ProjectIDs == nil {
			t.Fatalf("listed credential = %+v, want no token and explicit project_ids", item)
		}
	}

	scopedList := credentialHTTP(router, http.MethodGet, "/credentials", scoped.Token, "")
	if scopedList.Code != http.StatusForbidden {
		t.Fatalf("scoped credential list status = %d, want %d; body = %s", scopedList.Code, http.StatusForbidden, scopedList.Body.String())
	}
	scopedRevoke := credentialHTTP(router, http.MethodDelete, "/credentials/"+ownerCredential.ID, scoped.Token, "")
	if scopedRevoke.Code != http.StatusForbidden {
		t.Fatalf("scoped credential revoke status = %d, want %d; body = %s", scopedRevoke.Code, http.StatusForbidden, scopedRevoke.Body.String())
	}
	for _, credentialID := range []string{scoped.ID, scoped.ID} {
		response := credentialHTTP(router, http.MethodDelete, "/credentials/"+credentialID, ownerCredential.Token, "")
		if response.Code != http.StatusNoContent {
			t.Fatalf("account credential revoke status = %d, want %d; body = %s", response.Code, http.StatusNoContent, response.Body.String())
		}
	}
	for _, credentialID := range []string{foreignCredential.ID, "missing-credential"} {
		response := credentialHTTP(router, http.MethodDelete, "/credentials/"+credentialID, ownerCredential.Token, "")
		if response.Code != http.StatusNotFound {
			t.Fatalf("foreign/unknown credential revoke status = %d, want %d; body = %s", response.Code, http.StatusNotFound, response.Body.String())
		}
	}

	emptyList, err := authService.ListCredentials(ctx, Principal{UserID: "p01_credential_empty_" + suffix})
	if err != nil {
		t.Fatalf("list credentials for empty account: %v", err)
	}
	if emptyList == nil || len(emptyList) != 0 {
		t.Fatalf("empty account credential list = %+v, want non-nil empty slice", emptyList)
	}
}

func openCredentialDatabase(t *testing.T, ctx context.Context) (*database.DB, error) {
	t.Helper()
	db, err := database.Open(ctx, authDatabaseConfigForTest(t))
	if err != nil {
		return nil, err
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func seedCredentialUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject, email, display_name)
		VALUES ($1, 'credential-integration', $1, $2, $3)
	`, userID, userID+"@example.test", userID); err != nil {
		t.Fatalf("seed credential user %s: %v", userID, err)
	}
}

func credentialHTTP(router http.Handler, method, path, bearer, body string) *httptest.ResponseRecorder {
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
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
