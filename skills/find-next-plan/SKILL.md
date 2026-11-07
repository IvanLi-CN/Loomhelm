---
name: find-next-plan
description: "Choose the next implementable spec."
---

# Find Next Spec

## Goal

Pick the next implementable spec when the repo still uses a **task-queue-style** specs index, and fail clearly when the repo has already migrated to **topic-level lifecycle specs**.

## Resolution rule (fixed)

1. Prefer `docs/specs/README.md` when `docs/specs/` exists.
2. If that README is already a lifecycle-only topic-spec catalog **and** `docs/plan/README.md` still exists as a legacy task queue under transition, fall back to the legacy queue instead of pretending `active` means “next task”.
3. Otherwise fallback to `docs/plan/README.md` only when `docs/specs/` does not exist.

## Quick start

In the target repo root:

```bash
bun --no-install $LOOMHELM_TOOLKIT_ROOT/skills/find-next-plan/scripts/find_next_plan.ts --repo . --format json
```

## Selection rules

- Legacy task-queue index:
  - Parse columns: `ID | Title | Status | Spec | Last | Notes`.
  - Build the implementable candidate set from rows where:
    - `Status` is exactly `待实现`, or
    - `Status` starts with `部分完成` (supports `部分完成（x/y）`).
  - Prefer `部分完成` over `待实现`.
  - Within the same status priority, prefer the spec whose `SPEC.md`/`PLAN.md` was created earliest in git.
  - If creation time ties or is unavailable for multiple candidates, break ties by `SPEC_ID` lexicographically.
- Topic-spec lifecycle index:
  - Parse current columns such as `Topic | Lifecycle | Implementation | Spec | Successor | Notes`, plus historical ID catalogs.
  - Do **not** pretend `active` means “next task”.
  - If a legacy `docs/plan/README.md` queue still exists for the same repo transition state, reuse that queue first.
  - Otherwise return `ok=false` with a reason like `topic_spec_repo_has_no_task_queue` so the caller can choose another planning source.
- Resolve legacy queue rows to their concrete path; slug-only lifecycle catalogs intentionally have no queue result.
- Legacy compatibility: also accept `docs/specs/**/PLAN.md` and `docs/plan/**/PLAN.md` when referenced.
- If an implementable candidate is not uniquely resolvable, stop and ask the user to choose.

## Output contract

- `--format json`: prints one JSON object:
  - `ok: true/false`
  - `spec_id/spec_path` when `ok=true`
  - backward-compatible aliases: `plan_id/plan_path`
  - `reason` (+ `candidates`) when `ok=false`
- `--format spec_path`: prints only the resolved spec path.
- `--format plan_path`: backward-compatible alias for `spec_path`.

## Next step

When `ok=true`, use the returned `spec_path` (or `spec_id`) as the implementation target in your current workflow. When `ok=false` because the repo is lifecycle-based, use another task source (for example the user's explicit request, current branch scope, or workflow context) instead of treating `docs/specs/README.md` as a task backlog.

## PR fallback (`gh` CLI, legacy only)

If a legacy task-queue index is missing/stale, you may scan open PRs:

1. Use `gh` CLI to list/search open PRs in the current repo.
2. Parse PR bodies for both metadata styles:
   - `Spec:` / `Specs:` + `Spec Disposition:` / legacy `Spec Status:`
   - `Plan:` / `Plans:` + `Plan Status:` (legacy)
3. Build candidates only when the PR metadata still corresponds to a task-queue-style repo.
4. Selection rule:
   - Exactly one candidate: you may pick it.
   - Multiple candidates: ask the user to choose.
