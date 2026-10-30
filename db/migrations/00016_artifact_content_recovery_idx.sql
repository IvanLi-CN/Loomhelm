-- +goose NO TRANSACTION

-- +goose Up
DROP INDEX CONCURRENTLY IF EXISTS conversation_artifacts_content_mismatch_idx;

CREATE INDEX CONCURRENTLY conversation_artifacts_content_mismatch_idx
    ON conversation_artifacts (staging_reclaim_after, created_at, id)
    WHERE state = 'unavailable' AND unavailable_reason = 'content-mismatch';

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS conversation_artifacts_content_mismatch_idx;
