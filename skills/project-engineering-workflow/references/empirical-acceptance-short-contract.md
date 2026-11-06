# Empirical Acceptance Short Contract

Use this contract whenever the current direct plan declares `empirical_acceptance=required`. It supplements, and never replaces, ordinary validation, CI, visual evidence, or direct review proof.

## Evidence card

The main Agent keeps one current Candidate card under the shared workflow's evidence-placement rule. The legacy single-card shape remains readable, but it is always mapped to `pre_merge`; it can never satisfy a post-merge or post-deploy obligation. New phase-aware records retain the same digests and locator and add `acceptance_id`, `phase`, and the identity required by that phase.

```text
empirical_acceptance=required|not_required
empirical_acceptance_rationale=<non-empty proofability rationale>
empirical_evidence_status=passed|failed|unavailable|not_required
empirical_candidate_sha=<current Candidate SHA>|none
acceptance_contract_digest=<accepted behavior/acceptance digest>|none
scenario_set_digest=<required observable scenario-set digest>|none
evidence_locator=<inspectable run/log/artifact locator>|none
```

Phase-aware evidence uses this identity contract:

```text
acceptance_id=<manifest acceptance ID>
phase=pre_merge|post_merge|post_deploy
candidate_sha=<Candidate SHA>                     # pre_merge only
merge_sha=<actual Merge Receipt SHA>               # post_merge/post_deploy
deployment_identity=<structured deployment identity object> # post_deploy only
```

`deployment_identity` is not a free-form label. It is a structured deployment identity containing `deployment_id`, `source_sha`, `bound_sha`, `relationship`, `provenance_boundary`, `evidence_source`, `operation_id`, `observed_state`, and `external_locator`. The receipt must use `relationship=deployed-from`, `provenance_boundary=deployment-provider`, `evidence_source=deployment-receipt`, and `observed_state=verified`. Both SHA fields must equal the actual Merge Receipt `merge_sha`. Both SHA fields must equal the actual Merge Receipt `merge_sha`. The structured identity is checked for its required deployment fields and lineage; an absent or mismatched identity cannot produce post-deploy evidence.

`not_required` uses `empirical_evidence_status=not_required` and `none` for the remaining evidence identity fields. `required` uses a non-empty value for every remaining field and requires `empirical_candidate_sha` to equal the current Candidate for `pre_merge`. Post-merge evidence is admitted only after a real Merge Receipt exists and its `merge_sha` matches. Post-deploy evidence additionally requires the structured deployment identity above, bound to that same merge SHA. These later records do not block Review Readiness or the pre-merge Step 5C gate; they remain pending until their lifecycle phase. PR-bound Flow Complete still requires the canonical acceptance manifest to exist; an absent manifest is an owner-action blocker and is not equivalent to having no post-merge obligations.

## Admission

- `passed` is valid only when the Candidate SHA, acceptance-contract digest, scenario-set digest, and evidence locator are current and inspectable.
- A Candidate SHA, accepted behavior/acceptance contract, or required scenario set change makes the prior card stale. A stale card is blocked, not reused.
- `unavailable` blocks the gate but is not an empirical regression. It records an inability to observe the required evidence, not a guessed product cause.
- A missing, malformed, or mismatched `pre_merge` card blocks Review Readiness, Step 5C, and Step 5L. A missing post-merge or post-deploy record blocks only its applicable post-merge closeout and remains an explicit owner-action blocker. It does not create a Repair Batch.

## Review and regression disposition

- A proposed repair that changes external-response assumptions, timing, timeout, retry, permission/state transition, or acceptance semantics is `Design-Returning` unless the settled contract already specifies the exact correction and current evidence demonstrates a violation.
- A `failed` card for a Candidate after a comparable Candidate passed the same contract is an `Empirical Regression`. The flow records both Candidate SHAs, compares their relevant Git delta once, and enters diagnosis-only handling.
- Diagnosis-only handling does not launch a new ordinary Repair Batch, formal review wave, or acceptance relaxation. It also does not attribute the failure to a reviewer or repair without evidence.

## Continuation anchor

An anchor for an applicable obligation carries the complete phase-aware card fields plus `repair_batches_used`. Generic continuation must match the current Candidate for `pre_merge`, and the recorded `merge_sha` and structured `deployment_identity` for later phases, before it may wait, relay, or continue. Missing or mismatched fields block recovery; they never infer `not_required`, turn `merge-ready` into Flow Complete, or reset the repair count.
