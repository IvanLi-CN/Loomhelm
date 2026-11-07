# Mainline baseline and topic branch freshness contract 演进历史（#7uqp8）

> 这里记录关键演进原因；规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- 新建 `#7uqp8`，因为“显式 `$dev-plan` 的具体开发基线输出合同”与“shared workflow 的 topic branch freshness 准备”跨越了 planner 与 execution 两个层面，不能继续挤在 `#5dvcj` 或 `#w7yqp` 的边角里。
- 默认策略改用“目标仓库主干基线”而不是硬编码 `origin/main` 作为长期语义；但 owner-facing 最终计划值必须仍然落成具体 ref，不能把抽象策略词直接冒充最终答案。
- Step 1 被重新定义为“建立正确且新鲜的 topic-branch 执行上下文”，而不是单纯检查“当前是不是在 topic branch”。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#7uqp8`.
