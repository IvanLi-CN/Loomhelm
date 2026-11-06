---
name: git-cleanup
description: "Clean local branches, worktrees, port leases, and post-merge PR workspaces."
---

# Git cleanup

Use this skill for pure local repository cleanup: deleting merged local branches, removing worktrees, releasing port leases, and completing post-merge PR local closeout after the workflow PR merge procedure.

This skill is the canonical local cleanup layer for branch/worktree/lease closeout. It does not merge PRs, update the GitHub remote PR head, or align the primary base branch after merge; those remain workflow PR merge responsibilities.

## Inputs

- `MODE=post-merge-pr|local-merge|general|worktree-remove|branch-cleanup`
- `TARGET_PR`: PR number or URL for post-merge PR cleanup.
- `TARGET_BRANCH`: local branch to treat as a merged PR head.
- `TARGET_BASE_BRANCH`: PR target base branch resolved by the workflow PR merge procedure.
- `EXTRA_PR_WORKTREE_PATHS`: disposable merge/review worktrees created by the workflow PR merge procedure.
- `PR_WORKTREE_REQUIRED`: `yes|no|unknown`; whether a dedicated PR/review worktree or disposable merge-path worktree was part of the cleanup surface.
- `REQUIRED_PR_WORKTREE_PATHS`: PR/review/disposable worktree paths that must be absent before post-merge cleanup can be complete.
- `WORKTREE_SCOPE_IDS`: lease scope ids keyed by worktree path when known; use these before deriving a scope for lease release.
- `WORKTREE_PATH`: explicit worktree target for `worktree-remove`.
- `SCOPE_ID`: explicit global port lease scope when known.
- `CODEX_MANAGED_WORKTREE_PATHS`: native Codex task Worktrees observed for this run; these are archive-only, not removal targets. Do not enumerate unrelated native tasks.

Ask only when the target object cannot be uniquely identified or a deletion needs owner confirmation.

## Guardrails

- Never remove the Git primary worktree.
- Never delete dirty worktrees automatically.
- Never use forced worktree removal without explicit owner confirmation.
- Prefer `git branch -d`; use `git branch -D` only when post-merge safety checks prove it is safe or the owner confirms.
- Remote PR head deletion belongs to the workflow PR merge procedure, not this skill. This skill may verify remote head absence for closeout status.
- Do not fast-forward or rebase the primary base branch as cleanup.
- Port lease release must go through `$global-port-manager`.
- Never remove a Worktree inside `${CODEX_HOME:-~/.codex}/worktrees`, or any path declared in `CODEX_MANAGED_WORKTREE_PATHS`. Return `archive_codex_task_required` instead; Codex native task lifecycle owns its archival/removal.

## Dirty-state policy

When cleanup encounters a dirty worktree, classify it before asking:

- `continue_safe_cleanup`: dirty entries are unrelated and the current cleanup step does not touch that worktree.
- `skip_conflicting_action`: the cleanup step would switch, delete, or remove a dirty target, so skip that action and downgrade the final closeout.
- `user_decision_required`: no safe skip path exists or the owner explicitly wants that dirty target cleaned now.

Only `user_decision_required` should ask the owner.

## Post-merge PR closeout

Run `MODE=post-merge-pr` only after the PR has already been merged or the workflow PR merge procedure has handed off `merge+cleanup`.

### 1) Confirm merged PR

Use `gh` CLI to identify and confirm the merged PR:

- Prefer `TARGET_PR`.
- Otherwise resolve from `TARGET_BRANCH` or the current branch.
- If no merged PR is found, stop before deleting branch/worktree state.

### 2) Identify cleanup targets

Collect:

- PR head branch
- primary worktree
- non-primary worktree holding the PR head branch
- caller-provided `EXTRA_PR_WORKTREE_PATHS`
- current-run Codex-managed task Worktrees, recorded separately as archive-only facts
- port lease scope ids when derivable

### 3) Remove PR worktrees

Remove required PR worktrees before deleting the local PR branch, because Git refuses to delete a branch that is still checked out by any worktree.

For every required PR worktree path:

- if it is Codex-managed, exclude it from manual removal and return the native archive requirement; do not mark closeout complete until the native task lifecycle has archived it;
- check `git -C <path> status --porcelain`
- remove only when clean:
  - route to `$git-worktree ACTION=remove`, or use `git worktree remove <path>` and then release the scope through `$global-port-manager`
  - use caller-provided `WORKTREE_SCOPE_IDS` / `SCOPE_ID` when available; otherwise derive with the same deterministic scope rule as `$git-worktree`
- if a required PR worktree is dirty or cannot be removed, skip local PR branch deletion and downgrade closeout rather than trying a branch delete that Git must reject.

### 4) Delete local PR branch

Before deleting:

- ensure the branch is not checked out by any worktree
- compare local branch head with the PR head SHA when available
- ensure upstream does not contain local-only commits

Then:

- `git branch -d <branch>`
- if the PR is confirmed merged and safety checks passed, `git branch -D <branch>` is allowed when `-d` fails only because Git cannot prove merge ancestry.

### 5) Verify remote head absence

Use PR metadata and `gh` CLI as the primary source. Map:

- `missing` -> `远端分支=不存在`
- `exists` -> `远端分支=存在`
- `unknown` -> `远端分支=未检查`

If the remote head still exists, ask before deleting; do not delete it as part of this skill unless the owner explicitly authorizes that follow-up.

### 6) Closeout gate

Build `closeout_context` from live Git facts and pass it to:

```bash
GIT_CLEANUP_SKILL_DIR="<path-to-loaded-git-cleanup-skill-dir>"
bun "$GIT_CLEANUP_SKILL_DIR/scripts/closeout_context.ts" --repo-root "<main_worktree>" --feature-branch "<branch>" --pr-worktree-required "<yes|no|unknown>" [--codex-managed-worktree-path "<path>"] ...
bun "$GIT_CLEANUP_SKILL_DIR/scripts/closeout_gate.ts" --input-json '<closeout_context_json>'
```

- Resolve `GIT_CLEANUP_SKILL_DIR` from the actual loaded `git-cleanup` skill location. In this repository that is `skills/git-cleanup`; in an installed Codex home it may be `${LOOMHELM_TOOLKIT_ROOT}/skills/git-cleanup`.
- The context helper defaults to `--port-scope-resolved`; if a `SCOPE_ID` can be derived or any worktree-local service lease may exist, inspect/release it through `$global-port-manager` and pass the observed `--port-lease-status`.
- Pass `--no-port-scope-resolved` only when current PR/flow facts prove no port lease scope can be derived and no dedicated PR or disposable merge-path worktree was part of the cleanup surface.
- Set `--pr-worktree-required=no` only when current PR/flow facts prove no dedicated PR worktree was ever part of the cleanup surface.
- Leave it as `unknown`, or set `yes`, when a PR worktree path is missing but the cleanup surface cannot prove it never existed; completion must remain partial until the fact is resolved.
- Pass each native task Worktree observed for this run with `--codex-managed-worktree-path`. The helper additionally protects only explicit cleanup targets or the current feature-branch path under `${CODEX_HOME:-~/.codex}/worktrees`; it never adopts unrelated native tasks from the shared Codex directory. `本地收尾=完成` requires the gate to return `allowed_complete=true`. If the gate reports violations, downgrade to `本地收尾=部分完成` and report the first concrete next action.

## Local merge closeout

Use `MODE=local-merge` after `$local-merge-flow` has completed the local merge and the owner has explicitly requested cleanup.

Required facts:

- `base_branch`
- `current_branch`
- `topic_branch`
- `merge_worktree_path` when an isolated merge worktree was used
- `optional_push_status`
- dirty-worktree classification: `clean|preserved_unrelated|skipped_conflict|user_decision_required`

Closeout proof must include:

- `base_branch`
- `current_branch`
- `worktree_clean`
- `topic_branch_present`
- `head_sha`
- `base_head_sha`
- `optional_push_status`
- `dirty_worktree_policy`
- `topic_branch_action`
- `merge_worktree_status`
- `pending_cleanup_action`

Completion requires:

- current branch is the base branch
- topic branch is absent
- merge worktree is not still present
- pending cleanup action is `none`
- dirty worktree policy is either `clean` or `preserved_unrelated`

The local merge caller owns the merge decision and proof freshness. This skill owns branch/worktree/lease cleanup and structured `cleanup_proof`.

Helper scripts:

```bash
GIT_CLEANUP_SKILL_DIR="<path-to-loaded-git-cleanup-skill-dir>"
bun "$GIT_CLEANUP_SKILL_DIR/scripts/local_merge_closeout_context.ts" --repo-root "<repo>" --base-branch "<base>" ...
bun "$GIT_CLEANUP_SKILL_DIR/scripts/local_merge_closeout_gate.ts" --input-json '<closeout_context_json>'
```

## General cleanup

Use `MODE=general` for broad local cleanup:

1. Inspect:
   - `git worktree list --porcelain`
   - `git branch --merged <DEFAULT_BASE_REF>`
   - `git status --porcelain`
2. Do read-only candidate discovery first when the current worktree is dirty.
3. Ask the owner before deleting arbitrary worktrees or branch batches.
4. Use `$git-worktree` for worktree removal and `$git-branch` for branch deletion.

Remote branch cleanup is opt-in and requires a second explicit confirmation.

## Worktree remove

Use `MODE=worktree-remove` for one explicit non-Codex-managed path. Follow `$git-worktree ACTION=remove` semantics and release leases through `$global-port-manager`. Native Codex task Worktrees are returned as `archive_codex_task_required`, never passed to `git worktree remove`.

## Output

For post-merge PR cleanup, report:

- PR number or target branch
- `本地收尾=完成/部分完成/未执行`
- `本地分支=存在/不存在/未检查`
- `PR工作区=存在/不存在/未检查`
- `远端分支=存在/不存在/未检查`
- `端口租约=存在/不存在/未检查`
- `cleanup_proof=<json|未检查>` when needed for recovery

For repo cleanup, report deleted and skipped objects, plus any owner decisions still required.
