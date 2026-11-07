# Implementation

## Runtime observation

在现有 Codex 对话观察器的最新 turn 投影上增加“活跃 turn”判定，并将确认终止的 `completed`、`interrupted` 和明确失败归入 `agent_idle` 的输入集合。`starting`、`inProgress` 和等价活跃状态继续表示工作中；连接断开、历史读取失败、订阅恢复中和未知状态走现有资源异常路径。

`agent_idle` 作为任务视图的运行时字段或等价投影提供给 dashboard，不重写 `Task.state` 的业务状态枚举。任务状态显示层按既有状态优先级渲染依赖等待、阻塞和终态，同时在对话区域显示 idle 异常提示。

观察器通过既有 `agent-output` SSE 快照携带 task ID、thread ID、turn ID、观察时间和运行时状态；epoch/revision 防止过期快照回流。该投影保留在观察器内存，不为高频观察改写任务账本。Codex 的 `thread/read` 与 `thread/status/changed` 提供无活跃 turn 证据，turn 终止事件只作用于匹配的 turn。较旧账本缺少该投影时不猜测历史 idle 事实。

## Archive lifecycle

任务终态事件提交后，由归档协调器检查绑定 conversation resource 是否存在未解决 operation、notification 或 reconciliation，再调用既有线程归档能力。归档请求使用独立 operation identity，明确成功写入 `closed`，明确失败写入 `archive_failed`，结果无法确定写入 `archive_unknown`。

任务终态先提交，归档随后记录独立资源 receipt；归档前以资源 `archive_unknown` 持久化 intent，并以每个 thread 的 OS 锁串行化跨进程请求。未知结果只查询 archived thread 列表，正向确认后关闭资源；缺少确认继续保留 unknown，绝不盲目重发。详情页的“重新归档”调用同一幂等路径，成功后更新资源图标和状态，不触碰任务执行状态。

## UI evidence

任务卡片对绑定对话图标增加 idle 与 archive error 两类视觉状态；详情展示运行时状态、thread/turn identity、最近观察时间、资源归档状态、错误或未知原因和最后尝试时间。归档异常按钮在资源可重试时启用，否则显示对账所需原因。

## Verification

- Codex observer tests cover completed, interrupted, failed, active, unknown and reconnecting turn states.
- Ledger tests cover idempotent idle events, terminal-task archive initiation, failed/unknown archive receipts and retry reconciliation.
- Dashboard tests cover task icon, detail diagnostics and retry action without task execution side effects.

## Compatibility and recovery

保留 schema2/contract2 既有标识，新增资源枚举与可选诊断字段；当前程序可读既有 schema1/schema2 状态，无 eager backfill。新写入的归档异常枚举不保证被旧程序识别，因此回退程序不属于支持的恢复路径；恢复采用当前或更新程序对 intent 做正向对账，详见 [migration.json](migration.json)。资源失败重试不重置任务终态。

CLI 在终态更新和相关通知/操作对账后触发 sweep；dashboard 启动、账本变化及有订阅者时每 15 秒检查待归档资源。对话仍活跃时保持 pending，避免归档最后一轮尚未结束的子任务。明确失败和未知需要用户点击重试或对账。无 dashboard 订阅且没有新的 CLI 生命周期动作时，不承诺后台轮询。
