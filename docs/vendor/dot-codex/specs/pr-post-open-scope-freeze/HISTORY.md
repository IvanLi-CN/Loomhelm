# PR post-open scope freeze 演进历史（#pj4fz）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- 将 PR open freeze 拆成 Draft goal-scope 与 candidate convergence freeze，Draft bootstrap 通过独立 early-return 返回 Step 3，避免早期 Draft 阻断已批准切片或误入 Step 5。

- `b577074` fix(flow): freeze post-open PR scope
- `01a4501` fix(flow): generalize same-pr reopen scope
- `c39563c` fix(flow): extend reopen and freeze guardrails
- `7552826` fix(flow): persist same-pr reopen state
- `4986a57` fix(flow): bind reopen recovery to pr context
- `03654c5` fix(flow): tighten reopen recovery bindings
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#pj4fz`.
