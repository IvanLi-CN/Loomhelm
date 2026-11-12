---
name: spec-sync
description: "Sync docs/specs after implementation or review changes."
---

# Spec sync (`docs/specs/`)

## Goal

Keep topic-level specs in `docs/specs/` aligned with behavior, contracts, and acceptance expectations when implementation changes due to review, fixes, or scope clarification.

## Trigger policy (hard)

`$spec-sync` is mandatory when any of the following happens:

- Implementation files changed in the current round/PR.
- A review/fix round changed behavior, interfaces, or acceptance interpretation.
- The flow enters PR convergence/merge gating with associated spec(s).
- A dedicated `spec-sync-track` (sub-agent) reports `Spec漂移=存在`.

## Single-writer rule

- In parallel mode, sub-agents may only detect/report drift.
- Only `main-agent` may write `docs/specs/**` and create spec-sync commits.
- Do not allow concurrent docs/spec commits from multiple agents on the same branch.

## Optional helper script

- Preferred drift detector: `skills/spec-sync/scripts/spec_drift_check.sh`.
- When a direct flow has frozen `adr_refs`, pass the comma-separated binding list through `ADR_REFS=<path@blob,...>`; the detector compares the working candidate's regular-file blobs and the supplied Spec's `Related ADRs` membership to that exact list. `ADR_REFS=none` asserts an empty relationship set.
- For spec-free runs settled as `spec_disposition=not_needed`, call the detector with `--spec-free` (or `SPEC_DISPOSITION=not_needed`) so implementation-only deltas return the expected spec-free pass instead of `未检查`. This pass is valid only when the branch does **not** touch `docs/specs/**` or legacy `docs/plan/**`; touching spec files while claiming spec-free must surface as blocking drift.
- Script output contract:
  - `Spec同步状态=通过/阻断/未检查`
  - `Spec漂移=存在/不存在/未检查`
  - `Spec同步证据=<spec_paths@sha_csv|未检查>`
  - `结束原因=<one-line>`
- When a canonical `SPEC.md` contains `## Related ADRs`, the detector validates that the section is either exactly `None` or path-sorted, duplicate-free Markdown links to existing `docs/adr/<NNNN>-<slug>.md` files. A missing ADR status is compatible with `accepted`; explicit `superseded` or `deprecated`, another non-accepted status, or an invalid target blocks sync. Specs without the section remain readable compatibility inputs.
- When a canonical `SPEC.md` is new or modified, run `bun --no-install skills/spec-sync/scripts/spec_contract_check.ts --path <SPEC.md>` in addition to the drift detector. Untouched legacy and external Specs remain readable compatibility inputs.

## Workflow

1. Identify relevant spec(s)

- Prefer an explicit `docs/specs/<topic>/SPEC.md` path. New paths are slug-only.
- Compatibility: accept legacy ``docs/plan/<legacy-id>-<title>/PLAN.md`` and legacy ID-prefixed Spec paths. When a repo has canonicalized a legacy Plan, resolve it by an explicit canonical path, same-diff Git rename with a historical catalog row proving the exact ``ID + source path``, or one unique slug target with that same proof. For retained read-only aliases after the catalog becomes slug-only, the canonical ``HISTORY.md`` may carry an exact ``- Legacy compatibility identity: \``#id\`.``marker as the proof. A four- or five-character prefix alone is never proof:``audit-logs``must not be rewritten to``logs``. If a canonical target must be selected but the mapping is not proven or more than one target is plausible, block and ask for the canonical ``--spec-path`; otherwise retain the readable legacy source as its own sync target. Never choose by ID alone for new work.
- Compatibility: legacy canonical `docs/specs/<legacy-id>-<title>/SPEC.md` directories that predate companion docs remain valid sync targets until hygiene/backfill happens. Once a spec directory already contains any companion doc, `IMPLEMENTATION.md` / `HISTORY.md` must be kept complete as a set.
- If Step 2 has already settled `spec_disposition=not_needed`, do not invent a spec just to satisfy this skill; return spec-free evidence (`Spec同步状态=通过`, `Spec漂移=不存在`, `Spec同步证据=none(spec-free)`) and stop.
- If multiple specs are touched, list all of them explicitly.

2. Run drift check

- Compare current implementation delta with associated spec files.
- If the detector returns `未检查`, treat as gate-blocking in PR/merge stage.
- If it returns `阻断`, stop and sync docs before continuing.

3. Classify requested change

- **In-scope**: aligns with existing topic spec.
- **Contract update**: changes scope/acceptance/behavior and should update the current topic spec.
- **New topic**: no existing spec cleanly owns the change; create a new one or explicitly supersede an old one.

4. Sync updates (minimum set)

- Update `docs/specs/<topic>/SPEC.md` when behavior, contracts, constraints, or acceptance changed.
- Keep the normative contract in `SPEC.md`; put implementation coverage, current progress, rollout facts, and remaining gaps into `IMPLEMENTATION.md`.
- Put topic-local lifecycle, replacements, compatibility, necessary ADR background, and commit/PR/review references into `HISTORY.md`; do not copy the ADR's full decision rationale there.
- Keep current ADR relationships only in `SPEC.md` `## Related ADRs`, using path-sorted links or `None`.
- Update `docs/specs/README.md` only when needed:
  - add a newly created topic spec row with `Lifecycle=active`
  - refresh the lightweight `Implementation` summary when current status materially changed
  - mark a replaced spec `superseded` and set its `Successor` path
  - mark a retired historical spec `archived`
- Do not write `Related PRs` or current PR/change associations into `SPEC.md`; record them in `HISTORY.md`. Keep `References` and normative `Visual Evidence` only when they are part of the topic contract.

5. Report with tri-state evidence

- Always include:
  - `Spec同步状态=通过/阻断/未检查`
  - `Spec漂移=存在/不存在/未检查`
  - `Spec同步证据=<spec_paths@sha_csv|未检查>`
- Explain drift cause, sync action, and why updates were or were not made in natural Chinese; keep the tri-state fields together as a status block instead of turning the whole explanation into `字段=...` prose.
- Include `Spec sync:` line listing updated files (or why no update happened).
