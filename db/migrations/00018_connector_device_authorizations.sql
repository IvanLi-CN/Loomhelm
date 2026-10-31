-- +goose Up
CREATE TABLE connector_device_authorizations (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    user_code_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(user_code_hash) = 32),
    redirect_uri TEXT NOT NULL CHECK (length(trim(redirect_uri)) > 0),
    state TEXT NOT NULL CHECK (length(state) BETWEEN 16 AND 256),
    expires_at TIMESTAMPTZ NOT NULL,
    authorized_user_id TEXT REFERENCES auth_users (id) ON DELETE CASCADE,
    authorization_code_hash BYTEA UNIQUE CHECK (authorization_code_hash IS NULL OR octet_length(authorization_code_hash) = 32),
    authorized_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX connector_device_authorizations_expiry_idx
    ON connector_device_authorizations (expires_at);

-- +goose Down
DROP TABLE IF EXISTS connector_device_authorizations;
