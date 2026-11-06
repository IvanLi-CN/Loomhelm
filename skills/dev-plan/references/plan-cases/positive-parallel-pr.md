<proposed_plan>

# 并行 direct PR

## Summary

- 结论：以一个冻结 cohort 协调两个互不依赖的 direct PR task，并在各自 Step 5C Ready 后收口。

## Flow Decision

- `flow_type`: `parallel-pr`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `parallel_cohort`: `parallel-demo`
- `parallel_task_budget`: `2`
- 开发基线：`origin/main@4b213dd8143049ade2a59feb8366c5d3cb186416`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 实现两个独立 direct PR slice 每个 task 只写入冻结 ownership，并报告实现与 Step 5C 里程碑。

## Non-goals

- N1: 不创建 Initiative、Ticket、integration branch 或 aggregate PR。
- N2: 不改变仓库 remote、发布或部署配置。

## Task Orchestration

- wave: 1
  - task:pr-alpha [gpt-5.6-luna, high] => 实现 alpha direct PR 并报告 milestone (skill: $parallel-pr-flow)
  - task:pr-beta [gpt-5.6-luna, high] => 实现 beta direct PR 并报告 milestone (skill: $parallel-pr-flow)

## Parallel PR Contracts

- task:pr-alpha => owned_surfaces=src/alpha/**; consumed_contracts=docs/specs/alpha/SPEC.md; depends_on=none; merge_mode=ready-only
- task:pr-beta => owned_surfaces=src/beta/**; consumed_contracts=docs/specs/beta/SPEC.md; depends_on=none; merge_mode=ready-only

## Acceptance & Validation

- A1 [contract/direct] parallel-pr contract | evidence=`command:plan_contract_check --plan -` | assertions=`2_to_8_tasks_only,same_exact_base,depends_on_none,owned_surfaces_disjoint,parallel_task_contracts_complete`
- A2 [safety/direct] task isolation | evidence=`fixture:parallel-pr-positive-and-negative` | assertions=`milestone_reports_only,parent_no_active_polling,independent_block_does_not_cancel_cohort`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- Native task Worktrees and task-to-parent messages: 已确定
- 默认 task merge mode: 已确定 </proposed_plan>
