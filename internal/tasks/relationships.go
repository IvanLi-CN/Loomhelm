package tasks

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

func (s *Service) AddParent(ctx context.Context, principal auth.Principal, childID, parentID string) error {
	return s.mutatePair(ctx, principal, childID, parentID, func(ctx context.Context, tx pgx.Tx) error {
		if childID == parentID {
			return auth.ErrConflict
		}
		var cycle bool
		if err := tx.QueryRow(ctx, `
			WITH RECURSIVE descendants(id) AS (
				SELECT child_task_id FROM task_parent_links WHERE parent_task_id = $1
				UNION
				SELECT links.child_task_id
				FROM task_parent_links links
				JOIN descendants ON descendants.id = links.parent_task_id
			)
			SELECT EXISTS(SELECT 1 FROM descendants WHERE id = $2)
		`, childID, parentID).Scan(&cycle); err != nil {
			return fmt.Errorf("check parent relationship cycle: %w", err)
		}
		if cycle {
			return auth.ErrConflict
		}
		command, err := tx.Exec(ctx, `
			INSERT INTO task_parent_links (parent_task_id, child_task_id)
			VALUES ($1, $2) ON CONFLICT DO NOTHING
		`, parentID, childID)
		if err != nil {
			return fmt.Errorf("create parent relationship: %w", err)
		}
		if command.RowsAffected() == 0 {
			return auth.ErrConflict
		}
		return nil
	})
}

func (s *Service) RemoveParent(ctx context.Context, principal auth.Principal, childID, parentID string) error {
	return s.removePair(ctx, principal, childID, parentID, `DELETE FROM task_parent_links WHERE parent_task_id = $1 AND child_task_id = $2`)
}

func (s *Service) AddDependency(ctx context.Context, principal auth.Principal, dependentID, prerequisiteID string) error {
	return s.mutatePair(ctx, principal, dependentID, prerequisiteID, func(ctx context.Context, tx pgx.Tx) error {
		if dependentID == prerequisiteID {
			return auth.ErrConflict
		}
		var cycle bool
		if err := tx.QueryRow(ctx, `
			WITH RECURSIVE dependents(id) AS (
				SELECT dependent_task_id FROM task_dependency_links WHERE prerequisite_task_id = $1
				UNION
				SELECT links.dependent_task_id
				FROM task_dependency_links links
				JOIN dependents ON dependents.id = links.prerequisite_task_id
			)
			SELECT EXISTS(SELECT 1 FROM dependents WHERE id = $2)
		`, dependentID, prerequisiteID).Scan(&cycle); err != nil {
			return fmt.Errorf("check dependency cycle: %w", err)
		}
		if cycle {
			return auth.ErrConflict
		}
		command, err := tx.Exec(ctx, `
			INSERT INTO task_dependency_links (prerequisite_task_id, dependent_task_id)
			VALUES ($1, $2) ON CONFLICT DO NOTHING
		`, prerequisiteID, dependentID)
		if err != nil {
			return fmt.Errorf("create dependency relationship: %w", err)
		}
		if command.RowsAffected() == 0 {
			return auth.ErrConflict
		}
		return nil
	})
}

func (s *Service) RemoveDependency(ctx context.Context, principal auth.Principal, dependentID, prerequisiteID string) error {
	return s.removePair(ctx, principal, dependentID, prerequisiteID, `DELETE FROM task_dependency_links WHERE prerequisite_task_id = $1 AND dependent_task_id = $2`)
}

func (s *Service) mutatePair(ctx context.Context, principal auth.Principal, firstID, secondID string, mutate func(context.Context, pgx.Tx) error) error {
	if firstID == "" || secondID == "" {
		return fmt.Errorf("%w: both task ids are required", auth.ErrInvalid)
	}
	if firstID == secondID {
		return auth.ErrConflict
	}
	if s == nil || s.pool == nil || s.authorize == nil {
		return fmt.Errorf("relationship service dependencies are not configured")
	}
	if err := s.authorizedPair(ctx, principal, firstID, secondID); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin relationship transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, relationAdvisoryLock); err != nil {
		return fmt.Errorf("serialize relationship mutation: %w", err)
	}
	rows, err := tx.Query(ctx, `SELECT id FROM tasks WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, []string{firstID, secondID})
	if err != nil {
		return fmt.Errorf("lock relationship tasks: %w", err)
	}
	seen := map[string]struct{}{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("scan relationship task: %w", err)
		}
		seen[id] = struct{}{}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read relationship tasks: %w", err)
	}
	if len(seen) != 2 {
		return auth.ErrNotFound
	}
	if err := mutate(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit relationship mutation: %w", err)
	}
	return nil
}

func (s *Service) removePair(ctx context.Context, principal auth.Principal, firstID, secondID, query string) error {
	return s.mutatePair(ctx, principal, firstID, secondID, func(ctx context.Context, tx pgx.Tx) error {
		command, err := tx.Exec(ctx, query, secondID, firstID)
		if err != nil {
			return fmt.Errorf("remove relationship: %w", err)
		}
		if command.RowsAffected() == 0 {
			return auth.ErrNotFound
		}
		return nil
	})
}

func (s *Service) authorizedPair(ctx context.Context, principal auth.Principal, firstID, secondID string) error {
	rows, err := s.pool.Query(ctx, `SELECT id, project_id FROM tasks WHERE id = ANY($1::text[])`, []string{firstID, secondID})
	if err != nil {
		return fmt.Errorf("load relationship tasks: %w", err)
	}
	defer rows.Close()
	projectsByTask := make(map[string]string, 2)
	for rows.Next() {
		var taskID, projectID string
		if err := rows.Scan(&taskID, &projectID); err != nil {
			return fmt.Errorf("scan relationship task: %w", err)
		}
		projectsByTask[taskID] = projectID
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read relationship tasks: %w", err)
	}
	if len(projectsByTask) != 2 {
		return auth.ErrNotFound
	}
	for _, projectID := range projectsByTask {
		allowed, err := s.authorize.CanWriteProject(ctx, principal, projectID)
		if err != nil {
			return fmt.Errorf("authorize relationship endpoint: %w", err)
		}
		if !allowed {
			return auth.ErrNotFound
		}
	}
	return nil
}

func (s *Service) Relationships(ctx context.Context, principal auth.Principal, taskID string) (RelationshipPage, error) {
	if s == nil || s.pool == nil || s.authorize == nil {
		return RelationshipPage{}, fmt.Errorf("relationship service dependencies are not configured")
	}
	task, err := s.get(ctx, taskID)
	if err != nil {
		return RelationshipPage{}, err
	}
	allowed, err := s.authorize.CanReadProject(ctx, principal, task.ProjectID)
	if err != nil {
		return RelationshipPage{}, fmt.Errorf("authorize relationship read: %w", err)
	}
	if !allowed {
		return RelationshipPage{}, auth.ErrNotFound
	}
	page := RelationshipPage{
		Parents:       make([]Relationship, 0),
		Children:      make([]Relationship, 0),
		Prerequisites: make([]Relationship, 0),
		Dependents:    make([]Relationship, 0),
	}
	rows, err := s.pool.Query(ctx, `
		SELECT links.parent_task_id, links.child_task_id, links.created_at,
		       CASE WHEN links.parent_task_id = $1 THEN child.project_id ELSE parent.project_id END
		FROM task_parent_links links
		JOIN tasks parent ON parent.id = links.parent_task_id
		JOIN tasks child ON child.id = links.child_task_id
		WHERE links.parent_task_id = $1 OR links.child_task_id = $1
		ORDER BY links.created_at, links.parent_task_id, links.child_task_id
	`, taskID)
	if err != nil {
		return RelationshipPage{}, fmt.Errorf("list parent relationships: %w", err)
	}
	for rows.Next() {
		var relationship Relationship
		var createdAt time.Time
		var relatedProjectID string
		if err := rows.Scan(&relationship.ParentTaskID, &relationship.ChildTaskID, &createdAt, &relatedProjectID); err != nil {
			rows.Close()
			return RelationshipPage{}, fmt.Errorf("scan parent relationship: %w", err)
		}
		related, err := s.authorize.CanReadProject(ctx, principal, relatedProjectID)
		if err != nil {
			rows.Close()
			return RelationshipPage{}, fmt.Errorf("authorize related parent task: %w", err)
		}
		if !related {
			continue
		}
		relationship.CreatedAt = formatTime(createdAt)
		relationship.Kind = "parent_child"
		if relationship.ParentTaskID == taskID {
			page.Children = append(page.Children, relationship)
		} else {
			page.Parents = append(page.Parents, relationship)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return RelationshipPage{}, fmt.Errorf("read parent relationships: %w", err)
	}
	rows, err = s.pool.Query(ctx, `
		SELECT links.prerequisite_task_id, links.dependent_task_id, links.created_at,
		       CASE WHEN links.prerequisite_task_id = $1 THEN dependent.project_id ELSE prerequisite.project_id END
		FROM task_dependency_links links
		JOIN tasks prerequisite ON prerequisite.id = links.prerequisite_task_id
		JOIN tasks dependent ON dependent.id = links.dependent_task_id
		WHERE links.prerequisite_task_id = $1 OR links.dependent_task_id = $1
		ORDER BY links.created_at, links.prerequisite_task_id, links.dependent_task_id
	`, taskID)
	if err != nil {
		return RelationshipPage{}, fmt.Errorf("list dependency relationships: %w", err)
	}
	for rows.Next() {
		var relationship Relationship
		var createdAt time.Time
		var relatedProjectID string
		if err := rows.Scan(&relationship.PrerequisiteID, &relationship.DependentTaskID, &createdAt, &relatedProjectID); err != nil {
			rows.Close()
			return RelationshipPage{}, fmt.Errorf("scan dependency relationship: %w", err)
		}
		related, err := s.authorize.CanReadProject(ctx, principal, relatedProjectID)
		if err != nil {
			rows.Close()
			return RelationshipPage{}, fmt.Errorf("authorize related dependency task: %w", err)
		}
		if !related {
			continue
		}
		relationship.CreatedAt = formatTime(createdAt)
		relationship.Kind = "prerequisite"
		if relationship.PrerequisiteID == taskID {
			page.Dependents = append(page.Dependents, relationship)
		} else {
			page.Prerequisites = append(page.Prerequisites, relationship)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return RelationshipPage{}, fmt.Errorf("read dependency relationships: %w", err)
	}
	return page, nil
}

func (s *Service) handleRelationships(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalFor(request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	page, err := s.Relationships(request.Context(), principal, chi.URLParam(request, "task_id"))
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to load task relationships")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, page)
}

func (s *Service) handleAddParent(writer http.ResponseWriter, request *http.Request) {
	s.handleRelationshipMutation(writer, request, func(ctx context.Context, p auth.Principal) error {
		return s.AddParent(ctx, p, chi.URLParam(request, "task_id"), chi.URLParam(request, "parent_task_id"))
	})
}

func (s *Service) handleRemoveParent(writer http.ResponseWriter, request *http.Request) {
	s.handleRelationshipMutation(writer, request, func(ctx context.Context, p auth.Principal) error {
		return s.RemoveParent(ctx, p, chi.URLParam(request, "task_id"), chi.URLParam(request, "parent_task_id"))
	})
}

func (s *Service) handleAddDependency(writer http.ResponseWriter, request *http.Request) {
	s.handleRelationshipMutation(writer, request, func(ctx context.Context, p auth.Principal) error {
		return s.AddDependency(ctx, p, chi.URLParam(request, "task_id"), chi.URLParam(request, "prerequisite_task_id"))
	})
}

func (s *Service) handleRemoveDependency(writer http.ResponseWriter, request *http.Request) {
	s.handleRelationshipMutation(writer, request, func(ctx context.Context, p auth.Principal) error {
		return s.RemoveDependency(ctx, p, chi.URLParam(request, "task_id"), chi.URLParam(request, "prerequisite_task_id"))
	})
}

func (s *Service) handleRelationshipMutation(writer http.ResponseWriter, request *http.Request, mutate func(context.Context, auth.Principal) error) {
	principal, err := s.principalFor(request)
	if err != nil {
		auth.WriteError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	if err := mutate(request.Context(), principal); err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "failed to update task relationship")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
