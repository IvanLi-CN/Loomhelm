# Dev plan default fast-track auto-lock 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 显式 `$dev-plan` 路径现已把无显式 flow 的 happy path 默认锁到 `fast-track + merge-ready`
- Complexity routing: 无显式多任务信号的 direct work 继续使用 `default_fast_track`；主人明确选择多任务路线时，顶层 flow 锁定为 `multi-task-flow`，获准后由 `$multi-task-flow` 负责运行时协调。旧 `wave-thread` 协调输入仅保留为历史兼容。

## Coverage / rollout summary

- `AGENTS.md` 已把 built-in Plan Mode 默认路径改回官方原味，同时把 repo 的缺省 flow 规则收敛到显式 `$dev-plan` 合同。
- `skills/dev-plan/SKILL.md` 已保留 default auto-lock 合同、`flow_source=default_fast_track` 语义，以及 direct flow-skill / standalone flow token 覆盖优先级，并明确它只在显式 `$dev-plan` 时生效。
- `skills/project-engineering-workflow/SKILL.md` 已明确：显式 `$dev-plan` 计划中的 `Flow Decision.flow_source=default_fast_track` 与其他 locked flow 证据等价，后续恢复不得把它当成未锁定。
- `bin/plan_contract_check.ts` 已接受 `default_fast_track` 和 `default_wave_thread_complexity` 作为合法 flow 锁定来源，并新增 default-auto-lock 场景守卫与 direct flow-skill / standalone token 锁定解析。
- replay fixtures / `CASES.txt` 已补齐默认 auto-lock 正例、direct flow-skill 覆盖正例、以及“互斥信号 / 与 `flow_type` 或 routing 相关但不构成锁定的 wording”都不得静默默认的反例。
- `docs/specs/dev-plan-flow-lock-options/SPEC.md` 与 `docs/specs/flow-continue-lock-guard/SPEC.md` 已做最小交叉引用清理：interactive flow 问题的 owner 仍留在 `docs/specs/dev-plan-flow-lock-options/SPEC.md`，locked-flow 恢复优先级仍留在 `docs/specs/flow-continue-lock-guard/SPEC.md`。

## Remaining Gaps

- None currently tracked after local contract validation.

## Related Changes

- `docs/specs/README.md`
- `docs/specs/dev-plan-default-fast-track-auto-lock/SPEC.md`
- `AGENTS.md`
- `skills/dev-plan/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `bin/plan_contract_check.ts`
- `skills/dev-plan/references/replay-cases/*`

## References

- `./SPEC.md`
- `./HISTORY.md`
