---
name: git-branch
description: "Manage local git branches safely."
---

# Git branch

Use this skill for pure local branch operations: checking branch context, creating or switching topic branches, deleting safe local branches, and preparing a design-only branch when a caller explicitly asks for one.

This skill does not create PRs, push, merge PRs, rebase onto mainline, or remove worktrees. Route PR publication and merge to `$project-engineering-workflow`; use `$git-sync` or `$git-cleanup` for their respective local operations.

## Inputs

- `ACTION=create-topic|switch|delete-local|design-branch`
- `BRANCH`: target branch name when known.
- `BASE_REF`: optional starting ref for a new branch.
- `PURPOSE`: short slug source when `BRANCH` is not provided.

If inputs are missing, infer them from the current task and repository conventions. Ask only when ambiguity would change which branch is touched.

## Guardrails

- Never run destructive commands such as `reset --hard`, `clean -fd`, or forced branch deletion unless the owner explicitly requests the exact action.
- Never push, set upstream, or change remote configuration.
- Do not switch away from a dirty worktree unless the dirty state is explicitly preserved by the caller contract or the owner authorizes a stash.
- Branch names must be lowercase kebab-case with a conventional prefix when a topic branch is created: `feat/`, `fix/`, `refactor/`, `chore/`, or the repo's established equivalent.
- Prefer the configured Codex branch prefix `th/` when creating branches for Codex workspace maintenance.

## Workflow

### 1) Preflight

- `git rev-parse --show-toplevel`
- `git rev-parse --abbrev-ref HEAD`
- `git status --short --branch`
- `git status --porcelain`

If `HEAD` is detached and a topic branch is needed, create it from explicit `BASE_REF` when the caller has already resolved a development baseline; only fall back to the current commit when preserving the current detached context is itself the requested behavior. If the worktree is dirty and the requested action would switch or delete the checked-out branch, stop and ask one key question.

### 2) Create a topic branch

1. Resolve `BASE_REF`:
   - Use explicit `BASE_REF` when provided.
   - Otherwise use current `HEAD` when the owner wants to preserve current context.
   - Only use a remote default branch after it has been fetched and uniquely resolved.
   - When a shared workflow caller already resolved the target repo mainline or another confirmed baseline, treat that explicit `BASE_REF` as the source of truth for branch creation.
2. Derive a branch name from `PURPOSE` if `BRANCH` is not provided.
3. Confirm the name does not already exist:
   - `git show-ref --verify --quiet refs/heads/<branch>`
4. Create and switch:
   - `git switch -c <branch> [<BASE_REF>]`
5. Verify:
   - `git rev-parse --abbrev-ref HEAD`
   - `git status --short --branch`

### 3) Switch branches

- Refuse to switch when current dirty files would be put at risk.
- Prefer `git switch <branch>`.
- If the branch is absent, do not create it unless the requested `ACTION` is `create-topic`.

### 4) Delete local branches

- Never delete the current branch.
- Never delete a branch checked out by any worktree.
- Prefer `git branch -d <branch>`.
- Use `git branch -D <branch>` only after proving the branch has already been integrated into the intended base or after explicit owner confirmation.

### 5) Design-only branch mode

Use `ACTION=design-branch` only for design work. It may create or switch to a branch and then stop at design output or owner-authorized design-document changes. It must not imply implementation authorization.

## Output

Report:

- current branch
- action performed
- base ref used when a branch was created
- dirty-worktree status
- next allowed owner action
