package tasks_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/IvanLi-CN/Loomhelm/internal/tasks"
)

func TestTaskDeleteAndExecutionProtectionAreSerialized(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openDomainDatabase(t, ctx)
	pool := db.Pool()
	cleanupPool := pool
	t.Cleanup(func() {
		if cleanupPool != nil {
			cleanupPool.Close()
			cleanupPool = nil
		}
	})

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "p01_protection_race_user_" + suffix
	projectIDs := make([]string, 0, 1)
	taskIDs := make([]string, 0, 1)
	cleanupDomainState(t, &cleanupPool, &projectIDs, &taskIDs, []string{userID})
	seedUser(t, ctx, pool, userID)

	projectService := projects.NewService(pool, nil)
	taskService := tasks.NewService(pool, nil, projectService)
	principal := auth.Principal{UserID: userID}
	project, err := projectService.Create(ctx, principal, projects.CreateRequest{Name: "Protection race project"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	projectIDs = append(projectIDs, project.ID)
	task, err := taskService.Create(ctx, principal, tasks.CreateRequest{
		ProjectID: project.ID,
		Title:     "Protection race task",
		Goal:      "serialize deletion and protection updates",
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	taskIDs = append(taskIDs, task.ID)

	lockTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin task lock: %v", err)
	}
	defer lockTx.Rollback(ctx)
	var lockedTaskID string
	if err := lockTx.QueryRow(ctx, `SELECT id FROM tasks WHERE id = $1 FOR UPDATE`, task.ID).Scan(&lockedTaskID); err != nil {
		t.Fatalf("lock task: %v", err)
	}

	started := make(chan struct{}, 2)
	deleteResult := make(chan error, 1)
	protectionResult := make(chan error, 1)
	go func() {
		started <- struct{}{}
		deleteResult <- taskService.Delete(ctx, principal, task.ID)
	}()
	go func() {
		started <- struct{}{}
		protectionResult <- taskService.SetExecutionProtection(ctx, principal, task.ID, true, false)
	}()
	for range 2 {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatalf("task race did not start: %v", ctx.Err())
		}
	}
	time.Sleep(250 * time.Millisecond)
	if err := lockTx.Commit(ctx); err != nil {
		t.Fatalf("release task lock: %v", err)
	}

	var deleteErr, protectionErr error
	select {
	case deleteErr = <-deleteResult:
	case <-ctx.Done():
		t.Fatalf("task deletion did not finish: %v", ctx.Err())
	}
	select {
	case protectionErr = <-protectionResult:
	case <-ctx.Done():
		t.Fatalf("execution protection update did not finish: %v", ctx.Err())
	}

	switch {
	case protectionErr == nil:
		if !errors.Is(deleteErr, auth.ErrConflict) {
			t.Fatalf("protection update succeeded with deletion error = %v, want conflict", deleteErr)
		}
		var active bool
		if err := pool.QueryRow(ctx, `SELECT active_execution FROM task_execution_refs WHERE task_id = $1`, task.ID).Scan(&active); err != nil {
			t.Fatalf("read retained execution protection: %v", err)
		}
		if !active {
			t.Fatal("successful execution protection update was not retained")
		}
	case errors.Is(protectionErr, auth.ErrNotFound):
		if deleteErr != nil {
			t.Fatalf("task deletion error = %v after protection lost task, want nil", deleteErr)
		}
		var taskCount int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE id = $1`, task.ID).Scan(&taskCount); err != nil {
			t.Fatalf("count deleted task: %v", err)
		}
		if taskCount != 0 {
			t.Fatalf("deleted task count = %d, want 0", taskCount)
		}
	default:
		t.Fatalf("execution protection error = %v, want nil or not found", protectionErr)
	}
}

func TestRelationshipsAuthorizationReadsDoNotScaleWithEdges(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openDomainDatabase(t, ctx)
	cleanupPool := db.Pool()
	t.Cleanup(func() {
		if cleanupPool != nil {
			cleanupPool.Close()
			cleanupPool = nil
		}
	})

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "p01_relationship_reads_user_" + suffix
	projectIDs := make([]string, 0, 1)
	taskIDs := make([]string, 0, 1+3)
	cleanupDomainState(t, &cleanupPool, &projectIDs, &taskIDs, []string{userID})
	seedUser(t, ctx, cleanupPool, userID)

	projectService := projects.NewService(cleanupPool, nil)
	taskService := tasks.NewService(cleanupPool, nil, projectService)
	principal := auth.Principal{UserID: userID}
	project, err := projectService.Create(ctx, principal, projects.CreateRequest{Name: "Relationship read project"})
	if err != nil {
		t.Fatalf("create relationship read project: %v", err)
	}
	projectIDs = append(projectIDs, project.ID)
	root, err := taskService.Create(ctx, principal, tasks.CreateRequest{ProjectID: project.ID, Title: "Relationship root"})
	if err != nil {
		t.Fatalf("create relationship root: %v", err)
	}
	taskIDs = append(taskIDs, root.ID)
	for index := 0; index < 3; index++ {
		related, createErr := taskService.Create(ctx, principal, tasks.CreateRequest{
			ProjectID: project.ID,
			Title:     fmt.Sprintf("Relationship related %d", index),
		})
		if createErr != nil {
			t.Fatalf("create related task %d: %v", index, createErr)
		}
		taskIDs = append(taskIDs, related.ID)
		if err := taskService.AddParent(ctx, principal, related.ID, root.ID); err != nil {
			t.Fatalf("add parent relationship %d: %v", index, err)
		}
		if err := taskService.AddDependency(ctx, principal, related.ID, root.ID); err != nil {
			t.Fatalf("add dependency relationship %d: %v", index, err)
		}
	}

	before := cleanupPool.Stat().AcquireCount()
	page, err := taskService.Relationships(ctx, principal, root.ID)
	if err != nil {
		t.Fatalf("read relationships: %v", err)
	}
	acquires := cleanupPool.Stat().AcquireCount() - before
	if len(page.Children) != 3 || len(page.Dependents) != 3 {
		t.Fatalf("relationship page = %+v, want three children and dependents", page)
	}
	if acquires != 4 {
		t.Fatalf("relationship read acquired %d pool connections for six same-project edges, want 4 (task, root authorization, two edge reads); the old per-edge authorization baseline is 10", acquires)
	}
}

func TestRelationshipsRespectScopedProjectsAndMembershipRevocation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openDomainDatabase(t, ctx)
	cleanupPool := db.Pool()
	t.Cleanup(func() {
		if cleanupPool != nil {
			cleanupPool.Close()
			cleanupPool = nil
		}
	})

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	ownerID := "p01_relationship_scope_owner_" + suffix
	viewerID := "p01_relationship_scope_viewer_" + suffix
	projectIDs := make([]string, 0, 2)
	taskIDs := make([]string, 0, 3)
	cleanupDomainState(t, &cleanupPool, &projectIDs, &taskIDs, []string{ownerID, viewerID})
	seedUser(t, ctx, cleanupPool, ownerID)
	seedUser(t, ctx, cleanupPool, viewerID)

	projectService := projects.NewService(cleanupPool, nil)
	authService, err := auth.NewService(cleanupPool, auth.Config{}, nil)
	if err != nil {
		t.Fatalf("create auth service: %v", err)
	}
	taskService := tasks.NewService(cleanupPool, nil, projectService)
	owner := auth.Principal{UserID: ownerID}
	projectA, err := projectService.Create(ctx, owner, projects.CreateRequest{Name: "Relationship scope A"})
	if err != nil {
		t.Fatalf("create project A: %v", err)
	}
	projectIDs = append(projectIDs, projectA.ID)
	projectB, err := projectService.Create(ctx, owner, projects.CreateRequest{Name: "Relationship scope B"})
	if err != nil {
		t.Fatalf("create project B: %v", err)
	}
	projectIDs = append(projectIDs, projectB.ID)

	root, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectA.ID, Title: "Scoped relationship root"})
	if err != nil {
		t.Fatalf("create scoped relationship root: %v", err)
	}
	taskIDs = append(taskIDs, root.ID)
	sameProject, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectA.ID, Title: "Same project related"})
	if err != nil {
		t.Fatalf("create same-project related task: %v", err)
	}
	taskIDs = append(taskIDs, sameProject.ID)
	crossProject, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectB.ID, Title: "Cross project related"})
	if err != nil {
		t.Fatalf("create cross-project related task: %v", err)
	}
	taskIDs = append(taskIDs, crossProject.ID)
	for _, relatedID := range []string{sameProject.ID, crossProject.ID} {
		if err := taskService.AddParent(ctx, owner, relatedID, root.ID); err != nil {
			t.Fatalf("add parent relationship for %s: %v", relatedID, err)
		}
		if err := taskService.AddDependency(ctx, owner, relatedID, root.ID); err != nil {
			t.Fatalf("add dependency relationship for %s: %v", relatedID, err)
		}
	}

	ownerPage, err := taskService.Relationships(ctx, owner, root.ID)
	if err != nil {
		t.Fatalf("read owner relationships: %v", err)
	}
	if len(ownerPage.Children) != 2 || len(ownerPage.Dependents) != 2 {
		t.Fatalf("owner relationship page = %+v, want both project endpoints", ownerPage)
	}

	credential, err := authService.CreateCredential(ctx, owner, auth.CreateCredentialRequest{
		Name:       "relationship project A scope",
		ProjectIDs: []string{projectA.ID},
	})
	if err != nil {
		t.Fatalf("create scoped credential: %v", err)
	}
	credentialRequest := httptest.NewRequest(http.MethodGet, "/tasks/"+root.ID+"/relationships", nil)
	credentialRequest.Header.Set("Authorization", "Bearer "+credential.Token)
	scopedPrincipal, err := authService.ResolvePrincipal(ctx, credentialRequest)
	if err != nil {
		t.Fatalf("resolve scoped credential: %v", err)
	}
	scopedPage, err := taskService.Relationships(ctx, scopedPrincipal, root.ID)
	if err != nil {
		t.Fatalf("read scoped relationships: %v", err)
	}
	if len(scopedPage.Children) != 1 || scopedPage.Children[0].ChildTaskID != sameProject.ID || len(scopedPage.Dependents) != 1 || scopedPage.Dependents[0].DependentTaskID != sameProject.ID {
		t.Fatalf("scoped relationship page = %+v, want only project A endpoint", scopedPage)
	}

	if _, err := projectService.GrantMember(ctx, owner, projectA.ID, projects.MemberGrantRequest{UserID: viewerID, Role: projects.RoleViewer}); err != nil {
		t.Fatalf("grant viewer membership: %v", err)
	}
	viewer := auth.Principal{UserID: viewerID}
	if _, err := taskService.Relationships(ctx, viewer, root.ID); err != nil {
		t.Fatalf("read relationships before viewer revoke: %v", err)
	}
	if err := projectService.RevokeMember(ctx, owner, projectA.ID, viewerID); err != nil {
		t.Fatalf("revoke viewer membership: %v", err)
	}
	if _, err := taskService.Relationships(ctx, viewer, root.ID); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("read relationships after viewer revoke = %v, want not found", err)
	}
}
