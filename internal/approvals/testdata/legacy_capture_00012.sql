DROP TRIGGER execution_approvals_history_capture ON execution_approvals;
DROP FUNCTION loomhelm_capture_approval_history();

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

CREATE TRIGGER execution_approvals_history_capture
AFTER INSERT OR UPDATE OR DELETE ON execution_approvals
FOR EACH ROW
EXECUTE FUNCTION loomhelm_capture_approval_history();
