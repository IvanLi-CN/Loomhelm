# PR live GitHub 真相源 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 当前 PR blocker 只能从 live PR facts 推导；CI policy、expected checks、exact-SHA evidence 和 gate effect 由 shared CI contract 分层定义
- CI 适配器保持 provider observation 与 PR reducer 分离：policy `403`、malformed response、unknown event、旧 SHA 和过期 context 不会被改写成 `CI_NOT_EXPECTED`；workflow-level reducer 先处理 freshness/conflict，再消费四字段 CI facts。

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
- [x] M5: 对齐 CI facts envelope、冲突优先级和 policy observation error 的 live reducer 口径

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `docs/specs/pr-live-github-truth-source/SPEC.md`
- `docs/specs/code-hosting-platform/SPEC.md`
- `skills/project-engineering-workflow/references/ci-tracking-short-contract.md`
- `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- `skills/project-engineering-workflow/references/pr-merge-procedure.md`

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
