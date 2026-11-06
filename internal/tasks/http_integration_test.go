package tasks_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/IvanLi-CN/Loomhelm/internal/tasks"
	"github.com/go-chi/chi/v5"
)

type staticTaskPrincipalResolver struct {
	principal auth.Principal
}

func (r *staticTaskPrincipalResolver) ResolvePrincipal(_ context.Context, _ *http.Request) (auth.Principal, error) {
	if r.principal.UserID == "" {
		return auth.Principal{}, auth.ErrUnauthenticated
	}
	return r.principal, nil
}

func TestTaskHTTPCRUDRelationshipsAndRequiredGoal(t *testing.T) {
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
	userID := "p01_task_http_user_" + suffix
	projectIDs := make([]string, 0, 1)
	taskIDs := make([]string, 0, 2)
	cleanupDomainState(t, &cleanupPool, &projectIDs, &taskIDs, []string{userID})
	seedUser(t, ctx, cleanupPool, userID)

	projectService := projects.NewService(cleanupPool, nil)
	project, err := projectService.Create(ctx, auth.Principal{UserID: userID}, projects.CreateRequest{Name: "Task HTTP project"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	projectIDs = append(projectIDs, project.ID)
	resolver := &staticTaskPrincipalResolver{principal: auth.Principal{UserID: userID}}
	taskService := tasks.NewService(cleanupPool, resolver, projectService)
	router := chi.NewRouter()
	taskService.Mount(router)

	missingGoal := taskHTTPRequest(router, http.MethodPost, "/tasks", fmt.Sprintf(`{"project_id":%q,"title":"Missing goal"}`, project.ID))
	if missingGoal.Code != http.StatusBadRequest {
		t.Fatalf("missing goal status = %d, want %d; body = %s", missingGoal.Code, http.StatusBadRequest, missingGoal.Body.String())
	}

	first := createHTTPTask(t, router, project.ID, "HTTP parent", "")
	taskIDs = append(taskIDs, first.ID)
	second := createHTTPTask(t, router, project.ID, "HTTP child", "child goal")
	taskIDs = append(taskIDs, second.ID)
	exactTaskID := "task_" + fmt.Sprintf("%032x", time.Now().UnixNano())
	exactTaskResponse := taskHTTPRequest(router, http.MethodPost, "/tasks", fmt.Sprintf(`{"id":%q,"project_id":%q,"title":"Exact HTTP task","goal":"exact goal"}`, exactTaskID, project.ID))
	requireTaskHTTPStatus(t, exactTaskResponse, http.StatusCreated)
	var exactTaskBody struct {
		Task tasks.Task `json:"task"`
	}
	decodeTaskHTTPJSON(t, exactTaskResponse, &exactTaskBody)
	if exactTaskBody.Task.ID != exactTaskID || exactTaskBody.Task.Title != "Exact HTTP task" {
		t.Fatalf("exact task response = %+v", exactTaskBody.Task)
	}
	taskIDs = append(taskIDs, exactTaskID)
	duplicateTaskResponse := taskHTTPRequest(router, http.MethodPost, "/tasks", fmt.Sprintf(`{"id":%q,"project_id":%q,"title":"Must not overwrite","goal":"changed goal"}`, exactTaskID, project.ID))
	requireTaskHTTPStatus(t, duplicateTaskResponse, http.StatusConflict)
	exactTaskGet := taskHTTPRequest(router, http.MethodGet, "/tasks/"+exactTaskID, "")
	requireTaskHTTPStatus(t, exactTaskGet, http.StatusOK)
	decodeTaskHTTPJSON(t, exactTaskGet, &exactTaskBody)
	if exactTaskBody.Task.Title != "Exact HTTP task" || exactTaskBody.Task.Goal != "exact goal" {
		t.Fatalf("duplicate task changed stored task = %+v", exactTaskBody.Task)
	}
	for _, payload := range []string{
		fmt.Sprintf(`{"id":null,"project_id":%q,"title":"Null task","goal":"goal"}`, project.ID),
		fmt.Sprintf(`{"id":"","project_id":%q,"title":"Empty task","goal":"goal"}`, project.ID),
		fmt.Sprintf(`{"id":"task_not-a-valid-id","project_id":%q,"title":"Malformed task","goal":"goal"}`, project.ID),
	} {
		response := taskHTTPRequest(router, http.MethodPost, "/tasks", payload)
		requireTaskHTTPStatus(t, response, http.StatusBadRequest)
	}

	getResponse := taskHTTPRequest(router, http.MethodGet, "/tasks/"+first.ID, "")
	requireTaskHTTPStatus(t, getResponse, http.StatusOK)
	var getBody struct {
		Task tasks.Task `json:"task"`
	}
	decodeTaskHTTPJSON(t, getResponse, &getBody)
	if getBody.Task.ID != first.ID || getBody.Task.Goal != "" {
		t.Fatalf("GET task = %+v, want task %s with empty goal", getBody.Task, first.ID)
	}

	listResponse := taskHTTPRequest(router, http.MethodGet, "/tasks?project_id="+project.ID+"&limit=1", "")
	requireTaskHTTPStatus(t, listResponse, http.StatusOK)
	var listBody struct {
		Items      []tasks.Task `json:"items"`
		HasMore    bool         `json:"has_more"`
		NextCursor string       `json:"next_cursor"`
	}
	decodeTaskHTTPJSON(t, listResponse, &listBody)
	if len(listBody.Items) != 1 || !listBody.HasMore || listBody.NextCursor == "" {
		t.Fatalf("task list response = %+v, want one item with next cursor", listBody)
	}

	patchResponse := taskHTTPRequest(router, http.MethodPatch, "/tasks/"+first.ID, `{"status":"done"}`)
	requireTaskHTTPStatus(t, patchResponse, http.StatusOK)
	var patchBody struct {
		Task tasks.Task `json:"task"`
	}
	decodeTaskHTTPJSON(t, patchResponse, &patchBody)
	if patchBody.Task.Title != first.Title || patchBody.Task.Goal != first.Goal || patchBody.Task.Status != tasks.StatusDone {
		t.Fatalf("PATCH task = %+v, want title/goal preserved and done status", patchBody.Task)
	}

	parentPath := "/tasks/" + second.ID + "/parents/" + first.ID
	addParentResponse := taskHTTPRequest(router, http.MethodPost, parentPath, "")
	requireTaskHTTPStatus(t, addParentResponse, http.StatusNoContent)
	relationshipsResponse := taskHTTPRequest(router, http.MethodGet, "/tasks/"+first.ID+"/relationships", "")
	requireTaskHTTPStatus(t, relationshipsResponse, http.StatusOK)
	var relationshipBody tasks.RelationshipPage
	decodeTaskHTTPJSON(t, relationshipsResponse, &relationshipBody)
	if len(relationshipBody.Children) != 1 || relationshipBody.Children[0].ChildTaskID != second.ID {
		t.Fatalf("parent relationship response = %+v", relationshipBody)
	}
	removeParentResponse := taskHTTPRequest(router, http.MethodDelete, parentPath, "")
	requireTaskHTTPStatus(t, removeParentResponse, http.StatusNoContent)

	if response := taskHTTPRequest(router, http.MethodDelete, "/tasks/"+second.ID, ""); response.Code != http.StatusNoContent {
		t.Fatalf("delete child status = %d; body = %s", response.Code, response.Body.String())
	}
	if response := taskHTTPRequest(router, http.MethodDelete, "/tasks/"+first.ID, ""); response.Code != http.StatusNoContent {
		t.Fatalf("delete parent status = %d; body = %s", response.Code, response.Body.String())
	}

	resolver.principal = auth.Principal{}
	unauthorized := taskHTTPRequest(router, http.MethodGet, "/tasks", "")
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized task list status = %d, want %d", unauthorized.Code, http.StatusUnauthorized)
	}
}

func createHTTPTask(t *testing.T, router http.Handler, projectID, title, goal string) tasks.Task {
	t.Helper()
	response := taskHTTPRequest(router, http.MethodPost, "/tasks", fmt.Sprintf(`{"project_id":%q,"title":%q,"goal":%q}`, projectID, title, goal))
	requireTaskHTTPStatus(t, response, http.StatusCreated)
	var body struct {
		Task tasks.Task `json:"task"`
	}
	decodeTaskHTTPJSON(t, response, &body)
	if body.Task.ID == "" {
		t.Fatalf("created HTTP task = %+v", body.Task)
	}
	return body.Task
}

func taskHTTPRequest(router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	var request *http.Request
	if body == "" {
		request = httptest.NewRequest(method, path, nil)
	} else {
		request = httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func requireTaskHTTPStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()
	if response.Code != want {
		t.Fatalf("task HTTP status = %d, want %d; body = %s", response.Code, want, response.Body.String())
	}
}

func decodeTaskHTTPJSON(t *testing.T, response *httptest.ResponseRecorder, destination any) {
	t.Helper()
	if err := json.NewDecoder(response.Body).Decode(destination); err != nil {
		t.Fatalf("decode task HTTP response: %v; body = %s", err, response.Body.String())
	}
}
