-- +goose Up
CREATE TABLE host_registrations (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    singleton_key TEXT NOT NULL DEFAULT 'default' UNIQUE CHECK (singleton_key = 'default'),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'online')),
    connection_generation BIGINT NOT NULL DEFAULT 0 CHECK (connection_generation >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE host_credentials (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    host_id TEXT NOT NULL REFERENCES host_registrations (id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX host_credentials_host_idx ON host_credentials (host_id, created_at, id);

CREATE TABLE host_connections (
    host_id TEXT PRIMARY KEY REFERENCES host_registrations (id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL REFERENCES host_credentials (id) ON DELETE RESTRICT,
    generation BIGINT NOT NULL CHECK (generation > 0),
    connected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX host_connections_credential_idx ON host_connections (credential_id, host_id);

CREATE TABLE host_cursors (
    host_id TEXT NOT NULL REFERENCES host_registrations (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL CHECK (length(trim(session_id)) > 0),
    run_id TEXT NOT NULL DEFAULT '',
    cursor TEXT NOT NULL CHECK (octet_length(cursor) BETWEEN 1 AND 2048),
    observed_at TIMESTAMPTZ NOT NULL,
    cursor_retained_until TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (host_id, session_id, run_id)
);

CREATE INDEX host_cursors_retention_idx ON host_cursors (host_id, cursor_retained_until);

-- +goose Down
DROP TABLE IF EXISTS host_cursors;
DROP TABLE IF EXISTS host_connections;
DROP TABLE IF EXISTS host_credentials;
DROP TABLE IF EXISTS host_registrations;
