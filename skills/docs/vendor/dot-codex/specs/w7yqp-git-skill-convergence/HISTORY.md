# Git skill convergence 演进历史（#w7yqp）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- Pure git/local repo operations are a separate layer from PR orchestration and flow recovery.
- Deleted prompt and old skill names are removed outright instead of kept as compatibility shims.
- Historical specs, replay, and fixtures may keep old names because they are evidence, not current runtime routing.

## Key Reasons / Replacements

- `create-worktree` and `remove-worktree` are replaced by `git-worktree`.
- `update-baseline` is replaced by `git-sync`.
- `pr-post-merge-cleanup` and generic cleanup prompt behavior are replaced by `git-cleanup`.
- Native Codex Ticket Worktree lifecycle is intentionally outside `git-worktree` and `git-cleanup`; the local Git layer may record it, but never removes its internal directory.
- Branch setup prompt behavior is replaced by `git-branch`.
- `git-sync` keeps the old no-argument mainline-sync behavior for checked-out topic branches: resolve a reliable default base locally, then rebase, and ask only on ambiguity or rewrite-policy blockers.
- A detached maintenance worktree is distinct from a topic branch: a clean one can move directly to a confirmed base commit and remain detached, while `BASE_REF` + `REMOTE` shared workflow calls continue to require the topic-branch rebase path.
- Cleanup helpers are invoked relative to the loaded skill directory so repository-local and installed skill layouts both work; resumed post-merge cleanup must carry PR identity instead of calling cleanup bare.
- Cleanup gates need explicit absence evidence as well as existence evidence; same-worktree PR cleanup passes `PR_WORKTREE_REQUIRED=no`, and local-merge recovery keeps the topic branch name.
- A cleanup resume is not complete unless it preserves both the worktree requirement state and any required PR worktree paths.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#w7yqp`.
