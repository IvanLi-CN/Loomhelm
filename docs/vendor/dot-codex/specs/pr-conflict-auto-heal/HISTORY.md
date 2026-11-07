# PR conflict auto heal 演进历史（#j4ha2）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `b282add` fix: auto-heal PR conflict diagnostics
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## Contract Notes

- checks/workflow 缺席继续由 live mergeability 与共享 CI contract 共同判定；冲突优先于 absence，确认 manual-only 时也不使用 `workflow_dispatch` 制造自动证据。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#j4ha2`.
