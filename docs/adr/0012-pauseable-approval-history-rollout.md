# ADR 0012: Pauseable approval history rollout

## Context

ADR 0011 establishes the durable approval revision-history contract, but its original rollout placed structural DDL, all-row history copying, consistency validation, indexes and the projection writer guard under one `SHARE` lock in migration 00012. That operation is not pauseable and would bind history volume to application startup and migration-lock duration.

Migration 00012 is not part of the mainline deployed state, so its unpublished implementation may be reworked. A database that already recorded the previous atomic 00012 must instead be recognized and adopted forward without changing Goose history, replaying version 12 or invoking `Down`.

## Decision

Migration 00012 performs only the short structural setup: the history table, durable phase/checkpoint/lease state, dirty-row queue, capture function and capture trigger. It does not copy historical rows, build history-volume indexes, run a full consistency scan or install the final projection writer guard.

The explicit approval-history migrator executes ordered operations for capture, bounded keyset backfill, bounded dirty-row pre-drain, non-blocking consistency validation, concurrent index construction and final cutover. Each backfill or pre-drain batch commits its data and checkpoint together. Cancellation, process exit and a released lease leave a recoverable phase and checkpoint; a repeated operation is idempotent.

The capture trigger mirrors every supported projection insert or update into the matching history revision and queues the stable approval ID in the same transaction. A writer that races a backfill row lock either waits for the batch and is captured afterward or commits its capture before the batch observes the row. This preserves concurrent old-writer changes without reconstructing revisions that were absent from the projection. Approval deletion is not a supported business mutation; capture rejects it rather than silently destroying or inventing history.

Validation drains dirty IDs in committed bounded batches and performs the full projection/history equality audit outside the final write lock. History indexes are built with `CREATE INDEX CONCURRENTLY` and are ready only when PostgreSQL reports valid and ready indexes with the expected definitions.

Cutover first completes the bounded pre-drain and validation, then records `cutover_requested`. It acquires `execution_approvals` `SHARE` only for the final drain and guard transition. The final transaction has both `lock_timeout` and `statement_timeout`, a strict dirty-row budget and a strict work budget. If the lock cannot be acquired, validation cannot finish or the queue exceeds either budget, the transaction rolls back, capture remains installed and the projection-only mode remains active. It never processes an unbounded dirty queue while holding the lock.

Within a successful cutover transaction, the remaining dirty IDs are reconciled, the writer guard is installed, the capture trigger is removed and the durable phase becomes `cutover_complete`. Writers that started before the lock are included by capture; writers queued after the lock fail before projection DML unless they set the history capability. New projection and history writes continue to commit atomically in one transaction.

The previously applied atomic 00012 layout is adopted only when Goose version 12 is recorded, the expected history columns exist, both original indexes are valid and ready, the original writer guard function and trigger are enabled, and a non-startup consistency audit succeeds. Adoption creates missing control metadata and marks `cutover_complete`; it does not rewrite Goose history, alter the old migration or run a down migration. Any unrecognized layout fails closed and requires forward repair.

## Compatibility and rollout

The mainline upgrade path is `00011 -> structural 00012 -> capture -> backfill -> validate -> concurrent indexes -> bounded cutover -> history-capable Server/Worker readiness`. The old slot remains ready during capture and backfill. A new Server or Worker candidate is not ready before `cutover_complete`, and startup readiness checks durable phase, structural facts, valid indexes, the enabled guard and an empty dirty queue without repeating a history-volume consistency scan.

After the first post-cutover history write, a projection-only switchback is unsupported. Recovery uses a compatible forward candidate or an explicit repair operation that preserves existing history. Backup restore remains separate disaster recovery.

## Consequences

Approval history transfer no longer blocks application startup for the size of the history table, and normal old projection writes continue during the long phase. The final writer drain is bounded and observable, but a busy or continuously mutating approval table can defer cutover until the owner chooses a larger budget or a quieter window.

The migration record must expose the operation sequence, phase, checkpoint, lease, progress, pause points, budgets and failure recovery. Direct PostgreSQL integration evidence must cover exact raw-byte transfer, concurrent old writers, pause/re-entry, index failure recovery, oversized dirty queues, bounded lock timeout, atomic adoption and fail-closed readiness.

## References

- [Durable approval revision history and cursor compatibility](0011-durable-approval-revision-history.md)
- [Approval history migration record](../../db/migrations/00012_approval_revision_history.migration.json)
- [Persistent-state migration policy](../../.agents/skills/persistent-state-migrations/SKILL.md)
