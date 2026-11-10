# ADR 0028: Multi-task Flow version propagation and safe migration

## Context

Skill source、全局安装、Viewer release、运行 daemon 和 orchestration ledger 是独立的版本链。只更新其中一条会让 Agent 使用新规则而 dashboard 继续提供旧 Viewer，或让新 Viewer 对旧账本进行无证据写入。

## Decision

为 Skill、ledger 和 Viewer 记录可比较的版本信封。Skill 使用 SemVer；ledger schema、ledger contract 和 viewer contract 使用独立整数版本；source SHA 和 build ID 保留为实际内容身份。Agent 只发现版本差异并通知 Main Agent，Main Agent 执行登记的安全迁移。

自动迁移只允许无损结构变换、默认值补充和可计算派生投影。迁移必须在账本锁内创建备份、校验 expected revision、记录 request ID 和迁移事件，并保持幂等。涉及 owner、conversation、workspace、branch、PR、SHA、计划语义或外部事实的变化必须阻断并等待主人处理。

`service ensure` 可以自动切换已校验且平台匹配的 candidate release，但必须通过实际 build ID、source SHA、PID、generation 和端口健康检查。历史账本继续可读；缺少新版本事实时保持只读，不静默补写。

## Consequences

版本错位会在 Viewer 和 dashboard 中显式暴露，升级和迁移具备可追溯身份。安全迁移可以让运行中的编排从原停靠点继续，无法证明安全的迁移会保持 fail-closed。

## References

- [Multi-task Flow task execution and delivery boundaries](./0027-multi-task-flow-task-execution-and-delivery-boundaries.md)
- [Multi-task Flow proposal quality gates](./0026-multi-task-flow-proposal-quality-gates.md)
