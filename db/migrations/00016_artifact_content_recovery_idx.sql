-- +goose Up
CREATE INDEX conversation_artifacts_content_mismatch_idx
    ON conversation_artifacts (staging_reclaim_after, created_at, id)
    WHERE state = 'unavailable' AND unavailable_reason = 'content-mismatch';

-- +goose Down
DROP INDEX IF EXISTS conversation_artifacts_content_mismatch_idx;
