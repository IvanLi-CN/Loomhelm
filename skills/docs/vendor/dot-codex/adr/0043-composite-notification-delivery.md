# 复合通知投递

任务和编排事实先创建持久化的通知意图，再由 `orchestrate.ts` 的复合命令直接调用 Codex app-server 完成平台投递并记录结果。这样可以把已提交的账本事实、平台投递和收件确认分开，在 Agent turn 中断后仍可恢复，也不要求每个 Agent 手工编排记账与发消息的顺序。账本合同保持平台中立，当前 adapter 通过官方 Unix WebSocket 控制面调用 `turn/start` 连接当前 Codex 会话。

## 后果

- 账本更新成功后，投递结果可以是 pending、failed 或 unknown，且必须能够恢复处理。
- 投递成功永远不等同于收件确认；只有已绑定的收件会话可以确认。
- adapter 边界未来可以支持其他 Agent 平台，而不改变通知状态语义。
