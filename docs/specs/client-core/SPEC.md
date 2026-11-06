# 客户端独立核心

## Context and Scope

客户端核心承担本地配置、进程生命周期、任务与运行身份、账本收据和 Git/worktree 适配。它是客户端设计的基础子集，不包含 Codex app-server 协议、Skills 迁移、Multi-task Flow 调度、Connected mode、Web App 或服务端。

## Terms and Interfaces

本主题使用与 [术语表](../../GLOSSARY.md) 一致的对象定义：Task 是具有稳定身份、目标、范围、验收条件和依赖的工作单元；Run 是一次 Task 执行尝试；Receipt 是账本中的可验证重要执行事实；Ledger 是按顺序保存 Receipt、摘要链和恢复信息的本地账本；operation identity 是识别一次请求的稳定键；`schemaVersion` 是持久化格式版本键。Codex thread、turn 和 Dispatch 属于客户端总体设计，但不属于本核心 SPEC 的接口。

公共源码入口为 `client/src/index.ts`，构建后的本地 CLI 为 `client/dist/cli.js`；两者共享同一核心合同。

## Requirements

### REQ-CORE-001

客户端 MUST 无需服务端或凭据即可加载本地配置、启动、查询和停止。Node.js 为基线；业务代码 MUST 不调用 Bun 专属 API。配置 MUST 拒绝未知版本和无效字段。

### REQ-CORE-002

Task MUST 具备目标、范围、验收条件、依赖和稳定身份。相同 operation identity 的请求 MUST 表示同一事实；不同请求不得复用该身份。开始运行 MUST 检查依赖成功，失败、阻塞和中断允许显式重试；成功、取消和跳过保持终态。每次尝试 MUST 具有独立 Run 身份。

### REQ-CORE-003

账本 MUST 单写、原子持久化并验证收据序列与摘要链；重复 operation identity 的相同请求 MUST 返回既有收据，冲突请求 MUST 拒绝。损坏或未知版本 MUST 拒绝加载。重启 MUST 将未完成 Run 标记为 interrupted，不推断其成功。锁所有权 MUST 在释放时验证；不能自动抢占活跃锁。

### REQ-CORE-004

运行时 MUST 提供有界输出、超时和停止后的退出等待。Git 适配 MUST 使用参数数组，不通过 shell 执行；worktree 创建 MUST 要求干净源目录、新分支及不存在的目标，并保留 remote 配置和已有文件。

## Verification

### VER-CORE-001

- Method: 双运行时配置与 CLI 集成验证。
- covers: `REQ-CORE-001`
- Pass condition: 无服务端完成任务生命周期，非法配置被拒绝。

### VER-CORE-002

- Method: 任务依赖、重试、幂等与重启测试。
- covers: `REQ-CORE-002`, `REQ-CORE-003`
- Pass condition: 依赖门禁有效，失败可重试，重复操作不增加事实，损坏拒绝加载，运行重启后中断，第二写者被拒绝。

### VER-CORE-003

- Method: 临时进程与真实临时 Git 仓库测试。
- covers: `REQ-CORE-004`
- Pass condition: 超时退出、输出超限拒绝、worktree 身份正确，脏目录和已有目标拒绝操作。

## Related ADRs

- [ADR 0001](../../adr/0001-typescript-client-runtime.md)

## References

- [客户端设计](../../design/client.md)
- [实现说明](IMPLEMENTATION.md)
- [历史](HISTORY.md)
