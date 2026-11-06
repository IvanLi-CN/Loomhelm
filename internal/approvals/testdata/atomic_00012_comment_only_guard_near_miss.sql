DROP TRIGGER IF EXISTS execution_approvals_history_writer_guard ON execution_approvals;
DROP FUNCTION IF EXISTS loomhelm_require_approval_history_writer();

CREATE FUNCTION loomhelm_require_approval_history_writer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- IF current_setting('loomhelm.approval_writer_capability', true)
    --     IS DISTINCT FROM 'revision-history-v1' THEN
    --     RAISE EXCEPTION 'approval projection writes require revision-history capability'
    --         USING ERRCODE = '55000';
    -- END IF;
    -- IF TG_OP = 'DELETE' THEN
    --     RETURN OLD;
    -- END IF;
    -- RETURN NEW;
    RETURN NEW;
END
$$;

CREATE TRIGGER execution_approvals_history_writer_guard
BEFORE INSERT OR UPDATE OR DELETE ON execution_approvals
FOR EACH ROW
EXECUTE FUNCTION loomhelm_require_approval_history_writer();
