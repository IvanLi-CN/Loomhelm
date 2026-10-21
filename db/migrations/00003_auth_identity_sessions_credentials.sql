-- +goose Up
CREATE TABLE auth_users (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    issuer TEXT NOT NULL CHECK (length(issuer) > 0),
    subject TEXT NOT NULL CHECK (length(subject) > 0),
    email TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (issuer, subject)
);

CREATE TABLE auth_sessions (
    token TEXT PRIMARY KEY CHECK (length(token) > 0),
    data BYTEA NOT NULL,
    expiry TIMESTAMPTZ NOT NULL
);

CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expiry);

CREATE TABLE auth_api_credentials (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    token_hash BYTEA NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX auth_api_credentials_user_idx ON auth_api_credentials (user_id, created_at, id);

-- +goose Down
DROP TABLE IF EXISTS auth_api_credentials;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS auth_users;
