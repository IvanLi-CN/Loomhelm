package projects_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/IvanLi-CN/Loomhelm/internal/tasks"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProjectDeleteRevokesOnlyLastScopedCredential(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openMembersDatabase(t, ctx)
	pool := db.Pool()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "p01_scope_delete_user_" + suffix
	projectIDs := make([]string, 0, 2)
	defer func() {
		for _, projectID := range projectIDs {
			cleanupMembersState(ctx, pool, projectID, nil)
		}
		cleanupMembersState(ctx, pool, "", []string{userID})
		db.Close()
	}()
	seedMemberUser(t, ctx, pool, userID)

	projectService := projects.NewService(pool, nil)
	principal := auth.Principal{UserID: userID}
	projectA, err := projectService.Create(ctx, principal, projects.CreateRequest{Name: "Scoped delete A"})
	if err != nil {
		t.Fatalf("create project A: %v", err)
	}
	projectIDs = append(projectIDs, projectA.ID)
	projectB, err := projectService.Create(ctx, principal, projects.CreateRequest{Name: "Scoped delete B"})
	if err != nil {
		t.Fatalf("create project B: %v", err)
	}
	projectIDs = append(projectIDs, projectB.ID)

	authService, err := auth.NewService(pool, auth.Config{}, nil)
	if err != nil {
		t.Fatalf("create auth service: %v", err)
	}
	credential, err := authService.CreateCredential(ctx, principal, auth.CreateCredentialRequest{
		Name:       "two-project deletion scope",
		ProjectIDs: []string{projectA.ID, projectB.ID},
	})
	if err != nil {
		t.Fatalf("create two-project credential: %v", err)
	}
	credentialRequest := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	credentialRequest.Header.Set("Authorization", "Bearer "+credential.Token)

	if err := projectService.Delete(ctx, principal, projectA.ID); err != nil {
		t.Fatalf("delete project A: %v", err)
	}
	resolved, err := authService.ResolvePrincipal(ctx, credentialRequest)
	if err != nil {
		t.Fatalf("resolve credential after deleting one scoped project: %v", err)
	}
	if resolved.HasProjectScope(projectA.ID) || !resolved.HasProjectScope(projectB.ID) {
		t.Fatalf("remaining credential scope = %+v, want only project B", resolved.ProjectScope)
	}

	if err := projectService.Delete(ctx, principal, projectB.ID); err != nil {
		t.Fatalf("delete project B: %v", err)
	}
	if _, err := authService.ResolvePrincipal(ctx, credentialRequest); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Fatalf("credential after deleting its final scoped project error = %v, want unauthenticated", err)
	}
}

func TestConcurrentProjectDeletionRevokesFinalCredentialScope(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openMembersDatabase(t, ctx)
	pool := db.Pool()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "p01_concurrent_scope_user_" + suffix
	projectIDs := make([]string, 0, 2)
	defer func() {
		for _, projectID := range projectIDs {
			cleanupMembersState(ctx, pool, projectID, nil)
		}
		cleanupMembersState(ctx, pool, "", []string{userID})
		db.Close()
	}()
	seedMemberUser(t, ctx, pool, userID)

	projectService := projects.NewService(pool, nil)
	principal := auth.Principal{UserID: userID}
	projectA, err := projectService.Create(ctx, principal, projects.CreateRequest{Name: "Concurrent delete A"})
	if err != nil {
		t.Fatalf("create project A: %v", err)
	}
	projectIDs = append(projectIDs, projectA.ID)
	projectB, err := projectService.Create(ctx, principal, projects.CreateRequest{Name: "Concurrent delete B"})
	if err != nil {
		t.Fatalf("create project B: %v", err)
	}
	projectIDs = append(projectIDs, projectB.ID)
	authService, err := auth.NewService(pool, auth.Config{}, nil)
	if err != nil {
		t.Fatalf("create auth service: %v", err)
	}
	credential, err := authService.CreateCredential(ctx, principal, auth.CreateCredentialRequest{
		Name:       "concurrent deletion scope",
		ProjectIDs: []string{projectA.ID, projectB.ID},
	})
	if err != nil {
		t.Fatalf("create credential: %v", err)
	}

	lockTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin credential lock: %v", err)
	}
	defer lockTx.Rollback(ctx)
	var lockedCredentialID string
	if err := lockTx.QueryRow(ctx, `SELECT id FROM auth_api_credentials WHERE id = $1 FOR UPDATE`, credential.ID).Scan(&lockedCredentialID); err != nil {
		t.Fatalf("lock credential: %v", err)
	}

	started := make(chan struct{}, 2)
	results := make(chan error, 2)
	for _, projectID := range []string{projectA.ID, projectB.ID} {
		go func(projectID string) {
			started <- struct{}{}
			results <- projectService.Delete(ctx, principal, projectID)
		}(projectID)
	}
	for range 2 {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatalf("concurrent deletion did not start: %v", ctx.Err())
		}
	}

	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		var scopeCount int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM auth_api_credential_project_scopes WHERE credential_id = $1`, credential.ID).Scan(&scopeCount); err != nil {
			t.Fatalf("count credential scopes while locked: %v", err)
		}
		if scopeCount != 2 {
			t.Fatalf("credential scopes changed before credential lock release: got %d, want 2", scopeCount)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := lockTx.Commit(ctx); err != nil {
		t.Fatalf("release credential lock: %v", err)
	}
	for range 2 {
		select {
		case err := <-results:
			if err != nil {
				t.Fatalf("concurrent project deletion: %v", err)
			}
		case <-ctx.Done():
			t.Fatalf("concurrent project deletion did not finish: %v", ctx.Err())
		}
	}

	var revoked bool
	if err := pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM auth_api_credentials WHERE id = $1`, credential.ID).Scan(&revoked); err != nil {
		t.Fatalf("read concurrent credential revocation: %v", err)
	}
	if !revoked {
		t.Fatal("concurrent final-scope deletion left credential active")
	}
}

func TestProjectDeletionSerializesCredentialIssuance(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openMembersDatabase(t, ctx)
	pool := db.Pool()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "p01_concurrent_issue_user_" + suffix
	projectID := ""
	defer func() {
		cleanupMembersState(ctx, pool, projectID, []string{userID})
		db.Close()
	}()
	seedMemberUser(t, ctx, pool, userID)

	projectService := projects.NewService(pool, nil)
	principal := auth.Principal{UserID: userID}
	project, err := projectService.Create(ctx, principal, projects.CreateRequest{Name: "Concurrent issuance"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	projectID = project.ID
	authService, err := auth.NewService(pool, auth.Config{}, nil)
	if err != nil {
		t.Fatalf("create auth service: %v", err)
	}

	lockTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin project lock: %v", err)
	}
	defer lockTx.Rollback(ctx)
	var lockedProjectID string
	if err := lockTx.QueryRow(ctx, `SELECT id FROM projects WHERE id = $1 FOR UPDATE`, project.ID).Scan(&lockedProjectID); err != nil {
		t.Fatalf("lock project: %v", err)
	}

	started := make(chan struct{}, 2)
	deleteResult := make(chan error, 1)
	credentialResult := make(chan struct {
		credential auth.Credential
		err        error
	}, 1)
	go func() {
		started <- struct{}{}
		deleteResult <- projectService.Delete(ctx, principal, project.ID)
	}()
	go func() {
		started <- struct{}{}
		credential, err := authService.CreateCredential(ctx, principal, auth.CreateCredentialRequest{
			Name:       "credential during deletion",
			ProjectIDs: []string{project.ID},
		})
		credentialResult <- struct {
			credential auth.Credential
			err        error
		}{credential: credential, err: err}
	}()
	for range 2 {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatalf("concurrent issuance/deletion did not start: %v", ctx.Err())
		}
	}
	if err := lockTx.Commit(ctx); err != nil {
		t.Fatalf("release project lock: %v", err)
	}
	var deleteErr error
	select {
	case deleteErr = <-deleteResult:
	case <-ctx.Done():
		t.Fatalf("project deletion did not finish: %v", ctx.Err())
	}
	if deleteErr != nil {
		t.Fatalf("project deletion: %v", deleteErr)
	}
	created := <-credentialResult
	if created.err == nil {
		var revoked bool
		if err := pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM auth_api_credentials WHERE id = $1`, created.credential.ID).Scan(&revoked); err != nil {
			t.Fatalf("read issued credential revocation: %v", err)
		}
		if !revoked {
			t.Fatal("credential issued during project deletion remained active")
		}
	}
	var activeUnscoped int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM auth_api_credentials AS credential
		WHERE credential.user_id = $1 AND credential.revoked_at IS NULL
		  AND NOT EXISTS (
			SELECT 1 FROM auth_api_credential_project_scopes AS scope
			WHERE scope.credential_id = credential.id
		  )
	`, userID).Scan(&activeUnscoped); err != nil {
		t.Fatalf("count active unscoped credentials: %v", err)
	}
	if activeUnscoped != 0 {
		t.Fatalf("project deletion left %d active unscoped credential(s)", activeUnscoped)
	}
}

func TestProjectMemberAuthorizationMatrix(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openMembersDatabase(t, ctx)
	pool := db.Pool()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	creatorID := "p01_member_creator_" + suffix
	viewerID := "p01_member_viewer_" + suffix
	operatorID := "p01_member_operator_" + suffix
	projectID := ""
	defer func() {
		cleanupMembersState(ctx, pool, projectID, []string{creatorID, viewerID, operatorID})
		db.Close()
	}()
	seedMemberUser(t, ctx, pool, creatorID)
	seedMemberUser(t, ctx, pool, viewerID)
	seedMemberUser(t, ctx, pool, operatorID)

	service := projects.NewService(pool, nil)
	creator := auth.Principal{UserID: creatorID}
	viewer := auth.Principal{UserID: viewerID}
	operator := auth.Principal{UserID: operatorID}
	project, err := service.Create(ctx, creator, projects.CreateRequest{Name: "Member authorization project"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	projectID = project.ID
	if _, err := service.GrantMember(ctx, creator, project.ID, projects.MemberGrantRequest{UserID: viewerID, Role: projects.RoleViewer}); err != nil {
		t.Fatalf("grant viewer: %v", err)
	}
	if _, err := service.GrantMember(ctx, creator, project.ID, projects.MemberGrantRequest{UserID: operatorID, Role: projects.RoleOperator}); err != nil {
		t.Fatalf("grant operator: %v", err)
	}
	members, err := service.ListMembers(ctx, creator, project.ID)
	if err != nil {
		t.Fatalf("list members as creator: %v", err)
	}
	if len(members) != 3 {
		t.Fatalf("member count = %d, want 3", len(members))
	}
	memberRoles := make(map[string]projects.Role, len(members))
	for _, member := range members {
		memberRoles[member.UserID] = member.Role
	}
	if memberRoles[creatorID] != projects.RoleOwner || memberRoles[viewerID] != projects.RoleViewer || memberRoles[operatorID] != projects.RoleOperator {
		t.Fatalf("member roles = %+v", memberRoles)
	}

	for _, test := range []struct {
		name       string
		principal  auth.Principal
		wantRead   bool
		wantWrite  bool
		wantManage bool
	}{
		{name: "creator", principal: creator, wantRead: true, wantWrite: true, wantManage: true},
		{name: "viewer", principal: viewer, wantRead: true, wantWrite: false, wantManage: false},
		{name: "operator", principal: operator, wantRead: true, wantWrite: true, wantManage: false},
		{name: "outsider", principal: auth.Principal{UserID: "not-a-member"}, wantRead: false, wantWrite: false, wantManage: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			read, readErr := service.CanReadProject(ctx, test.principal, project.ID)
			write, writeErr := service.CanWriteProject(ctx, test.principal, project.ID)
			manage, manageErr := service.CanManageProject(ctx, test.principal, project.ID)
			if readErr != nil || writeErr != nil || manageErr != nil {
				t.Fatalf("permission errors = %v, %v, %v", readErr, writeErr, manageErr)
			}
			if read != test.wantRead || write != test.wantWrite || manage != test.wantManage {
				t.Fatalf("permissions = read:%t write:%t manage:%t, want read:%t write:%t manage:%t", read, write, manage, test.wantRead, test.wantWrite, test.wantManage)
			}
		})
	}

	taskService := tasks.NewService(pool, nil, service)
	if _, err := taskService.Create(ctx, viewer, tasks.CreateRequest{ProjectID: project.ID, Title: "viewer task", Goal: "must be denied"}); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("viewer task creation error = %v, want not found", err)
	}
	operatorTask, err := taskService.Create(ctx, operator, tasks.CreateRequest{ProjectID: project.ID, Title: "operator task", Goal: "can be changed"})
	if err != nil {
		t.Fatalf("operator task creation: %v", err)
	}
	if _, err := taskService.Update(ctx, viewer, operatorTask.ID, tasks.UpdateRequest{Goal: stringPointer("viewer cannot change")}); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("viewer task update error = %v, want not found", err)
	}
	if _, err := taskService.Update(ctx, operator, operatorTask.ID, tasks.UpdateRequest{Goal: stringPointer("operator changed")}); err != nil {
		t.Fatalf("operator task update: %v", err)
	}
	if err := taskService.SetExecutionProtection(ctx, viewer, operatorTask.ID, true, false); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("viewer execution protection error = %v, want not found", err)
	}
	if err := taskService.SetExecutionProtection(ctx, operator, operatorTask.ID, true, false); err != nil {
		t.Fatalf("operator execution protection: %v", err)
	}

	for _, test := range []struct {
		name      string
		principal auth.Principal
	}{
		{name: "viewer", principal: viewer},
		{name: "operator", principal: operator},
	} {
		t.Run("project management "+test.name, func(t *testing.T) {
			if _, err := service.Update(ctx, test.principal, project.ID, projects.UpdateRequest{Name: stringPointer("denied project update")}); !errors.Is(err, auth.ErrNotFound) {
				t.Fatalf("project update error = %v, want not found", err)
			}
			if _, err := service.GrantMember(ctx, test.principal, project.ID, projects.MemberGrantRequest{UserID: creatorID, Role: projects.RoleViewer}); !errors.Is(err, auth.ErrForbidden) {
				t.Fatalf("member grant error = %v, want forbidden", err)
			}
			if err := service.RevokeMember(ctx, test.principal, project.ID, viewerID); !errors.Is(err, auth.ErrForbidden) {
				t.Fatalf("member revoke error = %v, want forbidden", err)
			}
		})
	}
	if err := service.Delete(ctx, operator, project.ID); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("operator project delete error = %v, want not found", err)
	}

	authService, err := auth.NewService(pool, auth.Config{}, nil)
	if err != nil {
		t.Fatalf("create auth service: %v", err)
	}
	operatorCredential, err := authService.CreateCredential(ctx, operator, auth.CreateCredentialRequest{Name: "operator project credential", ProjectIDs: []string{project.ID}})
	if err != nil {
		t.Fatalf("create operator credential: %v", err)
	}
	operatorCredentialRequest := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	operatorCredentialRequest.Header.Set("Authorization", "Bearer "+operatorCredential.Token)
	operatorCredentialPrincipal, err := authService.ResolvePrincipal(ctx, operatorCredentialRequest)
	if err != nil {
		t.Fatalf("resolve operator credential: %v", err)
	}
	if _, err := taskService.Get(ctx, operatorCredentialPrincipal, operatorTask.ID); err != nil {
		t.Fatalf("credential-backed operator task read: %v", err)
	}
	if err := service.RevokeMember(ctx, creator, project.ID, operatorID); err != nil {
		t.Fatalf("revoke operator membership: %v", err)
	}
	if _, err := taskService.Get(ctx, operatorCredentialPrincipal, operatorTask.ID); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("revoked operator membership task read error = %v, want not found", err)
	}
	if _, err := authService.CreateCredential(ctx, operatorCredentialPrincipal, auth.CreateCredentialRequest{Name: "derived after membership revoke", ProjectIDs: []string{project.ID}}); !errors.Is(err, auth.ErrForbidden) {
		t.Fatalf("derived credential after membership revoke error = %v, want forbidden", err)
	}
	if err := service.RevokeMember(ctx, creator, project.ID, viewerID); err != nil {
		t.Fatalf("revoke viewer membership: %v", err)
	}
	if err := taskService.SetExecutionProtection(ctx, creator, operatorTask.ID, false, false); err != nil {
		t.Fatalf("clear execution protection: %v", err)
	}
	if err := taskService.Delete(ctx, creator, operatorTask.ID); err != nil {
		t.Fatalf("delete matrix task: %v", err)
	}
	if err := service.Delete(ctx, creator, project.ID); err != nil {
		t.Fatalf("delete matrix project: %v", err)
	}
	if _, err := authService.ResolvePrincipal(ctx, operatorCredentialRequest); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Fatalf("credential scoped only to deleted project error = %v, want unauthenticated", err)
	}
	projectID = ""
}

func openMembersDatabase(t *testing.T, ctx context.Context) *database.DB {
	t.Helper()
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
			t.Skip("LOOMHELM_DATABASE_URL is not set")
		}
		t.Fatalf("load database configuration: %v", err)
	}
	config.MinConns = 1
	config.MaxConns = 4
	db, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: config.MinConns, MaxConns: config.MaxConns})
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		t.Fatalf("database.Migrate() error = %v", err)
	}
	return db
}

func seedMemberUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject, email, display_name)
		VALUES ($1, 'member-integration', $1, $2, $3)
	`, userID, userID+"@example.test", userID)
	if err != nil {
		t.Fatalf("seed member user %s: %v", userID, err)
	}
}

func cleanupMembersState(ctx context.Context, pool *pgxpool.Pool, projectID string, userIDs []string) {
	if pool == nil {
		return
	}
	if projectID != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM task_execution_refs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`, projectID)
		_, _ = pool.Exec(ctx, `DELETE FROM tasks WHERE project_id = $1`, projectID)
		_, _ = pool.Exec(ctx, `DELETE FROM auth_api_credential_project_scopes WHERE project_id = $1`, projectID)
		_, _ = pool.Exec(ctx, `DELETE FROM project_members WHERE project_id = $1`, projectID)
		_, _ = pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, projectID)
	}
	_, _ = pool.Exec(ctx, `DELETE FROM auth_api_credentials WHERE user_id = ANY($1::text[])`, userIDs)
	_, _ = pool.Exec(ctx, `DELETE FROM auth_users WHERE id = ANY($1::text[])`, userIDs)
}

func stringPointer(value string) *string { return &value }
