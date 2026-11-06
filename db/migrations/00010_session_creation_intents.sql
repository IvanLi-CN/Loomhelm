-- +goose Up
ALTER TABLE execution_sessions
    ALTER COLUMN external_thread_ref DROP NOT NULL,
    ALTER COLUMN generation DROP NOT NULL;

ALTER TABLE execution_sessions
    DROP CONSTRAINT execution_sessions_external_thread_ref_check,
    DROP CONSTRAINT execution_sessions_generation_check;

ALTER TABLE execution_sessions
    ADD CONSTRAINT execution_sessions_external_thread_ref_check
        CHECK (external_thread_ref IS NULL OR length(trim(external_thread_ref)) > 0),
    ADD CONSTRAINT execution_sessions_generation_check
        CHECK (generation IS NULL OR length(trim(generation)) > 0);

ALTER TABLE execution_sessions
    ADD COLUMN creation_state TEXT NOT NULL DEFAULT 'confirmed'
        CHECK (creation_state IN ('pending', 'unknown', 'confirmed')),
    ADD COLUMN creation_command_id TEXT
        CHECK (creation_command_id IS NULL OR length(trim(creation_command_id)) > 0),
    ADD COLUMN creation_payload BYTEA
        CHECK (creation_payload IS NULL OR octet_length(creation_payload) > 0),
    ADD COLUMN creation_digest TEXT
        CHECK (creation_digest IS NULL OR creation_digest ~ '^[0-9a-f]{64}$'),
    ADD COLUMN creation_summary TEXT NOT NULL DEFAULT '',
    ADD COLUMN creation_unknown_reason TEXT NOT NULL DEFAULT '',
    ADD COLUMN creator_user_id TEXT REFERENCES auth_users (id) ON DELETE RESTRICT,
    ADD COLUMN host_id TEXT REFERENCES host_registrations (id) ON DELETE RESTRICT,
    ADD COLUMN creation_task_id TEXT REFERENCES tasks (id) ON DELETE RESTRICT;

ALTER TABLE execution_sessions
    ADD CONSTRAINT execution_sessions_creation_fields_check
        CHECK (
            (
                creation_state = 'confirmed'
                AND external_thread_ref IS NOT NULL
                AND generation IS NOT NULL
            )
            OR (
                creation_state IN ('pending', 'unknown')
                AND external_thread_ref IS NULL
                AND generation IS NULL
                AND creator_user_id IS NOT NULL
                AND host_id IS NOT NULL
                AND creation_command_id IS NOT NULL
                AND creation_payload IS NOT NULL
                AND creation_digest IS NOT NULL
            )
        );

CREATE UNIQUE INDEX execution_sessions_creator_command_idx
    ON execution_sessions (creator_user_id, creation_command_id)
    WHERE creator_user_id IS NOT NULL AND creation_command_id IS NOT NULL;
CREATE INDEX execution_sessions_creator_idx
    ON execution_sessions (creator_user_id, updated_at, id)
    WHERE creator_user_id IS NOT NULL;
CREATE INDEX execution_sessions_host_idx
    ON execution_sessions (host_id, updated_at, id)
    WHERE host_id IS NOT NULL;
CREATE INDEX execution_sessions_creation_task_idx
    ON execution_sessions (creation_task_id, updated_at, id)
    WHERE creation_task_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS execution_sessions_creation_task_idx;
DROP INDEX IF EXISTS execution_sessions_host_idx;
DROP INDEX IF EXISTS execution_sessions_creator_idx;
DROP INDEX IF EXISTS execution_sessions_creator_command_idx;
ALTER TABLE execution_sessions
    DROP CONSTRAINT IF EXISTS execution_sessions_creation_fields_check;
ALTER TABLE execution_sessions
    DROP COLUMN IF EXISTS creation_task_id,
    DROP COLUMN IF EXISTS host_id,
    DROP COLUMN IF EXISTS creator_user_id,
    DROP COLUMN IF EXISTS creation_unknown_reason,
    DROP COLUMN IF EXISTS creation_summary,
    DROP COLUMN IF EXISTS creation_digest,
    DROP COLUMN IF EXISTS creation_payload,
    DROP COLUMN IF EXISTS creation_command_id,
    DROP COLUMN IF EXISTS creation_state;
ALTER TABLE execution_sessions
    DROP CONSTRAINT IF EXISTS execution_sessions_external_thread_ref_check,
    DROP CONSTRAINT IF EXISTS execution_sessions_generation_check;
ALTER TABLE execution_sessions
    ALTER COLUMN external_thread_ref SET NOT NULL,
    ALTER COLUMN generation SET NOT NULL;
ALTER TABLE execution_sessions
    ADD CONSTRAINT execution_sessions_external_thread_ref_check
        CHECK (length(trim(external_thread_ref)) > 0),
    ADD CONSTRAINT execution_sessions_generation_check
        CHECK (length(trim(generation)) > 0);
