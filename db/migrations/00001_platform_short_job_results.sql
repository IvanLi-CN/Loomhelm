-- +goose Up
CREATE TABLE platform_short_job_results (
    job_id BIGINT PRIMARY KEY,
    generation BIGINT NOT NULL CHECK (generation > 0),
    payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- +goose Down
DROP TABLE IF EXISTS platform_short_job_results;
