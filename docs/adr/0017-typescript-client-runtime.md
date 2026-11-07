# ADR 0017：客户端采用 TypeScript 与双运行时兼容

## 状态

Superseded by [ADR 0021](0021-bun-source-runtime.md)。以下保留历史决策背景；当前生产仅支持 Bun 直接执行 TS。

## 背景

Loomhelm 新增的 TypeScript 客户端实现必须能够独立运行，主要承担两组能力：

1. 连接并驱动本机 Codex；
2. 承载开发任务辅助能力，包括 Skills、工程工作流、Fresh Thread Dispatch 和 Multi-task Flow。

第二组能力已经以 TypeScript、Bun 脚本、测试和本地服务的形式存在于 dot-codex。客户端还需要调用 Git、worktree、测试、构建和项目脚本，并保存任务账本、事件和证据。

## 决策

新增实现独立放在 `clients/typescript/`，使用 TypeScript 实现；现有 Go 客户端保留在 `cmd/connector/` 与 `internal/connector/`，不被替换。Node.js 作为正式兼容基线，Bun 作为开发和快速执行运行时。客户端代码必须运行在 Node.js 与 Bun 的共同能力子集内，不依赖 Bun 专属 API。

客户端不依赖服务端才能启动或执行本地任务。服务端连接、远程状态同步和远程任务控制通过可选适配层提供。

## 边界

- 客户端负责本地 Codex 进程、Skills、脚本、任务图、工作流、Git 操作和本地证据。
- 服务端负责远程身份、持久化业务事实、跨客户端同步和远程协作。
- Web App 负责浏览器用户界面，不成为客户端运行的前置条件。
- 客户端不复制服务端的业务数据库，不把本地任务账本误认为服务端事实。

## 与核心 SPEC 的关系

本 ADR 约束整个 Loomhelm 客户端的语言、运行时和本地优先边界；`docs/specs/client-core/SPEC.md` 只定义第一阶段可独立交付的核心子集。核心 SPEC 只交付基础子集；Codex app-server、Skills、Dispatch、Multi-task Flow、Connected mode 属于客户端的其他主题能力；Web App 与服务端始终是独立产品端，不属于客户端能力范围。

客户端合同统一使用以下对象含义：Task 是具有稳定身份、目标、范围、验收条件和依赖的工作单元；Run 是一次 Task 执行尝试；Receipt 是重要执行事实；本地账本保存这些事实及其恢复所需的摘要链。术语表是跨文档名称的索引，核心 SPEC 中的 MUST 要求仍是核心子集的规范来源。

## 取舍

TypeScript 可以直接迁移并复用现有工作流与 Multi-task Flow 的语义、测试和脚本，降低重写风险。Node.js 提供稳定的跨平台进程、文件、网络和打包基础；Bun 保留快速开发体验。

代价是必须维护 Node.js/Bun 兼容层，特别是子进程、信号、文件锁、服务生命周期和平台凭据存储。现有 Go 客户端的连接模式、发行包和生命周期保持其既有合同；本 ADR 只约束新增 TS 实现，不否定 Go 实现或要求重写。

## 约束

- 所有运行时差异集中在小型适配模块中。
- 核心任务模型、协议模型和业务流程不得直接调用 Bun API。
- 发布包必须说明所需 Node.js 版本和可选 Bun 版本。
- 迁移必须保留现有 Skill 和脚本的可审计行为，不以重写为目标。
