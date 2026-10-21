package tasks_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/IvanLi-CN/Loomhelm/internal/tasks"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskPaginationDoesNotSkipLookaheadRow(t *testing.T) {
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
	userID := "p01_task_page_user_" + suffix
	projectIDs := make([]string, 0, 1)
	taskIDs := make([]string, 0, 3)
	cleanupDomainState(t, &cleanupPool, &projectIDs, &taskIDs, []string{userID})
	seedUser(t, ctx, cleanupPool, userID)

	projectService := projects.NewService(cleanupPool, nil)
	taskService := tasks.NewService(cleanupPool, nil, projectService)
	principal := auth.Principal{UserID: userID}
	project, err := projectService.Create(ctx, principal, projects.CreateRequest{Name: "Task pagination project"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	projectIDs = append(projectIDs, project.ID)
	for index := 0; index < 3; index++ {
		task, err := taskService.Create(ctx, principal, tasks.CreateRequest{
			ProjectID: project.ID,
			Title:     fmt.Sprintf("Page task %d", index),
			Goal:      fmt.Sprintf("page goal %d", index),
		})
		if err != nil {
			t.Fatalf("create task %d: %v", index, err)
		}
		taskIDs = append(taskIDs, task.ID)
	}

	first, next, err := taskService.List(ctx, principal, project.ID, tasks.Cursor{}, 2)
	if err != nil {
		t.Fatalf("list first task page: %v", err)
	}
	if len(first) != 2 || next == nil {
		t.Fatalf("first task page = %d items, cursor %+v; want 2 items and cursor", len(first), next)
	}
	if next.ID != first[len(first)-1].ID {
		t.Fatalf("next task cursor = %+v, want last returned task %s", next, first[len(first)-1].ID)
	}

	second, finalCursor, err := taskService.List(ctx, principal, project.ID, *next, 2)
	if err != nil {
		t.Fatalf("list second task page: %v", err)
	}
	if len(second) != 1 || finalCursor != nil {
		t.Fatalf("second task page = %d items, cursor %+v; want 1 item and no cursor", len(second), finalCursor)
	}
	seen := map[string]struct{}{}
	for _, task := range append(first, second...) {
		seen[task.ID] = struct{}{}
	}
	if len(seen) != 3 {
		t.Fatalf("paginated task IDs = %v, want all 3 tasks", seen)
	}
}

func TestTaskPartialUpdatesPreserveConcurrentFields(t *testing.T) {
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
	userID := "p01_task_patch_user_" + suffix
	projectIDs := make([]string, 0, 1)
	taskIDs := make([]string, 0, 1)
	cleanupDomainState(t, &cleanupPool, &projectIDs, &taskIDs, []string{userID})
	seedUser(t, ctx, cleanupPool, userID)

	projectService := projects.NewService(cleanupPool, nil)
	taskService := tasks.NewService(cleanupPool, nil, projectService)
	principal := auth.Principal{UserID: userID}
	project, err := projectService.Create(ctx, principal, projects.CreateRequest{Name: "Task patch project"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	projectIDs = append(projectIDs, project.ID)
	task, err := taskService.Create(ctx, principal, tasks.CreateRequest{
		ProjectID: project.ID,
		Title:     "Original title",
		Goal:      "Original goal",
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	taskIDs = append(taskIDs, task.ID)
	newTitle := "Concurrent title"
	newStatus := tasks.StatusDone
	results := make(chan error, 2)
	start := make(chan struct{})
	var group sync.WaitGroup
	group.Add(2)
	go func() {
		defer group.Done()
		<-start
		_, updateErr := taskService.Update(ctx, principal, task.ID, tasks.UpdateRequest{Title: &newTitle})
		results <- updateErr
	}()
	go func() {
		defer group.Done()
		<-start
		_, updateErr := taskService.Update(ctx, principal, task.ID, tasks.UpdateRequest{Status: &newStatus})
		results <- updateErr
	}()
	close(start)
	group.Wait()
	close(results)
	for updateErr := range results {
		if updateErr != nil {
			t.Fatalf("concurrent task patch: %v", updateErr)
		}
	}
	updated, err := taskService.Get(ctx, principal, task.ID)
	if err != nil {
		t.Fatalf("read concurrently patched task: %v", err)
	}
	if updated.Title != newTitle || updated.Status != newStatus || updated.Goal != task.Goal {
		t.Fatalf("concurrently patched task = %+v, want title %q, status %q, goal %q", updated, newTitle, newStatus, task.Goal)
	}
}

func TestTaskSessionBindingMigrationIsIdempotentAndUnique(t *testing.T) {
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
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("re-run migrations: %v", err)
	}
	var unique bool
	var predicate string
	if err := cleanupPool.QueryRow(ctx, `
		SELECT indexrelid::regclass::text, indisunique, pg_get_expr(indpred, indrelid)
		FROM pg_index
		WHERE indexrelid::regclass::text = 'tasks_session_id_unique_idx'
	`).Scan(new(string), &unique, &predicate); err != nil {
		t.Fatalf("read task session binding index: %v", err)
	}
	if !unique || !strings.Contains(strings.ToLower(predicate), "session_id") {
		t.Fatalf("task session binding index unique=%v predicate=%q", unique, predicate)
	}

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "p01_session_binding_user_" + suffix
	projectIDs := make([]string, 0, 1)
	taskIDs := make([]string, 0, 2)
	cleanupDomainState(t, &cleanupPool, &projectIDs, &taskIDs, []string{userID})
	seedUser(t, ctx, cleanupPool, userID)
	projectService := projects.NewService(cleanupPool, nil)
	taskService := tasks.NewService(cleanupPool, nil, projectService)
	principal := auth.Principal{UserID: userID}
	project, err := projectService.Create(ctx, principal, projects.CreateRequest{Name: "Session binding project"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	projectIDs = append(projectIDs, project.ID)
	first, err := taskService.Create(ctx, principal, tasks.CreateRequest{ProjectID: project.ID, Title: "Session task one"})
	if err != nil {
		t.Fatalf("create first session task: %v", err)
	}
	taskIDs = append(taskIDs, first.ID)
	second, err := taskService.Create(ctx, principal, tasks.CreateRequest{ProjectID: project.ID, Title: "Session task two"})
	if err != nil {
		t.Fatalf("create second session task: %v", err)
	}
	taskIDs = append(taskIDs, second.ID)
	sessionID := "p01_session_" + suffix
	if _, err := cleanupPool.Exec(ctx, `UPDATE tasks SET session_id = $1 WHERE id = $2`, sessionID, first.ID); err != nil {
		t.Fatalf("bind first task session: %v", err)
	}
	_, err = cleanupPool.Exec(ctx, `UPDATE tasks SET session_id = $1 WHERE id = $2`, sessionID, second.ID)
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) || pgError.Code != "23505" {
		t.Fatalf("duplicate task session error = %v, want PostgreSQL unique violation", err)
	}
}
