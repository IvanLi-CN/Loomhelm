# 主题规格

| Topic | Lifecycle | Implementation | Spec | Successor |
| - | - | - | - | - |
| Loomhelm 完整工程 | active | 现有服务端、Go 客户端、Web App 与工程交付；完整产品验收以实现说明为准 | [phase1-core](phase1-core/SPEC.md) | - |
| TypeScript 客户端独立核心 | active | 新增独立实现，保留 Go 客户端；Local mode 核心已实现，Connected mode 未实现 | [client-core](client-core/SPEC.md) | - |
| 客户端 Skills 与工程执行支持 | active | 以完整源包、双运行时和旧运行兼容合同约束迁移，不以旧局部模块代替验收 | [client-skills](client-skills/SPEC.md) | - |
| Multi-task Flow Agent 空闲与对话归档 | proposed | 记录 Codex 对话空闲观察、子任务终态归档和归档异常恢复合同 | [multi-task-flow-agent-idle-archive](multi-task-flow-agent-idle-archive/SPEC.md) | - |
