# Native dispatch and reconciliation

本文件承载 native 对话创建、执行配置、通知和不确定结果的详细合同；任何 group/task 创建仍必须先满足 `SKILL.md` 的 dispatch gate。

## CLI 创建链

使用 `dispatch-group-claim` 或 `dispatch-claim` 后调用 `conversation-create`，输入 `{ operation_id, title, prompt }`。CLI 必须通过参数数组和关闭的 stdin 启动 `codex exec -C <repository> --worktree --json -m <model> -c 'model_reasoning_effort="<thinking>"'`，工作区由 Codex 创建；不要调用 `git worktree add` 或普通 `create_thread` 作为替代。

收到 `thread.started` 就记录 native identity，但只有在核验独立工作区、Codex 归属元数据、实际 model/thinking、初始 HEAD、初始化回合完成和进程正常退出后，才能绑定 dispatch operation。标题通过 `thread/name/set` 写入，不另开回合；`prompt` 只作为正式 handoff prompt 返回，首轮不执行。

如果创建过程在这些事实全部返回前超时、终止或断线，operation 必须保持 `unknown` 并保留 native request identity、已观察 thread、workspace、initial HEAD 和 execution observations；后续只能调用 `flow creation-reconcile`，不得自动再次执行 `conversation-create`。

`creation-reconcile` 使用 `{ run_id, actor, request_id, expected_revision, payload: { operation_id } }` 的标准 mutation envelope。它从 Flow Ledger 读取冻结的 native request 和已知 thread identity，查询 Codex app-server 的 `thread/read` 与初始化 turn，核验 model/thinking、thread cwd、独立 worktree owner、HEAD 和清洁状态，然后把带 `source: "multi-task-flow-reconcile"` 的 reconciliation evidence 原子写回同一 dispatch operation。

对账成功才可绑定目标 thread、生成 handoff notification 并解析为 `succeeded`；thread 仍在初始化、证据不完整、查询发生冲突或没有已知 thread identity 时保持 `unknown`。没有 thread 的查询结果不是失败证据；只有明确证明进程未启动、资源未创建且没有观察到 thread 的 pre-creation failure 才能解析为 `failed` 并释放 claim。

`flow creation-reconcile` 与 `codex reconcile` 分属不同的状态边界。后者只读取独立的 `codex-dispatch` journal，不能查询、绑定或更新 Flow Ledger operation，也不能作为 Contract 3 的恢复入口。

绑定后创建正式派发通知并领取唯一持久 attempt。只有 `handoff.should_send: true` 时，主对话才调用允许的 `send_message_to_thread`，随后用平台 receipt 执行 `notification-reconcile`。`sent` 只表示平台接受，不能推断已读、处理或开工；`acknowledged` 必须由收件会话记录。

## 执行配置和身份冻结

运行必须有完整的 `config.execution_profile = { model, thinking }`；交付单元和任务可以显式覆盖。使用 `execution-profile-update` 修改对象，使用 `execution-profile-default-update` 修改默认值，创建后的对话内调整不回写账本。

native request ID 一旦绑定，transport、cwd、prompt、title 和 execution profile 全部冻结；相同内容可以幂等重绑，不同内容复用同一 native ID 必须拒绝。`codex-exec` 成功必须同时带 `source: "multi-task-flow-cli"`、`native_tool_name: "codex exec"`、operation ID、native request ID、执行配置和真实 evidence。

对账 evidence 必须保留原生查询的身份、时间、thread、初始化 turn、配置、worktree 和 evidence reference；它不能伪造原始 CLI exit code。若原始 exit code 已丢失，只有完整的 thread、初始化和 worktree 外部证据才能作为恢复成功的依据。

## unknown 与重试

创建超时、创建后报错、证据冲突、已观察线程或资源可能已创建时，保留 operation、claim、容量和已知 identity，先 reconcile，不能重复创建。只有明确证明没有启动进程、没有创建资源、没有观察到线程身份的创建前失败，才允许释放 claim。

后续空的 unknown 回执不能遗忘已观察的线程、工作区、初始 HEAD 或执行事实。历史 `thread/start` 或旧 `create_thread` 失败证据不能替代新的 `codex exec` 创建证据。无法确定时暂停并交给主人，而不是凭错误消息判断失败。

## 通知

通知流程是“记账 → 领取唯一 attempt → 使用返回的 tool request 投递 → provider reconcile”。`notification-prepare` 和兼容名称 `notification-send` 只领取意图，不直接调用 `thread/resume + turn/start`；`codex-app-tools` 只能领取 unknown，不能伪造 sent/failed。

相同 request 重放返回 `should_send: false`，不能再次发送。pending、unknown 或未解决 attempt 会占用通知，必须先对账；只有 provider 明确 failed 才能创建新的 attempt。main 不能代替收件会话记录 `notification-ack`。
