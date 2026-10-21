// Package projects owns project persistence and project-scope authorization.
package projects

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Role string

const (
	RoleViewer   Role = "viewer"
	RoleOperator Role = "operator"
	RoleOwner    Role = "owner"
)

type Project struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type CreateRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type UpdateRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
}

type Member struct {
	ProjectID string `json:"project_id"`
	UserID    string `json:"user_id"`
	Role      Role   `json:"role"`
	CreatedAt string `json:"created_at"`
}

type MemberGrantRequest struct {
	UserID string `json:"user_id"`
	Role   Role   `json:"role"`
}

type Authorizer interface {
	CanReadProject(context.Context, auth.Principal, string) (bool, error)
	CanWriteProject(context.Context, auth.Principal, string) (bool, error)
	CanManageProject(context.Context, auth.Principal, string) (bool, error)
	AuthorizedProjectIDs(context.Context, auth.Principal) ([]string, error)
}

type Service struct {
	pool      *pgxpool.Pool
	principal auth.PrincipalResolver
	now       func() time.Time
}

func NewService(pool *pgxpool.Pool, principal auth.PrincipalResolver) *Service {
	return &Service{pool: pool, principal: principal, now: time.Now}
}

func (s *Service) Mount(r chi.Router) {
	r.Route("/projects", func(projects chi.Router) {
		projects.Get("/", s.handleList)
		projects.Post("/", s.handleCreate)
		projects.Get("/{project_id}", s.handleGet)
		projects.Patch("/{project_id}", s.handleUpdate)
		projects.Delete("/{project_id}", s.handleDelete)
	})
}

func (s *Service) CanReadProject(ctx context.Context, principal auth.Principal, projectID string) (bool, error) {
	if s == nil || s.pool == nil || principal.UserID == "" || !principal.HasProjectScope(projectID) {
		return false, nil
	}
	return s.hasRole(ctx, principal.UserID, projectID, RoleViewer, RoleOperator, RoleOwner)
}

func (s *Service) CanWriteProject(ctx context.Context, principal auth.Principal, projectID string) (bool, error) {
	if s == nil || s.pool == nil || principal.UserID == "" || !principal.HasProjectScope(projectID) {
		return false, nil
	}
	return s.hasRole(ctx, principal.UserID, projectID, RoleOperator, RoleOwner)
}

func (s *Service) CanManageProject(ctx context.Context, principal auth.Principal, projectID string) (bool, error) {
	return s.canManageMembers(ctx, principal, projectID)
}

func (s *Service) CanManageMembers(ctx context.Context, principal auth.Principal, projectID string) (bool, error) {
	return s.canManageMembers(ctx, principal, projectID)
}

func (s *Service) canManageMembers(ctx context.Context, principal auth.Principal, projectID string) (bool, error) {
	if s == nil || s.pool == nil || principal.UserID == "" || !principal.HasProjectScope(projectID) {
		return false, nil
	}
	var allowed bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM projects
			WHERE id = $1 AND created_by = $2
		)
	`, projectID, principal.UserID).Scan(&allowed)
	return allowed, err
}

func (s *Service) GrantMember(ctx context.Context, principal auth.Principal, projectID string, request MemberGrantRequest) (Member, error) {
	if err := s.requireMemberManager(ctx, principal, projectID); err != nil {
		return Member{}, err
	}
	userID := strings.TrimSpace(request.UserID)
	if userID == "" {
		return Member{}, fmt.Errorf("%w: member user_id is required", auth.ErrInvalid)
	}
	if userID == principal.UserID {
		return Member{}, auth.ErrConflict
	}
	if request.Role != RoleViewer && request.Role != RoleOperator {
		return Member{}, fmt.Errorf("%w: member role must be viewer or operator", auth.ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Member{}, fmt.Errorf("begin member grant: %w", err)
	}
	defer tx.Rollback(ctx)
	var userExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM auth_users WHERE id = $1)`, userID).Scan(&userExists); err != nil {
		return Member{}, fmt.Errorf("check member user: %w", err)
	}
	if !userExists {
		return Member{}, auth.ErrNotFound
	}
	var member Member
	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO project_members (project_id, user_id, role)
		VALUES ($1, $2, $3)
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
		RETURNING project_id, user_id, role, created_at
	`, projectID, userID, request.Role).Scan(&member.ProjectID, &member.UserID, &member.Role, &createdAt)
	if err != nil {
		return Member{}, fmt.Errorf("grant project member: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Member{}, fmt.Errorf("commit member grant: %w", err)
	}
	member.CreatedAt = formatTime(createdAt)
	return member, nil
}

func (s *Service) RevokeMember(ctx context.Context, principal auth.Principal, projectID, userID string) error {
	if err := s.requireMemberManager(ctx, principal, projectID); err != nil {
		return err
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return fmt.Errorf("%w: member user_id is required", auth.ErrInvalid)
	}
	if userID == principal.UserID {
		return auth.ErrConflict
	}
	command, err := s.pool.Exec(ctx, `
		DELETE FROM project_members
		WHERE project_id = $1 AND user_id = $2
	`, projectID, userID)
	if err != nil {
		return fmt.Errorf("revoke project member: %w", err)
	}
	if command.RowsAffected() == 0 {
		return auth.ErrNotFound
	}
	return nil
}

func (s *Service) ListMembers(ctx context.Context, principal auth.Principal, projectID string) ([]Member, error) {
	allowed, err := s.CanReadProject(ctx, principal, projectID)
	if err != nil {
		return nil, fmt.Errorf("authorize member list: %w", err)
	}
	if !allowed {
		return nil, auth.ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT project_id, user_id, role, created_at
		FROM project_members
		WHERE project_id = $1
		ORDER BY created_at, user_id
	`, projectID)
	if err != nil {
		return nil, fmt.Errorf("list project members: %w", err)
	}
	defer rows.Close()
	members := make([]Member, 0)
	for rows.Next() {
		var member Member
		var createdAt time.Time
		if err := rows.Scan(&member.ProjectID, &member.UserID, &member.Role, &createdAt); err != nil {
			return nil, fmt.Errorf("scan project member: %w", err)
		}
		member.CreatedAt = formatTime(createdAt)
		members = append(members, member)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read project members: %w", err)
	}
	return members, nil
}

func (s *Service) requireMemberManager(ctx context.Context, principal auth.Principal, projectID string) error {
	if principal.UserID == "" {
		return auth.ErrUnauthenticated
	}
	allowed, err := s.CanManageMembers(ctx, principal, projectID)
	if err != nil {
		return fmt.Errorf("authorize project member management: %w", err)
	}
	if !allowed {
		return auth.ErrForbidden
	}
	return nil
}

func (s *Service) hasRole(ctx context.Context, userID, projectID string, roles ...Role) (bool, error) {
	if len(roles) == 0 {
		return false, nil
	}
	values := make([]string, len(roles))
	for i, role := range roles {
		values[i] = string(role)
	}
	var allowed bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM project_members
			WHERE user_id = $1 AND project_id = $2 AND role = ANY($3::text[])
		)
	`, userID, projectID, values).Scan(&allowed)
	return allowed, err
}

func (s *Service) AuthorizedProjectIDs(ctx context.Context, principal auth.Principal) ([]string, error) {
	if principal.UserID == "" {
		return nil, auth.ErrUnauthenticated
	}
	rows, err := s.pool.Query(ctx, `
		SELECT project_id
		FROM project_members
		WHERE user_id = $1
		ORDER BY project_id
	`, principal.UserID)
	if err != nil {
		return nil, fmt.Errorf("list authorized projects: %w", err)
	}
	defer rows.Close()
	scope := principal.ProjectScope
	result := make([]string, 0)
	for rows.Next() {
		var projectID string
		if err := rows.Scan(&projectID); err != nil {
			return nil, fmt.Errorf("scan authorized project: %w", err)
		}
		if len(scope) == 0 {
			result = append(result, projectID)
			continue
		}
		if _, ok := scope[projectID]; ok {
			result = append(result, projectID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read authorized projects: %w", err)
	}
	return result, nil
}

func (s *Service) Create(ctx context.Context, principal auth.Principal, request CreateRequest) (Project, error) {
	if principal.UserID == "" {
		return Project{}, auth.ErrUnauthenticated
	}
	name := strings.TrimSpace(request.Name)
	if name == "" || len(name) > 200 {
		return Project{}, fmt.Errorf("%w: project name must be between 1 and 200 characters", auth.ErrInvalid)
	}
	if len(principal.ProjectScope) > 0 {
		return Project{}, auth.ErrForbidden
	}
	id, err := newID("project")
	if err != nil {
		return Project{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Project{}, fmt.Errorf("begin project transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	var project Project
	var createdAt, updatedAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO projects (id, name, description, created_by)
		VALUES ($1, $2, $3, $4)
		RETURNING id, name, description, created_at, updated_at
	`, id, name, strings.TrimSpace(request.Description), principal.UserID).Scan(&project.ID, &project.Name, &project.Description, &createdAt, &updatedAt)
	if err != nil {
		return Project{}, fmt.Errorf("create project: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
	`, project.ID, principal.UserID, RoleOwner); err != nil {
		return Project{}, fmt.Errorf("create project owner membership: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Project{}, fmt.Errorf("commit project: %w", err)
	}
	project.CreatedAt = formatTime(createdAt)
	project.UpdatedAt = formatTime(updatedAt)
	return project, nil
}

func (s *Service) List(ctx context.Context, principal auth.Principal, after Cursor, limit int) ([]Project, *Cursor, error) {
	if principal.UserID == "" {
		return nil, nil, auth.ErrUnauthenticated
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	args := []any{principal.UserID}
	query := `
		SELECT p.id, p.name, p.description, p.created_at, p.updated_at
		FROM projects p
		JOIN project_members pm ON pm.project_id = p.id
		WHERE pm.user_id = $1`
	if len(principal.ProjectScope) > 0 {
		args = append(args, projectScopeValues(principal.ProjectScope))
		query += fmt.Sprintf(" AND p.id = ANY($%d::text[])", len(args))
	}
	if after.ID != "" {
		args = append(args, after.CreatedAt, after.ID)
		query += fmt.Sprintf(" AND (p.created_at, p.id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY p.created_at, p.id LIMIT $%d", len(args))
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	projects := make([]Project, 0, limit)
	var next *Cursor
	for rows.Next() {
		var project Project
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&project.ID, &project.Name, &project.Description, &createdAt, &updatedAt); err != nil {
			return nil, nil, fmt.Errorf("scan project: %w", err)
		}
		project.CreatedAt = formatTime(createdAt)
		project.UpdatedAt = formatTime(updatedAt)
		if len(projects) == limit {
			cursor := Cursor{CreatedAt: createdAt, ID: project.ID}
			next = &cursor
			break
		}
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("read projects: %w", err)
	}
	return projects, next, nil
}

func (s *Service) Get(ctx context.Context, principal auth.Principal, projectID string) (Project, error) {
	allowed, err := s.CanReadProject(ctx, principal, projectID)
	if err != nil {
		return Project{}, fmt.Errorf("authorize project read: %w", err)
	}
	if !allowed {
		return Project{}, auth.ErrNotFound
	}
	return s.get(ctx, projectID)
}

func (s *Service) get(ctx context.Context, projectID string) (Project, error) {
	var project Project
	var createdAt, updatedAt time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, description, created_at, updated_at FROM projects WHERE id = $1
	`, projectID).Scan(&project.ID, &project.Name, &project.Description, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Project{}, auth.ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("get project: %w", err)
	}
	project.CreatedAt = formatTime(createdAt)
	project.UpdatedAt = formatTime(updatedAt)
	return project, nil
}

func (s *Service) Update(ctx context.Context, principal auth.Principal, projectID string, request UpdateRequest) (Project, error) {
	allowed, err := s.CanManageProject(ctx, principal, projectID)
	if err != nil {
		return Project{}, fmt.Errorf("authorize project update: %w", err)
	}
	if !allowed {
		return Project{}, auth.ErrNotFound
	}
	name := ""
	if request.Name != nil {
		name = strings.TrimSpace(*request.Name)
		if name == "" || len(name) > 200 {
			return Project{}, fmt.Errorf("%w: project name must be between 1 and 200 characters", auth.ErrInvalid)
		}
	}
	description := ""
	if request.Description != nil {
		description = strings.TrimSpace(*request.Description)
	}
	var project Project
	var createdAt, updatedAt time.Time
	err = s.pool.QueryRow(ctx, `
		UPDATE projects
		SET name = COALESCE(NULLIF($2, ''), name),
			description = CASE WHEN $3::boolean THEN $4 ELSE description END,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = $1
		RETURNING id, name, description, created_at, updated_at
	`, projectID, name, request.Description != nil, description).Scan(&project.ID, &project.Name, &project.Description, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Project{}, auth.ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("update project: %w", err)
	}
	project.CreatedAt = formatTime(createdAt)
	project.UpdatedAt = formatTime(updatedAt)
	return project, nil
}

func (s *Service) Delete(ctx context.Context, principal auth.Principal, projectID string) error {
	allowed, err := s.CanManageProject(ctx, principal, projectID)
	if err != nil {
		return fmt.Errorf("authorize project delete: %w", err)
	}
	if !allowed {
		return auth.ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin project deletion: %w", err)
	}
	defer tx.Rollback(ctx)
	var hasTasks bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks WHERE project_id = $1)`, projectID).Scan(&hasTasks); err != nil {
		return fmt.Errorf("check project deletion: %w", err)
	}
	if hasTasks {
		return auth.ErrConflict
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_api_credential_project_scopes WHERE project_id = $1`, projectID); err != nil {
		return fmt.Errorf("remove project credential scopes: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM project_members WHERE project_id = $1`, projectID); err != nil {
		return fmt.Errorf("remove project memberships: %w", err)
	}
	command, err := tx.Exec(ctx, `DELETE FROM projects WHERE id = $1`, projectID)
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	if command.RowsAffected() == 0 {
		return auth.ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit project deletion: %w", err)
	}
	return nil
}

type Cursor struct {
	CreatedAt time.Time
	ID        string
}

func projectScopeValues(scope map[string]struct{}) []string {
	result := make([]string, 0, len(scope))
	for projectID := range scope {
		result = append(result, projectID)
	}
	return result
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func newID(prefix string) (string, error) {
	value, err := randomBytes(16)
	if err != nil {
		return "", err
	}
	return prefix + "_" + fmt.Sprintf("%x", value), nil
}

func randomBytes(size int) ([]byte, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return nil, fmt.Errorf("generate identifier: %w", err)
	}
	return value, nil
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

func principalFor(s *Service, request *http.Request) (auth.Principal, error) {
	if s.principal == nil {
		return auth.Principal{}, auth.ErrUnauthenticated
	}
	return s.principal.ResolvePrincipal(request.Context(), request)
}

func (s *Service) handleList(writer http.ResponseWriter, request *http.Request) {
	principal, err := principalFor(s, request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	limit, err := parseLimit(request.URL.Query().Get("limit"))
	if err != nil {
		auth.WriteError(writer, request, http.StatusBadRequest, err, "invalid project list query")
		return
	}
	cursor, err := DecodeCursor(request.URL.Query().Get("after_cursor"))
	if err != nil {
		auth.WriteError(writer, request, http.StatusBadRequest, err, "invalid project cursor")
		return
	}
	items, next, err := s.List(request.Context(), principal, cursor, limit)
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to list projects")
		return
	}
	response := map[string]any{"items": items, "has_more": next != nil}
	if next != nil {
		response["next_cursor"] = EncodeCursor(*next)
	}
	auth.WriteJSON(writer, http.StatusOK, response)
}

func (s *Service) handleCreate(writer http.ResponseWriter, request *http.Request) {
	principal, err := principalFor(s, request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	var body CreateRequest
	if err := auth.DecodeJSON(request, &body); err != nil {
		auth.WriteError(writer, request, http.StatusBadRequest, err, "invalid project request")
		return
	}
	project, err := s.Create(request.Context(), principal, body)
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to create project")
		return
	}
	auth.WriteJSON(writer, http.StatusCreated, map[string]Project{"project": project})
}

func (s *Service) handleGet(writer http.ResponseWriter, request *http.Request) {
	principal, err := principalFor(s, request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	project, err := s.Get(request.Context(), principal, chi.URLParam(request, "project_id"))
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to load project")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, map[string]Project{"project": project})
}

func (s *Service) handleUpdate(writer http.ResponseWriter, request *http.Request) {
	principal, err := principalFor(s, request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	var body UpdateRequest
	if err := auth.DecodeJSON(request, &body); err != nil {
		auth.WriteError(writer, request, http.StatusBadRequest, err, "invalid project request")
		return
	}
	project, err := s.Update(request.Context(), principal, chi.URLParam(request, "project_id"), body)
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to update project")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, map[string]Project{"project": project})
}

func (s *Service) handleDelete(writer http.ResponseWriter, request *http.Request) {
	principal, err := principalFor(s, request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	err = s.Delete(request.Context(), principal, chi.URLParam(request, "project_id"))
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to delete project")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
