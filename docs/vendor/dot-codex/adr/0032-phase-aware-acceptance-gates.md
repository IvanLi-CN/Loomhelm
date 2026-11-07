# 0032 Phase-Aware Acceptance Gates

## Status

Accepted

## Context

Direct/v1 plans previously rendered acceptance as one undifferentiated list. That allowed a criterion whose truth depended on a merged commit, a release, or a deployment observation to be interpreted as a pre-merge readiness gate. It also made a Candidate-only evidence card appear sufficient for later closeout, even though the required merge or deployment identity did not exist.

The project workflow is trunk-only: both formal and informal releases are based on a pull request that has actually merged. `Step 5C Ready` is therefore a pre-merge handoff, not a release or deployment result.

## Decision

Use one canonical acceptance manifest with explicit `scope` and `phase` on all new direct/v1 items:

- `scope=plan` is the direct-plan scope.
- `phase=pre_merge` binds evidence to `candidate_sha` and is the only phase consumed by Review Readiness, PR convergence, and Step 5C.
- `phase=post_merge` binds evidence to the `merge_sha` in a real Merge Receipt.
- `phase=post_deploy` binds evidence to that same `merge_sha` and a structured `deployment_identity`. The identity carries the deployment ID, operation ID, external locator, provider provenance, observed state, and source/bound SHA fields equal to the Merge Receipt SHA.

Post-merge evidence is recorded through the existing flow receipt and ledger lifecycle. It does not create a second ledger, tracking issue, aggregate PR, or release entry point. A post-merge record is rejected until the matching Merge Receipt exists; a post-deploy record is rejected without deployment authority. Closeout remains blocked until all applicable later-phase items are proved. PR-bound Flow Complete also requires a registered canonical acceptance manifest; a missing manifest is an owner-action blocker rather than an empty acceptance set.

The owner-facing plan projection is derived from the canonical manifest and shows two phase headings: `PR 合并前验收` and `PR 合并后验收`. Each acceptance item is rendered as a readable card with its ID, scope when present, proof target, pass conditions, and evidence. Post-merge and post-deploy cards also show their applicable trigger rather than adding another phase column. Cards keep long evidence and assertion text in semantic lines, so the owner-facing view does not depend on equal-width table columns. This is a display projection only and never becomes a second machine contract. Wave Thread v2 keeps its existing batch/task graph and Mermaid projection.

Historical JSONL without phase is compatible only when its text has no merge, release, deployment, or observation ambiguity; it maps read-only to `plan/pre_merge`. Ambiguous history is rejected and is not auto-promoted to a later phase.

## Consequences

Review readiness can finish without waiting for facts that cannot exist before merge, while the flow cannot claim overall completion by silently dropping post-merge work. Missing deployment identity or mismatched SHA lineage is visible as an owner-action blocker. Deterministic tests can prove the identity transitions and rejection paths; this decision does not authorize real deployment or publication during plan validation.

## Rejected Alternatives

- Keep one implicit acceptance phase: rejected because it permits a later fact to block or falsely satisfy a pre-merge gate.
- Duplicate the manifest into separate pre/post registries: rejected because the two copies would drift; the cards remain projections of one manifest.
- Retain multi-column acceptance tables: rejected because long evidence and assertion text is difficult to scan when a renderer allocates narrow or equal-width columns; cards preserve the same facts with natural wrapping.
- Treat `merge-ready` as complete when no deployment is requested: rejected because trunk-only publication still requires an actual merge fact, and deployment applicability must be determined by the relevant post-merge contract rather than inferred from the pre-merge card.

## Verification

The manifest parser, contract checker, flow receipt, plan projection, profile replay model, and replay fixtures cover explicit phases, legacy ambiguity, Candidate-only evidence, merge-SHA binding, structured deployment identities, and the `merge-ready` versus `Flow Complete` boundary.
