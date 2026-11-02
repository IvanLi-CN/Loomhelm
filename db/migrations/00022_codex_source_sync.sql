-- +goose Up

-- Migration 00010 introduced nullable Host provenance. NULL host_id is
-- intentionally retained for legacy rows; this migration never guesses a Host.
DROP INDEX IF EXISTS execution_sessions_external_thread_idx;
CREATE UNIQUE INDEX execution_sessions_host_thread_idx
    ON execution_sessions (host_id, external_thread_ref)
    WHERE host_id IS NOT NULL;

CREATE TABLE codex_sync_sources (
    host_id TEXT PRIMARY KEY REFERENCES host_registrations (id) ON DELETE RESTRICT,
    state TEXT NOT NULL DEFAULT 'offline' CHECK (state IN ('online', 'offline', 'unavailable')),
    sync_state TEXT NOT NULL DEFAULT 'never' CHECK (sync_state IN ('never', 'syncing', 'complete', 'partial', 'stale', 'failed')),
    build TEXT NOT NULL DEFAULT '',
    protocol_version TEXT NOT NULL DEFAULT '',
    capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
    capability_states JSONB NOT NULL DEFAULT '{}'::jsonb,
    sync_operation_id TEXT NOT NULL DEFAULT '',
    as_of TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE codex_projects (
    host_id TEXT NOT NULL REFERENCES codex_sync_sources (host_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
    name TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    loomhelm_project_id TEXT REFERENCES projects (id) ON DELETE RESTRICT,
    snapshot_state TEXT NOT NULL DEFAULT 'never' CHECK (snapshot_state IN ('never', 'syncing', 'complete', 'partial', 'stale', 'failed')),
    as_of TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (host_id, project_id)
);

CREATE INDEX codex_projects_mapping_idx
    ON codex_projects (loomhelm_project_id, host_id, project_id)
    WHERE loomhelm_project_id IS NOT NULL;

CREATE TABLE codex_threads (
    host_id TEXT NOT NULL REFERENCES codex_sync_sources (host_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
    project_id TEXT,
    parent_thread_id TEXT,
    source_kind TEXT NOT NULL DEFAULT 'main' CHECK (source_kind IN ('main', 'subagent')),
    codex_title TEXT,
    conversation_title TEXT NOT NULL CHECK (length(trim(conversation_title)) > 0),
    preview TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    source_status TEXT NOT NULL DEFAULT 'active' CHECK (source_status IN ('active', 'archived', 'deleted', 'unavailable')),
    history_state TEXT NOT NULL DEFAULT 'pending' CHECK (history_state IN ('pending', 'complete', 'partial', 'failed')),
    files_complete BOOLEAN NOT NULL DEFAULT FALSE,
    title_sync_state TEXT NOT NULL DEFAULT 'unsupported' CHECK (title_sync_state IN ('synced', 'pending', 'failed', 'conflict', 'paused', 'unsupported')),
    title_sync_error TEXT NOT NULL DEFAULT '',
    title_conflict_codex_title TEXT,
    title_conflict_detected_at TIMESTAMPTZ,
    bound_task_id TEXT REFERENCES tasks (id) ON DELETE RESTRICT,
    bound_session_id TEXT REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    imported_by TEXT REFERENCES auth_users (id) ON DELETE RESTRICT,
    as_of TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (host_id, thread_id),
    FOREIGN KEY (host_id, project_id) REFERENCES codex_projects (host_id, project_id) ON DELETE RESTRICT
);

CREATE INDEX codex_threads_activity_idx
    ON codex_threads (host_id, source_status, last_activity_at DESC, thread_id);
CREATE INDEX codex_threads_search_idx
    ON codex_threads USING GIN (to_tsvector('simple', conversation_title || ' ' || preview || ' ' || cwd));
CREATE UNIQUE INDEX codex_threads_task_idx
    ON codex_threads (bound_task_id)
    WHERE bound_task_id IS NOT NULL;
CREATE UNIQUE INDEX codex_threads_session_idx
    ON codex_threads (bound_session_id)
    WHERE bound_session_id IS NOT NULL;

CREATE TABLE codex_title_operations (
    operation_id TEXT PRIMARY KEY CHECK (length(trim(operation_id)) > 0),
    request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
    host_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    desired_title TEXT NOT NULL CHECK (length(trim(desired_title)) > 0),
    expected_codex_title TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    state TEXT NOT NULL DEFAULT 'title_sync_pending' CHECK (state IN ('title_sync_pending', 'title_sync_failed', 'title_sync_conflict', 'title_sync_paused', 'title_sync_complete')),
    last_error TEXT NOT NULL DEFAULT '',
    next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (request_id),
    FOREIGN KEY (host_id, thread_id) REFERENCES codex_threads (host_id, thread_id) ON DELETE RESTRICT
);

CREATE INDEX codex_title_operations_retry_idx
    ON codex_title_operations (state, next_retry_at, updated_at);

CREATE TABLE codex_project_mappings (
    host_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    loomhelm_project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    created_by TEXT NOT NULL REFERENCES auth_users (id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (host_id, project_id),
    FOREIGN KEY (host_id, project_id) REFERENCES codex_projects (host_id, project_id) ON DELETE CASCADE
);

CREATE TABLE codex_thread_links (
    host_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
    session_id TEXT NOT NULL REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
    linked_by TEXT NOT NULL REFERENCES auth_users (id) ON DELETE RESTRICT,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (host_id, thread_id),
    UNIQUE (task_id),
    UNIQUE (session_id),
    UNIQUE (request_id),
    FOREIGN KEY (host_id, thread_id) REFERENCES codex_threads (host_id, thread_id) ON DELETE RESTRICT
);

CREATE TABLE codex_thread_history (
    host_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    event_id TEXT NOT NULL CHECK (length(trim(event_id)) > 0),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    event_type TEXT NOT NULL DEFAULT 'unknown',
    raw_payload TEXT NOT NULL,
    readable_fallback TEXT NOT NULL DEFAULT '',
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (host_id, thread_id, event_id),
    UNIQUE (host_id, thread_id, sequence),
    FOREIGN KEY (host_id, thread_id) REFERENCES codex_threads (host_id, thread_id) ON DELETE CASCADE
);

CREATE INDEX codex_thread_history_sequence_idx
    ON codex_thread_history (host_id, thread_id, sequence);

CREATE TABLE codex_thread_files (
    host_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    path TEXT NOT NULL CHECK (length(trim(path)) > 0),
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
    sha256 TEXT NOT NULL DEFAULT '',
    content_bytes BYTEA,
    content_ref TEXT NOT NULL DEFAULT '',
    complete BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (host_id, thread_id, path),
    CHECK (content_bytes IS NOT NULL OR length(trim(content_ref)) > 0 OR complete = FALSE),
    FOREIGN KEY (host_id, thread_id) REFERENCES codex_threads (host_id, thread_id) ON DELETE CASCADE
);

CREATE TABLE codex_sync_snapshots (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    host_id TEXT NOT NULL REFERENCES codex_sync_sources (host_id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('source', 'projects', 'threads', 'thread')),
    thread_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('never', 'syncing', 'complete', 'partial', 'stale', 'failed')),
    complete BOOLEAN NOT NULL DEFAULT FALSE,
    as_of TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cursor TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((scope = 'thread' AND thread_id IS NOT NULL) OR (scope <> 'thread' AND thread_id IS NULL)),
    FOREIGN KEY (host_id, thread_id) REFERENCES codex_threads (host_id, thread_id) ON DELETE CASCADE
);

CREATE INDEX codex_sync_snapshots_host_idx
    ON codex_sync_snapshots (host_id, scope, updated_at DESC);

-- +goose Down
DROP TABLE IF EXISTS codex_sync_snapshots;
DROP TABLE IF EXISTS codex_title_operations;
DROP TABLE IF EXISTS codex_thread_files;
DROP TABLE IF EXISTS codex_thread_history;
DROP TABLE IF EXISTS codex_thread_links;
DROP TABLE IF EXISTS codex_project_mappings;
DROP TABLE IF EXISTS codex_threads;
DROP TABLE IF EXISTS codex_projects;
DROP TABLE IF EXISTS codex_sync_sources;
DROP INDEX IF EXISTS execution_sessions_host_thread_idx;
CREATE UNIQUE INDEX execution_sessions_external_thread_idx ON execution_sessions (external_thread_ref);
