---
status: superseded
supersedes: 0003-external-fact-delivery-gates.md (review conclusion only)
superseded_by: 0013-review-necessity-tiering.md
---

# Mandatory Local Review Proof

ADR 0003 remains authoritative for CI, release, tracker, PR, and post-merge external facts. This successor changes only the review conclusion: direct delivery flows require a fresh, read-only-sub-agent local `ReviewReceipt` before the corresponding delivery gate can pass.

## Decision

- Direct PR creation, reuse, update, and receipt binding do not require review proof. Before Step 5C or PR merge, every direct PR must converge one fresh clear four-lane proof on its current live `base_sha` and `head_sha`. `local-merge` requires the same proof on its current local base/head before Step 5L or merge.
- A review runner failure, timeout, unavailable runner, malformed structured result, dirty reviewer worktree, stale base/head, or unresolved blocking finding is a blocker. There is no advisory fallback.
- Proof is transport-neutral. It is accepted only from a read-only sub-agent's structured terminal result, exact base/head binding, and clean candidate HEAD. The receipt helper does not execute a model. Child IDs, PTC wrappers, and transcript shape are not proof.
- Direct lane profiles are contract/Luna medium, state-concurrency/Luna xhigh, failure-data-safety/Luna max, and test-platform/Terra xhigh. Luna startup unavailability may use Terra medium and then Terra xhigh. Terra unavailability remains a blocker and cannot be silently replaced by Luna-only coverage.
- Review waves retain four to six lanes, explicit convergence reopen, and at most three repair permits. Any repair commit or PR base/head drift makes the prior proof stale. A clear wave is the only AI review proof: Step 5C then checks current PR facts, CI, validation, repository rules, and clean HEAD without running a second AI merge review.

## Compatibility

Schema v6 is the active receipt format. An active v5 ledger is migrated on its next relevant gate, with the prior review bytes retained as read-only `legacy_review` history. Migration never makes historical proof current.

`initiative-flow` keeps its independent review-proof state machine for legacy Initiative delivery. Wave Thread uses the review and evidence bindings defined by ADR 0029. This ADR applies to `normal`, `fast-track`, `local-merge`, and direct parallel-PR task flows only.
