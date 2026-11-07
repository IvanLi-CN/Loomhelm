# Dev plan default fast-track auto-lock

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 目前显式 `$dev-plan` 路径在 `flow_type` 未明确时，仍把 `request_user_input(flow_type)` 当成 happy path 的硬前置门，导致自定义 Plan Mode 经常为了同一个默认选择反复弹一次 flow 选择。
- 主人的实际使用模式已经稳定：当主人明确要求仓库自定义 workflow-aligned 计划时，绝大多数无显式 flow 指令的请求，都希望直接走 `fast-track`，并停在 latest PR 可立即合并的 `merge-ready / Step 5C Ready`。
- 现有相邻 topic spec 只覆盖了局部边界：
  - `docs/specs/dev-plan-flow-lock-options/SPEC.md` 只负责“interactive flow 锁定问题的选项指导”，不 owner 默认无信号路径；
  - `docs/specs/flow-continue-lock-guard/SPEC.md` 只负责“已锁定 flow 的恢复优先级”，不 owner Plan Mode 首次进入时的默认选路。
- 因此这次需要一个新的 owner spec，把“显式 `$dev-plan` 时默认 auto-lock 到 `fast-track + merge-ready`”写成独立契约，同时明确它不会削弱 `docs/specs/flow-continue-lock-guard/SPEC.md` 的锁定优先级守卫，也不 owner 未显式引用 `$dev-plan` 时的官方原味 built-in Plan Mode。

## 核心合同

- 显式引用 `$dev-plan` 时，自定义 plan 路径的 flow 解析顺序固定为：显式 `flow_type:` -> 显式切 flow 文本 -> standalone flow token -> direct flow-skill 引用 -> `default_fast_track` -> `request_user_input(flow_type)`。
- `default_fast_track` 只允许用于新的规划请求，且当前请求同时满足：无显式 flow、无互斥信号、无与 `flow_type` / routing 相关但不构成锁定的 wording、无先前 non-`flow_type` interactive blocker。
- 该显式路径的默认 `Flow Decision` 必须是 `flow_type=fast-track`、`flow_source=default_fast_track`、`lock_status=locked`，默认 stop condition 是 `merge-ready / Step 5C Ready`。
- 显式 `implement-only` / `normal` / `local-merge`、显式切 flow 文本、standalone flow token、以及 direct flow-skill 引用都必须覆盖默认值。
- 至少以下 direct flow-skill 引用必须被视为合法锁定证据：`$implement-only-flow`、`$normal-flow`、`$fast-flow`、`$local-merge-flow`。
- 多个互斥 flow 信号、仅出现与 `flow_type` / routing 相关但不构成锁定的 wording、或无可恢复上下文的 generic `继续 / continue`，都必须触发 `request_user_input(flow_type)`，不得静默落默认值。
- 显式 `$dev-plan` 输出中的 `Flow Decision.flow_source=default_fast_track` 一旦进入 `<proposed_plan>`，后续恢复/继续语义必须把它视为合法 locked-flow 证据；这条规则不得削弱 `docs/specs/flow-continue-lock-guard/SPEC.md` 的锁定优先级守卫。
- checker / replay / skill 文案必须与本合同保持一致。

## 非目标

- 不修改 `fast-track`、`normal`、`local-merge`、`implement-only` 的业务执行语义。
- 不把默认 auto-lock 扩展成 generic continuation 的新入口。
- 不改变 `docs/specs/flow-continue-lock-guard/SPEC.md` 已有的“已锁定 session 不得被热更新文案追溯改写”规则。
- 不接管未显式引用 `$dev-plan` 时的官方原味 built-in Plan Mode 默认行为。

## 验收标准（Acceptance Criteria）

- Given 用户在 built-in Plan Mode 中显式引用 `$dev-plan`，且请求未显式指定 flow，也没有冲突或无关 interactive blocker When assistant 直接输出 `<proposed_plan>` Then `Flow Decision` 必须是 `flow_type=fast-track`、`flow_source=default_fast_track`、`lock_status=locked`，且默认 stop condition 为 `merge-ready / Step 5C Ready`。

- Given 用户在显式 `$dev-plan` 请求里直接引用 `$local-merge-flow` When assistant 输出 `<proposed_plan>` Then `Flow Decision.flow_type` 必须是 `local-merge`，而不是默认 `fast-track`。

- Given 同一条显式 `$dev-plan` 用户请求里同时出现 `normal` 与 `$fast-flow` 这类互斥 flow 信号 When assistant 试图规划 Then 它必须继续发起 `request_user_input(flow_type)`，而不是静默落 `default_fast_track`。

- Given flow 在显式 `$dev-plan` 路径中以 `flow_source=default_fast_track` 锁定 When 后续 turn 只说 generic `继续 / 合并 / 收尾` Then 共享恢复语义必须把它当成已锁定 `fast-track` session 处理，不得因为“它不是显式提问锁的”而判成未锁定。

## 风险 / 假设

- 风险：如果 default auto-lock 的 blocker 识别过宽，会把正常请求重新打回追问；若识别过窄，则会在歧义请求里静默猜 flow。
- 假设：主人当前说的 `pr-ready` 在本 repo 共享术语里应映射到 `merge-ready / Step 5C Ready`，而不是 `Step 4 Ready`。
- 假设：default auto-lock 仅适用于显式 `$dev-plan` 的首次规划入口，不自动推广到 `flow-continue` 的 generic continuation。

## Testing

- `bash bin/plan_contract_check.sh --cases skills/dev-plan/references/replay-cases/CASES.txt`
- `git diff --check`

## 参考（References）

- `docs/specs/dev-plan-flow-lock-options/SPEC.md`
- `docs/specs/flow-continue-lock-guard/SPEC.md`
- `skills/dev-plan/SKILL.md`
- `bin/plan_contract_check.sh`
