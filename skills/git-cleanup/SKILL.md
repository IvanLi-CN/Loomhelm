---
name: git-cleanup
description: "Clean local branches, worktrees, port leases, and post-merge PR workspaces."
disable-model-invocation: true
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

Run `MODE=post-merge-pr` only after the PR merged or the workflow PR merge procedure handed off `merge+cleanup`. `references/post-merge-closeout.md` owns the sequence: confirm the merged PR, identify cleanup targets, remove PR worktrees, delete the local PR branch, verify remote head absence, then run the closeout gate.

## Local merge closeout

Run `MODE=local-merge` after `$local-merge-flow` completed the local merge and the owner explicitly requested cleanup. `references/local-merge-closeout.md` owns the required facts, proof fields, completion conditions, and helper scripts.

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
