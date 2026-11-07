# Git skill convergence 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: Git/local repo 操作已收敛为四个新 git skills，并保留 `git-remote-troubleshoot`。

## Coverage / rollout summary

- Added `git-branch`, `git-worktree`, `git-sync`, and `git-cleanup`.
- Moved post-merge and local-merge closeout scripts/tests to `skills/git-cleanup/scripts`.
- Removed old pure-git skills and retired prompt files.
- Updated active orchestration skills to reference new git skills.
- Converted `work-branch-and-design` into a design-only prompt.
- Preserved baseline-sync default resolution in `git-sync`: bare mainline sync requests resolve the remote default branch or unambiguous common branch before asking.
- Added a direct `align-detached-base` path for clean maintenance worktrees: it fetches a confirmed base and leaves `HEAD` detached at the resolved commit without creating a branch, backup ref, or stash. It stops unless the old commit remains recoverable through target ancestry, an existing ref, or a HEAD reflog entry for that exact commit. Bare mainline-sync requests rebase only on attached topic branches; the shared `BASE_REF` + `REMOTE` rebase contract remains unchanged.
- Added a disposable-repository integration test for detached alignment, idempotency, dirty-worktree and unrecoverable-head blocking, exact reflog recovery, action selection, and remote/branch preservation.
- Made `git-cleanup` helper examples resolve scripts from the loaded skill directory and made `$flow-continue` carry post-merge PR cleanup context into `MODE=post-merge-pr`.
- Preserved cleanup recovery state by passing explicit PR worktree requirement facts from `workflow PR merge procedure` and exposing local-merge `topic_branch` in status output.
- Completed PR cleanup handoff state by carrying required PR worktree paths whenever `PR_WORKTREE_REQUIRED=yes` and preserving that requirement fact on `$flow-continue` resume.
- Added Codex-managed Worktree protection to `git-worktree`, `git-cleanup`, and closeout context/gate scripts. Native Ticket paths are recorded as archive-only, excluded from manual removal, and covered by unit tests.

## Remaining Gaps

- None for the current migration scope.

## Related Changes

- `skills/git-branch/SKILL.md`
- `skills/git-worktree/SKILL.md`
- `skills/git-sync/SKILL.md`
- `skills/git-cleanup/SKILL.md`
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- `skills/project-engineering-workflow/references/pr-merge-procedure.md`
- `skills/flow-continue/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/fast-flow/SKILL.md`
- `skills/local-merge-flow/SKILL.md`
- `skills/global-port-manager/SKILL.md`
- `skills/initiative-flow/SKILL.md`
- `skills/README.md`
- `prompts/work-branch-and-design.md`

## References

- `./SPEC.md`
- `./HISTORY.md`
