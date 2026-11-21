# Sync mode: keep `docs/specs/` aligned

Read this reference when a Spec exists and implementation or review changes must be reflected in it.

## Trigger policy (hard)

Sync is mandatory when any of the following happens:

- implementation files changed in the current round or PR;
- a review or fix round changed behavior, interfaces, or acceptance interpretation;
- the flow enters PR convergence or merge gating with associated specs;
- a dedicated sync sidecar reports `Spec漂移=存在`.

## Single-writer rule

- In parallel mode, sub-agents may only detect and report drift.
- Only `main-agent` may write `docs/specs/**` and create spec-sync commits.
- Do not allow concurrent docs/spec commits from multiple agents on the same branch.

## Drift detector

Preferred helper: `skills/topic-spec/scripts/spec_drift_check.sh`.

- When a direct flow has frozen `adr_refs`, pass the comma-separated binding list through `ADR_REFS=<path@blob,...>`. The detector compares the working candidate's regular-file blobs and the supplied Spec's `Related ADRs` membership to that exact list; `ADR_REFS=none` asserts an empty relationship set.
- For spec-free runs settled as `spec_disposition=not_needed`, call it with `--spec-free` (or `SPEC_DISPOSITION=not_needed`) so implementation-only deltas return the expected spec-free pass instead of `未检查`. Valid only when the branch does not touch `docs/specs/**` or legacy `docs/plan/**`; touching spec files while claiming spec-free must surface as blocking drift.
- Output contract: `Spec同步状态=通过/阻断/未检查`, `Spec漂移=存在/不存在/未检查`, `Spec同步证据=<spec_paths@sha_csv|未检查>`, `结束原因=<one-line>`.
- When a canonical `SPEC.md` contains `## Related ADRs`, the detector validates that the section is exactly `None` or path-sorted, duplicate-free Markdown links to existing `docs/adr/<NNNN>-<slug>.md` files. A missing ADR status is compatible with `accepted`; explicit `superseded` or `deprecated`, any other non-accepted status, or an invalid target blocks sync. Specs without the section remain readable compatibility inputs.
- When a canonical `SPEC.md` is new or modified, additionally run `bun --no-install skills/bin/spec_contract_check.ts --path <SPEC.md>`. Untouched legacy and external Specs remain readable compatibility inputs.

## Resolve the target spec

- Prefer an explicit `docs/specs/<topic>/SPEC.md` path. New paths are slug-only.
- Legacy `docs/plan/<legacy-id>-<title>/PLAN.md` and legacy ID-prefixed Spec paths remain readable compatibility targets; see `legacy-identity.md` for the proofs that may establish a canonical mapping.
- Legacy canonical `docs/specs/<legacy-id>-<title>/SPEC.md` directories predating companion docs stay valid until hygiene/backfill. Once a directory contains any companion doc, `IMPLEMENTATION.md` and `HISTORY.md` must be kept complete as a set.
- If Step 2 settled `spec_disposition=not_needed`, do not invent a spec; return spec-free evidence and stop.
- List every touched spec explicitly when more than one applies.

## Classify the change

- **In-scope**: aligns with the existing topic contract.
- **Contract update**: changes scope, acceptance, or behavior; update the current topic Spec.
- **New topic**: no existing Spec cleanly owns the change; create one or explicitly supersede an old one.

## Minimum update set

- Update `SPEC.md` when behavior, contracts, constraints, or acceptance changed.
- Keep the normative contract in `SPEC.md`; put implementation coverage, current progress, rollout facts, and remaining gaps in `IMPLEMENTATION.md`.
- Put topic-local lifecycle, replacements, compatibility, necessary ADR background, and commit/PR/review references in `HISTORY.md`; do not copy the ADR's full rationale there.
- Keep current ADR relationships only in `SPEC.md` `## Related ADRs`.
- Update `docs/specs/README.md` only when needed: add a new topic row with `Lifecycle=active`, refresh the lightweight `Implementation` summary on material change, mark a replaced spec `superseded` with its `Successor`, or mark a retired historical spec `archived`.
- Do not write `Related PRs` or current PR/change associations into `SPEC.md`; record them in `HISTORY.md`. `References` and normative `Visual Evidence` stay only when they are part of the topic contract.

## Report

Always include the tri-state block:

- `Spec同步状态=通过/阻断/未检查`
- `Spec漂移=存在/不存在/未检查`
- `Spec同步证据=<spec_paths@sha_csv|未检查>`

Explain the drift cause, sync action, and why updates were or were not made in natural Chinese, keeping the tri-state fields together as one status block instead of turning the explanation into `字段=...` prose. Include one `Spec sync:` line listing updated files, or why no update happened.
