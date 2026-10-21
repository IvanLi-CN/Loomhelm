package tasks_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/IvanLi-CN/Loomhelm/internal/tasks"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDomainPersistenceAuthorizationAndRelationships(t *testing.T) {
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
	ownerID := "p01_owner_" + suffix
	outsiderID := "p01_outsider_" + suffix
	projectIDs := make([]string, 0, 2)
	taskIDs := make([]string, 0, 8)
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
	cycleA, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectA.ID, Title: "Cycle A"})
	if err != nil {
		t.Fatalf("create cycle A task: %v", err)
	}
	taskIDs = append(taskIDs, cycleA.ID)
	cycleB, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectB.ID, Title: "Cycle B"})
	if err != nil {
		t.Fatalf("create cycle B task: %v", err)
	}
	taskIDs = append(taskIDs, cycleB.ID)
	cycleC, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectA.ID, Title: "Cycle C"})
	if err != nil {
		t.Fatalf("create cycle C task: %v", err)
	}
	taskIDs = append(taskIDs, cycleC.ID)
	reverseLeft, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectA.ID, Title: "Reverse Left"})
	if err != nil {
		t.Fatalf("create reverse left task: %v", err)
	}
	taskIDs = append(taskIDs, reverseLeft.ID)
	reverseRight, err := taskService.Create(ctx, owner, tasks.CreateRequest{ProjectID: projectB.ID, Title: "Reverse Right"})
	if err != nil {
		t.Fatalf("create reverse right task: %v", err)
	}
	taskIDs = append(taskIDs, reverseRight.ID)

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
	assertExecutionProtection := func(taskID string, wantActive, wantRetained bool) {
		t.Helper()
		var active, retained bool
		if err := cleanupPool.QueryRow(ctx, `
			SELECT active_execution, retained_history
			FROM task_execution_refs WHERE task_id = $1
		`, taskID).Scan(&active, &retained); err != nil {
			t.Fatalf("read execution protection for %s: %v", taskID, err)
		}
		if active != wantActive || retained != wantRetained {
			t.Fatalf("execution protection for %s = active:%v retained:%v, want active:%v retained:%v", taskID, active, retained, wantActive, wantRetained)
		}
	}
	assertExecutionProtection(parent.ID, false, false)
	assertExecutionProtection(child.ID, false, false)

	if err := taskService.AddParent(ctx, owner, cycleB.ID, cycleA.ID); err != nil {
		t.Fatalf("add first three-node parent edge: %v", err)
	}
	if err := taskService.AddParent(ctx, owner, cycleC.ID, cycleB.ID); err != nil {
		t.Fatalf("add second three-node parent edge: %v", err)
	}
	if err := taskService.AddParent(ctx, owner, cycleA.ID, cycleC.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("three-node parent cycle error = %v, want conflict", err)
	}
	if err := taskService.RemoveParent(ctx, owner, cycleC.ID, cycleB.ID); err != nil {
		t.Fatalf("remove second three-node parent edge: %v", err)
	}
	if err := taskService.RemoveParent(ctx, owner, cycleB.ID, cycleA.ID); err != nil {
		t.Fatalf("remove first three-node parent edge: %v", err)
	}
	if err := taskService.AddDependency(ctx, owner, cycleB.ID, cycleA.ID); err != nil {
		t.Fatalf("add first three-node dependency edge: %v", err)
	}
	if err := taskService.AddDependency(ctx, owner, cycleC.ID, cycleB.ID); err != nil {
		t.Fatalf("add second three-node dependency edge: %v", err)
	}
	if err := taskService.AddDependency(ctx, owner, cycleA.ID, cycleC.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("three-node dependency cycle error = %v, want conflict", err)
	}
	if err := taskService.RemoveDependency(ctx, owner, cycleC.ID, cycleB.ID); err != nil {
		t.Fatalf("remove second three-node dependency edge: %v", err)
	}
	if err := taskService.RemoveDependency(ctx, owner, cycleB.ID, cycleA.ID); err != nil {
		t.Fatalf("remove first three-node dependency edge: %v", err)
	}

	concurrentReverse := func(mutate func(string, string) error) []error {
		lockTx, err := cleanupPool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin relationship barrier: %v", err)
		}
		if _, err := lockTx.Exec(ctx, `SELECT pg_advisory_lock($1)`, int64(0x4c6f6f6d7461736b)); err != nil {
			lockTx.Rollback(ctx)
			t.Fatalf("acquire relationship barrier: %v", err)
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		go func() {
			<-start
			results <- mutate(reverseLeft.ID, reverseRight.ID)
		}()
		go func() {
			<-start
			results <- mutate(reverseRight.ID, reverseLeft.ID)
		}()
		close(start)
		deadline := time.Now().Add(5 * time.Second)
		for {
			var waiters int
			if err := cleanupPool.QueryRow(ctx, `
				SELECT COUNT(*)
				FROM pg_stat_activity
				WHERE wait_event_type = 'Lock'
				  AND query LIKE '%pg_advisory_xact_lock%'
			`).Scan(&waiters); err != nil {
				lockTx.Exec(ctx, `SELECT pg_advisory_unlock($1)`, int64(0x4c6f6f6d7461736b))
				lockTx.Rollback(ctx)
				t.Fatalf("observe relationship barrier: %v", err)
			}
			if waiters == 2 {
				break
			}
			if time.Now().After(deadline) {
				lockTx.Exec(ctx, `SELECT pg_advisory_unlock($1)`, int64(0x4c6f6f6d7461736b))
				lockTx.Rollback(ctx)
				t.Fatalf("relationship mutations did not both wait on advisory lock; observed %d", waiters)
			}
			time.Sleep(10 * time.Millisecond)
		}
		if _, err := lockTx.Exec(ctx, `SELECT pg_advisory_unlock($1)`, int64(0x4c6f6f6d7461736b)); err != nil {
			lockTx.Rollback(ctx)
			t.Fatalf("release relationship barrier: %v", err)
		}
		if err := lockTx.Commit(ctx); err != nil {
			t.Fatalf("commit relationship barrier: %v", err)
		}
		return []error{<-results, <-results}
	}
	assertOneSuccessOneConflict := func(label string, results []error) {
		t.Helper()
		successes, conflicts := 0, 0
		for _, err := range results {
			switch {
			case err == nil:
				successes++
			case errors.Is(err, auth.ErrConflict):
				conflicts++
			default:
				t.Fatalf("%s concurrent mutation error = %v, want nil or conflict", label, err)
			}
		}
		if successes != 1 || conflicts != 1 {
			t.Fatalf("%s concurrent mutation results = successes:%d conflicts:%d, want one of each", label, successes, conflicts)
		}
	}
	parentResults := concurrentReverse(func(firstID, secondID string) error {
		return taskService.AddParent(ctx, owner, firstID, secondID)
	})
	assertOneSuccessOneConflict("parent", parentResults)
	var storedParent, storedChild string
	if err := cleanupPool.QueryRow(ctx, `
		SELECT parent_task_id, child_task_id
		FROM task_parent_links
		WHERE (parent_task_id = $1 AND child_task_id = $2)
		   OR (parent_task_id = $2 AND child_task_id = $1)
	`, reverseLeft.ID, reverseRight.ID).Scan(&storedParent, &storedChild); err != nil {
		t.Fatalf("read concurrent parent edge: %v", err)
	}
	if err := taskService.RemoveParent(ctx, owner, storedChild, storedParent); err != nil {
		t.Fatalf("remove concurrent parent edge: %v", err)
	}
	dependencyResults := concurrentReverse(func(firstID, secondID string) error {
		return taskService.AddDependency(ctx, owner, firstID, secondID)
	})
	assertOneSuccessOneConflict("dependency", dependencyResults)
	var storedPrerequisite, storedDependent string
	if err := cleanupPool.QueryRow(ctx, `
		SELECT prerequisite_task_id, dependent_task_id
		FROM task_dependency_links
		WHERE (prerequisite_task_id = $1 AND dependent_task_id = $2)
		   OR (prerequisite_task_id = $2 AND dependent_task_id = $1)
	`, reverseLeft.ID, reverseRight.ID).Scan(&storedPrerequisite, &storedDependent); err != nil {
		t.Fatalf("read concurrent dependency edge: %v", err)
	}
	if err := taskService.RemoveDependency(ctx, owner, storedDependent, storedPrerequisite); err != nil {
		t.Fatalf("remove concurrent dependency edge: %v", err)
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
	if _, err := authService.CreateCredential(ctx, scopedPrincipal, auth.CreateCredentialRequest{Name: "empty scoped credential"}); !errors.Is(err, auth.ErrForbidden) {
		t.Fatalf("empty scoped credential error = %v, want forbidden", err)
	}
	if _, err := authService.CreateCredential(ctx, scopedPrincipal, auth.CreateCredentialRequest{Name: "superset scoped credential", ProjectIDs: []string{projectA.ID, projectB.ID}}); !errors.Is(err, auth.ErrForbidden) {
		t.Fatalf("superset scoped credential error = %v, want forbidden", err)
	}
	credentialRouter := chi.NewRouter()
	authService.MountAPI(credentialRouter)
	emptyCredentialRequest := httptest.NewRequest(http.MethodPost, "/credentials/", strings.NewReader(`{"name":"empty HTTP credential","project_ids":[]}`))
	emptyCredentialRequest.Header.Set("Authorization", "Bearer "+credential.Token)
	emptyCredentialResponse := httptest.NewRecorder()
	credentialRouter.ServeHTTP(emptyCredentialResponse, emptyCredentialRequest)
	if emptyCredentialResponse.Code != http.StatusForbidden {
		t.Fatalf("empty scoped HTTP credential status = %d, want %d", emptyCredentialResponse.Code, http.StatusForbidden)
	}
	projectRouter := chi.NewRouter()
	projects.NewService(cleanupPool, authService).Mount(projectRouter)
	limitedProjectRequest := httptest.NewRequest(http.MethodPost, "/projects/", strings.NewReader(`{"name":"denied scoped project"}`))
	limitedProjectRequest.Header.Set("Authorization", "Bearer "+credential.Token)
	limitedProjectResponse := httptest.NewRecorder()
	projectRouter.ServeHTTP(limitedProjectResponse, limitedProjectRequest)
	if limitedProjectResponse.Code != http.StatusForbidden {
		t.Fatalf("limited HTTP project creation status = %d, want %d", limitedProjectResponse.Code, http.StatusForbidden)
	}
	if _, err := projectService.Create(ctx, scopedPrincipal, projects.CreateRequest{Name: "denied scoped project"}); !errors.Is(err, auth.ErrForbidden) {
		t.Fatalf("limited project creation error = %v, want forbidden", err)
	}
	wideCredential, err := authService.CreateCredential(ctx, owner, auth.CreateCredentialRequest{Name: "wide project scope", ProjectIDs: []string{projectA.ID, projectB.ID}})
	if err != nil {
		t.Fatalf("create wide credential: %v", err)
	}
	wideRequest := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	wideRequest.Header.Set("Authorization", "Bearer "+wideCredential.Token)
	widePrincipal, err := authService.ResolvePrincipal(ctx, wideRequest)
	if err != nil {
		t.Fatalf("resolve wide credential: %v", err)
	}
	subsetCredential, err := authService.CreateCredential(ctx, widePrincipal, auth.CreateCredentialRequest{Name: "subset project scope", ProjectIDs: []string{projectA.ID}})
	if err != nil {
		t.Fatalf("create subset credential from wide credential: %v", err)
	}
	ownerCredential, err := authService.CreateCredential(ctx, owner, auth.CreateCredentialRequest{Name: "owner management credential"})
	if err != nil {
		t.Fatalf("create owner management credential: %v", err)
	}
	revokeRequest := httptest.NewRequest(http.MethodDelete, "/credentials/"+subsetCredential.ID, nil)
	revokeRequest.Header.Set("Authorization", "Bearer "+ownerCredential.Token)
	revokeResponse := httptest.NewRecorder()
	credentialRouter.ServeHTTP(revokeResponse, revokeRequest)
	if revokeResponse.Code != http.StatusNoContent {
		t.Fatalf("HTTP revoke credential status = %d, want %d", revokeResponse.Code, http.StatusNoContent)
	}
	subsetRequest := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	subsetRequest.Header.Set("Authorization", "Bearer "+subsetCredential.Token)
	if _, err := authService.ResolvePrincipal(ctx, subsetRequest); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Fatalf("HTTP-revoked subset credential error = %v, want unauthenticated", err)
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

	beforeRelatedParent, err := reopenedTasks.Get(ctx, owner, parent.ID)
	if err != nil {
		t.Fatalf("get related task before rejected delete: %v", err)
	}
	beforeRelatedPage, err := reopenedTasks.Relationships(ctx, owner, parent.ID)
	if err != nil {
		t.Fatalf("get relationships before rejected delete: %v", err)
	}
	if err := reopenedTasks.Delete(ctx, owner, parent.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("delete related task error = %v, want conflict", err)
	}
	afterRelatedParent, err := reopenedTasks.Get(ctx, owner, parent.ID)
	if err != nil {
		t.Fatalf("get related task after rejected delete: %v", err)
	}
	afterRelatedPage, err := reopenedTasks.Relationships(ctx, owner, parent.ID)
	if err != nil {
		t.Fatalf("get relationships after rejected delete: %v", err)
	}
	if !reflect.DeepEqual(beforeRelatedParent, afterRelatedParent) || !reflect.DeepEqual(beforeRelatedPage, afterRelatedPage) {
		t.Fatalf("rejected related-task delete changed state: before task=%+v page=%+v after task=%+v page=%+v", beforeRelatedParent, beforeRelatedPage, afterRelatedParent, afterRelatedPage)
	}
	if err := reopenedTasks.RemoveParent(ctx, owner, child.ID, parent.ID); err != nil {
		t.Fatalf("remove parent relationship: %v", err)
	}
	if err := reopenedTasks.RemoveDependency(ctx, owner, child.ID, parent.ID); err != nil {
		t.Fatalf("remove dependency relationship: %v", err)
	}
	if err := reopenedTasks.SetExecutionProtection(ctx, owner, parent.ID, true, false); err != nil {
		t.Fatalf("set active execution protection: %v", err)
	}
	beforeActiveParent, err := reopenedTasks.Get(ctx, owner, parent.ID)
	if err != nil {
		t.Fatalf("get active task before rejected delete: %v", err)
	}
	if err := reopenedTasks.Delete(ctx, owner, parent.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("delete actively executing task error = %v, want conflict", err)
	}
	afterActiveParent, err := reopenedTasks.Get(ctx, owner, parent.ID)
	if err != nil {
		t.Fatalf("get active task after rejected delete: %v", err)
	}
	if !reflect.DeepEqual(beforeActiveParent, afterActiveParent) {
		t.Fatalf("rejected active-task delete changed task: before=%+v after=%+v", beforeActiveParent, afterActiveParent)
	}
	assertExecutionProtectionAfterReopen(t, ctx, reopened.Pool(), parent.ID, true, false)
	if err := reopenedTasks.SetExecutionProtection(ctx, owner, parent.ID, false, false); err != nil {
		t.Fatalf("clear execution protection: %v", err)
	}
	if err := reopenedTasks.SetExecutionProtection(ctx, owner, parent.ID, false, true); err != nil {
		t.Fatalf("set retained history protection: %v", err)
	}
	beforeRetainedParent, err := reopenedTasks.Get(ctx, owner, parent.ID)
	if err != nil {
		t.Fatalf("get retained task before rejected delete: %v", err)
	}
	if err := reopenedTasks.Delete(ctx, owner, parent.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("delete task with retained history error = %v, want conflict", err)
	}
	afterRetainedParent, err := reopenedTasks.Get(ctx, owner, parent.ID)
	if err != nil {
		t.Fatalf("get retained task after rejected delete: %v", err)
	}
	if !reflect.DeepEqual(beforeRetainedParent, afterRetainedParent) {
		t.Fatalf("rejected retained-history delete changed task: before=%+v after=%+v", beforeRetainedParent, afterRetainedParent)
	}
	assertExecutionProtectionAfterReopen(t, ctx, reopened.Pool(), parent.ID, false, true)
	if err := reopenedTasks.SetExecutionProtection(ctx, owner, parent.ID, false, false); err != nil {
		t.Fatalf("clear retained history protection: %v", err)
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
	for _, extraTask := range []tasks.Task{cycleA, cycleB, cycleC, reverseLeft, reverseRight} {
		if err := reopenedTasks.Delete(ctx, owner, extraTask.ID); err != nil {
			t.Fatalf("delete relationship test task %s: %v", extraTask.ID, err)
		}
	}
	projectBBefore, err := reopenedProjects.Get(ctx, owner, projectB.ID)
	if err != nil {
		t.Fatalf("get project B before rejected delete: %v", err)
	}
	tasksBBefore, _, err := reopenedTasks.List(ctx, owner, projectB.ID, tasks.Cursor{}, 10)
	if err != nil {
		t.Fatalf("list project B before rejected delete: %v", err)
	}
	if err := reopenedProjects.Delete(ctx, owner, projectB.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("delete project with tasks error = %v, want conflict", err)
	}
	projectBAfter, err := reopenedProjects.Get(ctx, owner, projectB.ID)
	if err != nil {
		t.Fatalf("get project B after rejected delete: %v", err)
	}
	tasksBAfter, _, err := reopenedTasks.List(ctx, owner, projectB.ID, tasks.Cursor{}, 10)
	if err != nil {
		t.Fatalf("list project B after rejected delete: %v", err)
	}
	if !reflect.DeepEqual(projectBBefore, projectBAfter) || !reflect.DeepEqual(tasksBBefore, tasksBAfter) {
		t.Fatalf("rejected project delete changed state: before project=%+v tasks=%+v after project=%+v tasks=%+v", projectBBefore, tasksBBefore, projectBAfter, tasksBAfter)
	}
	if err := reopenedTasks.Delete(ctx, owner, child.ID); err != nil {
		t.Fatalf("delete child task: %v", err)
	}
	if err := reopenedTasks.SetExecutionProtection(ctx, owner, unrelated.ID, true, true); err != nil {
		t.Fatalf("set cancellation execution protection: %v", err)
	}
	cancelledTask, err := reopenedTasks.Update(ctx, owner, unrelated.ID, tasks.UpdateRequest{Status: taskStatus(tasks.StatusCancelled)})
	if err != nil {
		t.Fatalf("cancel protected task: %v", err)
	}
	if cancelledTask.Status != tasks.StatusCancelled {
		t.Fatalf("cancelled task status = %q, want %q", cancelledTask.Status, tasks.StatusCancelled)
	}
	if _, err := reopenedTasks.Get(ctx, owner, unrelated.ID); err != nil {
		t.Fatalf("read cancelled task history: %v", err)
	}
	assertExecutionProtectionAfterReopen(t, ctx, reopened.Pool(), unrelated.ID, true, true)
	if err := reopenedTasks.Delete(ctx, owner, unrelated.ID); !errors.Is(err, auth.ErrConflict) {
		t.Fatalf("delete cancelled task with retained history error = %v, want conflict", err)
	}
	if err := reopenedTasks.SetExecutionProtection(ctx, owner, unrelated.ID, false, false); err != nil {
		t.Fatalf("clear cancelled task protection: %v", err)
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

func assertExecutionProtectionAfterReopen(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID string, wantActive, wantRetained bool) {
	t.Helper()
	var active, retained bool
	if err := pool.QueryRow(ctx, `
		SELECT active_execution, retained_history
		FROM task_execution_refs WHERE task_id = $1
	`, taskID).Scan(&active, &retained); err != nil {
		t.Fatalf("read execution protection for %s: %v", taskID, err)
	}
	if active != wantActive || retained != wantRetained {
		t.Fatalf("execution protection for %s = active:%v retained:%v, want active:%v retained:%v", taskID, active, retained, wantActive, wantRetained)
	}
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
		statements := []struct {
			query string
			args  []any
		}{
			{`DELETE FROM task_parent_links WHERE parent_task_id = ANY($1::text[]) OR child_task_id = ANY($1::text[])`, []any{*taskIDs}},
			{`DELETE FROM task_dependency_links WHERE prerequisite_task_id = ANY($1::text[]) OR dependent_task_id = ANY($1::text[])`, []any{*taskIDs}},
			{`DELETE FROM task_execution_refs WHERE task_id = ANY($1::text[])`, []any{*taskIDs}},
			{`DELETE FROM tasks WHERE id = ANY($1::text[])`, []any{*taskIDs}},
			{`DELETE FROM auth_api_credential_project_scopes WHERE project_id = ANY($1::text[])`, []any{*projectIDs}},
			{`DELETE FROM auth_api_credentials WHERE user_id = ANY($1::text[])`, []any{userIDs}},
			{`DELETE FROM project_members WHERE project_id = ANY($1::text[]) OR user_id = ANY($2::text[])`, []any{*projectIDs, userIDs}},
			{`DELETE FROM projects WHERE id = ANY($1::text[])`, []any{*projectIDs}},
			{`DELETE FROM auth_users WHERE id = ANY($1::text[])`, []any{userIDs}},
		}
		for _, statement := range statements {
			if _, err := (*pool).Exec(ctx, statement.query, statement.args...); err != nil {
				t.Errorf("cleanup query %q: %v", statement.query, err)
			}
		}
	})
}
