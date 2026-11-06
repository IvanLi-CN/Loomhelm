# Retire zellij service manager 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 删除已废弃服务托管 skill 与 repo 内配套辅助链，保留本机运行态残留为 out of scope

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-04-10
- Legacy last-tracked: 2026-04-10
- Current lifecycle: active
- Catalog note: 删除已废弃服务托管 skill 与 repo 内配套辅助链，保留本机运行态残留为 out of scope

## Delivery Milestones

- [x] M1: 建立退役 spec、更新索引并写清范围边界
- [x] M2: 删除 skill、本仓库 `devctl` / launchd 辅助链与相关 bin 文档
- [x] M3: 清理现行技能/规格中的活跃引用并完成本地验证

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`: 新增索引项
- `docs/specs/retire-legacy-service-manager/SPEC.md`: 记录退役范围与验收口径
- `docs/specs/global-port-preview-governance/SPEC.md`: 去掉已删除能力的点名引用
- `skills/README.md`: 移除 retired skill 条目
- `skills/storybook-stories/SKILL.md`: 去掉 `$zellij-service-manager` 回退路径

### Plan assets

- Directory: `docs/specs/retire-legacy-service-manager/assets/`
- Visual evidence source: none required for this non-UI retirement task.

### Asset promotion

None

## Related Changes

- `c530b57` chore: retire legacy service manager stack
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
