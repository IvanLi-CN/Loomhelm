package projects_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
)

func TestProjectPaginationDoesNotSkipLookaheadRow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openMembersDatabase(t, ctx)
	pool := db.Pool()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "p01_project_page_user_" + suffix
	projectIDs := make([]string, 0, 3)
	defer func() {
		for _, projectID := range projectIDs {
			cleanupMembersState(t, ctx, pool, projectID, nil)
		}
		cleanupMembersState(t, ctx, pool, "", []string{userID})
		db.Close()
	}()
	seedMemberUser(t, ctx, pool, userID)

	service := projects.NewService(pool, nil)
	principal := auth.Principal{UserID: userID}
	for index := 0; index < 3; index++ {
		project, err := service.Create(ctx, principal, projects.CreateRequest{Name: fmt.Sprintf("Page project %d", index)})
		if err != nil {
			t.Fatalf("create project %d: %v", index, err)
		}
		projectIDs = append(projectIDs, project.ID)
	}

	first, next, err := service.List(ctx, principal, projects.Cursor{}, 2)
	if err != nil {
		t.Fatalf("list first project page: %v", err)
	}
	if len(first) != 2 || next == nil {
		t.Fatalf("first project page = %d items, cursor %+v; want 2 items and cursor", len(first), next)
	}
	if next.ID != first[len(first)-1].ID {
		t.Fatalf("next project cursor = %+v, want last returned project %s", next, first[len(first)-1].ID)
	}

	second, finalCursor, err := service.List(ctx, principal, *next, 2)
	if err != nil {
		t.Fatalf("list second project page: %v", err)
	}
	if len(second) != 1 || finalCursor != nil {
		t.Fatalf("second project page = %d items, cursor %+v; want 1 item and no cursor", len(second), finalCursor)
	}
	seen := map[string]struct{}{}
	for _, project := range append(first, second...) {
		seen[project.ID] = struct{}{}
	}
	if len(seen) != 3 {
		t.Fatalf("paginated project IDs = %v, want all 3 projects", seen)
	}
}
