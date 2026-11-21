---
name: local-merge-flow
description: "Fast local delivery to merge-ready without creating a PR."
disable-model-invocation: true
---

# Local merge flow

Use only for explicit `local-merge`, `no-pr`, or a currently locked local-merge run. Generic merge/continue language cannot switch another flow into this one.

## Authorization

- Execute `$project-engineering-workflow` Step 1-4 and Step 5L locally.
- Authorize local implementation, validation, signed-off commits, applicable contract sync, and fixes required by current local facts.
- Do not create/update/merge a PR or push. A read-only `gh` lookup is allowed only to resolve live base/head facts. A separately requested topic push is a narrow side path; it does not authorize PR creation.
- Record the Agent's Tier 1..4 review necessity assessment with rationale and no categorical rubric: Tier 1 needs no code review, Tier 2 is advisory only, Tier 3 requires one fresh comprehensive read-only sub-agent review, and Tier 4 adds one or two risk-selected specialist reviewers before Step 5L. Formal lane requests come from the parent flow; review output carries content evidence only.
- Before any Tier 3/4 lane launch, confirm Review Readiness: approved behavior, acceptance, scope, and required contracts settled, no design decision unresolved, and current-candidate validation plus applicable visual evidence complete. Tier 1/2 record only the assessment and rationale.
- Review disposition, repair-batch, and lane-refresh semantics come from `../project-engineering-workflow/references/review-proof-short-contract.md`: an `In-Scope Review Finding` is the only class that may enter the bounded Repair Batch, a `Design-Returning Review Finding` returns to design before fresh lanes review the changed candidate, and a `Review Observation` stays report-only. Missing or stale review output remains an `unchecked` evidence blocker.
- When `empirical_acceptance=required`, the same readiness check requires a passed current Candidate evidence card; missing, stale, failed, or unavailable evidence blocks Step 5L, and a failed run after a comparable pass is diagnosis-only and cannot open another Repair Batch.
- Step 5L consumes only `pre_merge` acceptance evidence bound to the Candidate SHA. This flow does not manufacture post-merge evidence: `post_merge` requires a real Merge Receipt and `merge_sha`, while `post_deploy` additionally requires a structured `deployment_identity` whose source and bound SHA match that merge. A local merge-ready state is not Flow Complete; missing deployment identity is an owner-action blocker.

## Stop conditions

1. Reach `Step 5L Ready` with current head/base validation and merge facts and stop for owner approval.
2. After explicit approval, refresh head/base/upstream facts and merge locally with `MODE=merge`. Conflicts or required history rewrite block.
3. Stop after merge with cleanup unperformed unless the owner explicitly selected `merge+cleanup`; cleanup is owned by `$git-cleanup MODE=local-merge`.

Unrelated dirty state may be preserved through an isolated merge worktree when facts prove it will not be touched. Never move or clean the user's work merely to satisfy this flow.

## Output

Report local merge readiness, merge result, cleanup result when applicable, current validation/merge SHA, and the single next gate. Include recovery fields only while blocked or non-terminal.
