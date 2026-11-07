# ADR 0028: Wave Thread Coordinator

- Status: Superseded by ADR 0029
- Successor: `docs/adr/0029-wave-thread-delivery-batches.md`
- Supersedes: `docs/adr/0011-parallel-direct-pr-flow.md` and the active coordination portions of `docs/specs/initiative-flow/`.
- Date: 2026-10-11

## Context

The former coordination flows split ownership across Initiative tickets, aggregate PRs, and an independent Parallel PR coordinator. That topology added state surfaces and made recovery depend on multiple ledgers. The delivery model needs one owner-facing parent conversation that can plan continuous waves, dispatch fresh task conversations, receive task events, and integrate sibling PRs without GitHub Stacked PR.

## Decision

Adopt `wave-thread-flow` as the only active multi-task coordinator. The parent conversation owns a parent branch, a parent PR, and conversation-local wave state; no coordination manifest is committed to the project. Each task conversation receives an envelope, works in an isolated worktree, and creates a direct child PR targeting the current parent branch. Same-wave children are siblings; dependencies are deferred to later waves after prerequisite merges.

Task progress is delivered by explicit structured messages. The parent does not poll, schedule a heartbeat, or infer completion from absence. A plan approval authorizes in-scope child dispatch, planned release checkpoints, and ready child merges. The final parent PR remains owner-controlled at Step 5C Ready.

Release checkpoints prefer a parent-branch non-production preview and use trunk-only publication only when repository policy offers no non-trunk route. The flow keeps the shared direct PR gates and does not create a Tracking Issue, aggregate PR, child PR chain, or runtime database.

## Consequences

Recovery has one durable source in the parent PR plus live GitHub PR facts and received messages. Event delivery is explicit and idempotent. Parent-branch changes invalidate stale child base evidence and force revalidation. Historical materials remain auditable but cannot be selected by new plans.
