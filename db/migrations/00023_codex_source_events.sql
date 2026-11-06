-- +goose Up

-- Source notifications are acknowledged only after this durable record reaches
-- applied. It prevents a reconnect replay from being mistaken for a new event.
CREATE TABLE codex_source_events (
    host_id TEXT NOT NULL REFERENCES codex_sync_sources (host_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL CHECK (length(trim(event_id)) > 0),
    kind TEXT NOT NULL,
    thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
    raw_payload TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'applied', 'failed')),
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (host_id, event_id)
);

CREATE INDEX codex_source_events_recovery_idx
    ON codex_source_events (host_id, state, updated_at);

-- +goose Down
DROP TABLE IF EXISTS codex_source_events;
