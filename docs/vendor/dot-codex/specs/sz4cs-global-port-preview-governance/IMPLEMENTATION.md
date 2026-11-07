# Global port preview governance 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 统一本地长驻服务的端口归属检查与冲突处理规则
- Catalog note detail: 同时收口 `AGENTS.md` 中 `chrome-devtools` 例外路径的 `isolatedContext` 必要性门禁与单任务复用约束

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-13
- Legacy last-tracked: 2026-03-13
- Current lifecycle: active
- Catalog note: 统一本地长驻服务的端口归属检查与冲突处理规则

## Delivery Milestones

- [x] M1: 建立全局端口治理 spec 并登记索引
- [x] M2: 收紧全局长驻服务与端口冲突处理规则
- [x] M3: 收紧本地预览相关浏览器禁忌，禁止系统 opener fallback
- [x] M4: 将自动端口分配改为 `10000+` 按 scope 稳定随机候选顺序
- [x] M5: 将 `chrome-devtools` 例外路径的 `isolatedContext` 治理纳入 `docs/specs/global-port-preview-governance/SPEC.md`，明确默认共享、必要性声明、单任务单实例复用与违规硬阻断

## Rollout Artifacts

### Docs touched

- `skills/global-port-manager/SKILL.md`
- `docs/specs/global-port-preview-governance/SPEC.md`
- `docs/specs/global-port-preview-governance/IMPLEMENTATION.md`
- `docs/specs/global-port-preview-governance/HISTORY.md`
- `docs/solutions/workflow-issues/browser-isolated-context-reuse.md`
- `AGENTS.md`

### Code touched

- `bin/modules/workspace/port_registry.ts`
- `bin/modules/workspace/port_registry_cli.ts`
- `bin/tests/workspace/workspace.test.ts`
- `skills/global-port-manager/scripts/port_registry.ts`
- `skills/global-port-manager/scripts/test_port_registry.ts`

Port lease registration and heartbeats now separate the recorded PID from its expected-owner guard. Dashboard wrappers atomically claim an empty-PID lease under the registry lock, bind before writing their PID, reject duplicate startup, and use the recorded port plus expected PID so stale processes cannot change or release replacement leases.

The dashboard wrapper retains its listener cleanup handle before claim verification and persistence, so failed startup cannot leave an unmanaged local listener.

### Plan assets

None

### Asset promotion

None

## Related Changes

- `826a50f` docs: enforce local preview port governance
- `c530b57` chore: retire legacy service manager stack
- `b39a914` docs(specs): adopt topic-level spec model
- Automatic allocation now defaults to stable scope-random ports at or above `10000`.
- `AGENTS.md` 现在明确要求：默认浏览器入口是 `$ego-browser`；Chrome control 与 `chrome-devtools` 只保留显式例外路径。
- `AGENTS.md` 现在明确要求：默认共享浏览器上下文；只有在共享状态会污染验证结果或引入不可接受副作用时，才允许在 `chrome-devtools` 例外路径里带 `task_scope_id` + `isolation_reason` 申请单一可复用的隔离上下文。

## Remaining Gaps

- 仅 `AGENTS.md` 记载的 `chrome-devtools` 例外路径受本次 `isolatedContext` 契约约束；其他直接 `chrome-devtools` consumer 仍需单独治理。

## References

- `./SPEC.md`
- `./HISTORY.md`
