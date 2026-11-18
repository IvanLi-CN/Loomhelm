# 原生派发、配置与对账

创建／派发、配置修改、通知和初始化恢复前读取本文件。正式对话创建仅走 claim → exact-version CLI `conversation-create` → native evidence reconcile → formal dispatch；原生 create/fork、裸 thread/start 或 resume/start 不可替代。

## 执行配置与创建

运行只有一个完整的 `config.execution_profile = { model, thinking }`。交付单元和任务可以独立覆盖；没有覆盖时各自使用运行默认值。新对象按 `kind-v1` 推荐表物化配置，手动修改后保持原值；只有主人明确要求重新推荐时才执行 `execution-profile-recommend`。创建后的对话内调整属于会话运行时，不回写账本，也不主动重设。

使用 `execution-profile-update` 修改对象，payload 为 `{ target_type: "group" | "task", target_id, execution_profile: { model, thinking } | null }`；使用 `execution-profile-default-update` 修改默认值，payload 为 `{ execution_profile: { model, thinking } }`。所有写入都带标准 owner/request/revision envelope，并通过 app-server `model/list` 验证组合。认证网页复用相同 mutation contract，保留选择和 URL，并显示服务端错误。外部 source viewer 保持只读。

## 创建与身份冻结

`conversation-create` payload 为 `{ operation_id, title, prompt }`。CLI 使用参数数组和关闭的 stdin 启动 `codex exec -C <repository> --worktree --json -m <model> -c 'model_reasoning_effort="<thinking>"' <固定初始化提示词>` ，完整透传已锁定配置；工作区由 Codex 创建，脚本不调用 `git worktree add`。`prompt` 是兼容保留的正式任务，只在成功结果的 `handoff.formal_prompt` 返回，首轮不执行。收到 `thread.started` 立即记录身份；绑定前必须核验独立工作区、Codex 归属元数据、实际配置、初始 HEAD、初始化回合完成以及进程正常退出。`project_id` 为空不单独失败。标题通过 `thread/name/set` 写入，不另开回合。绑定后创建正式派发通知并领取持久 attempt；主对话仅在 `handoff.should_send: true` 时调用内置 `send_message_to_thread`，使用返回的 `tool_request` 并对账平台回执。创建请求重放返回 `should_send: false`，不得再次派发。超时、创建后错误或证据冲突保留 unknown 和已知资源，先对账，不重复创建。只有没有观察到线程身份，且回执明确 `process_started: false`、`resources_created: false` 的创建前失败才允许释放 claim；新 exec 请求不能使用历史 `thread/start` 失败回执。历史 `thread/start` 与 `create_thread` 证据继续读取，不重建已有线程或中断在途 CLI。

native request ID 一旦绑定，完整创建参数（含 transport、cwd、prompt、title 和 execution_profile）即冻结；相同内容可以再次绑定，不同内容复用 ID 必须拒绝。已知线程、工作区、初始 HEAD 和执行事实通过 `creation_observations` 单调保留；后续空 unknown 回执不能遗忘它们，failed 门禁不能依赖可变 transport。明确失败且完成对账的请求才允许修正配置并重新 claim。未绑定 native request 的 claim 遇到配置变化会终止旧 claim，审计记录保留旧 profile、原因和新 claim 要求。

`codex-exec` 成功证据必须带 `source: "multi-task-flow-cli"`、`native_tool_name: "codex exec"`、operation ID、native request ID、执行配置和真实 evidence。

对账 evidence 必须保留原生查询的身份、时间、thread、初始化 turn、配置、worktree 和 evidence reference；它不能伪造原始 CLI exit code。若原始 exit code 已丢失，只有完整的 thread、初始化和 worktree 外部证据才能作为恢复成功的依据。

## 对账入口

恢复 unknown creation 只能调用同一 exact-version CLI 的 `flow creation-reconcile`，使用绑定的 run、operation、native request 和当前 revision 查询原生 thread 并写回 Flow Ledger。对账成功必须有匹配 thread、初始化 handshake、execution profile、独立 worktree owner、HEAD 和清洁状态证据；没有已知 thread identity 或仅查询不到 thread 时保持 unknown，不按标题、cwd 或时间猜测，也不调用普通 `codex reconcile`。

`flow creation-reconcile` 使用标准 mutation envelope，payload 为 `{ operation_id }`。它从账本读取冻结请求，查询 app-server 的 `thread/read` 与初始化 turn，把 `source: "multi-task-flow-reconcile"` 的证据写回同一 operation。`codex reconcile` 只读独立 codex-dispatch journal，不能更新 Flow Ledger，不能替代此入口。初始 group/task thread ID 无效，不按标题、cwd 或时间猜身份；无法确定时暂停交给主人。

未观察到 thread 且回执明确 `process_started: false`、`resources_created: false` 的创建前失败，才允许释放 claim。后续空 unknown 回执不能遗忘已观察资源；新 exec 请求不接受历史 thread/start 或 create_thread 失败证据。原生工具可见性不要求先被撤权，也不是已调用的证据；本 Skill 不提供宿主工具权限隔离。

## 任务 Agent 执行入口

任务 Agent 收到正式派发后，先使用派发消息中的 `run_id`、`task_id`、自身 `thread_id` 和 exact package version 读取自己的作用域上下文：`printf '%s' '{"run_id":"<run-id>","actor":{"role":"task","thread_id":"<task-thread-id>"},"section":"task-context","task_id":"<task-id>"}' | bunx --bun @loomhelm/multi-task-flow@<exact-version> --output json flow show --input -`。该只读投影是任务执行清单的入口，包含任务、所属交付单元、依赖边、原子节点和边、工作区资源、验收相关事实、阻塞原因与当前 `ready` 状态；只能读取绑定到自身对话的任务。随后按返回的原子和现有账本事实推进，使用 `task-update`、`atom-update` 及对应的 PR/事实命令记录自己的进展和证据，直到 `closeout`；不要等待固定握手回复，也不要自行创建或派发其他任务。需要主 Agent 处理时，仅通过账本产生的通知或阻塞、完成消息报告。

## 通知

记账命令可以在 `payload.notification` 中提供 `{ "mode": "auto" | "deliver" | "none", "recipient": "owner" | { "thread_id": "..." } }`。`auto` 保留各命令现有的默认通知规则，`deliver` 明确创建主动投递意图，`none` 禁止主动投递；旧字段 `notify_main: true` 继续等价于向 `owner` 投递。

记账命令先提交通知事实，再领取唯一持久 `delivery_attempt_id`，返回 `should_send`、`tool_request` 和回执身份。 `notification-prepare` 与兼容名称 `notification-send` 都只领取意图，不调用 CLI `thread/resume + turn/start`。仅当 `should_send: true` 时，主对话调用内置 `send_message_to_thread`；随后使用 `notification-reconcile` 写回真实平台结果， payload 包含 `notification_id`、相同 `delivery_attempt_id`、唯一 `reconciliation_id`、`outcome` 和 `provider_receipt: { provider: "codex-app-tools", evidence_ref, message_id?, recipient_thread_id, prompt_digest }` 。新的原生 attempt 必须让收件线程和 prompt digest 与领取意图一致；没有回执保持 unknown，只有证实未投递才可记 failed。`codex-app-tools` 直接 `notification-deliver` 只允许领取 unknown，不能直接记录 sent/failed；兼容 `notification-sent` 不接受该 provider，原生对账必须匹配 attempt 和 provider，历史 provider attempt 不能直接套用原生回执。`sent` 表示平台接受，不能推断已读、处理或开工。

相同请求重放返回 `should_send: false`，不能再次发送。持久 unknown attempt 跨工具调用占用通知，不依赖常驻文件锁。并发领取或未解决 attempt 禁止再次发送； unknown 必须先对账。历史外部发送的文件锁仍保护其在途回合，遇到 `NOTIFICATION_IN_FLIGHT` 不得改写状态解锁。只有收件会话可调用 `notification-ack`， main 不能代确认。使用 `notification-reconcile --input -` 的查询形式恢复 pending、failed、unknown 和长期未确认的 sent；明确 failed 才可创建新 attempt。

## 中断初始化恢复

创建超时或连接中断后先用 `flow creation-reconcile` 对账；如果明确是原始初始化握手 interrupted，可由绑定 main 使用标准 envelope 调用 `flow initialization-recover`，payload 仅包含 `operation_id`。它只在原 thread/worktree 上执行一次固定 READY 握手，不能传正式任务、替换执行配置或创建新会话；仅支持已验证 writer 排斥的 codex-cli 0.169.0。已保存 attempt 后无论退出码如何都不得重发：读取当前 revision，以 `creation-reconcile` 验证注册的 original/recovery turn 链。只有 intent 而无法证明 turn 是否启动时保持 unknown 并报告审计阻塞，不能释放 claim。该入口是受审计的恢复例外，不授权 Agent 裸用 resume/start 操作正式对话。

## 历史账本

缺少默认 profile 或任务执行策略的历史账本保持只读；迁移前读取 [共享 viewer 的兼容与账本维护合同](shared-viewer.md)。合同策略缺失与执行配置缺失是独立门禁，分别批准、备份与迁移，不补造 PR、owner 或生命周期事实；历史创建证据继续读取，新增创建使用 CLI 证据。
