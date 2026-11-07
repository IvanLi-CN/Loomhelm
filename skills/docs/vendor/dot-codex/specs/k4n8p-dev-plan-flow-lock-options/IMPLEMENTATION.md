# Dev plan flow lock option guidance cleanup 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 移除 `flow_type` 选项完备性的硬约束，只保留完整列表建议与 local-merge 别名兼容

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-15
- Legacy last-tracked: 2026-03-15
- Current lifecycle: active
- Catalog note: 移除 `flow_type` 选项完备性的硬约束，只保留完整列表建议与 local-merge 别名兼容

## Delivery Milestones

- [x] M1: 建立 spec 并登记索引
- [x] M2: 收紧 skill 文案并移除选项完备性硬校验
- [x] M3: 更新 replay fixtures 与 cases
- [x] M4: 跑本地校验并收口到 merge-ready（local）

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `docs/specs/dev-plan-flow-lock-options/SPEC.md`
- `skills/dev-plan/SKILL.md`
- `skills/dev-plan/references/replay-cases/README.md`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `df977df` fix: enforce complete flow lock options
- `76c6b4d` fix: remove plan flow lock limitation wording
- `46cbee3` fix: remove strict flow option validation
- `b583666` fix: relax plan flow option guidance
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
