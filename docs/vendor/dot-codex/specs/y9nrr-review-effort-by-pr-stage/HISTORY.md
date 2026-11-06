# Review model and effort defaults 演进历史（#y9nrr）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- 主人决策：一般与轻量 review 默认使用 `gpt-5.6-luna` + `high`，关联 review 默认使用 `gpt-5.6-sol` + `low`，高要求或疑难 review 在启动前显式标记后使用 `gpt-5.6-sol` + `medium`。
- 主人决策：默认 review 模型切回 `gpt-5.5`，所有 review 入口默认 `low`，并允许 invocation 启动前一次性自由改档。
- 先前决策：所有 review 入口固定使用 `gpt-5.6-terra`，所有 profile 默认 `medium`，并允许 invocation 启动前一次性自由改档。
- `54a9c9b` docs(workflow): align review effort defaults by pr stage
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#y9nrr`.
