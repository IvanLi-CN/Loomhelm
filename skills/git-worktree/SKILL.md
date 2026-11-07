---
name: git-worktree
description: "Create, inspect, and remove git worktrees safely."
---

# Git worktree

Use this skill for pure local worktree lifecycle operations: creating isolated workspaces, inspecting existing worktrees, removing safe worktrees, and coordinating port-lease cleanup with `$global-port-manager`.

This skill does not implement features, create PRs, merge branches, or perform mainline sync.

## Inputs

- `ACTION=create|inspect|remove`
- `WORKTREE_SLUG`: short kebab-case identifier for a new worktree.
- `WORKTREE_PATH`: absolute path for an existing worktree.
- `BRANCH`: branch to create or attach.
- `BASE_REF`: baseline ref for a new worktree.
- `SCOPE_ID`: explicit global port lease scope when known.
- `CODEX_MANAGED_TASK=yes|no`: whether the requested path belongs to a native Codex task Worktree.

Ask only when the target worktree or branch cannot be uniquely identified.

## Guardrails

- Never remove the Git primary worktree.
- Never remove a dirty worktree unless the owner explicitly confirms `git worktree remove --force`.
- Never delete local branches unless the caller explicitly routes that to `$git-branch` or `$git-cleanup`.
- Never create or change remotes, upstreams, or push destinations.
- Worktree-local long-lived services must lease ports through `$global-port-manager`.
- If `CODEX_MANAGED_TASK=yes`, or the target path is inside `${CODEX_HOME:-~/.codex}/worktrees`, do not create, remove, prune, or move it. Native Codex task lifecycle owns that Worktree and its archive.
- Native task conversations must use native Codex task Worktrees. `ACTION=create` is not a fallback for an unavailable native task facility.

## Scope ID

Use the same deterministic scope rule across create/remove/cleanup:

```text
<project>--<repo_hash8>--<worktree_slug>
```

- `project`: basename of the Git repo root.
- `repo_hash8`: first 8 chars of SHA256 over the absolute repo root path.
- `worktree_slug`: the worktree's stable short slug.

Never use a bare slug as `scope_id`.

## Create workflow

Before any create, reject `CODEX_MANAGED_TASK=yes`. For a native task conversation envelope, report `native_task_worktree_required` and return to the owning coordinator flow instead.

1. Verify current repo and clean preconditions:
   - `git rev-parse --show-toplevel`
   - `git status --short --branch`
   - `git worktree list`
2. Resolve `BASE_REF`:
   - explicit input first
   - before using any remote-tracking ref, refresh that remote with `git fetch --prune <remote>`
   - remote default branch if uniquely available after fetch
   - otherwise ask one key question
3. Resolve `WORKTREE_SLUG`, `BRANCH`, and absolute path:
   - default path: `<repo_parent>/<project>-wt-<WORKTREE_SLUG>`
4. Do not overwrite an existing directory.
5. Create:
   - `git worktree add -b <branch> <worktree_path> <base_ref>`
6. Verify:
   - `git worktree list`
   - `git -C <worktree_path> status --short --branch`
7. Allocate a default app lease through `$global-port-manager` when the new worktree may host local services.

## Inspect workflow

- `git worktree list --porcelain`
- Summarize path, branch, detached state, and dirty status for requested candidates.
- Do not mutate anything.

## Remove workflow

1. Identify the target from explicit `WORKTREE_PATH` or `git worktree list --porcelain`.
2. If the target is Codex-managed, do not call `git worktree remove`; report `archive_codex_task_required` and leave the task lifecycle to Codex.
3. Confirm it is not the primary worktree.
4. Check target cleanliness:
   - `git -C <path> status --porcelain`
5. Remove:
   - `git worktree remove <path>`
6. Release leases:
   - call `$global-port-manager` `release-scope --scope-id <SCOPE_ID>`.

If `SCOPE_ID` cannot be derived reliably, report that lease cleanup was skipped rather than guessing.

## Output

Report:

- worktree path
- branch
- action result
- port lease cleanup result
- any skipped cleanup and why
