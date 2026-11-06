-- +goose Up
CREATE TABLE tasks (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
    session_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX tasks_project_idx ON tasks (project_id, created_at, id);
CREATE INDEX tasks_status_idx ON tasks (status, created_at, id);

CREATE TABLE task_parent_links (
    parent_task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
    child_task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (parent_task_id, child_task_id),
    CHECK (parent_task_id <> child_task_id)
);

CREATE INDEX task_parent_links_child_idx ON task_parent_links (child_task_id, parent_task_id);

CREATE TABLE task_dependency_links (
    prerequisite_task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
    dependent_task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (prerequisite_task_id, dependent_task_id),
    CHECK (prerequisite_task_id <> dependent_task_id)
);

CREATE INDEX task_dependency_links_dependent_idx ON task_dependency_links (dependent_task_id, prerequisite_task_id);

CREATE TABLE task_execution_refs (
    task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE RESTRICT,
    active_execution BOOLEAN NOT NULL DEFAULT FALSE,
    retained_history BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- +goose Down
DROP TABLE IF EXISTS task_execution_refs;
DROP TABLE IF EXISTS task_dependency_links;
DROP TABLE IF EXISTS task_parent_links;
DROP TABLE IF EXISTS tasks;
