package tasks_test

import (
	"context"
	"errors"
	"fmt"
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
