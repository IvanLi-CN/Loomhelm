# History

## 2026-11-07

根据 multi-task-flow 设计讨论建立本主题，确定 `agent_idle` 是由 Codex runtime 观察驱动的正式 Task.state 值，用于发现停止工作的异常对话；确定任务终态与对话资源归档状态分离，并为归档失败或未知提供 dashboard 诊断和人工“重新归档”入口。

- 实现：运行时 idle 观察、归档资源状态、幂等重试、dashboard 诊断与受控 fixture 验证。

- 补充：所有按钮提示使用项目 Tooltip；聊天气泡角标区分归档结果，浮层提供重新归档、对账和取消归档；手动取消归档持久化防止自动再次归档。
