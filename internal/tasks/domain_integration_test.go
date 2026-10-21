package tasks_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
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

func TestDomainPersistenceAuthorizationAndRelationships(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	db := openDomainDatabase(t, ctx)
	cleanupPool := db.Pool()
	defer db.Close()

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	ownerID := "p01_owner_" + suffix
	outsiderID := "p01_outsider_" + suffix
	projectIDs := make([]string, 0, 2)
	taskIDs := make([]string, 0, 3)
	cleanupDomainState(t, &cleanupPool, &projectIDs, &taskIDs, []string{ownerID, outsiderID})
	seedUser(t, ctx, cleanupPool, ownerID)
	seedUser(t, ctx, cleanupPool, outsiderID)

	projectService := projects.NewService(cleanupPool, nil)
	taskService := tasks.NewService(cleanupPool, nil, projectService)
	authService, err := auth.NewService(cleanupPool, auth.Config{}, nil)
	if err != nil {
		t.Fatalf("auth.NewService() error = %v", err)
	}
	owner := auth.Principal{UserID: ownerID}

	projectA, err := projectService.Create(ctx, owner, projects.CreateRequest{Name: "Project A", Description: "initial"})
	if err != nil {
		t.Fatalf("create project A: %v", err)
	}
	projectIDs = append(projectIDs, projectA.ID)
	projectB, err := projectService.Create(ctx, owner, projects.CreateRequest{Name: "Project B"})
	if err != nil {
		t.Fatalf("create project B: %v", err)
	}
	projectIDs = append(projectIDs, projectB.ID)

	description := "updated"
	updatedProject, err := projectService.Update(ctx, owner, projectA.ID, projects.UpdateRequest{Description: &description})
	if err != nil {
		t.Fatalf("update project A: %v", err)
	}
	if updatedProject.Description != description {
		t.Fatalf("updated project description = %q, want %q", updatedProject.Description, description)
	}
	listedProjects, _, err := projectService.List(ctx, owner, projects.Cursor{}, 10)
	if err != nil {
		t.Fatalf("list projects: %v", err)
	}
	if len(listedProjects) != 2 {
		t.Fatalf("listed project count = %d, want 2", len(listedProjects))
	}

	parent, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectA.ID, Title: "Parent", Goal: "parent goal"})
	if err != nil {
		t.Fatalf("create parent task: %v", err)
	}
	taskIDs = append(taskIDs, parent.ID)
	child, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectB.ID, Title: "Child", Goal: "child goal", Status: taskStatus(tasks.StatusInProgress)})
	if err != nil {
		t.Fatalf("create child task: %v", err)
	}
	taskIDs = append(taskIDs, child.ID)
	unrelated, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectB.ID, Title: "Unrelated", Goal: "unrelated goal"})
	if err != nil {
		t.Fatalf("create unrelated task: %v", err)
	}
	taskIDs = append(taskIDs, unrelated.ID)

	if got, err := taskService.Get(ctx, owner, parent.ID); err != nil || got.ID != parent.ID {
		t.Fatalf("get parent task = %+v, error = %v", got, err)
	}
	goal := "revised goal"
	updatedTask, err := taskService.Update(ctx, owner, child.ID, tasks.UpdateRequest{Goal: &goal})
	if err != nil {
		t.Fatalf("update child task: %v", err)
	}
	if updatedTask.Goal != goal || updatedTask.Status != tasks.StatusInProgress {
		t.Fatalf("updated child task = %+v", updatedTask)
	}
	listedTasks, _, err := taskService.List(ctx, owner, projectB.ID, tasks.Cursor{}, 10)
	if err != nil {
		t.Fatalf("list project B tasks: %v", err)
	}
	if len(listedTasks) != 2 {
		t.Fatalf("listed project B task count = %d, want 2", len(listedTasks))
	}

	if err := taskService.AddParent(ctx, owner, child.ID, parent.ID); err != nil {
		t.Fatalf("add parent relationship: %v", err)
	}
	if err := taskService.AddDependency(ctx, owner, child.ID, parent.ID); err != nil {
		t.Fatalf("add dependency relationship: %v", err)
	}
	if err := taskService.AddParent(ctx, owner, parent.ID, parent.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("self parent relationship error = %v, want conflict", err)
	}
	if err := taskService.AddDependency(ctx, owner, parent.ID, parent.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("self dependency relationship error = %v, want conflict", err)
	}
	if err := taskService.AddParent(ctx, owner, parent.ID, child.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("parent cycle error = %v, want conflict", err)
	}
	if err := taskService.AddDependency(ctx, owner, parent.ID, child.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("dependency cycle error = %v, want conflict", err)
	}

	page, err := taskService.Relationships(ctx, owner, parent.ID)
	if err != nil {
		t.Fatalf("list parent relationships: %v", err)
	}
	if len(page.Children) != 1 || len(page.Dependents) != 1 || page.Children[0].Kind != "parent_child" || page.Dependents[0].Kind != "prerequisite" {
		t.Fatalf("unexpected parent relationships: %+v", page)
	}
	emptyPage, err := taskService.Relationships(ctx, owner, unrelated.ID)
	if err != nil {
		t.Fatalf("list empty relationships: %v", err)
	}
	if emptyPage.Parents == nil || emptyPage.Children == nil || emptyPage.Prerequisites == nil || emptyPage.Dependents == nil {
		t.Fatalf("empty relationship arrays must be non-nil: %+v", emptyPage)
	}
	encodedPage, err := json.Marshal(emptyPage)
	if err != nil {
		t.Fatalf("marshal empty relationships: %v", err)
	}
	if !strings.Contains(string(encodedPage), `"parents":[]`) {
		t.Fatalf("empty relationships JSON = %s, want empty arrays", encodedPage)
	}

	credential, err := authService.CreateCredential(ctx, owner, auth.CreateCredentialRequest{Name: "project A", ProjectIDs: []string{projectA.ID}})
	if err != nil {
		t.Fatalf("create scoped credential: %v", err)
	}
	var storedHash []byte
	if err := cleanupPool.QueryRow(ctx, `SELECT token_hash FROM auth_api_credentials WHERE id = $1`, credential.ID).Scan(&storedHash); err != nil {
		t.Fatalf("read stored credential hash: %v", err)
	}
	wantHash := sha256.Sum256([]byte(credential.Token))
	if string(storedHash) != string(wantHash[:]) {
		t.Fatalf("stored credential is not the SHA-256 token hash")
	}
	credentialRequest := httptest.NewRequest("GET", "/api/v1/projects", nil)
	credentialRequest.Header.Set("Authorization", "Bearer "+credential.Token)
	scopedPrincipal, err := authService.ResolvePrincipal(ctx, credentialRequest)
	if err != nil {
		t.Fatalf("resolve scoped credential: %v", err)
	}
	if scopedPrincipal.UserID != ownerID || scopedPrincipal.CredentialID != credential.ID || !scopedPrincipal.HasProjectScope(projectA.ID) || scopedPrincipal.HasProjectScope(projectB.ID) {
		t.Fatalf("resolved scoped principal = %+v", scopedPrincipal)
	}
	if _, err := projectService.Get(ctx, scopedPrincipal, projectB.ID); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("scoped project B read error = %v, want not found", err)
	}
	if _, err := taskService.Get(ctx, scopedPrincipal, child.ID); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("scoped child read error = %v, want not found", err)
	}
	if err := taskService.AddParent(ctx, scopedPrincipal, child.ID, parent.ID); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("scoped cross-project relationship error = %v, want not found", err)
	}
	filteredPage, err := taskService.Relationships(ctx, scopedPrincipal, parent.ID)
	if err != nil {
		t.Fatalf("list scoped relationships: %v", err)
	}
	if len(filteredPage.Children) != 0 || len(filteredPage.Dependents) != 0 {
		t.Fatalf("scoped relationship page leaked cross-project links: %+v", filteredPage)
	}
	if err := authService.RevokeCredential(ctx, owner, credential.ID); err != nil {
		t.Fatalf("revoke credential: %v", err)
	}
	if _, err := authService.ResolvePrincipal(ctx, credentialRequest); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Fatalf("revoked credential error = %v, want unauthenticated", err)
	}
	outsider := auth.Principal{UserID: outsiderID}
	if _, err := projectService.Get(ctx, outsider, projectA.ID); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("outsider project read error = %v, want not found", err)
	}

	db.Close()
	reopened, err := database.Open(ctx, databaseConfigForDomainTest(t))
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	defer reopened.Close()
	cleanupPool = reopened.Pool()
	if err := reopened.Migrate(ctx); err != nil {
		t.Fatalf("migrate after reopen: %v", err)
	}
	reopenedProjects := projects.NewService(reopened.Pool(), nil)
	reopenedTasks := tasks.NewService(reopened.Pool(), nil, reopenedProjects)
	if got, err := reopenedProjects.Get(ctx, owner, projectA.ID); err != nil || got.Description != description {
		t.Fatalf("project after reopen = %+v, error = %v", got, err)
	}
	if got, err := reopenedTasks.Get(ctx, owner, parent.ID); err != nil || got.ID != parent.ID {
		t.Fatalf("task after reopen = %+v, error = %v", got, err)
	}
	reopenedPage, err := reopenedTasks.Relationships(ctx, owner, parent.ID)
	if err != nil {
		t.Fatalf("relationships after reopen: %v", err)
	}
	if len(reopenedPage.Children) != 1 || len(reopenedPage.Dependents) != 1 {
		t.Fatalf("relationships after reopen = %+v", reopenedPage)
	}

	if err := reopenedTasks.Delete(ctx, owner, parent.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("delete related task error = %v, want conflict", err)
	}
	if err := reopenedTasks.SetExecutionProtection(ctx, owner, parent.ID, true, false); err != nil {
		t.Fatalf("set active execution protection: %v", err)
	}
	if err := reopenedTasks.RemoveParent(ctx, owner, child.ID, parent.ID); err != nil {
		t.Fatalf("remove parent relationship: %v", err)
	}
	if err := reopenedTasks.RemoveDependency(ctx, owner, child.ID, parent.ID); err != nil {
		t.Fatalf("remove dependency relationship: %v", err)
	}
	if err := reopenedTasks.Delete(ctx, owner, parent.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("delete actively executing task error = %v, want conflict", err)
	}
	if err := reopenedTasks.SetExecutionProtection(ctx, owner, parent.ID, false, false); err != nil {
		t.Fatalf("clear execution protection: %v", err)
	}
	if _, err := reopened.Pool().Exec(ctx, `UPDATE tasks SET session_id = 'session-p01' WHERE id = $1`, parent.ID); err != nil {
		t.Fatalf("set task session id: %v", err)
	}
	if err := reopenedTasks.Delete(ctx, owner, parent.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("delete session-bound task error = %v, want conflict", err)
	}
	if _, err := reopened.Pool().Exec(ctx, `UPDATE tasks SET session_id = NULL WHERE id = $1`, parent.ID); err != nil {
		t.Fatalf("clear task session id: %v", err)
	}
	if err := reopenedTasks.Delete(ctx, owner, parent.ID); err != nil {
		t.Fatalf("delete unprotected task: %v", err)
	}
	if err := reopenedProjects.Delete(ctx, owner, projectB.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("delete project with tasks error = %v, want conflict", err)
	}
	if err := reopenedTasks.Delete(ctx, owner, child.ID); err != nil {
		t.Fatalf("delete child task: %v", err)
	}
	if err := reopenedTasks.Delete(ctx, owner, unrelated.ID); err != nil {
		t.Fatalf("delete unrelated task: %v", err)
	}
	if err := reopenedProjects.Delete(ctx, owner, projectB.ID); err != nil {
		t.Fatalf("delete project B: %v", err)
	}
	if err := reopenedProjects.Delete(ctx, owner, projectA.ID); err != nil {
		t.Fatalf("delete project A: %v", err)
	}
}

func taskStatus(status tasks.Status) *tasks.Status {
	return &status
}

func openDomainDatabase(t *testing.T, ctx context.Context) *database.DB {
	t.Helper()
	db, err := database.Open(ctx, databaseConfigForDomainTest(t))
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		t.Fatalf("database.Migrate() error = %v", err)
	}
	return db
}

func databaseConfigForDomainTest(t *testing.T) database.Config {
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
	return database.Config{URL: config.URL, MinConns: config.MinConns, MaxConns: config.MaxConns}
}

func seedUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject, email, display_name)
		VALUES ($1, 'integration', $1, $2, $3)
	`, userID, userID+"@example.test", userID)
	if err != nil {
		t.Fatalf("seed user %s: %v", userID, err)
	}
}

func cleanupDomainState(t *testing.T, pool **pgxpool.Pool, projectIDs *[]string, taskIDs *[]string, userIDs []string) {
	t.Helper()
	t.Cleanup(func() {
		if pool == nil || *pool == nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = (*pool).Exec(ctx, `DELETE FROM task_parent_links WHERE parent_task_id = ANY($1::text[]) OR child_task_id = ANY($1::text[])`, *taskIDs)
		_, _ = (*pool).Exec(ctx, `DELETE FROM task_dependency_links WHERE prerequisite_task_id = ANY($1::text[]) OR dependent_task_id = ANY($1::text[])`, *taskIDs)
		_, _ = (*pool).Exec(ctx, `DELETE FROM task_execution_refs WHERE task_id = ANY($1::text[])`, *taskIDs)
		_, _ = (*pool).Exec(ctx, `DELETE FROM tasks WHERE id = ANY($1::text[])`, *taskIDs)
		_, _ = (*pool).Exec(ctx, `DELETE FROM auth_api_credential_project_scopes WHERE project_id = ANY($1::text[])`, *projectIDs)
		_, _ = (*pool).Exec(ctx, `DELETE FROM auth_api_credentials WHERE user_id = ANY($1::text[])`, userIDs)
		_, _ = (*pool).Exec(ctx, `DELETE FROM project_members WHERE project_id = ANY($1::text[]) OR user_id = ANY($2::text[])`, *projectIDs, userIDs)
		_, _ = (*pool).Exec(ctx, `DELETE FROM projects WHERE id = ANY($1::text[])`, *projectIDs)
		_, _ = (*pool).Exec(ctx, `DELETE FROM auth_users WHERE id = ANY($1::text[])`, userIDs)
	})
}
