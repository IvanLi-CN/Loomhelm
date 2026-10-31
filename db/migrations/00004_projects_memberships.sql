-- +goose Up
CREATE TABLE projects (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES auth_users (id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX projects_created_at_idx ON projects (created_at, id);

CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'owner')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX project_members_user_idx ON project_members (user_id, project_id);

CREATE TABLE auth_api_credential_project_scopes (
    credential_id TEXT NOT NULL REFERENCES auth_api_credentials (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    PRIMARY KEY (credential_id, project_id)
);

CREATE INDEX auth_api_credential_project_scopes_project_idx ON auth_api_credential_project_scopes (project_id, credential_id);

-- +goose Down
DROP TABLE IF EXISTS auth_api_credential_project_scopes;
DROP TABLE IF EXISTS project_members;
DROP TABLE IF EXISTS projects;
