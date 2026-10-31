# ADR 0011: Durable approval revision history and cursor compatibility

> Superseded for rollout mechanics by [ADR 0012: Pauseable approval history rollout](0012-pauseable-approval-history-rollout.md); the durable approval and cursor contract recorded below remains the historical decision being refined.

## Context

The execution approval row is a current compare-and-set projection keyed by the stable native request identity. A later approval.requested event can reuse that identity with a higher revision, but replacing the current row cannot expose the earlier status, raw context or requested-event identity. Migration 00011 added only a projection index, so it does not prove or preserve same-ID revision history.

The public approval record must keep the stable public/native approval ID and existing response fields. A list cursor must remain opaque and Run-bound while distinguishing rows that share an ID or timestamp. Existing deployments may contain only one durable projection row for an approval ID; the system must not invent revisions that the old writer discarded.

## Decision

Keep `execution_approvals` as the current CAS projection keyed by stable approval ID and add an append-only `execution_approval_revisions` table keyed by `(id, revision)`. Every revision observed after migration 00012 is written as an immutable history snapshot containing the session, Run, generation, stable ID, revision, kind, requested time, status, summary, raw context, optional requested event ID, resolver command and resolution time. The current projection and its corresponding new history row or history update commit in the same transaction.

Migration 00012 runs in one transaction and first acquires a `SHARE` lock on `execution_approvals`, so projection writes already in flight are included in the snapshot and conflicting old writers queue behind the cutover. It creates the history table, backfills exactly one history snapshot from each existing current projection row at its persisted revision, validates projection/history equality, and installs a trigger that rejects projection DML without the transaction-local `revision-history-v1` capability. It does not reconstruct revisions that are absent from the projection, and it remains additive, forward-repairable and non-reversible in deployment. A new writer fails closed when the current projection has no matching history row or when its current revision/state does not agree with history; a projection-only writer queued after the cutover is rejected before its DML.

Approval history reads use cursor version 2 encoded inside the existing opaque cursor field. The stable keyset is `(created_at, id, revision)` and the Run ID remains bound in the cursor. A legacy version-1 cursor containing only `(created_at, id)` is accepted only when the database proves exactly one history row for that Run and position and can recover its revision; malformed, cross-Run, missing or ambiguous legacy positions are rejected without guessing or silently skipping a row. Public approval IDs, list limits, authorization checks, response fields and exact current Run/generation/revision/CAS resolution semantics remain unchanged.

Create, revision advancement, expiration and resolution set the transaction-local capability before updating the projection and update history through the same transaction. The readiness gate checks the current-schema projection and history tables, required columns and history indexes, the enabled writer trigger, and projection/history consistency; failures block approval reads and writes and surface as unavailable. Retried approval.requested events are idempotent by requested event identity and exact creation identity; a resolved current revision cannot be reopened by a higher revision. Old history remains readable across execution generations, while writes remain fenced to the exact current generation and revision.

## Compatibility and rollout

The public compatibility classification is `public_api=minor`: the response shape and stable approval ID remain compatible, while the opaque cursor gains an explicit internal version and preserves a narrowly proven legacy decode path. The persistent-state classification is `persistent_state=minor`: migration 00012 is additive and old projection rows are readable, but older projection-only writers and older list implementations cannot provide complete same-ID revision semantics for newly written history.

The blue-green rollout applies migration 00012 and verifies that every existing projection row has exactly one matching backfilled history row and that the old-writer trigger is installed before admitting history-capable writes. New Server/Worker candidates then pass a writer-capability and schema-version readiness gate, and all old approval writers are drained and fenced before the first post-migration higher-revision write. Older binaries may remain in a non-writing drain window only; they are not an accepted rollback target after new revision history exists. A switchback is supported only before the first new history write, otherwise recovery proceeds through a forward-compatible candidate and the new writer's fail-closed projection/history guard.

## Consequences

Same-ID revisions are queryable without changing public identity, and equal timestamps are ordered without fabricated time values. History consumers must handle an opaque cursor version and explicit invalidation of ambiguous legacy positions. Migration evidence must cover exact backfill, re-entry, collision rollback, unchanged raw context and requested-event links, same-ID revisions, old-generation reads and rejection of projection-only state drift.

## References

- [Versioned public protocol and reconciliation boundary](0003-public-protocol-and-reconciliation.md)
- [Phase-one specification](../specs/phase1-core/SPEC.md)
- [Approval history migration record](../../db/migrations/00012_approval_revision_history.migration.json)
