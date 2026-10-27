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

CREATE TABLE execution_approval_history_migrations (
    migration_key TEXT PRIMARY KEY CHECK (length(trim(migration_key)) > 0),
    phase TEXT NOT NULL CHECK (phase IN (
        'structure_ready',
        'backfill_running',
        'backfill_paused',
        'backfill_complete',
        'failed',
        'validated',
        'indexes_ready',
        'cutover_requested',
        'cutover_complete',
        'repair_required'
    )),
    checkpoint_id TEXT NOT NULL DEFAULT '',
    rows_scanned BIGINT NOT NULL DEFAULT 0 CHECK (rows_scanned >= 0),
    rows_copied BIGINT NOT NULL DEFAULT 0 CHECK (rows_copied >= 0),
    dirty_rows_reconciled BIGINT NOT NULL DEFAULT 0 CHECK (dirty_rows_reconciled >= 0),
    lease_owner TEXT NOT NULL DEFAULT '',
    lease_expires_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE execution_approval_history_dirty (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    queued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO execution_approval_history_migrations (migration_key, phase)
VALUES ('approval-revision-history', 'structure_ready')
ON CONFLICT (migration_key) DO NOTHING;

-- +goose StatementBegin
CREATE FUNCTION loomhelm_capture_approval_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'approval deletion is not supported while revision history capture is active'
            USING ERRCODE = '55000';
    END IF;

    INSERT INTO execution_approval_revisions (
        id, revision, session_id, run_id, generation, kind, requested_at,
        status, summary, context, resolved_by_command_id, requested_event_id,
        resolved_at, created_at, updated_at
    )
    VALUES (
        NEW.id, NEW.revision, NEW.session_id, NEW.run_id, NEW.generation,
        NEW.kind, NEW.requested_at, NEW.status, NEW.summary, NEW.context,
        NEW.resolved_by_command_id, NEW.requested_event_id, NEW.resolved_at,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT (id, revision) DO UPDATE SET
        session_id = EXCLUDED.session_id,
        run_id = EXCLUDED.run_id,
        generation = EXCLUDED.generation,
        kind = EXCLUDED.kind,
        requested_at = EXCLUDED.requested_at,
        status = EXCLUDED.status,
        summary = EXCLUDED.summary,
        context = EXCLUDED.context,
        resolved_by_command_id = EXCLUDED.resolved_by_command_id,
        requested_event_id = EXCLUDED.requested_event_id,
        resolved_at = EXCLUDED.resolved_at,
        updated_at = CURRENT_TIMESTAMP;

    INSERT INTO execution_approval_history_dirty (id, queued_at)
    VALUES (NEW.id, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET queued_at = EXCLUDED.queued_at;

    RETURN NEW;
END
$$;
-- +goose StatementEnd

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

CREATE TRIGGER execution_approvals_history_capture
AFTER INSERT OR UPDATE OR DELETE ON execution_approvals
FOR EACH ROW
EXECUTE FUNCTION loomhelm_capture_approval_history();

-- +goose Down
DROP TRIGGER IF EXISTS execution_approvals_history_writer_guard ON execution_approvals;
DROP TRIGGER IF EXISTS execution_approvals_history_capture ON execution_approvals;
DROP FUNCTION IF EXISTS loomhelm_require_approval_history_writer();
DROP FUNCTION IF EXISTS loomhelm_capture_approval_history();
DROP TABLE IF EXISTS execution_approval_history_dirty;
DROP TABLE IF EXISTS execution_approval_history_migrations;
DROP TABLE IF EXISTS execution_approval_revisions;
