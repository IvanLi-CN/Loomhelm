---
status: accepted
---

# 显式计划的范围权威与主题 Spec 边界

## Context

Grilling、显式 `$dev-plan` 和 canonical topic Spec 服务于不同生命周期。过去的计划可以把仓库证据或模型推断演绎成 Goal、验收或流程硬门禁，Topic Spec 也混入执行状态、PR 选项和任务清单，造成来源不可追溯与重复治理。

## Decision

- 显式 `$dev-plan` 在 `Flow Decision` 后生成临时 `Scope Basis`，为每个 `G*`、`N*`、`A*` claim 记录唯一来源。只有具体 owner 指令、存在 anchor 的 canonical Spec 或 ADR 才能授权 material claim；`derives` 只连接已授权 claim，`flow` 只记录流程技能。
- 泛化的 owner 批准、仓库事实和模型推断不能单独授权范围；来源解析由 Agent 自动完成，不把查找来源的工作转嫁给主人。未调用 `$dev-plan` 时，原生 Plan Mode 不受此合同影响。
- canonical `SPEC.md` 是可追溯、可验证的主题级需求合同，使用稳定 `REQ-*` 与 `VER-*`；实施覆盖、命令、当前状态、PR/commit 关联和生命周期历史分别归入 `IMPLEMENTATION.md` 与 `HISTORY.md`。工作流主题可以在规范性需求中描述 PR/Phase 行为，但不能把当前任务状态写入 Spec。
- Task Evidence Set 是视觉交付阶段的临时输入；Spec 中的 `Visual Evidence` 只保留规范性 owner-facing 资产，PR 选图与 Phase A/B 记录由既有工作流负责。

## Consequences

- 计划 checker 可以拒绝无来源或来源过宽的 claim，并保持 legacy recovery 读取能力。
- Spec checker 可以按结构拒绝执行编排和未决问题，而不会因为工作流需求中的 `PR` 或 `Phase` 词语误伤。
- 已有未触及的历史或外部 Spec 保持可读，不进行批量重写。

## Related Specs

- [Dev plan goals first](../specs/dev-plan-goals-first/SPEC.md)
- [Topic Spec model](../specs/topic-spec-model/SPEC.md)
- [Shared UI visual evidence gate](../specs/shared-ui-visual-evidence-gate/SPEC.md)
