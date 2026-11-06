# GUI Escalation Gate History

## Decisions

- 保留 `Browser Use` 与 `Computer Use` 插件启用状态，因为未来任务可能需要这些能力。
- 不修改 bundled plugin cache 内的自带 skill，因为插件更新或缓存刷新可能覆盖本地改动。
- 将长期策略放入本仓可控的 `AGENTS.md`、自有 skill 与 topic spec。
- Legacy compatibility identity: `#gn7xq`.
- 浏览器正式入口已从 Chrome-first 迁移到 `$agent-browser`；Chrome control 只保留给显式请求或必须复用既有 Chrome 会话的任务。
- Browser-task GUI escalation 现在先尝试 `$agent-browser`，再仅在满足明确例外时使用 Chrome control 或 DevTools，防止因工具不可用猜测而主观切换路线。
- Browser-task recovery 不维护 project-owned headless-proof browser layer；若 `$agent-browser` 被阻断且没有可用例外，agent 只能报告 blocker 或按 GUI gate 评估升级，不得自起新的 Chrome/Chromium/`9222` 调试实例来伪造 DevTools Surface。
- `AGENTS.md` 保持短入口职责，DevTools isolated-context 细则下沉到 `skills/gui-escalation-gate/SKILL.md` 与本 spec。
