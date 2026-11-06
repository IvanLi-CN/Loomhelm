---
name: local-merge-flow
description: "Fast local delivery to merge-ready without creating a PR."
---

# Local merge flow

Use only for explicit `local-merge`, `no-pr`, or a currently locked local-merge run. Generic merge/continue language cannot switch another flow into this one.

## Authorization

- Execute `$project-engineering-workflow` Step 1-4 and Step 5L locally.
- Authorize local implementation, validation, signed-off commits, applicable contract sync, and fixes required by current local facts. The Agent records a Tier 1..4 review necessity assessment with no categorical rubric: Tier 1 needs no code review, Tier 2 is advisory only, Tier 3 requires fresh clear read-only-sub-agent four-lane current-head review evidence, and Tier 4 requires those lanes plus one or two selected dynamic lanes before Step 5L.
- Do not create/update/merge a PR or push. A read-only `gh` lookup is allowed only to resolve live base/head facts.
- Review disposition semantics come from the shared `../project-engineering-workflow/references/review-proof-short-contract.md` contract.
- Before any Tier 3/4 lane launch, confirm Review Readiness: approved behavior, acceptance, scope, and required contracts are settled; no design decision is unresolved; and current-candidate validation plus applicable visual evidence are complete. Tier 1/2 record only their assessment and rationale.
- When `empirical_acceptance=required`, the same readiness check requires a passed current Candidate evidence card. Missing, stale, failed, or unavailable evidence blocks Step 5L; a failed run after a comparable pass is diagnosis-only and cannot open another Repair Batch.
- Step 5L consumes only `pre_merge` acceptance evidence bound to the Candidate SHA. This flow does not manufacture post-merge evidence: `post_merge` requires a real Merge Receipt and `merge_sha`, while `post_deploy` additionally requires a structured `deployment_identity` whose source and bound SHA match that merge. A local merge-ready state is not Flow Complete; missing deployment identity is an owner-action blocker.
- A Design-Returning Review Finding stops ordinary repair/review convergence; resolve the design and launch fresh formal lanes for the changed candidate. A Review Observation remains report-only, and an In-Scope Review Finding is the only class that may enter the bounded Repair Batch. Missing or stale review output remains an `unchecked` evidence blocker.
- A separately requested topic push is a narrow side path; it does not authorize PR creation.

## Stop conditions

1. Reach `Step 5L Ready` with current head/base validation and merge facts and stop for owner approval.
2. After explicit approval, refresh head/base/upstream facts and merge locally with `MODE=merge`. Conflicts or required history rewrite block.
3. Stop after merge with cleanup unperformed unless the owner explicitly selected `merge+cleanup`; cleanup is owned by `$git-cleanup MODE=local-merge`.

Unrelated dirty state may be preserved through an isolated merge worktree when facts prove it will not be touched. Never move or clean the user's work merely to satisfy this flow.

## Output

Report local merge readiness, merge result, cleanup result when applicable, current validation/merge SHA, and the single next gate. Include recovery fields only while blocked or non-terminal.
