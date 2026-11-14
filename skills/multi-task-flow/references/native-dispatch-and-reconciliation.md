# Native dispatch and reconciliation

本文件承载 native 对话创建、执行配置、通知和不确定结果的详细合同；任何 group/task 创建仍必须先满足 `SKILL.md` 的 dispatch gate。

## CLI 创建链

使用 `dispatch-group-claim` 或 `dispatch-claim` 后调用 `conversation-create`，输入 `{ operation_id, title, prompt }`。CLI 必须通过参数数组和关闭的 stdin 启动 `codex exec -C <repository> --worktree --json -m <model> -c 'model_reasoning_effort="<thinking>"'`，工作区由 Codex 创建；不要调用 `git worktree add` 或普通 `create_thread` 作为替代。

收到 `thread.started` 就记录 native identity，但只有在核验独立工作区、Codex 归属元数据、实际 model/thinking、初始 HEAD、初始化回合完成和进程正常退出后，才能绑定 dispatch operation。标题通过 `thread/name/set` 写入，不另开回合；`prompt` 只作为正式 handoff prompt 返回，首轮不执行。

绑定后创建正式派发通知并领取唯一持久 attempt。只有 `handoff.should_send: true` 时，主对话才调用允许的 `send_message_to_thread`，随后用平台 receipt 执行 `notification-reconcile`。`sent` 只表示平台接受，不能推断已读、处理或开工；`acknowledged` 必须由收件会话记录。

## 执行配置和身份冻结

运行必须有完整的 `config.execution_profile = { model, thinking }`；交付单元和任务可以显式覆盖。使用 `execution-profile-update` 修改对象，使用 `execution-profile-default-update` 修改默认值，创建后的对话内调整不回写账本。

native request ID 一旦绑定，transport、cwd、prompt、title 和 execution profile 全部冻结；相同内容可以幂等重绑，不同内容复用同一 native ID 必须拒绝。`codex-exec` 成功必须同时带 `source: "multi-task-flow-cli"`、`native_tool_name: "codex exec"`、operation ID、native request ID、执行配置和真实 evidence。

## unknown 与重试

创建超时、创建后报错、证据冲突、已观察线程或资源可能已创建时，保留 operation、claim、容量和已知 identity，先 reconcile，不能重复创建。只有明确证明没有启动进程、没有创建资源、没有观察到线程身份的创建前失败，才允许释放 claim。

后续空的 unknown 回执不能遗忘已观察的线程、工作区、初始 HEAD 或执行事实。历史 `thread/start` 或旧 `create_thread` 失败证据不能替代新的 `codex exec` 创建证据。无法确定时暂停并交给主人，而不是凭错误消息判断失败。

## 通知

通知流程是“记账 → 领取唯一 attempt → 使用返回的 tool request 投递 → provider reconcile”。`notification-prepare` 和兼容名称 `notification-send` 只领取意图，不直接调用 `thread/resume + turn/start`；`codex-app-tools` 只能领取 unknown，不能伪造 sent/failed。

相同 request 重放返回 `should_send: false`，不能再次发送。pending、unknown 或未解决 attempt 会占用通知，必须先对账；只有 provider 明确 failed 才能创建新的 attempt。main 不能代替收件会话记录 `notification-ack`。
