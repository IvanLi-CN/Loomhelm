DROP TRIGGER execution_approvals_history_writer_guard ON execution_approvals;
DROP FUNCTION loomhelm_require_approval_history_writer();

CREATE FUNCTION loomhelm_require_approval_history_writer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('loomhelm.approval_writer_capability', true)
        IS DISTINCT FROM 'revision-history-v1' THEN
        NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER execution_approvals_history_writer_guard
BEFORE INSERT OR UPDATE OR DELETE ON execution_approvals
FOR EACH ROW
EXECUTE FUNCTION loomhelm_require_approval_history_writer();
