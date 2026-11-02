-- +goose Up
CREATE TABLE deployment_installations (
    id TEXT PRIMARY KEY CHECK (id = 'default'),
    active_slot TEXT NOT NULL DEFAULT '' CHECK (active_slot IN ('', 'blue', 'green')),
    active_candidate_id TEXT NOT NULL DEFAULT '',
    active_fingerprint TEXT NOT NULL DEFAULT '',
    active_operation_id TEXT NOT NULL DEFAULT '',
    next_worker_generation BIGINT NOT NULL DEFAULT 1 CHECK (next_worker_generation > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO deployment_installations (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

CREATE TABLE deployment_candidates (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    source_sha TEXT NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
    artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    web_digest TEXT NOT NULL CHECK (web_digest ~ '^sha256:[0-9a-f]{64}$'),
    server_image TEXT NOT NULL CHECK (server_image ~ '^[A-Za-z0-9._/:@-]+@sha256:[0-9a-f]{64}$'),
    worker_image TEXT NOT NULL CHECK (worker_image ~ '^[A-Za-z0-9._/:@-]+@sha256:[0-9a-f]{64}$'),
    manifest JSONB NOT NULL,
    state_version BIGINT NOT NULL CHECK (state_version > 0),
    read_min BIGINT NOT NULL CHECK (read_min > 0),
    read_max BIGINT NOT NULL CHECK (read_max >= read_min),
    migration_mode TEXT NOT NULL DEFAULT 'none' CHECK (migration_mode IN ('none', 'expand')),
    status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'preflight_passed', 'staged', 'active', 'retained', 'failed', 'unknown')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE deployment_slots (
    slot TEXT PRIMARY KEY CHECK (slot IN ('blue', 'green')),
    state TEXT NOT NULL DEFAULT 'empty' CHECK (state IN ('empty', 'staging', 'staged', 'active', 'draining', 'retained', 'failed')),
    candidate_id TEXT REFERENCES deployment_candidates (id) ON DELETE RESTRICT,
    worker_generation BIGINT CHECK (worker_generation IS NULL OR worker_generation > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO deployment_slots (slot) VALUES ('blue'), ('green') ON CONFLICT (slot) DO NOTHING;

CREATE TABLE deployment_operations (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('preflight', 'stage', 'promote', 'rollback', 'drain', 'reconcile')),
    status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'running', 'succeeded', 'failed', 'degraded', 'unknown', 'reconciling', 'blocked')),
    candidate_id TEXT REFERENCES deployment_candidates (id) ON DELETE RESTRICT,
    slot TEXT CHECK (slot IS NULL OR slot IN ('blue', 'green')),
    target_operation_id TEXT REFERENCES deployment_operations (id) ON DELETE RESTRICT,
    actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) > 0),
    actor_credential_id TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 128),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    expected_fingerprint TEXT NOT NULL DEFAULT '',
    error_code TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (actor_user_id, idempotency_key)
);

CREATE INDEX deployment_operations_status_idx ON deployment_operations (status, updated_at, id);
CREATE INDEX deployment_operations_candidate_idx ON deployment_operations (candidate_id, created_at, id);

CREATE TABLE deployment_events (
    id BIGSERIAL PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES deployment_operations (id) ON DELETE RESTRICT,
    actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) > 0),
    type TEXT NOT NULL CHECK (length(trim(type)) > 0),
    candidate_id TEXT NOT NULL DEFAULT '',
    slot TEXT NOT NULL DEFAULT '' CHECK (slot IN ('', 'blue', 'green')),
    worker_generation BIGINT CHECK (worker_generation IS NULL OR worker_generation > 0),
    observed_fingerprint TEXT NOT NULL DEFAULT '',
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX deployment_events_operation_idx ON deployment_events (operation_id, id);
CREATE INDEX deployment_events_created_idx ON deployment_events (created_at, id);

CREATE TABLE deployment_roles (
    user_id TEXT PRIMARY KEY REFERENCES auth_users (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('deployment_observer', 'deployment_operator', 'deployment_releaser', 'deployment_recovery', 'installation_owner')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
