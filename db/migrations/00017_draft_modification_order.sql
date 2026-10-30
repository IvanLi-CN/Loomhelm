-- +goose Up
SET LOCAL lock_timeout = '5s';

ALTER TABLE conversation_drafts
    ADD COLUMN modification_physical_ms BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN modification_logical_counter BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN modification_client_id TEXT NOT NULL DEFAULT '';

ALTER TABLE conversation_drafts
    ADD CONSTRAINT conversation_drafts_modification_order_check
        CHECK (
            (modification_physical_ms = 0 AND modification_logical_counter = 0 AND modification_client_id = '')
            OR
            (modification_physical_ms > 0 AND modification_logical_counter >= 0 AND length(trim(modification_client_id)) > 0)
        ) NOT VALID;

ALTER TABLE conversation_draft_mutations
    ADD COLUMN modification_physical_ms BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN modification_logical_counter BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN modification_client_id TEXT NOT NULL DEFAULT '';

ALTER TABLE conversation_draft_mutations
    ADD CONSTRAINT conversation_draft_mutations_modification_order_check
        CHECK (
            (modification_physical_ms = 0 AND modification_logical_counter = 0 AND modification_client_id = '')
            OR
            (modification_physical_ms > 0 AND modification_logical_counter >= 0 AND length(trim(modification_client_id)) > 0)
        ) NOT VALID;

-- +goose StatementBegin
CREATE FUNCTION loomhelm_require_nonzero_draft_modification_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.modification_physical_ms <= 0
       OR NEW.modification_logical_counter < 0
       OR length(trim(NEW.modification_client_id)) = 0 THEN
        RAISE EXCEPTION 'draft writers must persist a non-zero modification order'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER conversation_drafts_modification_order_fence
    BEFORE INSERT OR UPDATE ON conversation_drafts
    FOR EACH ROW
    EXECUTE FUNCTION loomhelm_require_nonzero_draft_modification_order();

CREATE TRIGGER conversation_draft_mutations_modification_order_fence
    BEFORE INSERT ON conversation_draft_mutations
    FOR EACH ROW
    EXECUTE FUNCTION loomhelm_require_nonzero_draft_modification_order();

-- +goose Down
DROP TRIGGER IF EXISTS conversation_draft_mutations_modification_order_fence ON conversation_draft_mutations;
DROP TRIGGER IF EXISTS conversation_drafts_modification_order_fence ON conversation_drafts;
DROP FUNCTION IF EXISTS loomhelm_require_nonzero_draft_modification_order();
ALTER TABLE conversation_draft_mutations DROP CONSTRAINT IF EXISTS conversation_draft_mutations_modification_order_check;
ALTER TABLE conversation_drafts DROP CONSTRAINT IF EXISTS conversation_drafts_modification_order_check;
ALTER TABLE conversation_draft_mutations
    DROP COLUMN IF EXISTS modification_physical_ms,
    DROP COLUMN IF EXISTS modification_logical_counter,
    DROP COLUMN IF EXISTS modification_client_id;
ALTER TABLE conversation_drafts
    DROP COLUMN IF EXISTS modification_physical_ms,
    DROP COLUMN IF EXISTS modification_logical_counter,
    DROP COLUMN IF EXISTS modification_client_id;
