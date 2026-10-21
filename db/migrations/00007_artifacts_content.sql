-- +goose Up
CREATE TABLE conversation_artifacts (
    id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    session_id TEXT NOT NULL CHECK (session_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    run_id TEXT CHECK (run_id IS NULL OR run_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    name TEXT NOT NULL CHECK (length(name) > 0 AND length(name) <= 1024),
    kind TEXT NOT NULL CHECK (kind IN ('file', 'diff', 'snapshot')),
    size BIGINT NOT NULL CHECK (size >= 0),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content_type TEXT NOT NULL CHECK (length(content_type) > 0 AND length(content_type) <= 255),
    created_at TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'unavailable')),
    staging_name TEXT NOT NULL CHECK (staging_name ~ '^\.upload-[A-Za-z0-9_-]+$'),
    staging_reclaimed_at TIMESTAMPTZ,
    staging_reclaim_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unavailable_reason TEXT NOT NULL DEFAULT '' CHECK (length(unavailable_reason) <= 128)
);

CREATE TABLE conversation_artifact_staging_cleanup (
    staging_name TEXT PRIMARY KEY CHECK (staging_name ~ '^\.upload-[A-Za-z0-9_-]+$'),
    retry_after TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX conversation_artifacts_session_idx ON conversation_artifacts (session_id, created_at, id);
CREATE INDEX conversation_artifacts_run_idx ON conversation_artifacts (run_id, created_at, id) WHERE run_id IS NOT NULL;
CREATE INDEX conversation_artifacts_pending_idx ON conversation_artifacts (staging_reclaim_after, created_at, id) WHERE state = 'pending';
CREATE INDEX conversation_artifacts_ready_staging_idx ON conversation_artifacts (staging_reclaim_after, created_at, id) WHERE state = 'ready' AND staging_reclaimed_at IS NULL;
CREATE INDEX conversation_artifact_staging_cleanup_retry_idx ON conversation_artifact_staging_cleanup (retry_after, staging_name);

-- Session and Run ownership foreign keys are intentionally added by a follow-up
-- migration after the E01 business schema is published on the parent branch.

-- +goose Down
DROP TABLE IF EXISTS conversation_artifact_staging_cleanup;
DROP TABLE IF EXISTS conversation_artifacts;
