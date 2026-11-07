# Dev plan flow lock option guidance cleanup 演进历史（#k4n8p）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `df977df` fix: enforce complete flow lock options
- `76c6b4d` fix: remove plan flow lock limitation wording
- `46cbee3` fix: remove strict flow option validation
- `b583666` fix: relax plan flow option guidance
- `b39a914` docs(specs): adopt topic-level spec model
- `#5dvcj` 接管 built-in Plan Mode 的 default auto-lock；`#k4n8p` 仅继续 owner interactive `request_user_input(flow_type)` 的选项指导与别名兼容。

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#k4n8p`.
