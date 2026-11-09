# ADR 0046：原生工作区创建与桌面交接

- Status: accepted
- Date: 2026-11-07
- Supersedes: ADR 0044 的 app-server 创建传输决定；完整执行配置、冻结和未知结果对账规则继续有效。
- Related: `../specs/multi-task-flow/SPEC.md`、`../design/multi-task-flow/execution.md`

## 背景

app-server 的 thread/start 不封装 Codex 原生工作区创建。外部 CLI 工作回合运行期间，桌面可能显示其他应用占用；让 CLI 执行完整任务会延长交接等待。桌面 create_thread 的模型限制不满足账本配置。

## 决定

由独立 codex exec --worktree --json 创建并初始化，工作区归属由 Codex 管理。完整透传锁定模型和推理配置，首轮仅确认初始化，不执行正式工作。收到身份立即落账，核验工作区、配置、回合完成、正常退出后绑定。标题通过不启动回合的命名接口设置。

主对话在绑定后使用内置 send_message_to_thread 发正式任务。通知先持久领取 attempt，再调用工具并写回真实回执；unknown 禁止重发。旧 CLI 在途锁继续保护，不干预旧回合。

接受 Codex 默认工作区起点，保留 initial_head。组在正式工作回合 fetch 远程主干，子任务继承组父分支 SHA；仅在本次新建、干净且归属明确的工作区对齐并通过 readiness 后开工。创建成功不要求提前达到目标 commit。

## 取舍与验收

不让脚本创建 Git worktree，也不引入临时基线 checkout。这个选择减少自有工作区元数据和双工作区生命周期，同时把基线安全检查交给有正式合同的工作 Agent。绑定、消息接受、基线就绪和实际开工分开审计。

本次不解决外部回合的底层占用机制。必须实测 CLI 退出后原生消息能否让桌面接管；无法观察或失败时阻塞验收，不静默退回长期 CLI。历史 thread/start 和 create_thread 证据保留，不自动迁移真实数据，不重建已有线程。
