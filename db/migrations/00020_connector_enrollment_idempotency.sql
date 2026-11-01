-- +goose Up
ALTER TABLE host_registrations
    ADD COLUMN connector_device_authorization_id TEXT
        REFERENCES connector_device_authorizations (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX host_registrations_connector_device_idx
    ON host_registrations (connector_device_authorization_id)
    WHERE connector_device_authorization_id IS NOT NULL;

ALTER TABLE host_credentials
    ADD COLUMN connector_device_authorization_id TEXT
        REFERENCES connector_device_authorizations (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX host_credentials_connector_device_idx
    ON host_credentials (connector_device_authorization_id)
    WHERE connector_device_authorization_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS host_credentials_connector_device_idx;
ALTER TABLE host_credentials
    DROP COLUMN IF EXISTS connector_device_authorization_id;
DROP INDEX IF EXISTS host_registrations_connector_device_idx;
ALTER TABLE host_registrations
    DROP COLUMN IF EXISTS connector_device_authorization_id;
