# PR convergence batching 演进历史（#syj6s）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- 统一首轮 `CI-Operator` sub-agent 的模型偏好为 `gpt-5.6-luna + low`，绑定单一 PR head SHA，并要求主 agent 通过阻塞式等待接收结果；模型或 effort override 不可用时回退到继承配置，同时保持 review profile 不变；重复的 tracker 不变量集中到 CI tracking short contract。
- `d443ac1` fix(flow): batch PR convergence before remote churn
- `71c44e5` fix(review): preserve convergence budgets across repair pushes
- `f565cff` fix(flow): enforce resumable PR convergence gates
- `281b1cd` fix(flow): honor no-write PR proof gates
- `b4544c8` fix(review): rerun stale pre-pr proofs on new heads
- `3b0afb3` fix(review): bind proof budget to current PR batch
- `90e80dd` fix(docs): persist PR budget bindings consistently
- `2c11073` fix(review): harden proof-only convergence rules
- `4895098` docs(review): add pragmatic stop-loss after repeated reviews
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#syj6s`.
