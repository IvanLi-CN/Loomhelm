# PR live GitHub 真相源 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 收紧 shared Step 5：当前 PR blocker 只能从 `gh CLI` 刷新的 GitHub 当前事实集推导，assistant 历史回答仅用于 promise-resume

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-04-12
- Legacy last-tracked: 2026-04-12
- Current lifecycle: active
- Catalog note: 收紧 shared Step 5：当前 PR blocker 只能从 `gh CLI` 刷新的 GitHub 当前事实集推导，assistant 历史回答仅用于 promise-resume

## Delivery Milestones

- [x] M1: 明确 `gh CLI` 刷新的 GitHub 当前事实集是 PR blocker 真相源
- [x] M2: 收紧 shared contract 与 Step 5 入口 skill
- [x] M3: 同步无参数 `pr-*` prompts
- [x] M4: 完成文档 spot-check 与 `git diff --check`

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `docs/specs/pr-live-github-truth-source/SPEC.md`
- `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`
- `prompts/pr-create.md`
- `prompts/pr-merge.md`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `2aa616a` docs(pr): require live GitHub blocker diagnosis
- `5603121` docs(pr): tighten blocked-state diagnosis
- `9317980` docs(pr): fix blocked-state owner wording
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
