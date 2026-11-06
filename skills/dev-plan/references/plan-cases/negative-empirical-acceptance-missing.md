# Missing empirical acceptance declaration

## Summary

- 验证 direct plan 不能省略经验性验收评估。

## Flow Decision

- `flow_type`: `fast-track`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `review_tier`: `Tier 3`
- `review_rationale`: `当前 Candidate 需要完整 direct review evidence。`
- `runtime_review_strategy`: `Review Readiness 通过后运行时创建 fresh required formal lanes。`
- `review_profile_recommendation`: `四至六个 formal lane 建议使用 gpt-5.6-luna + medium pair。`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 验证经验性评估字段。缺少评估时 checker 必须阻断 finalized direct plan。

## Non-goals

- N1: 不执行外部系统观察。

## Task Orchestration

- wave: 1
  - main-agent => 校验 direct plan 合同 (skill: $fast-flow)

## Acceptance & Validation

- A1 [contract/direct] empirical declaration | scope=`plan` | phase=`pre_merge` | evidence=`test:plan-contract` | assertions=`missing empirical acceptance declaration fails`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- 该样例仅用于合同回放：已确定
