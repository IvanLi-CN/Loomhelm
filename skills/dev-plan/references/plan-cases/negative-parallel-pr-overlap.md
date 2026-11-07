<proposed_plan>

# 无效并行 direct PR

## Summary

- 结论：尝试创建两个 ownership 重叠的 direct PR task。

## Flow Decision

- `flow_type`: `parallel-pr`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `parallel_cohort`: `bad-parallel`
- `parallel_task_budget`: `2`
- 开发基线：`origin/main@4b213dd8143049ade2a59feb8366c5d3cb186416`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 验证 ownership 校验两个 task 声明相同写入面。

## Non-goals

- N1: 不创建 aggregate PR。

## Task Orchestration

- wave: 1
  - task:pr-alpha [gpt-5.6-luna, high] => 实现 alpha (skill: $parallel-pr-flow)
  - task:pr-beta [gpt-5.6-luna, high] => 实现 beta (skill: $parallel-pr-flow)

## Parallel PR Contracts

- task:pr-alpha => owned_surfaces=src/shared/**; consumed_contracts=none; depends_on=none; merge_mode=ready-only
- task:pr-beta => owned_surfaces=src/shared/**; consumed_contracts=none; depends_on=none; merge_mode=ready-only

## Acceptance & Validation

- A1 [contract/direct] ownership | evidence=`command:plan_contract_check --plan -` | assertions=`owned_surfaces_disjoint`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- Native task Worktrees: 已确定 </proposed_plan>
