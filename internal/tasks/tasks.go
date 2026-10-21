// Package tasks owns task persistence, project-scoped authorization, and the
// distinct parent/child and prerequisite relationship services.
package tasks

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Status string

const (
	StatusTodo       Status = "todo"
	StatusInProgress Status = "in_progress"
	StatusBlocked    Status = "blocked"
	StatusDone       Status = "done"
	StatusCancelled  Status = "cancelled"
)

type Task struct {
	ID        string  `json:"id"`
	ProjectID string  `json:"project_id"`
	Title     string  `json:"title"`
	Goal      string  `json:"goal"`
	Status    Status  `json:"status"`
	SessionID *string `json:"session_id,omitempty"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

type CreateRequest struct {
	ProjectID string  `json:"project_id"`
	Title     string  `json:"title"`
	Goal      string  `json:"goal"`
	Status    *Status `json:"status,omitempty"`
}

type UpdateRequest struct {
	Title  *string `json:"title,omitempty"`
	Goal   *string `json:"goal,omitempty"`
	Status *Status `json:"status,omitempty"`
}

type Relationship struct {
	Kind            string `json:"kind"`
	ParentTaskID    string `json:"parent_task_id,omitempty"`
	ChildTaskID     string `json:"child_task_id,omitempty"`
	PrerequisiteID  string `json:"prerequisite_task_id,omitempty"`
	DependentTaskID string `json:"dependent_task_id,omitempty"`
	CreatedAt       string `json:"created_at"`
}

type RelationshipPage struct {
	Parents       []Relationship `json:"parents"`
	Children      []Relationship `json:"children"`
	Prerequisites []Relationship `json:"prerequisites"`
	Dependents    []Relationship `json:"dependents"`
}

type Service struct {
	pool      *pgxpool.Pool
	principal auth.PrincipalResolver
	authorize projects.Authorizer
	now       func() time.Time
}

const relationAdvisoryLock int64 = 0x4c6f6f6d7461736b

func NewService(pool *pgxpool.Pool, principal auth.PrincipalResolver, authorize projects.Authorizer) *Service {
	return &Service{pool: pool, principal: principal, authorize: authorize, now: time.Now}
}

func (s *Service) Mount(r chi.Router) {
	r.Route("/tasks", func(tasks chi.Router) {
		tasks.Get("/", s.handleList)
		tasks.Post("/", s.handleCreate)
		tasks.Get("/{task_id}", s.handleGet)
		tasks.Patch("/{task_id}", s.handleUpdate)
		tasks.Delete("/{task_id}", s.handleDelete)
		tasks.Get("/{task_id}/relationships", s.handleRelationships)
		tasks.Post("/{task_id}/parents/{parent_task_id}", s.handleAddParent)
		tasks.Delete("/{task_id}/parents/{parent_task_id}", s.handleRemoveParent)
		tasks.Post("/{task_id}/dependencies/{prerequisite_task_id}", s.handleAddDependency)
		tasks.Delete("/{task_id}/dependencies/{prerequisite_task_id}", s.handleRemoveDependency)
	})
}

func (s *Service) Create(ctx context.Context, principal auth.Principal, request CreateRequest) (Task, error) {
	if principal.UserID == "" {
		return Task{}, auth.ErrUnauthenticated
	}
	if s == nil || s.pool == nil || s.authorize == nil {
		return Task{}, errors.New("task service dependencies are not configured")
	}
	if strings.TrimSpace(request.ProjectID) == "" {
		return Task{}, fmt.Errorf("%w: project_id is required", auth.ErrInvalid)
	}
	allowed, err := s.authorize.CanWriteProject(ctx, principal, request.ProjectID)
	if err != nil {
		return Task{}, fmt.Errorf("authorize task creation: %w", err)
	}
	if !allowed {
		return Task{}, auth.ErrNotFound
	}
	title := strings.TrimSpace(request.Title)
	if title == "" || len(title) > 300 {
		return Task{}, fmt.Errorf("%w: task title must be between 1 and 300 characters", auth.ErrInvalid)
	}
	status := StatusTodo
	if request.Status != nil {
		status = *request.Status
	}
	if !validStatus(status) {
		return Task{}, fmt.Errorf("%w: unsupported task status", auth.ErrInvalid)
	}
	id, err := newID("task")
	if err != nil {
		return Task{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Task{}, fmt.Errorf("begin task transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	var task Task
	var createdAt, updatedAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO tasks (id, project_id, title, goal, status)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, project_id, title, goal, status, session_id, created_at, updated_at
	`, id, request.ProjectID, title, strings.TrimSpace(request.Goal), status).Scan(
		&task.ID, &task.ProjectID, &task.Title, &task.Goal, &task.Status, &task.SessionID, &createdAt, &updatedAt,
	)
	if err != nil {
		return Task{}, fmt.Errorf("create task: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_execution_refs (task_id) VALUES ($1)`, task.ID); err != nil {
		return Task{}, fmt.Errorf("create task execution protection: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Task{}, fmt.Errorf("commit task: %w", err)
	}
	task.CreatedAt = formatTime(createdAt)
	task.UpdatedAt = formatTime(updatedAt)
	return task, nil
}

func (s *Service) List(ctx context.Context, principal auth.Principal, projectID string, after Cursor, limit int) ([]Task, *Cursor, error) {
	if principal.UserID == "" {
		return nil, nil, auth.ErrUnauthenticated
	}
	if s == nil || s.pool == nil || s.authorize == nil {
		return nil, nil, errors.New("task service dependencies are not configured")
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	var projectIDs []string
	var err error
	if projectID != "" {
		allowed, authorizeErr := s.authorize.CanReadProject(ctx, principal, projectID)
		if authorizeErr != nil {
			return nil, nil, fmt.Errorf("authorize task list: %w", authorizeErr)
		}
		if !allowed {
			return nil, nil, auth.ErrNotFound
		}
		projectIDs = []string{projectID}
	} else {
		projectIDs, err = s.authorize.AuthorizedProjectIDs(ctx, principal)
		if err != nil {
			return nil, nil, err
		}
		if len(projectIDs) == 0 {
			return []Task{}, nil, nil
		}
	}
	args := []any{projectIDs}
	query := `
		SELECT id, project_id, title, goal, status, session_id, created_at, updated_at
		FROM tasks
		WHERE project_id = ANY($1::text[])`
	if after.ID != "" {
		args = append(args, after.CreatedAt, after.ID)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("list tasks: %w", err)
	}
	defer rows.Close()
	tasks := make([]Task, 0, limit)
	var next *Cursor
	for rows.Next() {
		var task Task
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&task.ID, &task.ProjectID, &task.Title, &task.Goal, &task.Status, &task.SessionID, &createdAt, &updatedAt); err != nil {
			return nil, nil, fmt.Errorf("scan task: %w", err)
		}
		task.CreatedAt = formatTime(createdAt)
		task.UpdatedAt = formatTime(updatedAt)
		if len(tasks) == limit {
			cursor := Cursor{CreatedAt: createdAt, ID: task.ID}
			next = &cursor
			break
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("read tasks: %w", err)
	}
	return tasks, next, nil
}

func (s *Service) Get(ctx context.Context, principal auth.Principal, taskID string) (Task, error) {
	if s == nil || s.pool == nil || s.authorize == nil {
		return Task{}, errors.New("task service dependencies are not configured")
	}
	task, err := s.get(ctx, taskID)
	if err != nil {
		return Task{}, err
	}
	allowed, err := s.authorize.CanReadProject(ctx, principal, task.ProjectID)
	if err != nil {
		return Task{}, fmt.Errorf("authorize task read: %w", err)
	}
	if !allowed {
		return Task{}, auth.ErrNotFound
	}
	return task, nil
}

func (s *Service) get(ctx context.Context, taskID string) (Task, error) {
	var task Task
	var createdAt, updatedAt time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT id, project_id, title, goal, status, session_id, created_at, updated_at
		FROM tasks WHERE id = $1
	`, taskID).Scan(&task.ID, &task.ProjectID, &task.Title, &task.Goal, &task.Status, &task.SessionID, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Task{}, auth.ErrNotFound
	}
	if err != nil {
		return Task{}, fmt.Errorf("get task: %w", err)
	}
	task.CreatedAt = formatTime(createdAt)
	task.UpdatedAt = formatTime(updatedAt)
	return task, nil
}

func (s *Service) Update(ctx context.Context, principal auth.Principal, taskID string, request UpdateRequest) (Task, error) {
	if s == nil || s.pool == nil || s.authorize == nil {
		return Task{}, errors.New("task service dependencies are not configured")
	}
	current, err := s.get(ctx, taskID)
	if err != nil {
		return Task{}, err
	}
	allowed, err := s.authorize.CanWriteProject(ctx, principal, current.ProjectID)
	if err != nil {
		return Task{}, fmt.Errorf("authorize task update: %w", err)
	}
	if !allowed {
		return Task{}, auth.ErrNotFound
	}
	title := current.Title
	if request.Title != nil {
		title = strings.TrimSpace(*request.Title)
		if title == "" || len(title) > 300 {
			return Task{}, fmt.Errorf("%w: task title must be between 1 and 300 characters", auth.ErrInvalid)
		}
	}
	goal := current.Goal
	if request.Goal != nil {
		goal = strings.TrimSpace(*request.Goal)
	}
	status := current.Status
	if request.Status != nil {
		status = *request.Status
		if !validStatus(status) {
			return Task{}, fmt.Errorf("%w: unsupported task status", auth.ErrInvalid)
		}
	}
	var task Task
	var createdAt, updatedAt time.Time
	err = s.pool.QueryRow(ctx, `
		UPDATE tasks
		SET title = $2, goal = $3, status = $4, updated_at = CURRENT_TIMESTAMP
		WHERE id = $1
		RETURNING id, project_id, title, goal, status, session_id, created_at, updated_at
	`, taskID, title, goal, status).Scan(&task.ID, &task.ProjectID, &task.Title, &task.Goal, &task.Status, &task.SessionID, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Task{}, auth.ErrNotFound
	}
	if err != nil {
		return Task{}, fmt.Errorf("update task: %w", err)
	}
	task.CreatedAt = formatTime(createdAt)
	task.UpdatedAt = formatTime(updatedAt)
	return task, nil
}

func (s *Service) Delete(ctx context.Context, principal auth.Principal, taskID string) error {
	if s == nil || s.pool == nil || s.authorize == nil {
		return errors.New("task service dependencies are not configured")
	}
	current, err := s.get(ctx, taskID)
	if err != nil {
		return err
	}
	allowed, err := s.authorize.CanWriteProject(ctx, principal, current.ProjectID)
	if err != nil {
		return fmt.Errorf("authorize task deletion: %w", err)
	}
	if !allowed {
		return auth.ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin task deletion: %w", err)
	}
	defer tx.Rollback(ctx)
	var sessionID string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(session_id, '') FROM tasks WHERE id = $1 FOR UPDATE`, taskID).Scan(&sessionID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return auth.ErrNotFound
		}
		return fmt.Errorf("lock task for deletion: %w", err)
	}
	if sessionID != "" {
		return auth.ErrConflict
	}
	var protected bool
	if err := tx.QueryRow(ctx, `
		SELECT active_execution OR retained_history
		FROM task_execution_refs WHERE task_id = $1
	`, taskID).Scan(&protected); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("check task execution protection: %w", err)
	}
	if protected {
		return auth.ErrConflict
	}
	var related bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM task_parent_links WHERE parent_task_id = $1 OR child_task_id = $1)
		   OR EXISTS(SELECT 1 FROM task_dependency_links WHERE prerequisite_task_id = $1 OR dependent_task_id = $1)
	`, taskID).Scan(&related); err != nil {
		return fmt.Errorf("check task relationships: %w", err)
	}
	if related {
		return auth.ErrConflict
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_execution_refs WHERE task_id = $1`, taskID); err != nil {
		return fmt.Errorf("remove task execution protection: %w", err)
	}
	command, err := tx.Exec(ctx, `DELETE FROM tasks WHERE id = $1`, taskID)
	if err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	if command.RowsAffected() == 0 {
		return auth.ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit task deletion: %w", err)
	}
	return nil
}

func (s *Service) SetExecutionProtection(ctx context.Context, principal auth.Principal, taskID string, active, retained bool) error {
	if s == nil || s.pool == nil || s.authorize == nil {
		return errors.New("task service dependencies are not configured")
	}
	task, err := s.get(ctx, taskID)
	if err != nil {
		return err
	}
	allowed, err := s.authorize.CanWriteProject(ctx, principal, task.ProjectID)
	if err != nil {
		return fmt.Errorf("authorize task execution protection: %w", err)
	}
	if !allowed {
		return auth.ErrNotFound
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO task_execution_refs (task_id, active_execution, retained_history, updated_at)
		VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
		ON CONFLICT (task_id) DO UPDATE SET active_execution = EXCLUDED.active_execution,
			retained_history = EXCLUDED.retained_history, updated_at = CURRENT_TIMESTAMP
	`, taskID, active, retained)
	return err
}

func validStatus(status Status) bool {
	switch status {
	case StatusTodo, StatusInProgress, StatusBlocked, StatusDone, StatusCancelled:
		return true
	default:
		return false
	}
}

func (s *Service) principalFor(request *http.Request) (auth.Principal, error) {
	if s.principal == nil {
		return auth.Principal{}, auth.ErrUnauthenticated
	}
	return s.principal.ResolvePrincipal(request.Context(), request)
}

func (s *Service) handleList(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalFor(request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	limit, err := parseLimit(request.URL.Query().Get("limit"))
	if err != nil {
		auth.WriteError(writer, request, http.StatusBadRequest, err, "invalid task list query")
		return
	}
	cursor, err := DecodeCursor(request.URL.Query().Get("after_cursor"))
	if err != nil {
		auth.WriteError(writer, request, http.StatusBadRequest, err, "invalid task cursor")
		return
	}
	items, next, err := s.List(request.Context(), principal, request.URL.Query().Get("project_id"), cursor, limit)
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to list tasks")
		return
	}
	response := map[string]any{"items": items, "has_more": next != nil}
	if next != nil {
		response["next_cursor"] = EncodeCursor(*next)
	}
	auth.WriteJSON(writer, http.StatusOK, response)
}

func (s *Service) handleCreate(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalFor(request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	var body CreateRequest
	if err := auth.DecodeJSON(request, &body); err != nil {
		auth.WriteError(writer, request, http.StatusBadRequest, err, "invalid task request")
		return
	}
	task, err := s.Create(request.Context(), principal, body)
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to create task")
		return
	}
	auth.WriteJSON(writer, http.StatusCreated, map[string]Task{"task": task})
}

func (s *Service) handleGet(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalFor(request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	task, err := s.Get(request.Context(), principal, chi.URLParam(request, "task_id"))
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to load task")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, map[string]Task{"task": task})
}

func (s *Service) handleUpdate(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalFor(request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	var body UpdateRequest
	if err := auth.DecodeJSON(request, &body); err != nil {
		auth.WriteError(writer, request, http.StatusBadRequest, err, "invalid task request")
		return
	}
	task, err := s.Update(request.Context(), principal, chi.URLParam(request, "task_id"), body)
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to update task")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, map[string]Task{"task": task})
}

func (s *Service) handleDelete(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalFor(request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	err = s.Delete(request.Context(), principal, chi.URLParam(request, "task_id"))
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to delete task")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func newID(prefix string) (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate task identifier: %w", err)
	}
	return prefix + "_" + hex.EncodeToString(value), nil
}

func parseLimit(raw string) (int, error) {
	if raw == "" {
		return 50, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 || value > 200 {
		return 0, fmt.Errorf("%w: limit must be between 1 and 200", auth.ErrInvalid)
	}
	return value, nil
}
