# Review proof 去重与等待语义守卫 演进历史（#m3k8q）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- shared proof 生命周期从 exec-session polling 迁移为 native Agent task + `wait_agent`；旧 replay fixtures 保留为历史事故样例，不再作为 current shared gate checker。
- completed proof 从 raw output/SHA 推断改为 execution receipt + current-head delta attestation；live proof identity 仍严格绑定当前 head。
- 以 spec-local deterministic fixtures 取代已回收的全局 session replay，继续覆盖 exec-session wait misuse 与 non-direct review launch。

- `dab0cc2` fix(flow): guard review proof lifecycle
- `8a262c7` docs(review): align proof startup with codex runtime
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#m3k8q`.
