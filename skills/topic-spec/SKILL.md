---
name: topic-spec
description: "Create and maintain durable topic-level SPECs, not execution plans."
---

# Topic Spec workflow (`docs/specs/`)

Use this skill to create or maintain a durable topic-level `SPEC.md`: a capability contract, behavior rule, interface boundary, or long-lived constraint. This skill is docs-only and never generates a task execution plan.

## Output contract

- The output of this skill is documentation under `docs/specs/<topic>/`: `SPEC.md`, `IMPLEMENTATION.md`, `HISTORY.md`, and only the required contract files or catalog row.
- `SPEC.md` records long-lived requirements. A temporary implementation plan belongs to `$dev-plan`; do not answer a `$topic-spec` request with a `Summary` / `Flow Decision` / `Task Orchestration` plan.
- If the request mixes a new topic Spec with implementation planning, finish the Spec documents first and route the separate execution plan to `$dev-plan`.

## Canonical layout

- New topic: `docs/specs/<topic>/`
- Required files: `SPEC.md`, `IMPLEMENTATION.md`, and `HISTORY.md`
- `SPEC.md` includes `## Related ADRs`: path-sorted Markdown links to current ADRs, or `None`
- `SPEC.md` is a requirements contract: it uses stable `REQ-*` and `VER-*` identifiers, explicit normative boundaries, and a `covers:` traceability link for every requirement. It does not contain task state, orchestration, PR lists, test command lists, checkbox progress, or unresolved business questions.
- Optional interfaces: `docs/specs/<topic>/contracts/`
- Optional evidence: `SPEC.md` `## Visual Evidence` using `./assets/<file>`
- Catalog: `docs/specs/README.md`

`<topic>` is a unique, stable kebab-case slug. It is the identity for new specs; do not generate a spec ID. Existing `docs/specs/<legacy-id>-<topic>/` and `docs/plan/**/PLAN.md` paths remain readable compatibility inputs, not a naming model for new work.

## Guardrails

- Do not modify implementation code, migrations, or runtime configuration.
- Resolve the spec root first: use `docs/specs/`; when only `docs/plan/` exists, use `$docs-migrate MODE=specs` to establish the slug-only canonical target before authoring.
- Do not delete or rename legacy paths here. `$docs-migrate MODE=specs-hygiene` owns confirmed legacy-directory normalization and inbound-reference updates.
- `docs/specs/` is engineering memory. Promote stable human-facing project truth separately through `$project-doc-promote`.

## Create

1. Choose a concise `<topic>` slug and check `docs/specs/<topic>/` does not already exist.
2. Create the three required files from this skill's templates.
3. Add a catalog row at the end of `docs/specs/README.md`:
   - `Topic`: human-readable title
   - `Lifecycle`: `active`
   - `Implementation`: lightweight status only
   - `Spec`: `<topic>/SPEC.md`
   - `Successor`: `-`
4. If interfaces change, add only the needed contract templates.

## Update or supersede

- Update the same directory when the long-lived topic still owns the contract.
- Create a new slug only for a genuinely new stable boundary.
- When superseding, set the old catalog row's `Lifecycle` to `superseded` and its `Successor` to the successor's `SPEC.md` path. `Lifecycle` values are exactly `active`, `superseded`, or `archived`.
- Keep rollout detail in `IMPLEMENTATION.md`; keep topic-local lifecycle, replacement, compatibility, and necessary ADR background in `HISTORY.md`. Durable ADR rationale remains in `docs/adr/`; the catalog is not a task board.
- Put implementation status, rollout facts, test commands, and coverage in `IMPLEMENTATION.md`. Put PR/commit/review associations and compatibility history in `HISTORY.md`. `Visual Evidence` in `SPEC.md` is limited to normative owner-facing assets; Task Evidence Set and PR image selection remain ephemeral workflow inputs.

## Handoff

Before implementation, the shared workflow records `spec_disposition=link|update|create|supersede|not_needed` and the ADR relationship. The associated directory must provide the background, goals/non-goals, stable requirements or contracts, acceptance criteria, implementation coverage, and relevant history.

## Contract Check

- For a new or modified canonical `docs/specs/<slug>/SPEC.md`, run `bun bin/spec_contract_check.ts --path docs/specs/<slug>/SPEC.md` (or the candidate-home equivalent) before handoff. The checker is structural: workflow topics may describe PR/Phase behavior, but task-state headings and unresolved decisions remain invalid.

## Templates

- `templates/topic-spec-README.md` -> `docs/specs/README.md`
- `templates/SPEC.md` -> `docs/specs/<topic>/SPEC.md`
- `templates/IMPLEMENTATION.md` -> `docs/specs/<topic>/IMPLEMENTATION.md`
- `templates/HISTORY.md` -> `docs/specs/<topic>/HISTORY.md`
- `templates/legacy/PLAN.md` -> legacy compatibility only; never use for new Specs
- `templates/contracts/*` -> copy selectively
