# Multi-task Flow Agent 角色交互指南

本文是维护者阅读 Multi-task Flow 运行时的入口，解释主 Agent（main Agent）、交付 Agent（Delivery Agent）和任务 Agent（Task Agent）如何通过 CLI、原生 Codex 交互和账本协作。本文是解释性指南，不新增角色、状态或命令；规范事实以 [统一原子编排主题](../../specs/multi-task-flow-unified-atomic-orchestration/SPEC.md)、[数据模型](../../specs/multi-task-flow-unified-atomic-orchestration/DATA-MODEL.md)、[状态机](../../specs/multi-task-flow-unified-atomic-orchestration/STATE-MACHINES.md) 和 [CLI 合同](../../specs/multi-task-flow-unified-atomic-orchestration/CLI-CONTRACT.md) 为准。

## 角色边界

| 角色 | CLI actor | 身份绑定 | 主要责任 | 写入边界 |
| - | - | - | - | - |
| 主 Agent（main Agent） | `role: "main"` | `control.owner_thread_id` | 归纳计划、批准运行、维护全局依赖图、选择交付拓扑、派发和对账、处理跨单元异常、最终收口 | 全局计划、交付单元调度、任务派发、通知确认和受保护操作；不能伪造其他 Agent 的任务事实 |
| 交付 Agent（Delivery Agent） | `role: "group"` | `groups[].agent_thread_id` | 管理一个 regular DeliveryUnit 的父分支、集成 PR、集成验收、发布/部署/验证义务和 closeout | 仅所属 DeliveryUnit 生命周期、交付单元原子、父 PR/合并事实和自身协调状态 |
| 任务 Agent（Task Agent） | `role: "task"` | `tasks[].thread_id` | 读取自身任务上下文，推进原子、工作区、任务分支、child PR、rebase、合并和 closeout | 仅自身 Task、原子、任务 PR 和证据；不能创建或派发其他任务，不能修改依赖图或交付单元所有权 |

Bootstrap DeliveryUnit 是唯一由主 Agent 持有的交付单元：其 `owner_kind` 为 `main`，不绑定独立交付对话。regular DeliveryUnit 必须先绑定交付 Agent；恰有一个 contribution Task 时使用 shared-delivery 拓扑，多个 contribution Task 时使用 multi-task integration 拓扑。verification、release 和 deployment Task 不参与 contribution 数量判断。

## CLI 与 Codex 对话边界

正式调用使用固定版本的 `bunx --bun @loomhelm/multi-task-flow@<exact-version> flow <command> --input -`。每次写操作都携带 `run_id`、`actor`、唯一 `request_id` 和 `expected_revision`；revision 冲突必须先读取账本，不能盲目重试。`show`/`view` 是只读入口，`show` 的 `task-context` 只向绑定的任务 Agent 投影自身任务、依赖、原子、验收、工作区和阻塞事实。

对话创建只有一条路径：先由主 Agent 使用 `dispatch-group-claim` 或 `dispatch-claim` 领取账本 operation，再调用 `conversation-create`。该命令通过 `codex exec --worktree --json` 创建独立工作区，核对真实 thread、初始化 turn、model/thinking、工作区归属、初始 HEAD 和清洁状态；完成后才绑定对话。超时、断线、证据不完整或已观察到 thread 时保持 `unknown`，只能进入 `creation-reconcile`，不能再次创建。

初始化 prompt 只建立角色待命状态。正式 handoff 通过账本 notification 产生；主 Agent 领取唯一发送 attempt，使用允许的原生消息工具投递，再以 provider receipt 对账。`sent` 只表示平台接受，`acknowledged` 必须由收件 Agent 产生；通知确认不等于派发批准。

## 完整工作流

### Proposal、init 与批准

主 Agent 在 proposal 阶段先建立 canonical AtomicNode/AtomicEdge、TaskScope、DeliveryUnitScope、原子前驱和验收条件。`init` 只接受尚未绑定且处于 `planned` 的交付单元和任务，不创建对话。计划批准后，`execution_plan_id` 才支配调度；dispatch claim、starting 和对话创建都不能单独把运行推进到 `implementation`，真正的阶段转换来自首个 `task_started` 事实。

### 交付单元准备与派发

主 Agent 按需求结果归纳 `delivery_unit_id`，不能从 PR 数量、Agent 数量或文件重叠推断边界。交付 Agent 负责 regular 单元的父分支、父 PR、集成基线和 closeout；Task Agent 路径在 starting 前通常必须等待已发布且可核验的父 PR。唯一例外是 active、workspace-ready、main-owned 的 bootstrap 单元允许其 main-owned contribution Task 在父 PR definitively absent 时启动；发布中、结果 unknown 或已有非空父 PR 时仍阻塞。

### Shared-delivery 拓扑

一个 DeliveryUnit 恰有一个 contribution Task 时，交付单元对话、工作区、分支和 PR 同时服务 DeliveryUnit 与 Task。交付 Agent 负责交付单元边界，任务事实仍通过 TaskScope 和原子图表达；不会额外创建 child PR。任务完成、父 PR 合并和 DeliveryUnit closeout 仍是不同的事实和门禁。

### Multi-task integration 拓扑

一个 DeliveryUnit 有多个 contribution Task 时，交付 Agent拥有父分支和集成 PR，每个 Task Agent 拥有独立对话、工作区、分支和 child PR。Task Agent 先通过 `task-context` 读取自身边界，再按原子顺序推进 `prepare-branch → create-pr → merge-pr → closeout`。child PR 合并事实可以使后继任务 ready，但不等于当前任务已经完成；当前 Task 仍须完成 closeout。交付 Agent在所有 child PR 和集成验收满足后推进父 PR 合并及单元级 post-merge 工作。

### 状态、通知与恢复

AtomicNode/AtomicEdge 是唯一编排事实。Task 和 DeliveryUnit 状态是从原子、里程碑、外部 PR/CI/release/deployment/verification facts 推导的读取投影；Agent idle、连接状态、最新输出和观察器断开属于 runtime observation，不能覆盖业务状态。

任务首次进入 `ready` 时账本生成可派发 notification；主 Agent确认收件并重新评估依赖后才能调用 `dispatch-claim`。`waiting`、`blocked` 和 DeliveryUnit coordination state 表达依赖与门禁，不创建新的 coordination Task。创建、通知、发布、合并和部署出现 unknown 时保留 operation、claim、容量和原生身份，先 reconcile；不能用错误消息推断副作用未发生。

### Release、deployment、verification 与 closeout

release、deployment 和 verification 是显式原子，不能从 contribution Task 隐式推断。DeliveryUnit 合并能力必须由有效 merge receipt、`merge_sha`、PR identity 和未失效事实共同证明；provider PR 的 `closed` 或 DeliveryUnit 的 `closed` 单独不能满足 `requires: merged`。closeout reconciliation 只追加审计事件：证据仍有效则保持 `closed`，证据否定则转为 `blocked`，证据不足则保持原业务状态并阻塞后续门禁。

## 交互不变量

- 每个 Agent 只能使用与其绑定的 `thread_id` 和账本 actor role；复制 ID 不能产生第二个控制器。
- 主 Agent 是全局调度者，交付 Agent 是单一 DeliveryUnit 的所有者，任务 Agent 是单一 Task 的所有者；所有权不能通过普通更新或计划顺序改写。
- CLI 写入必须带 revision fence；相同 request 只能以相同 canonical input 幂等重放。
- 原生创建必须经过 `dispatch-claim → conversation-create → native evidence reconcile → formal handoff`；绕过路径是编排违规，不能静默接管结果。
- Task 完成、child PR 集成、DeliveryUnit 父 PR 合并、release/deployment/verification 和 closeout 是不同状态边界，不能互相替代。

## 参考

- [Multi-task Flow Skill](../../../skills/multi-task-flow/SKILL.md)
- [Native dispatch and reconciliation](../../../skills/multi-task-flow/references/native-dispatch-and-reconciliation.md)
- [Task Agent ledger-driven progression](../../adr/0035-task-agent-ledger-driven-progression-and-dispatch-notifications.md)
- [Task execution and delivery boundaries](../../adr/0027-multi-task-flow-task-execution-and-delivery-boundaries.md)
- [Task Agent child PR ownership](../../adr/0025-task-agent-owned-child-pr-delivery.md)
