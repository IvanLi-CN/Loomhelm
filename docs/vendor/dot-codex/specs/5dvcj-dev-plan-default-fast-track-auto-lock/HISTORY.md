# Dev plan default fast-track auto-lock 演进历史（#5dvcj）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- 新建 `#5dvcj`，把显式 `$dev-plan` 的默认 auto-lock 独立成新 topic spec，避免继续挤在 `#k4n8p` 的 interactive 选项指导或 `#yr954` 的恢复优先级主题里。
- 将主人习惯说的 `pr-ready` 映射为本 repo 共享 stop-condition 语义里的 `merge-ready / Step 5C Ready`，而不是本地 `Step 4 Ready`。
- 保留 `yr954` 的 locked-flow precedence，不让这次 default auto-lock 反向放宽 generic `继续 / 合并 / 收尾` 的恢复边界。
- 把 default auto-lock 的 blocker 收敛到四类：互斥 flow 信号、与 `flow_type` / routing 相关但不构成锁定的 wording、无关 interactive blocker、以及纯 generic `继续` 且无可恢复上下文；避免为了 happy path 继续强迫主人点 flow 选择。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#5dvcj`.
