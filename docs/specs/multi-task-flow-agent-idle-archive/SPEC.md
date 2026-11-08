# Multi-task Flow Agent 空闲与对话归档

## Context and Scope

本主题补充 multi-task-flow 对绑定 Codex 对话的运行时观察和子任务对话归档合同，目标是及时发现已经停止工作的异常对话，并让已完成子任务的对话及时归档。

本主题不重新建模既有任务依赖、交接、通知、阻塞或完成状态；`agent_idle` 是来自 Codex runtime 的观察状态，不表达子任务停下的原因，也不代表任务完成或需要主对话处理。

## Domain Terms

- `agent_idle`：绑定 Agent 对话没有活跃 turn，且已确认最新 turn 终止的运行时状态。
- 对话资源异常：归档失败或归档结果未知等资源事实，与任务业务状态分离。
- 归档闭环：发起归档、取得明确成功证据，或在失败/未知时保留可恢复事实并由用户重试或对账。

## Requirements

### REQ-IDLE-001

系统 MUST 从 Codex runtime 观察绑定任务对话的 turn 状态，并在确认对话不再工作时暴露 `agent_idle`。

### REQ-IDLE-002

`agent_idle` MUST 只表达“当前没有活跃 turn”的观察事实，不得推断子任务停下的原因、交接意图、阻塞原因或完成意图。

### REQ-IDLE-003

已确认终止的 turn（包括正常结束、中断和明确失败）可触发 `agent_idle`；仍在启动或执行中的 turn 不得触发。连接断开、观测未知或恢复中的状态 MUST 保持独立的资源异常语义，不得伪装成 `agent_idle`。

### REQ-IDLE-004

本主题在 Task.state 中增加 agent_idle，不改变既有交接模型。依赖等待、阻塞、完成、关闭、放弃和 superseded 等既有状态不因 `agent_idle` 被覆盖；本主题不新增或推导 handoff 状态。

`agent_idle` MUST 作为任务状态可能值持久化并参与状态筛选、统计和详情展示；不得仅以布尔标记或对话附加徽标代替。只有 starting/running 的 active 任务进入该状态，active/unknown 观察恢复进入前的状态。

### REQ-IDLE-005

观察器发现 `agent_idle` 时 MUST 发布含 task/thread/turn identity 与观察时间的可追溯运行时事件并刷新 dashboard；系统不得自动发送新 turn、重启对话或推导其他任务状态。恢复动作由用户或既有任务流程执行。

### REQ-ARCHIVE-001

子任务进入明确终态后，系统 SHOULD 及时发起绑定对话归档。归档资格 MUST 要求任务为 `completed`、`closed` 或 disposition 为 `abandoned`、`superseded`；`integrated` 本身不满足资格。归档前 MUST 确认没有相关未解决操作、未合并 follow PR、未确认通知或其他未结束任务共用对话，且不是主对话或交付协调对话；执行前在账本锁内重验资格，并确认平台对话 idle。

### REQ-ARCHIVE-002

任务终态与对话资源归档状态 MUST 分离。归档失败或未知不得回退任务终态；资源应分别记录 `archive_failed` 或 `archive_unknown` 及错误、证据和最后尝试时间。

### REQ-ARCHIVE-003

归档成功后对话资源标记为 `closed`。失败或未知的归档操作 MUST 保留幂等重试或对账所需事实，不得静默丢弃。

### REQ-ARCHIVE-004

dashboard 的任务卡片和任务详情 MUST 显示对话资源归档异常；卡片对话入口 MUST 保留聊天气泡，并叠加可区分归档失败、未知、成功的状态标记。详情 MUST 将打开对话与当前可用操作集中在单一“任务对话”区域；正常状态不增加重复的归档状态、说明或操作 label，仅异常时显示简短提示。最近尝试和证据继续保留在资源事实及卡片浮层中。

### REQ-ARCHIVE-005

任务详情和卡片浮层 MUST 仅在归档资格满足且匹配当前对话的非 stale 观察确认 idle 时显示“归档”或“重试归档”；首次归档不要求已有 conversation resource。资格不满足时 MUST 隐藏归档与重试入口。未知结果 MUST 保留“归档对账”，只查询上次结果而不重复提交。恢复和对账不受归档资格限制，仍 MUST 验证真实绑定与资源身份；操作不得发送任务消息、重试任务执行或改变任务业务状态。

### REQ-ARCHIVE-006

归档状态入口 MUST 支持悬浮、键盘聚焦、点击和触屏长按打开项目 UI 浮层，说明当前状态，并提供带图标和文字的“归档”“重试归档”“归档对账”或“取消归档”按钮。所有控件提示 MUST 使用项目 Tooltip，不使用浏览器原生 title。

### REQ-ARCHIVE-007

取消归档 MUST 只恢复对话资源，不改变任务终态或启动 turn；成功后资源为 active，并持久化 archive_policy=manual，阻止自动 sweep 立即再次归档。失败写入 unarchive_failed，未知写入 unarchive_unknown；未知请求只能通过未归档列表的正向证据对账，不能盲目重发或反向归档。

### REQ-ARCHIVE-008

创建通知和发起发送时，已归档对话 MUST 拒绝成为通知接收方，并提示先手动取消归档。归档未知、取消归档失败或未知同样 MUST 拒绝发送，直到明确恢复；归档明确失败可以继续既有通知流程。不得以通知发送隐式取消归档或启动 turn。

## Acceptance

- Agent turn 明确结束且任务没有活跃 turn 时，dashboard 显示 `agent_idle`，任务 state 为 agent_idle，保留恢复状态和依赖事实。
- Agent 连接或观察未知时，dashboard 显示独立资源异常，不显示 `agent_idle`。
- 子任务完成后自动发起归档；明确失败和未知均可在详情中看到并通过符合资格的重试或未知结果对账恢复。
- 归档异常不会把已完成任务改回运行中，也不会触发重复任务执行。

## Verification

### VER-IDLE-001

- covers: `REQ-IDLE-001`, `REQ-IDLE-002`, `REQ-IDLE-003`, `REQ-IDLE-004`, `REQ-IDLE-005`
- Method: `task-runtime.test.ts`、`codex-agent-observer.test.ts` 与 schema/engine replay 测试。
- Pass condition: 明确 idle 才写入状态，active/unknown 恢复运行状态，等待、终态和交接事实不被覆盖，不发送 turn。

### VER-ARCHIVE-001

- covers: `REQ-ARCHIVE-001`, `REQ-ARCHIVE-002`, `REQ-ARCHIVE-003`, `REQ-ARCHIVE-005`, `REQ-ARCHIVE-007`, `REQ-ARCHIVE-008`
- Method: `notification-delivery.test.ts` 的归档接收方守卫，以及 `conversation-archive.test.ts` 的持锁竞争、故障注入、RPC 与正向对账测试。
- Pass condition: 单次归档意图可恢复，未知不盲目重发，手动恢复阻止自动重归档；任务终态与 turn 调用不变。

### VER-ARCHIVE-002

- covers: `REQ-ARCHIVE-004`, `REQ-ARCHIVE-006`
- Method: UI tooltip/conversation-control 测试及隔离 `preview:idle-archive` 浏览器交互。
- Pass condition: 聊天气泡角标和浮层诊断正确；详情仅单一任务对话区域，不满足资格时隐藏归档及重试按钮；异常保留短提示，恢复与对账独立可用；原生 title 数量为零，归档与取消归档均只更新资源。

## Visual Evidence

- Storybook覆盖=不适用
- 视觉证据目标源=ui_demo
- 视觉证据=存在
- 空白裁剪=无需裁剪
- 聊天回图=已展示
- 证据落盘=已落盘
- 视觉比较=已确认
- 主人已确认真实源码服务中的归档成功与手动取消归档交互；入口保留聊天气泡和状态角标。
- [归档成功与取消归档按钮](assets/conversation-archived.png)
- [取消归档后保持手动状态](assets/conversation-restored.png)

- 主干布局集成后重新验证，归档资源交互与已确认效果一致。
- [主干集成后的归档成功](assets/integrated-conversation-archived.jpg)
- [主干集成后的手动恢复](assets/integrated-conversation-restored.jpg)

![空闲任务的 runtime turn 诊断](assets/idle-runtime-turn.jpg)

主人已确认紧凑任务对话布局；首次归档按钮与打开对话并排显示，其他状态复用同一区域。

![紧凑任务对话与归档操作](../../../skills/docs/vendor/dot-codex/specs/multi-task-flow/assets/archive-compact.png)

## Related ADRs

- [ADR 0020：以运行时观察表达 Agent 空闲，并独立记录对话归档](../../adr/0020-observational-agent-idle-and-independent-conversation-archive.md)
