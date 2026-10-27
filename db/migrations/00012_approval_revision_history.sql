-- +goose Up
CREATE TABLE execution_approval_revisions (
    id TEXT NOT NULL CHECK (length(trim(id)) > 0),
    revision BIGINT NOT NULL CHECK (revision > 0),
    session_id TEXT NOT NULL REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL CHECK (length(trim(run_id)) > 0),
    generation TEXT NOT NULL CHECK (length(trim(generation)) > 0),
    kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    summary TEXT NOT NULL DEFAULT '',
    context BYTEA NOT NULL DEFAULT decode('7b7d', 'hex'),
    resolved_by_command_id TEXT NOT NULL DEFAULT '',
    requested_event_id TEXT NOT NULL DEFAULT '',
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, revision)
);

INSERT INTO execution_approval_revisions (
    id, revision, session_id, run_id, generation, kind, requested_at,
    status, summary, context, resolved_by_command_id, requested_event_id,
    resolved_at, created_at, updated_at
)
SELECT id, revision, session_id, run_id, generation, kind, requested_at,
       status, summary, context, resolved_by_command_id, requested_event_id,
       resolved_at, created_at, updated_at
FROM execution_approvals
ON CONFLICT (id, revision) DO NOTHING;

CREATE INDEX execution_approval_revisions_run_cursor_idx
    ON execution_approval_revisions (run_id, created_at, id, revision);
CREATE INDEX execution_approval_revisions_requested_event_idx
    ON execution_approval_revisions (requested_event_id)
    WHERE requested_event_id <> '';

-- +goose Down
DROP INDEX IF EXISTS execution_approval_revisions_requested_event_idx;
DROP INDEX IF EXISTS execution_approval_revisions_run_cursor_idx;
DROP TABLE IF EXISTS execution_approval_revisions;
