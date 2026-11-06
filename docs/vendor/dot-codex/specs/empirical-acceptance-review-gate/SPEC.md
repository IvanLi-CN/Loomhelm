# Empirical Acceptance Review Gate

> This file is the durable topic requirements contract. Current implementation facts belong in `IMPLEMENTATION.md`; lifecycle and change references belong in `HISTORY.md`.

## Context and Scope

- Context: Direct delivery needs a current-Candidate gate for acceptance criteria whose truth depends on observing an external system or environment.
- In scope: obligation assessment, phase-aware Candidate/merge/deployment evidence, review admission, finding disposition, regression handling, and continuation.
- Out of scope: executing a particular hardware rig, defining a vendor protocol, storing device data in the repository, or replacing CI/review evidence.

## Terms and Interfaces

- `Empirical Acceptance Obligation`: a declaration that external observation is required because deterministic repository-local validation cannot prove an acceptance criterion.
- `Empirical Acceptance Evidence`: active Candidate/flow evidence containing `acceptance_id`, `phase`, the phase-appropriate identity (`candidate_sha`, `merge_sha`, and optionally a structured `deployment_identity`), `acceptance_contract_digest`, required scenarios, outcome, `scenario_set_digest`, and an inspectable evidence locator. A legacy Candidate-only card is compatible only as `pre_merge` evidence.
- `Empirical Regression`: failed evidence for a Candidate after a comparable Candidate passed the same acceptance contract.
- Interface: the current Candidate evidence and continuation anchor consumed by `$project-engineering-workflow`, direct delivery flows, and `$flow-continue`.

## Requirements

### REQ-EMPIRICAL-GATE-001

- Every direct flow MUST assess whether each acceptance criterion is provable by deterministic repository-local validation. An unprovable criterion creates an Empirical Acceptance Obligation before formal review can launch.
- Inputs: approved behavior, acceptance criteria, required contracts, and the available deterministic validation boundary.
- Outputs: an explicit `required` or `not_required` disposition and rationale.
- The assessment MUST NOT infer `not_required` solely from task type, file path, reviewer opinion, or prior Candidate evidence.

### REQ-EMPIRICAL-GATE-002

- Every applicable obligation MUST have current phase-appropriate Empirical Acceptance Evidence. Each record MUST bind its phase identity, `acceptance_contract_digest`, required scenarios, outcome, and an inspectable evidence locator. `pre_merge` evidence MUST bind `candidate_sha` to the exact Candidate; later phases use the Merge Receipt `merge_sha` and, for `post_deploy`, the structured deployment identity defined below.
- Evidence outcomes are `passed`, `failed`, or `unavailable`. `unavailable` is a blocker, not a passing result or an empirical regression.
- A Candidate SHA, acceptance-contract, or scenario-set change MUST invalidate affected passed evidence.

### REQ-EMPIRICAL-GATE-003

- Evidence placement MUST follow the shared workflow's evidence-placement invariant; collecting an observation preserves the tested candidate.
- Review Readiness, Step 5C, and Step 5L MUST require passed current evidence for every applicable `pre_merge` obligation before claiming the Candidate is ready. `post_merge` evidence MUST wait for a Merge Receipt and actual `merge_sha`. `post_deploy` evidence MUST additionally bind a structured `deployment_identity` whose source and bound SHA equal that `merge_sha`. The evidence MUST NOT be reported as complete before that phase.
- Formal reviewers MAY inspect the evidence but MUST NOT treat it as a review receipt, transcript substitute, or evidence of a clear review lane.
- A missing, stale, failed, or unavailable empirical record MUST block the relevant gate without creating a Repair Batch.

### REQ-EMPIRICAL-GATE-004

- A demonstrated review finding MUST be classified as Design-Returning when its remedy changes external-response assumptions, timing deadlines, retry semantics, permission/state transitions, or acceptance semantics, unless the settled contract already specifies the exact correction and current evidence demonstrates a violation.
- A Design-Returning finding MUST stop ordinary repair/review convergence and return to design. It cannot be reclassified as an In-Scope Review Finding by generic continuation.

### REQ-EMPIRICAL-GATE-005

- A failed empirical run after a comparable passed Candidate MUST enter diagnosis-only handling. The flow MUST identify the exact passing and failing Candidate SHAs and compare their relevant delta before a new design decision.
- Diagnosis-only handling MUST NOT attribute the failure to review or a repair without evidence, launch another ordinary Repair Batch, relaunch formal review, or weaken the acceptance criterion to regain a pass.

### REQ-EMPIRICAL-GATE-006

- A non-terminal continuation anchor for an applicable obligation MUST carry the obligation disposition, current evidence identity and outcome, Candidate SHA, acceptance-contract digest, and cumulative Repair Batch count.
- A generic continuation with any missing or mismatched field MUST block rather than infer the evidence state, reset the Repair Batch count, or start a new review wave. Repair authorization follows the selected flow and approved scope; the count is a diagnostic fact, not an additional authorization gate.

### REQ-EMPIRICAL-GATE-007

- Every new direct/v1 acceptance item MUST declare `scope=plan` and exactly one of `phase=pre_merge|post_merge|post_deploy`. Historical items without phase may be read as `plan/pre_merge` only when their text has no merge, release, deployment, or observation ambiguity; ambiguous history MUST be rejected.
- Review Readiness, PR convergence, and Step 5C MUST consume only `pre_merge` evidence. `post_merge` and `post_deploy` are closeout evidence and cannot unblock a pre-merge gate.
- Missing merge or deployment authority MUST remain an explicit owner-action blocker. It MUST NOT be converted to `not_required`, and `merge-ready` MUST NOT be reported as `Flow Complete`.
- A PR-bound Flow Complete MUST have a registered canonical acceptance manifest. A missing manifest MUST remain an owner-action blocker and MUST NOT be treated as an empty acceptance set.

## Verification

### VER-EMPIRICAL-GATE-001

- Method: direct-flow contract and instruction-architecture checks.
- covers: `REQ-EMPIRICAL-GATE-001`, `REQ-EMPIRICAL-GATE-003`
- Pass condition: a formal review launch without an explicit passed applicable obligation is rejected; a deterministically provable criterion may be marked `not_required` only with its rationale.

### VER-EMPIRICAL-GATE-002

- Method: Candidate-evidence replay fixtures.
- covers: `REQ-EMPIRICAL-GATE-002`, `REQ-EMPIRICAL-GATE-006`
- Pass condition: stale SHA, changed contract digest, absent scenario evidence, or a missing continuation field blocks review/convergence and cannot reset the repair count.

### VER-EMPIRICAL-GATE-003

- Method: finding-disposition and regression replay fixtures.
- covers: `REQ-EMPIRICAL-GATE-004`, `REQ-EMPIRICAL-GATE-005`
- Pass condition: an external-contract change is Design-Returning; a failed run after a comparable pass enters diagnosis-only handling and does not open a new ordinary Repair Batch or formal review wave.

### VER-EMPIRICAL-GATE-004

- Method: phase-aware manifest, receipt, and replay contract tests.
- covers: `REQ-EMPIRICAL-GATE-007`
- Pass condition: pre-merge readiness rejects missing/ambiguous phase syntax. Post-merge evidence without the actual merge SHA, mismatched merge-SHA closeout replay, and post-deploy evidence without deployment identity are rejected. A Candidate-only card cannot satisfy a later phase.

## Related ADRs

- [0033 Empirical Acceptance and Repair Autonomy](../../adr/0033-empirical-acceptance-and-repair-autonomy.md)

## Visual Evidence

- None

## References

- `./IMPLEMENTATION.md`
- `./HISTORY.md`
