-- +goose Up
CREATE TABLE conversation_draft_commands (
    command_id TEXT PRIMARY KEY REFERENCES execution_commands (command_id) ON DELETE RESTRICT,
    session_id TEXT NOT NULL REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    owner_user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE RESTRICT,
    expected_revision BIGINT NOT NULL CHECK (expected_revision > 0),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'consumed', 'preserved')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finalized_at TIMESTAMPTZ
);

CREATE INDEX conversation_draft_commands_pending_idx
    ON conversation_draft_commands (session_id, updated_at, command_id)
    WHERE state = 'pending';

-- +goose Down
DROP INDEX IF EXISTS conversation_draft_commands_pending_idx;
DROP TABLE IF EXISTS conversation_draft_commands;
