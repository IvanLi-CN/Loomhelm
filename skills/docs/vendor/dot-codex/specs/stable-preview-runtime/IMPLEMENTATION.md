# Native background preview handoff guard 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 为 owner-facing localhost handoff 收紧 native-background 契约，并补 pid-backed lease 自愈

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-04-13
- Legacy last-tracked: 2026-04-13
- Current lifecycle: active
- Catalog note: 为 owner-facing localhost handoff 收紧 native-background 契约，并补 pid-backed lease 自愈

## Delivery Milestones

- [x] M1: 建立 spec 与 canonical solution 骨架
- [x] M2: 为 stable lease 增加即时 stale cleanup 与单测
- [x] M3: 收紧 AGENTS / skills handoff 契约并完成本地验证
- [x] M4: 确认方案保持为 Codex 原生后台能力，不新增 repo 内 detached runtime
- [x] M5: 让 dashboard wrapper 自理 PID/租约生命周期，并明确宿主 Agent 负责 native background session
- [x] M6: 分离 heartbeat 的 PID 补登记与 expected-pid 所有权校验，锁内 claim 启动租约，并补齐替代 lease 回归测试
- [x] M7: 在绑定 dashboard listener 前完成 guarded lease claim
- [x] M8: 在同一 registry 锁内完成 listener bind 与 PID 登记，并拒绝重复启动
- [x] M9: 在 claim 提交失败时复用已绑定 listener 的清理句柄

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `AGENTS.md`
- `skills/global-port-manager/SKILL.md`
- `skills/storybook-stories/SKILL.md`
- `docs/solutions/workflow-issues/stable-preview-handoff-runtime.md`
- `bin/modules/workspace/port_registry.ts`
- `bin/modules/workspace/port_registry_cli.ts`
- `bin/tests/workspace/workspace.test.ts`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `ae26703` fix(workflow): tighten native preview handoff guard
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
