# Flow continue lock guard 演进历史（#yr954）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `91e9479` fix(flow): preserve locked flow across prompt drift
- `b39a914` docs(specs): adopt topic-level spec model
- `#5dvcj` 新增 built-in Plan Mode 的 `default_fast_track` lock source 后，`#yr954` 明确把它纳入合法 locked-flow 证据，但继续禁止 generic continuation 改路由。
- Initiative 增加后，恢复层仍保持“显式事实优先”：child merge 只恢复 integration CI，aggregate 的最终 merge 必须绑定主人对当前 head SHA 的明确批准。

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#yr954`.
