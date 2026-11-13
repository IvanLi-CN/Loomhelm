# Native background preview handoff guard

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## Context and Scope

This topic governs owner-facing localhost preview handoff, the dashboard service wrapper's own lease lifecycle, and the boundary between repository Skills and Codex host-native background sessions. It does not add a repository-local detached service manager or change Codex host capabilities.

## Requirements

### REQ-PREVIEW-001

- An owner-facing localhost URL MUST have a matching active port lease and a still-retained Codex native background session owned by the current workspace.

### REQ-PREVIEW-002

- The dashboard wrapper MUST atomically validate and claim the inspected preallocated lease before binding, reject an existing PID or already-listening duplicate instead of treating it as transfer authorization, hold the registry lock while binding its listener, record its own PID only after the listener is confirmed, heartbeat its service lease while running and release only that service lease during shutdown. Heartbeat and release MUST verify the inspected port and expected PID state so a replaced lease is left untouched. The registry MUST distinguish the PID being recorded from an expected owner PID so a first binding may require an empty PID without weakening replacement protection.

### REQ-PREVIEW-003

- The Agent/host MUST create and retain the native background session. The Skill MUST NOT create, infer or substitute a visible terminal or foreground exec session; without a supported host route, handoff MUST be blocked.

## Verification

### VER-PREVIEW-001

- Method: Lease and service-wrapper integration tests.
- covers: REQ-PREVIEW-001, REQ-PREVIEW-002
- Pass condition: A running dashboard is atomically bound to the matching lease, records its PID/session metadata only after listener binding, executes a guarded heartbeat and releases only its own service lease on signal; duplicate startup leaves the active owner untouched, and registry tests cover first PID binding and same-port PID replacement rejection.

### VER-PREVIEW-002

- Method: Skill and Agent contract review.
- covers: REQ-PREVIEW-003
- Pass condition: The documented host/Agent boundary rejects visible-terminal or foreground-exec substitution and reports missing host background support as a handoff blocker.

## Related ADRs

None

## 背景 / 问题陈述

- `docs/specs/retire-legacy-service-manager/SPEC.md` 退役 `devctl/zellij` 之后，当前全局契约已经明确回到 Codex native background terminals，但 owner-facing localhost handoff 这条语义仍然不够收紧。
- session `019d8091-9ee8-7882-b386-17304fca9830` 暴露出反例：agent 把 `session_id=19097` 持有的预览 `http://localhost:30060` 交给主人，随后又显式 `Ctrl-C` 停掉该会话，导致交付地址立即失效。
- 当前 `leases.tsv` 还能保留大量 `pid/agent_session` 为空且端口已不再监听的租约，说明端口治理仍需要更快的 stale 自愈；但这不等于应该在 repo 内重新引入新的服务托管层。
- 当前仓库能够负责 dashboard/service wrapper 自身的 PID 与租约生命周期，但不能替 Codex host 创建或证明 native background session；没有宿主支持时不得把可见终端或前台 exec 当成隐藏后台会话。

## 目标 / 非目标

### Goals

- 明确区分 `live exec preview`（仅当前 turn/browser 验证）与 `native background handoff preview`（允许给主人交付 URL）。
- 保持 owner-facing localhost handoff 继续依赖 Codex 原生后台能力，而不是新增 repo 内 detached runtime。
- 让 `$global-port-manager` 对带 `pid` 的 lease 支持即时自愈，不再只依赖 24h TTL。
- 让 `AGENTS.md`、`$global-port-manager`、`$storybook-stories` 使用一致契约。
- 补自动化回归，覆盖 stale lease 自愈与错误 handoff 语义。

### Non-goals

- 不恢复 `devctl`、zellij、launchd 或其它旧服务托管栈。
- 不新增 `stable_service.py` 之类的 repo 内 detached service manager。
- 不调整 `config.toml` 的模型/provider/MCP 选择。
- 不一次性接管所有后台 daemon；本次只治理 owner-facing 本地预览 handoff 语义与租约自愈。

## 范围（Scope）

### In scope

- 使用 `skills/global-port-manager/scripts/port_registry.ts` 提供带 `pid` lease 的即时 stale cleanup。
- 更新 `AGENTS.md`、`skills/global-port-manager/SKILL.md`、`skills/storybook-stories/SKILL.md`。
- 新增一篇 canonical solution，沉淀 native-background preview handoff 的复用规则。
- 更新 `docs/specs/README.md` 并登记本规格。
- 保持 `port_registry.ts` 的单测，并覆盖 dashboard wrapper 的 PID/session 登记、心跳和退出释放。

### Out of scope

- repo 外已有 launchd/job/log/state 的宿主机清理。
- 新建或恢复任何 repo 内服务托管脚本。
- 远端 PR / push / merge。

## 需求（Requirements）

### MUST

- owner-facing localhost URL 不得再依赖 repo 内自管 detached runtime；必须继续依赖 Codex 原生后台会话。
- `live exec preview` 仍可用于当前 turn 内浏览器复现，但不得再作为最终 handoff URL。
- owner-facing localhost handoff 必须满足：当前端口租约归属匹配，并且该服务仍由当前工作区的 Codex 原生后台会话持有；若运行时可得，lease 中还应记录对应 `agent_session`。
- `port_registry.ts` 在 `inspect/register/allocate/heartbeat/gc` 路径上，遇到带 `pid` 的 lease 进程已死或端口已不监听时，必须即时清理。
- Agent/host 负责创建和保留 native background session；Skill 只登记宿主实际提供的 `agent_session`，不创建、推断或替代该会话。没有受支持的宿主后台路径时，owner-facing handoff 必须阻塞。
- 相关 skills/AGENTS 文本必须显式区分 live preview 与 native-background handoff preview。

### SHOULD

- 文本契约应说明：交付给主人后的同一路径不得在同 run 内被 agent 自己 `Ctrl-C` / release。
- 对没有 `pid` 的历史租约，继续保留旧 TTL 规则，而不是激进回收。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- `live exec preview`
  - 当前 turn 为了浏览器验证可以使用前台 exec 或短生命周期会话。
  - 这种地址只能用于本回合内部验证，不得作为最终 handoff URL。
- `native background handoff preview`
  - 服务必须由当前工作区的 Codex 原生后台会话持有。
  - Agent 必须从 Codex host 获取并保留该会话；Skill 不得用可见终端、前台 exec 或服务 PID 猜测它。
  - 交付给主人前，agent 必须确认端口属于当前 lease，并保留该后台会话，不得在同一路径上立刻 `Ctrl-C`。
  - 若运行时能提供 `agent_session`，应把它注册到 lease，作为 provenance 补强证据。
- `port_registry.ts`
  - 对带 `pid` 的 lease 做即时 stale cleanup：`pid` 已死或端口已不监听时，立刻移除。
  - 对没有 `pid` 的旧 row 维持 `24h + port-not-listening` 的 TTL 规则。
  - heartbeat 将待记录的 `pid` 与 `expected-pid` 所有权 guard 分离：空 PID 可首次绑定，已有 PID 不匹配时拒绝更新。

### Edge cases / errors

- 若只有前台 live exec 持有预览，即便当前端口租约正确，也不能把它当成 owner-facing handoff。
- 若 owner-facing handoff 后，agent 又主动停止对应的原生后台会话，这属于明确违约。
- 若 runtime 提供不了 `agent_session`，仍至少要满足“当前 lease 归属 + 当前工作区启动 + 原生后台会话仍存活”三项事实。
- 若 Codex host 没有可供 Agent 保留的 native background route，不能通过打开可见终端或维持前台 exec 来满足 handoff；该 URL 只能用于当前回合验证。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

- `skills/global-port-manager/scripts/port_registry.ts`

### 契约文档（按 Kind 拆分）

- owner-facing localhost handoff 前置条件：当前 lease 归属匹配 + 当前工作区的 Codex 原生后台会话仍持有该服务。
- `live exec preview` 与 `native background handoff preview` 的行为差异，由 `AGENTS.md` + skills 文本共同定义；不靠口头约定。

## 验收标准（Acceptance Criteria）

- Given 只有 live exec session 维持的本地预览 When agent 准备把该 URL 作为最终 handoff 交给主人 Then 契约必须判定为不合规，需要改用 Codex 原生后台会话持有该服务。

- Given 一个通过当前工作区 Codex 原生后台会话持有的本地 HTTP 服务，且端口租约归当前 scope/service When agent 准备把该 URL 交给主人 Then 该 URL 可以被视为合法 handoff 来源，但 agent 不得在同 run 内主动停止该后台会话。

- Given 一个最近刚写入、但 `pid` 已死亡且端口不再监听的 lease When 对该 scope/service 执行 `inspect` 或 `register` Then stale row 会被即时清理，不必等 24h TTL。

- Given session `019d8091` 的等价路径 When 先拉起 live exec preview，再结束该 exec Then 旧 URL 不再被视为可交付；只有改由 Codex 原生后台会话持有后才允许 handoff。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `bun test skills/global-port-manager/scripts/test_port_registry.ts`
- `git diff --check`

### Quality checks

- spot-check `AGENTS.md`、`skills/global-port-manager/SKILL.md`、`skills/storybook-stories/SKILL.md` 的 live/native-background 语义是否一致。
- 确认 repo 中不存在新的 detached preview runtime 脚本。

## 方案概述（Approach, high-level）

- 不回滚到旧 zellij 栈，也不在 repo 内新建 detached service manager。
- 继续把 Codex native background terminals 作为 owner-facing localhost handoff 的唯一后台能力来源。
- 端口租约继续是归属真相源；`pid` 仅用于 registry 自愈，dashboard wrapper 只管理自身 service lease，不作为引入新运行时的理由。
- 文本契约负责明确“什么时候必须升级成 native background handoff”；真正的后台生命周期仍由 Codex 原生能力负责。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：当前 repo 只能收紧契约、维护自身 service lease 并验证宿主传入的事实，无法直接替 Codex runtime 增加新的后台观测接口。
- 风险：仍有历史 lease 缺少 `pid` / `agent_session`，本次不会立刻把它们全部清走。
- 假设：Codex 原生后台能力会继续存在，并且 owner-facing handoff 可以依赖它而不是 repo 内守护进程。

## 参考（References）

- `docs/specs/retire-legacy-service-manager/SPEC.md`
- `docs/specs/global-port-preview-governance/SPEC.md`
- `docs/solutions/workflow-issues/stable-preview-handoff-runtime.md`
- `sessions/2026/04/12/rollout-2026-04-12T15-22-00-019d8091-9ee8-7882-b386-17304fca9830.jsonl`
