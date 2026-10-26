-- +goose Up
CREATE INDEX execution_approvals_run_created_idx
    ON execution_approvals (run_id, created_at, id);

-- +goose Down
DROP INDEX IF EXISTS execution_approvals_run_created_idx;
