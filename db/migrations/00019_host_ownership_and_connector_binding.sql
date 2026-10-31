-- +goose Up
ALTER TABLE host_registrations
    ALTER COLUMN singleton_key DROP NOT NULL,
    ALTER COLUMN singleton_key DROP DEFAULT;

ALTER TABLE host_registrations
    ADD COLUMN owner_user_id TEXT REFERENCES auth_users (id) ON DELETE RESTRICT;

CREATE INDEX host_registrations_owner_idx
    ON host_registrations (owner_user_id, created_at, id);

CREATE TABLE host_share_grants (
    host_id TEXT NOT NULL REFERENCES host_registrations (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
    granted_by TEXT NOT NULL REFERENCES auth_users (id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (host_id, user_id)
);

CREATE INDEX host_share_grants_user_active_idx
    ON host_share_grants (user_id, host_id)
    WHERE revoked_at IS NULL;

CREATE TABLE host_user_defaults (
    user_id TEXT PRIMARY KEY REFERENCES auth_users (id) ON DELETE CASCADE,
    host_id TEXT NOT NULL REFERENCES host_registrations (id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX host_user_defaults_host_idx
    ON host_user_defaults (host_id, user_id);

ALTER TABLE connector_device_authorizations
    ADD COLUMN requested_host_id TEXT REFERENCES host_registrations (id) ON DELETE RESTRICT,
    ADD COLUMN exchange_started_at TIMESTAMPTZ;

CREATE INDEX connector_device_authorizations_exchange_idx
    ON connector_device_authorizations (exchange_started_at)
    WHERE exchange_started_at IS NOT NULL AND consumed_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS connector_device_authorizations_exchange_idx;
ALTER TABLE connector_device_authorizations
    DROP COLUMN IF EXISTS exchange_started_at,
    DROP COLUMN IF EXISTS requested_host_id;
DROP TABLE IF EXISTS host_user_defaults;
DROP INDEX IF EXISTS host_share_grants_user_active_idx;
DROP TABLE IF EXISTS host_share_grants;
DROP INDEX IF EXISTS host_registrations_owner_idx;
ALTER TABLE host_registrations
    DROP COLUMN IF EXISTS owner_user_id,
    ALTER COLUMN singleton_key SET DEFAULT 'default',
    ALTER COLUMN singleton_key SET NOT NULL;
