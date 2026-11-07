# PR freshness gate 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: PR 阶段 stale/conflict 前置门禁

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-13
- Legacy last-tracked: 2026-03-13
- Current lifecycle: active
- Catalog note: PR 阶段 stale/conflict 前置门禁

## Delivery Milestones

- [x] M1: 建立 `docs/specs` 根目录与本次 freshness gate 规格
- [x] M2: 更新共享 Step 5 契约，前置 PR freshness gate
- [x] M3: 收紧 `$pr-create`、`$pr-merge`、`$fast-flow`、`$flow-continue`

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`: 新增规格索引
- `skills/project-engineering-workflow/SKILL.md`: Step 5 freshness gate
- `skills/pr-create/SKILL.md`: PR 创建后 freshness gate 与轮询重置
- `skills/pr-merge/SKILL.md`: final refresh 与 stale-head merge fallback
- `skills/fast-flow/SKILL.md`: Auto Heal 授权范围扩展
- `skills/flow-continue/SKILL.md`: 恢复路由优先级对齐

### Plan assets

None

### Asset promotion

None

## Related Changes

- `aca3834` fix(skills): gate stale prs before convergence
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
