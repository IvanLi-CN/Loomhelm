# Post-merge PR closeout

Run `MODE=post-merge-pr` only after the PR merged or the workflow PR merge procedure handed off `merge+cleanup`.

## Confirm merged PR

Use `gh` CLI to identify and confirm the merged PR:

- Prefer `TARGET_PR`.
- Otherwise resolve from `TARGET_BRANCH` or the current branch.
- If no merged PR is found, stop before deleting branch/worktree state.

## Identify cleanup targets

Collect:

- PR head branch
- primary worktree
- non-primary worktree holding the PR head branch
- caller-provided `EXTRA_PR_WORKTREE_PATHS`
- current-run Codex-managed task Worktrees, recorded separately as archive-only facts
- port lease scope ids when derivable

## Remove PR worktrees

Remove required PR worktrees before deleting the local PR branch, because Git refuses to delete a branch that is still checked out by any worktree.

For every required PR worktree path:

- if it is Codex-managed, exclude it from manual removal and return the native archive requirement; do not mark closeout complete until the native task lifecycle has archived it;
- check `git -C <path> status --porcelain`
- remove only when clean:
  - route to `$git-worktree ACTION=remove`, or use `git worktree remove <path>` and then release the scope through `$global-port-manager`
  - use caller-provided `WORKTREE_SCOPE_IDS` / `SCOPE_ID` when available; otherwise derive with the same deterministic scope rule as `$git-worktree`
- if a required PR worktree is dirty or cannot be removed, skip local PR branch deletion and downgrade closeout rather than trying a branch delete that Git must reject.

## Delete local PR branch

Before deleting:

- ensure the branch is not checked out by any worktree
- compare local branch head with the PR head SHA when available
- ensure upstream does not contain local-only commits

Then:

- `git branch -d <branch>`
- if the PR is confirmed merged and safety checks passed, `git branch -D <branch>` is allowed when `-d` fails only because Git cannot prove merge ancestry.

## Verify remote head absence

Use PR metadata and `gh` CLI as the primary source. Map:

- `missing` -> `远端分支=不存在`
- `exists` -> `远端分支=存在`
- `unknown` -> `远端分支=未检查`

If the remote head still exists, ask before deleting; do not delete it as part of this skill unless the owner explicitly authorizes that follow-up.

## Closeout gate

Build `closeout_context` from live Git facts and pass it to:

```bash
GIT_CLEANUP_SKILL_DIR="<path-to-loaded-git-cleanup-skill-dir>"
bun --no-install "$GIT_CLEANUP_SKILL_DIR/scripts/closeout_context.ts" --repo-root "<main_worktree>" --feature-branch "<branch>" --pr-worktree-required "<yes|no|unknown>" [--codex-managed-worktree-path "<path>"] ...
bun --no-install "$GIT_CLEANUP_SKILL_DIR/scripts/closeout_gate.ts" --input-json '<closeout_context_json>'
```

- Resolve `GIT_CLEANUP_SKILL_DIR` from the actual loaded `git-cleanup` skill location. In this repository that is `skills/git-cleanup`; in an installed Codex home it may be `${LOOMHELM_TOOLKIT_ROOT}/skills/git-cleanup`.
- The context helper defaults to `--port-scope-resolved`; if a `SCOPE_ID` can be derived or any worktree-local service lease may exist, inspect/release it through `$global-port-manager` and pass the observed `--port-lease-status`.
- Pass `--no-port-scope-resolved` only when current PR/flow facts prove no port lease scope can be derived and no dedicated PR or disposable merge-path worktree was part of the cleanup surface.
- Set `--pr-worktree-required=no` only when current PR/flow facts prove no dedicated PR worktree was ever part of the cleanup surface.
- Leave it as `unknown`, or set `yes`, when a PR worktree path is missing but the cleanup surface cannot prove it never existed; completion must remain partial until the fact is resolved.
- Pass each native task Worktree observed for this run with `--codex-managed-worktree-path`. The helper additionally protects only explicit cleanup targets or the current feature-branch path under `${CODEX_HOME:-~/.codex}/worktrees`; it never adopts unrelated native tasks from the shared Codex directory. `本地收尾=完成` requires the gate to return `allowed_complete=true`. If the gate reports violations, downgrade to `本地收尾=部分完成` and report the first concrete next action.
