---
status: accepted
---

# 计划授权留在内部，验证限制建模为范围约束

## Context

将对话来源逐条输出到 `Scope Basis` 的初衷，是阻止模型把仓库事实、推断或泛化批准演绎成计划范围。它无法从静态 Markdown 判断一句话是否真正蕴含后续机制，反而会把主人对旧方案的否定、纠正或安全限制逐字写入计划，并将验证条件伪装成新的 Goal。

## Decision

- Scope Authority 仍由 Agent 在输出前自动检查：只有具体主人请求或有效的当前 Spec/ADR 能授权 material Goal 或 Non-goal；不把来源查找或重述转嫁给主人。
- 最终 `$dev-plan` 不输出 `Scope Basis`、主人消息引语或 `owner`、`contract`、`adr`、`derives`、`flow` 来源映射；不保留该格式的兼容输出路径。
- 主人对方法的否定、受控验证、绝对时间和安全边界等限制使用语义化 `C*` Constraint 表达，并绑定已有 `A*` 验收项。Constraint 只限制已授权目标及其验收，不能独立授权新 workflow、脚本、Spec、远端写入或交付义务。
- 当提出的具体机制没有独立授权时，Agent 必须提出一个明确决策，而不是把机制混入 Goal、Constraint 或 Task Orchestration。

## Consequences

- 主人审阅的是目标、边界、约束、编排和验收，而不是对话转录或伪精确的来源账本。
- checker 可以可靠验证最终文档的结构边界和 Constraint 到验收的关联，但不声称能从静态文本证明对话语义蕴含。
- 本 ADR 取代 [ADR 0004](0004-scope-authority-and-topic-spec-boundaries.md) 中关于最终计划输出 Scope Basis 的决定；ADR 0004 关于 Topic Spec 分层的决定继续有效。

## Related Specs

- [Dev plan goals first](../specs/dev-plan-goals-first/SPEC.md)
