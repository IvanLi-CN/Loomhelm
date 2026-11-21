---
name: topic-spec
description: "Create or maintain durable topic-level SPECs and keep them synced with implementation and review changes."
---

# Topic Spec workflow (`docs/specs/`)

Use this skill for a durable topic-level `SPEC.md`: a capability contract, behavior rule, interface boundary, or long-lived constraint, and for keeping that Spec aligned with implementation and review changes. It is docs-only and never generates a task execution plan.

Two modes share the same layout and contracts:

- `create` (default): author a new Spec or supersede an existing one.
- `sync`: reconcile existing Specs after implementation or review changes. Follow `references/sync-mode.md`.

## Output contract

- Output is documentation under `docs/specs/<topic>/`: `SPEC.md`, `IMPLEMENTATION.md`, `HISTORY.md`, and only the required contract files or catalog row.
- `SPEC.md` records long-lived requirements. A temporary implementation plan belongs to `$dev-plan`; never answer with a `Summary` / `Flow Decision` / `Task Orchestration` plan.
- If a request mixes a new topic Spec with implementation planning, finish the Spec documents first and route the execution plan to `$dev-plan`.

## Canonical layout

- New topic: `docs/specs/<topic>/`
- Required files: `SPEC.md`, `IMPLEMENTATION.md`, `HISTORY.md`
- `SPEC.md` includes `## Related ADRs`: path-sorted Markdown links to current ADRs, or `None`
- `SPEC.md` is a requirements contract: stable `REQ-*` and `VER-*` identifiers, explicit normative boundaries, and a `covers:` traceability link per requirement. It contains no task state, orchestration, PR lists, test command lists, checkbox progress, or unresolved business questions.
- Optional interfaces: `docs/specs/<topic>/contracts/`
- Optional evidence: `SPEC.md` `## Visual Evidence` using `./assets/<file>`
- Catalog: `docs/specs/README.md`

`<topic>` is a unique, stable kebab-case slug and is the identity for new specs; do not generate a spec ID. Legacy `docs/specs/<legacy-id>-<topic>/` and `docs/plan/**/PLAN.md` paths remain readable compatibility inputs — see `references/legacy-identity.md`.

## Guardrails

- Do not modify implementation code, migrations, or runtime configuration.
- Resolve the spec root first: use `docs/specs/`; when only `docs/plan/` exists, use `$docs-migrate MODE=specs` to establish the slug-only canonical target before authoring.
- Do not delete or rename legacy paths here. `$docs-migrate MODE=specs-hygiene` owns confirmed legacy-directory normalization and inbound-reference updates.
- `docs/specs/` is engineering memory. Promote stable human-facing project truth separately through `$docs-migrate MODE=project-docs`.

## Create

1. Choose a concise `<topic>` slug and confirm `docs/specs/<topic>/` does not already exist.
2. Create the three required files from this skill's templates.
3. Add a catalog row at the end of `docs/specs/README.md`: `Topic`, `Lifecycle=active`, a lightweight `Implementation` status, `Spec=<topic>/SPEC.md`, `Successor=-`.
4. If interfaces change, add only the needed contract templates.

## Update or supersede

- Update the same directory when the long-lived topic still owns the contract; create a new slug only for a genuinely new stable boundary.
- When superseding, set the old catalog row's `Lifecycle` to `superseded` and `Successor` to the successor's `SPEC.md` path. `Lifecycle` is exactly `active`, `superseded`, or `archived`.
- Keep rollout detail in `IMPLEMENTATION.md`; keep topic-local lifecycle, replacement, compatibility, and necessary ADR background in `HISTORY.md`. Durable ADR rationale stays in `docs/adr/`; the catalog is not a task board.
- Put implementation status, rollout facts, test commands, and coverage in `IMPLEMENTATION.md`. Put PR/commit/review associations and compatibility history in `HISTORY.md`. `Visual Evidence` in `SPEC.md` is limited to normative owner-facing assets; Task Evidence Set and PR image selection remain ephemeral workflow inputs.

## Sync

Follow `references/sync-mode.md` whenever implementation or review changes must be reflected in existing Specs. The drift detector is `skills/topic-spec/scripts/spec_drift_check.sh`; it reports `Spec同步状态`, `Spec漂移`, and `Spec同步证据`.

## Handoff and checks

- Before implementation, the shared workflow records `spec_disposition=link|update|create|supersede|not_needed` and the ADR relationship. The directory must provide background, goals/non-goals, stable requirements or contracts, acceptance criteria, implementation coverage, and relevant history.
- For a new or modified canonical `docs/specs/<slug>/SPEC.md`, run `bun --no-install skills/bin/spec_contract_check.ts --path docs/specs/<slug>/SPEC.md` (or the candidate-home equivalent) before handoff. The checker is structural: workflow topics may describe PR/Phase behavior, but task-state headings and unresolved decisions remain invalid.

## Templates

- `templates/topic-spec-README.md` -> `docs/specs/README.md`
- `templates/SPEC.md` -> `docs/specs/<topic>/SPEC.md`
- `templates/IMPLEMENTATION.md` -> `docs/specs/<topic>/IMPLEMENTATION.md`
- `templates/HISTORY.md` -> `docs/specs/<topic>/HISTORY.md`
- `templates/legacy/PLAN.md` -> legacy compatibility only; never use for new Specs
- `templates/contracts/*` -> copy selectively
