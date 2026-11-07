# Flow continue lock guard 演进历史（#yr954）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- 新增 `default_initiative_complexity` lock source，并把旧 `fast-track + aggregate-stack` 限制为 recovery-only compatibility。
- 恢复 checker 与 planner 共享 `多ticket倡议`、`倡议流` 别名，避免中文 Initiative 锁在 generic continue 时退化为 unknown。
- repair permit 的 base fast-forward 是 current-base rebind，不是 reset 或 `convergence-reopen`：状态机继续由 `workflow-execution-receipts` 持有，恢复层只将 generic continuation 前、当前 flow lock 下同一条 assistant message 的完整且无歧义三元前提路由到 ordinary PR convergence，并拒绝缺失、非可信、部分、矛盾、续推后、flow-switch 后、混入 reset/reopen 或不完整 repair-wave 的自动 recovery route。
- recovery route 的可信边界收紧为结构化调用和当前快照：最新 marker 取代旧 marker，非可信或非 canonical 事实、反向否定、draft bootstrap、顶层 reopen 与文本伪 route 都不能恢复；合法 repair-wave 保留 argparse 的可选 head 与参数顺序语义。没有 recovery marker 的普通 `$pr-create` 继续由既有 ordinary convergence 处理。
- recovery route 的结构化检查拒绝 duplicate JSON key、额外 skill argument、非 canonical interpreter、shell 元字符、未知/悬空/sentinel 后 CLI operand 与错误 retry；仅新可信 marker 可以替换被拒绝 route 的当前 snapshot。

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
