# ADR 0043：综合审查与独立 reviewer 生命周期

## Status

Accepted。

## Context

固定四个通用视角分别启动 reviewer，会重复读取上下文并增加去重、等待和续接成本；跨契约、状态与失败恢复的因果关系仍需完整审查。维度覆盖与 reviewer 数量需要分开表达。

## Decision

直接交付 Tier 3 使用一个综合只读 reviewer，覆盖契约、状态与并发、失败与数据安全、测试与平台四个维度。Tier 4 按明确风险增加一至两个专项 reviewer。每个维度必须有覆盖结论或不适用理由，维度不伪装成独立审查证据。

每轮正式 review 使用全新 `fork_turns=none` sub-agent；未结束的同一轮继续等待，终态实例退役。Candidate 改变后综合 review 检查完整当前 base-to-head 差异，修复清单提供上下文但不缩小审查范围。只有可证明未受影响的专项结果可在当前运行内保留；采用新 base 或影响不明时全量刷新。

本决策替代 vendor ADR 0013、0014、0017 中固定四 lane 和仅按影响刷新通用 lane 的部分，保留其 readiness、只读、候选绑定和主 Agent 修复边界。旧 review-wave ledger adapter 保持历史兼容，不成为当前直接交付的调度器或门禁。

## Consequences

默认减少 reviewer 数量，综合 reviewer 承担完整覆盖责任；风险边界无法覆盖时必须补充专项审查，不能将缺失覆盖判为 clear。实际审查按共享合同从 `gpt-5.6-luna + medium`、`gpt-5.6-luna + xhigh` 与 `gpt-6.1-sol + low` 选择请求档位。本条取代 ADR 0042 对当前直接交付固定 `gpt-6-luna + max` 的要求，保留父流程请求和结果证据分离。CI 门禁和 findings 处置沿用原合同。
