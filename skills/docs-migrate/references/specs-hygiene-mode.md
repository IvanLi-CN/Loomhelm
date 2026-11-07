# `$docs-migrate` / `MODE=specs-hygiene`

Use this mode to improve existing topic Specs and, when explicitly approved, normalize legacy ID-prefixed directories to slug-only paths.

## Scope

- Backfill topic-level `SPEC.md` plus `IMPLEMENTATION.md` and `HISTORY.md`.
- Normalize the catalog to `Topic | Lifecycle | Implementation | Spec | Successor | Notes`.
- Normalize legacy `docs/specs/<legacy-id>-<topic>/` paths to `docs/specs/<topic>/` only after conflict and reference checks.

## Directory-normalization gate

1. Prove each legacy prefix through a current or reachable historical catalog row with exact `ID + Spec path`, or an explicit matching `--legacy-id`; catalog paths are normalized relative to the catalog directory after unwrapping inline code or Markdown links. A five-character-looking slug alone is never proof. When the legacy directory's topic portion is not lowercase kebab-case, supply the intended stable slug with `--topic <topic>`; the guard otherwise blocks with `topic_slug_required`.
2. Discover candidate `old_path -> docs/specs/<topic>/` mappings and all inbound Markdown references, resolving relative links from the Markdown file that contains them.
3. Block when the slug target already exists, when two proven legacy paths map to one slug, or when an inbound reference cannot be updated deterministically.
4. Present the complete mapping, reference update set, and delete/rename effect to the owner.
5. Only after explicit confirmation, use `git mv` for the directory and update inbound links in the same change.
6. Do not delete a retained legacy source or a stale duplicate without separate explicit delete approval. Until then, report `pending delete approval`.

## Topic hygiene

1. Keep background, requirements, contracts, acceptance, risks, and references in `SPEC.md`.
2. Move rollout, milestones, current implementation coverage, and remaining gaps to `IMPLEMENTATION.md`.
3. Move decision rationale and replacements to `HISTORY.md`.
4. Set lifecycle to `active`, `superseded`, or `archived`. A superseded row points to its slug-only successor through the `Successor` column.
5. Keep visual evidence in the single `## Visual Evidence` section of `SPEC.md`.

## Validation

- All active new-style directories have the three companion files.
- Catalog paths resolve, lifecycle values are valid, and `Successor` paths are real for superseded rows.
- Git rename detection and explicit paths are preferred by `$spec-sync`; legacy ID matching remains read-only compatibility.
- The diff is docs-only.
