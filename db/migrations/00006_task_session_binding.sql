-- +goose Up
CREATE UNIQUE INDEX IF NOT EXISTS tasks_session_id_unique_idx
    ON tasks (session_id)
    WHERE session_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS tasks_session_id_unique_idx;
