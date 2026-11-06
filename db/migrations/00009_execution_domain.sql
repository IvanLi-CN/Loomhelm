-- +goose Up
CREATE TABLE execution_sessions (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    external_thread_ref TEXT NOT NULL CHECK (length(trim(external_thread_ref)) > 0),
    path TEXT NOT NULL CHECK (path IN ('new', 'existing_active')),
    state TEXT NOT NULL DEFAULT 'starting' CHECK (state IN ('starting', 'active', 'reconciling', 'disconnected', 'closed', 'unsupported')),
    project_id TEXT REFERENCES projects (id) ON DELETE RESTRICT,
    generation TEXT NOT NULL CHECK (length(trim(generation)) > 0),
    last_cursor TEXT NOT NULL DEFAULT '',
    terminal_reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX execution_sessions_external_thread_idx ON execution_sessions (external_thread_ref);
CREATE INDEX execution_sessions_project_idx ON execution_sessions (project_id, updated_at, id);
CREATE INDEX execution_sessions_state_idx ON execution_sessions (state, updated_at, id);

CREATE TABLE execution_commands (
    command_id TEXT PRIMARY KEY CHECK (length(trim(command_id)) > 0),
    session_id TEXT NOT NULL REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    run_id TEXT CHECK (run_id IS NULL OR length(trim(run_id)) > 0),
    generation TEXT NOT NULL CHECK (length(trim(generation)) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('session.start', 'session.attach', 'run.send', 'run.approve', 'run.deny', 'run.interrupt')),
    issued_at TEXT NOT NULL DEFAULT '',
    payload BYTEA NOT NULL CHECK (octet_length(payload) > 0),
    digest TEXT NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'executing', 'succeeded', 'failed', 'unknown', 'rejected')),
    received_at TEXT NOT NULL,
    operation_id TEXT NOT NULL DEFAULT '',
    result BYTEA,
    error BYTEA,
    event_cursor TEXT NOT NULL DEFAULT '',
    reconciliation_state TEXT NOT NULL DEFAULT '' CHECK (reconciliation_state IN ('', 'confirmed', 'not_found', 'unknown')),
    reconciled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX execution_commands_session_idx ON execution_commands (session_id, created_at, command_id);
CREATE INDEX execution_commands_run_idx ON execution_commands (run_id, created_at, command_id) WHERE run_id IS NOT NULL;
CREATE INDEX execution_commands_state_idx ON execution_commands (state, updated_at, command_id);

CREATE TABLE execution_runs (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    session_id TEXT NOT NULL REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    command_id TEXT NOT NULL CHECK (length(trim(command_id)) > 0),
    generation TEXT NOT NULL CHECK (length(trim(generation)) > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted', 'unknown')),
    interrupt_state TEXT NOT NULL DEFAULT 'none' CHECK (interrupt_state IN ('none', 'requested', 'observed', 'superseded')),
    last_cursor TEXT NOT NULL DEFAULT '',
    terminal_reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX execution_runs_session_idx ON execution_runs (session_id, created_at, id);
CREATE INDEX execution_runs_status_idx ON execution_runs (status, updated_at, id);
CREATE INDEX execution_runs_command_idx ON execution_runs (command_id);

CREATE TABLE execution_events (
    event_id TEXT PRIMARY KEY CHECK (length(trim(event_id)) > 0),
    session_id TEXT NOT NULL REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    run_id TEXT CHECK (run_id IS NULL OR length(trim(run_id)) > 0),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    cursor TEXT NOT NULL CHECK (length(trim(cursor)) > 0),
    type TEXT NOT NULL CHECK (length(trim(type)) > 0),
    source TEXT NOT NULL CHECK (length(trim(source)) > 0),
    occurred_at TEXT NOT NULL,
    payload BYTEA NOT NULL CHECK (octet_length(payload) > 0),
    digest TEXT NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, sequence),
    UNIQUE (session_id, cursor)
);

CREATE INDEX execution_events_session_order_idx ON execution_events (session_id, sequence, event_id);
CREATE INDEX execution_events_run_order_idx ON execution_events (session_id, run_id, sequence, event_id);
CREATE INDEX execution_events_type_idx ON execution_events (type, created_at, event_id);

CREATE TABLE execution_approvals (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    session_id TEXT NOT NULL REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL CHECK (length(trim(run_id)) > 0),
    generation TEXT NOT NULL CHECK (length(trim(generation)) > 0),
    kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
    requested_at TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    summary TEXT NOT NULL DEFAULT '',
    context BYTEA NOT NULL DEFAULT decode('7b7d', 'hex'),
    resolved_by_command_id TEXT NOT NULL DEFAULT '',
    requested_event_id TEXT NOT NULL DEFAULT '',
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX execution_approvals_session_run_idx ON execution_approvals (session_id, run_id, status, revision, id);
CREATE INDEX execution_approvals_pending_idx ON execution_approvals (status, updated_at, id) WHERE status = 'pending';

CREATE TABLE execution_control_leases (
    lease_key TEXT PRIMARY KEY CHECK (length(trim(lease_key)) > 0),
    session_id TEXT NOT NULL REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL CHECK (length(trim(run_id)) > 0),
    generation TEXT NOT NULL CHECK (length(trim(generation)) > 0),
    owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
    candidate_source_sha TEXT NOT NULL CHECK (length(trim(candidate_source_sha)) > 0),
    artifact_digest TEXT NOT NULL CHECK (length(trim(artifact_digest)) > 0),
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX execution_control_leases_run_idx ON execution_control_leases (session_id, run_id, generation);
CREATE INDEX execution_control_leases_expiry_idx ON execution_control_leases (expires_at, lease_key);

-- +goose Down
DROP TABLE IF EXISTS execution_control_leases;
DROP TABLE IF EXISTS execution_approvals;
DROP TABLE IF EXISTS execution_events;
DROP TABLE IF EXISTS execution_runs;
DROP TABLE IF EXISTS execution_commands;
DROP TABLE IF EXISTS execution_sessions;
