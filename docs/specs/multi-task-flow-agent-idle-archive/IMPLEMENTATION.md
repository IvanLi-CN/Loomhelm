# Implementation

## Runtime observation

在现有 Codex 对话观察器的最新 turn 投影上增加“活跃 turn”判定，并将确认终止的 `completed`、`interrupted` 和明确失败归入 `agent_idle` 的输入集合。`starting`、`inProgress` 和等价活跃状态继续表示工作中；连接断开、历史读取失败、订阅恢复中和未知状态走现有资源异常路径。

`agent_idle` 是 `Task.state` 的正式可能值。运行时观察将 active disposition 的 starting/running 任务转入 agent_idle，并用可选的 agent_resume_state 保存原状态；active 或 unknown 观察恢复原状态。waiting、blocked、终态和非 active disposition 不被覆盖。卡片、筛选、统计、详情和时间轴共用此状态，移除独立布尔字段和额外徽标。

观察器通过既有 `agent-output` SSE 快照携带 task ID、thread ID、turn ID、观察时间和运行时状态；epoch/revision 防止过期快照回流。观察结果经账本锁校验当前绑定后，仅对实际状态转换写入 task_runtime_observed 事件；重复观察不增加 revision。Codex 的 `thread/read` 与 `thread/status/changed` 提供无活跃 turn 证据，turn 终止事件只作用于匹配的 turn。较旧账本缺少该投影时不猜测历史 idle 事实。

## Archive lifecycle

任务终态事件提交后，由归档协调器检查绑定 conversation resource 是否存在未解决 operation、notification 或 reconciliation，再调用既有线程归档能力。归档请求使用独立 operation identity，明确成功写入 `closed`，明确失败写入 `archive_failed`，结果无法确定写入 `archive_unknown`。

任务终态先提交，归档随后记录独立资源 receipt；归档前以资源 `archive_unknown` 持久化 intent，并以每个 thread 的 OS 锁串行化跨进程请求。未知结果只查询 archived thread 列表，正向确认后关闭资源；缺少确认继续保留 unknown，绝不盲目重发。详情页的“重新归档”调用同一幂等路径，成功后更新资源图标和状态，不触碰任务执行状态。

## UI evidence

`agent_idle` 统一使用主人选定的 Lucide `tree-palm` 棕榈树图标，覆盖任务状态、概览和依赖图。空闲任务的对话入口保留聊天气泡图标。

任务卡片对绑定对话图标增加 idle 与 archive error 两类视觉状态；详情保留运行时观察信息，将打开对话及当前可用操作集中在单一“任务对话”区域，正常状态不重复展示归档标签；失败或未知仅附加简短提示。最后尝试时间和证据保留在资源事实及卡片浮层。归档与重试仅在账本资格满足且匹配对话的非 stale 观察确认 idle 时显示；恢复和未知结果对账独立可用。

## Verification

- Codex observer tests cover completed, interrupted, failed, active, unknown and reconnecting turn states.
- Ledger tests cover idempotent idle events, terminal-task archive initiation, failed/unknown archive receipts and retry reconciliation.
- Dashboard tests cover task icon, detail diagnostics and retry action without task execution side effects.

## Compatibility and recovery

保留 schema2/contract2 既有标识，新增任务 agent_idle 枚举、可选恢复字段、资源枚举与可选诊断字段；当前程序可读既有 schema1/schema2 状态，无 eager backfill。新写入的任务空闲或归档异常枚举不保证被旧程序识别，因此回退程序不属于支持的恢复路径；恢复采用当前或更新程序对 intent 做正向对账，详见 [migration.json](migration.json)。资源失败重试不重置任务终态。

CLI 在终态更新和相关通知/操作对账后触发 sweep；dashboard 启动、账本变化及有订阅者时每 15 秒检查待归档资源。对话仍活跃时保持 pending，避免归档最后一轮尚未结束的子任务。明确失败和未知需要用户点击重试或对账。无 dashboard 订阅且没有新的 CLI 生命周期动作时，不承诺后台轮询。

受控示例由 `bun run scripts/demo-static.ts --archive-fixture` 生成，`preview.html?tab=graph&layout=grid&state=agent_idle&selected=task%3Adashboard-ui&detail=1` 展示正式任务状态的筛选、统计和详情。

对话归档状态统一复用聊天气泡和角标；归档失败、未知、已归档分别显示 `!`、`?`、`✓`。可交互浮层使用项目 Tooltip 样式并以 dialog 语义暴露按钮，支持悬浮、聚焦、点击、长按和 Escape。缩放、对话、PR、标题截断和输出提示移除原生 title，动态控件共享 Tooltip 绑定与卸载清理。

取消归档沿用 thread 级 OS 锁和 durable intent，使用 thread/unarchive；成功写 active 与 archive_policy=manual，避免自动 sweep 重复归档。失败和未知分别保留 unarchive_failed/unarchive_unknown；未知只查询 archived=false 列表做正向对账。已 closed 资源仅允许具有新 operation identity 和证据的 conversation/manual/unarchive_unknown 转换，其他终态资源保持不可重新打开。

真实源码服务使用 `bun run --cwd skills/multi-task-flow preview:idle-archive`，命名示例提供合成对话、受控观察器和归档/取消归档 provider，通过实际 dashboard API 验证交互，不操作真实 Codex 对话。

通知创建与发送均拒绝已归档或归档状态未知的接收方，要求先手动恢复；运行时 idle 使用最新 turn 的独立身份和明确终态，不复用较旧公开消息的 turn identity。

主线卡片资源浮层与运行时观察并行集成：标题、运行时元数据和消息读取互不阻塞，同一 thread 的任务与交付单元绑定复用观察器；最新 turn 终止证据独立保留。集成验证通过 271 项运行时测试、81 项 UI 测试及 dashboard 构建，受控示例复核归档重试、取消归档和零原生按钮 title 提示。

归档 intent 写入在账本锁内重新验证完整资格，防止其他进程在快照检查后创建或认领通知；回执写入继续只校验绑定，以保留 provider 的真实结果。详情的“观察 Turn”使用 runtime_turn_id，与较旧公开消息身份分离。

修复后验证通过 273 项运行时测试、81 项 UI 测试与 dashboard 构建；新增竞争测试先在修复前失败，覆盖通知只创建及已 provider claim 两种次序。空闲详情的 runtime turn 身份经内置浏览器确认。

归档资格投影复用 `conversation-eligibility.ts`，首次入口不要求已有资源；服务端在 intent 写入前重验资格，恢复和对账只验证绑定与资源身份。静态 archive fixture 支持无资源的首次归档、取消归档后的 manual 策略和再次归档，并通过实际生成的 fetch shim 回归测试验证任务状态不变。
