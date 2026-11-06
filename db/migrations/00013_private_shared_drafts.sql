-- +goose Up
CREATE TABLE conversation_drafts (
    session_id TEXT PRIMARY KEY REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    owner_user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE RESTRICT,
    content TEXT NOT NULL CHECK (octet_length(content) <= 1048576),
    revision BIGINT NOT NULL CHECK (revision > 0),
    mutation_id TEXT NOT NULL CHECK (length(trim(mutation_id)) > 0),
    client_id TEXT NOT NULL CHECK (length(trim(client_id)) > 0),
    client_sequence BIGINT NOT NULL CHECK (client_sequence >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE conversation_draft_mutations (
    session_id TEXT NOT NULL REFERENCES execution_sessions (id) ON DELETE RESTRICT,
    owner_user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE RESTRICT,
    mutation_id TEXT NOT NULL CHECK (length(trim(mutation_id)) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('update', 'consume')),
    client_id TEXT NOT NULL CHECK (length(trim(client_id)) > 0),
    client_sequence BIGINT NOT NULL CHECK (client_sequence >= 0),
    revision BIGINT NOT NULL CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, mutation_id)
);

CREATE UNIQUE INDEX conversation_draft_mutation_sequence_idx
    ON conversation_draft_mutations (session_id, owner_user_id, client_id, client_sequence)
    WHERE kind = 'update';

CREATE INDEX conversation_draft_mutations_owner_idx
    ON conversation_draft_mutations (session_id, owner_user_id, created_at, mutation_id);

-- +goose Down
DROP INDEX IF EXISTS conversation_draft_mutations_owner_idx;
DROP INDEX IF EXISTS conversation_draft_mutation_sequence_idx;
DROP TABLE IF EXISTS conversation_draft_mutations;
DROP TABLE IF EXISTS conversation_drafts;
