-- +goose Up
CREATE TABLE platform_worker_leases (
    lease_key TEXT PRIMARY KEY CHECK (length(lease_key) > 0),
    generation BIGINT NOT NULL CHECK (generation > 0),
    candidate_source_sha TEXT NOT NULL CHECK (length(candidate_source_sha) > 0),
    artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) > 0),
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- +goose Down
DROP TABLE IF EXISTS platform_worker_leases;
