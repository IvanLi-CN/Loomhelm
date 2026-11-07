# `$docs-migrate` / `MODE=specs`

Use this mode to move a legacy planning/spec document into a new slug-only topic Spec.

## Target

- Source: `docs/plan/**/PLAN.md` or a confirmed planning/spec Markdown file.
- Target: `docs/specs/<topic>/SPEC.md`, `IMPLEMENTATION.md`, and `HISTORY.md`.
- `<topic>` is a unique stable kebab-case slug. Do not preserve or generate an ID for the target directory.

## Preconditions

1. Be on a non-protected docs/topic branch or an isolated writable worktree.
2. If running in a Codex-managed Ticket task, do not create a nested manual worktree; use the task's existing workspace or report the blocker.
3. Exclude `docs/plan/README.md`, ADRs, RFCs, architecture/design/manual documents, `docs/specs/**`, and `docs/solutions/**` from one-to-one candidates.
4. Check that `docs/specs/<topic>/` does not already own a conflicting active topic. A conflict blocks rather than merges documents automatically.

## Mapping and write

1. Derive `<topic>` from the stable subject, not from a legacy ID prefix. If the source directory name is not already lowercase kebab-case, the guard blocks with `topic_slug_required`; choose the stable slug explicitly with `--topic <topic>` rather than deriving it mechanically.
2. Create the three companion documents in `docs/specs/<topic>/`.
3. Convert the source into a topic-level contract in `SPEC.md`; move rollout and current coverage into `IMPLEMENTATION.md`; put durable rationale and replacement facts in `HISTORY.md`.
4. Append a catalog row using `Topic | Lifecycle | Implementation | Spec | Successor | Notes`, with `active`, a lightweight implementation value, and `Successor=-`.
5. Prepare inbound Markdown link changes from the old path to the new path.
6. Keep the old source until the owner confirms deletion. Report `pending delete approval=<old-path>` when it remains.

## Validation

- Every new target has all three companion files.
- Each catalog `Spec` path exists and lifecycle is exactly `active`, `superseded`, or `archived`.
- The old-to-new mapping and inbound links are listed before any delete/rename action.
- The diff contains only documentation files and documentation assets.
