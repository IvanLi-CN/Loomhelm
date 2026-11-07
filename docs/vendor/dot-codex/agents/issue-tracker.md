# 多任务协调

多任务开发使用 `$multi-task-flow`，由独立运行时 ledger 管理任务、依赖与生命周期。任务内的直接 PR 使用 `$fast-flow` 和共享工程工作流。

Wave Thread 的 Skill、历史状态读取、事件回放和 CLI 已移除；历史对话状态不再由本仓库恢复或迁移。
