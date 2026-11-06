# Local merge cleanup closeout 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 收紧 local-merge cleanup 决策树与恢复语义

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-13
- Legacy last-tracked: 2026-03-13
- Current lifecycle: active
- Catalog note: 收紧 local-merge cleanup 决策树与恢复语义

## Delivery Milestones

- [x] M1: 建立 local merge cleanup closeout 规格并登记索引
- [x] M2: 收紧 local merge cleanup 契约与恢复语义
- [x] M3: 新增 local closeout gate/context 与测试

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`: 登记本规格
- `skills/local-merge-flow/SKILL.md`: cleanup 决策树与 closeout gate 规则
- `skills/project-engineering-workflow/SKILL.md`: 共享 `Step 5L.3/5L.4` 语义
- `skills/flow-continue/SKILL.md`: local cleanup 恢复规则
- `prompts/advance-flow.md`: 顶部恢复提示

### Plan assets

None

### Asset promotion

None

## Related Changes

- `8bcbcb9` fix(flow): smooth local merge cleanup closeout
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
