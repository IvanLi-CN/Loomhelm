# GUI Escalation Gate Implementation

## Status

已实现。

## Coverage

- `AGENTS.md`: 保留全局浏览器与 GUI 路由门禁，将 `$ego-browser` 设为默认浏览器路线，并将 Chrome control 限制为显式例外。
- `skills/gui-escalation-gate/SKILL.md`: 定义 `$ego-browser` 默认路线、Chrome / DevTools 例外和 `Computer Use` 升级条件，并承载 DevTools 例外路径与 isolated-context 细则。
- `CONTEXT.md`: 新增 `Synthetic DevTools Bootstrap` 术语，避免把非法恢复动作继续混写成“选错浏览器”。
- `docs/specs/gui-escalation-gate/SPEC.md`: 固化长期契约。
- `bin/browser_policy_replay_check.py`: 检查 `$ego-browser` 默认路线，以及“ego-browser 不可用 -> 请求 Chrome fallback”回归。
- Replay coverage includes direct and failed-command Chrome-fallback negatives plus an ego-browser-first positive path.

## Validation

- `python3 bin/browser_policy_replay_check.py --policy`
- `python3 bin/browser_policy_replay_check.py --cases docs/specs/gui-escalation-gate/replay/cases.txt`
- `rg -n "ego-browser|Ego Browser Standard|Chrome Control Exception Gate" skills/gui-escalation-gate docs/specs/gui-escalation-gate`
