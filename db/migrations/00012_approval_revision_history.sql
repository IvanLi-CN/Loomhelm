-- +goose Up
LOCK TABLE execution_approvals IN SHARE MODE;

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

-- +goose StatementBegin
DO $$
DECLARE
    drift BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM execution_approvals AS current
        LEFT JOIN execution_approval_revisions AS history
          ON history.id = current.id AND history.revision = current.revision
        WHERE history.id IS NULL
           OR history.session_id IS DISTINCT FROM current.session_id
           OR history.run_id IS DISTINCT FROM current.run_id
           OR history.generation IS DISTINCT FROM current.generation
           OR history.kind IS DISTINCT FROM current.kind
           OR history.requested_at IS DISTINCT FROM current.requested_at
           OR history.status IS DISTINCT FROM current.status
           OR history.summary IS DISTINCT FROM current.summary
           OR history.context IS DISTINCT FROM current.context
           OR history.resolved_by_command_id IS DISTINCT FROM current.resolved_by_command_id
           OR history.requested_event_id IS DISTINCT FROM current.requested_event_id
           OR history.resolved_at IS DISTINCT FROM current.resolved_at
    ) INTO drift;
    IF drift THEN
        RAISE EXCEPTION 'execution approval projection/history backfill is inconsistent';
    END IF;
END
$$;
-- +goose StatementEnd

CREATE INDEX execution_approval_revisions_run_cursor_idx
    ON execution_approval_revisions (run_id, created_at, id, revision);
CREATE INDEX execution_approval_revisions_requested_event_idx
    ON execution_approval_revisions (requested_event_id)
    WHERE requested_event_id <> '';

-- +goose StatementBegin
CREATE FUNCTION loomhelm_require_approval_history_writer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('loomhelm.approval_writer_capability', true)
        IS DISTINCT FROM 'revision-history-v1' THEN
        RAISE EXCEPTION 'approval projection writes require revision-history capability'
            USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER execution_approvals_history_writer_guard
BEFORE INSERT OR UPDATE OR DELETE ON execution_approvals
FOR EACH ROW
EXECUTE FUNCTION loomhelm_require_approval_history_writer();

-- +goose Down
DROP TRIGGER IF EXISTS execution_approvals_history_writer_guard ON execution_approvals;
DROP FUNCTION IF EXISTS loomhelm_require_approval_history_writer();
DROP INDEX IF EXISTS execution_approval_revisions_requested_event_idx;
DROP INDEX IF EXISTS execution_approval_revisions_run_cursor_idx;
DROP TABLE IF EXISTS execution_approval_revisions;
