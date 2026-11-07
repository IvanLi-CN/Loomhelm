# Review model and effort defaults 实现状态（superseded）

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: superseded
- Catalog note: 一般 review 默认使用 `gpt-5.6-luna` + `high`，关联 proof 默认使用 `gpt-5.6-sol` + `low`，高要求信号使用 `gpt-5.6-sol` + `medium`；保留 agent 启动前一次性自由改 effort

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-17
- Legacy last-tracked: 2026-03-17
- Current lifecycle: active
- Catalog note: 一般 review 默认使用 `gpt-5.6-luna` + `high`，关联 proof 默认使用 `gpt-5.6-sol` + `low`，高要求信号使用 `gpt-5.6-sol` + `medium`；保留 agent 启动前一次性自由改 effort

## Delivery Milestones

- [x] M1: 建立 `docs/specs/review-effort-by-pr-stage/SPEC.md` 规格并登记索引
- [x] M2: 统一 native review 与独立手动 review/fix 的模型、允许档位与默认矩阵
- [x] M3: 同步 shared workflow 与 PR 入口的 native proof / convergence 文案
- [x] M4: 完成静态 CLI、文档一致性与 spec drift 检查
- [x] M5/M6: historical v2 receipt compatibility retained; current behavior is defined by `../workflow-agent-model-selection/SPEC.md`

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `docs/specs/review-effort-by-pr-stage/SPEC.md`
- `docs/specs/review-effort-by-pr-stage/IMPLEMENTATION.md`
- `docs/specs/review-effort-by-pr-stage/HISTORY.md`
- `skills/codex-review-loop/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `54a9c9b` docs(workflow): align review effort defaults by pr stage
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
