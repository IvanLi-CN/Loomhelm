# Empirical Acceptance Review Gate Implementation

> Current requirements remain in `./SPEC.md`. This document records the intended implementation boundary and verification coverage for the accepted contract.

## Current Status

- Implementation: 已完成 phase-aware contract (4/4)
- Lifecycle: active
- Catalog note: Candidate-bound empirical acceptance is required before review and delivery readiness when deterministic local validation cannot prove the criterion.

## Implementation Coverage

- Evidence cards follow the shared workflow's evidence-placement invariant. The legacy single Candidate card remains compatible only as `pre_merge`. The existing flow receipt records later-phase evidence with `merge_sha` and, when applicable, `deployment_identity`.
- `CONTEXT.md`: defines the shared empirical-acceptance vocabulary.
- `skills/dev-plan/SKILL.md` and `bin/plan_contract_check.ts`: require a proofability disposition and rationale; required plans name observable scenarios and expected results.
- `skills/project-engineering-workflow/references/empirical-acceptance-short-contract.md` defines the phase-aware evidence card, admission, regression, and anchor rules; the shared workflow and direct-flow consumers point to it.
- `bin/flow_receipt.py`: normalizes explicit acceptance phases, rejects ambiguous historical manifests, and binds pre-merge evidence to the Candidate. It records post-merge/post-deploy evidence only after the matching Merge Receipt exists. Post-deploy evidence requires a structured `deployment_identity` whose source and bound SHA both equal the Merge Receipt SHA.
- `bin/plan_review_view.ts`: derives separate pre-merge and post-merge acceptance cards from the one canonical manifest; each card preserves ID, scope, proof target, pass conditions, evidence, and the applicable trigger without creating a second machine registry.
- `bin/test_agent_profiles.py`: models current evidence, stale identity, diagnosis-only regressions, and anchor matching.
- The migration disposition replay retains failed acceptance as a blocker even when the baseline limitation was accepted.
- `bin/instruction_architecture_check.py` and plan fixtures: guard every direct consumer and the new topic contract.
- `bin/plan_acceptance_manifest.py` rejects exact or embedded empirical scenario/expected assertion placeholders; direct manifest tests cover that parser boundary.
- `ReviewReplay` in `bin/test_agent_profiles.py` rejects blank/sentinel evidence locators and same-Candidate regression comparisons before diagnosis-only classification.

## Verification Coverage

- Contract checks assert that every direct-flow consumer carries the same empirical readiness and regression semantics.
- Lifecycle replay checks assert phase, Candidate/merge/deployment identity SHA lineage, acceptance-contract digest freshness, required scenario evidence, and complete continuation anchors. `replay/phase-closeout-cases.jsonl` drives closeout negatives for pending post-merge evidence, a mismatched merge SHA, and Candidate-only evidence presented after merge.
- Disposition replay checks assert that external-behavior changes return to design and that empirical regressions remain diagnosis-only.

## Remaining Gaps

- Deterministic direct-plan, receipt, projection, and replay coverage is implemented. Live external-system execution remains intentionally outside dot-codex and is supplied by the calling project when an obligation is applicable.

## Related Changes

- [ADR 0033](../../adr/0033-empirical-acceptance-and-repair-autonomy.md)
- [ADR 0032](../../adr/0032-phase-aware-acceptance-gates.md)

## References

- `./SPEC.md`
- `./HISTORY.md`
