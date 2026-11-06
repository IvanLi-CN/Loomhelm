# Loomhelm TypeScript 客户端设计

## 目标

本设计只约束新增的 TypeScript 客户端实现，源码位于 `clients/typescript/`。现有 Go 客户端的 `cmd/connector/`、`internal/connector/`、协议和发行方式保持不变。TS 实现是一个可以脱离服务端独立工作的本地程序。它的主价值是驱动 Codex 完成工程工作，并提供可恢复、可追踪的开发任务辅助能力。

## 功能范围

### Codex 交互

- 启动、停止和监控本机 Codex app-server。
- 创建、继续、派生和中断 Codex 会话。
- 传递消息、工具调用、审批、事件、文件引用和执行结果。
- 保存本地关联身份，区分 Loomhelm 任务、Codex thread、turn 和操作。
- 对 ACK 丢失、重复事件、进程重启和断线进行恢复与对账。
- Codex 凭据只留在执行机器；服务端连接失败不能破坏本地任务恢复。

### 开发任务辅助

- 加载项目与用户 Skills，并检查版本和适用范围。
- 执行 project-engineering-workflow 的本地阶段和验证入口。
- 创建新的 Codex task/thread，并传递明确的任务边界和上下文。
- 执行 Multi-task Flow 的任务图、依赖、账本、锁、收据和状态恢复。
- 管理 Git 分支、worktree、测试、构建、脚本和证据目录。
- 汇总子任务结果，识别完成、失败、阻塞、跳过和可重试状态。
- 通过 CLI 和机器可读输出提供任务查询、日志和收据。

## 非目标

- 不在客户端实现 Web App 的页面和浏览器状态。
- 不要求服务端在线才能创建或执行本地任务。
- 不把服务端数据库复制到客户端。
- 不在第一阶段实现完整的组织管理、远程 fleet 管理或通用协同编辑。
- 不为了语言统一而重写 Skills 的领域语义。

## 合同分层与术语

本设计描述客户端总体能力；客户端独立核心 SPEC 描述其中可以脱离服务端交付的本地基础。核心 SPEC 明确排除的 Codex app-server、Skills/工程工作流、Fresh Thread Dispatch、Multi-task Flow、Connected mode、Web App 和服务端能力，仍由本设计保留边界，待后续主题 SPEC 约束。

Task 表示具有稳定身份、目标、范围、验收条件和依赖的工作单元；Run 表示一次 Task 执行尝试；Receipt 表示可验证的重要执行事实；Ledger 表示按顺序保存本地事实、摘要链和恢复信息的账本。Dispatch 是把 Task 交给 Codex thread 的动作，operation identity 用于识别一次可重试但不可冲突复用的请求。完整定义见 [术语表](../../GLOSSARY.md)。

文档合同按以下边界使用：ADR 约束语言、运行时和客户端/服务端边界；本设计约束总体能力和模块关系；主题 SPEC 对其范围内的 MUST 要求负责；术语表统一对象名称。新增模块不得把核心 SPEC 的子集验收解释为整个客户端完成。

## 运行模式

客户端至少提供两种模式：

1. **Local mode**：只使用本地 Codex、Git、Skills 和任务账本。
2. **Connected mode**：在 Local mode 之上连接服务端，上传授权范围内的事件和结果，并接受远程任务或状态同步。

Connected mode 断开后必须降级为可解释的离线状态；本地可继续执行的任务不能因为远程连接断开而丢失。

## 核心模块

- `runtime`：Node.js/Bun 兼容的进程、文件、信号、锁和平台适配。
- `codex`：Codex app-server 生命周期、协议、事件和恢复。
- `workflow`：Skills、工程工作流和验证阶段。
- `tasks`：任务模型、依赖、状态机、账本和收据。
- `dispatch`：Fresh Thread Dispatch 和任务交接。
- `orchestration`：Multi-task Flow 任务图和执行协调。
- `git`：分支、worktree、提交和状态检查。
- `transport`：可选的服务端认证、连接、重连和同步。
- `cli`：人类命令和 JSON/事件流输出。

## 关键场景

- 没有服务端时，用户可以在一个仓库中创建任务、派发 Codex thread、运行验证并取得收据。
- Codex 进程重启后，客户端能恢复本地任务状态并避免重复发送不确定操作。
- 多任务图中一个子任务失败时，客户端保留账本和证据，按依赖关系阻止后续任务并允许受控重试。
- 服务端断线时，本地任务继续运行；恢复连接后按身份和游标对账，不重复上传事实。
- 同一任务被重新派发时，客户端识别已有 dispatch identity，避免创建意外重复 thread。

## 验收边界

第一阶段完成的标志是：Local mode 可独立运行；Codex 交互和任务辅助各有一条端到端 CLI 路径；迁移的工作流和 Multi-task Flow 测试可在 Node.js 基线下运行，并在 Bun 下通过兼容性检查；Connected mode 至少完成连接、身份绑定、事件上传和断线恢复的协议骨架。
