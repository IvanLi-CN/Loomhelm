-- +goose Up
-- The 00007 artifact schema already provides the bounded unavailable_reason
-- column. This ordered marker activates the forward-only content recovery
-- semantics without rewriting the integrated 00007 migration or its state.
SELECT 1;

-- +goose Down
SELECT 1;
