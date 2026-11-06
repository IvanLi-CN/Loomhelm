---
status: accepted
---

# 交付门禁以外部事实为准

> Review conclusion superseded by [ADR 0013](0013-review-necessity-tiering.md); CI, release, tracker, and post-merge external facts below remain active.

交付资格由当前候选的验证结果、PR/CI 实时状态以及实际发布产物决定；Agent 的调用传输、子任务身份、等待方式和内部 transcript 只服务于执行，不构成交付证明。独立 review 作为 advisory review 提供可定位的改进建议，高风险改动自动运行，但其缺失或失败不能替代或阻塞上述事实门禁。这样可以保留低成本子 Agent 的并行与等待收益，同时避免 harness 日志格式变化改变流程结果。

## Considered Options

- 将 native spawn、child session 和 transcript attestation 作为 review/merge proof：拒绝，因为它把执行器内部格式误当成业务事实，并已导致 PTC 调用被错误判定为无 Agent。
- 为每一种 PTC/harness 变体增加日志解析器：拒绝，因为解析器与运行时实现强耦合，维护成本高且无法提升 PR、CI 或发布事实的可信度。

## Consequences

- tracker 仍由低成本子 Agent 执行轮询，主 Agent 等待运行时返回的任务句柄，并在终态后复核一次外部事实。
- review 结果需要可定位证据才能帮助修复，但不再写入或满足 flow receipt 的 merge gate。
- Direct receipt schema v1-v4 已退役并明确拒绝；仅 active v5 receipt 可迁移到 v6。
