# Missing phase direct plan contract fixture

## Summary

- 验证 direct/v1 新验收项不能省略生命周期阶段。

## Flow Decision

- `flow_type`: `fast-track`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `empirical_acceptance`: `not_required`
- `empirical_acceptance_rationale`: `合同错误可由确定性本地检查证明。`
- `review_tier`: `Tier 3`
- `review_rationale`: `当前 Candidate 需要完整 direct review evidence。`
- `runtime_review_strategy`: `Review Readiness 通过后运行时创建 required lanes。`
- `review_profile_recommendation`: `四至六个 formal lane 建议使用 gpt-5.6-luna + medium pair。`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 阻断没有阶段声明的 direct/v1 验收项。该合同错误必须在 raw-plan 检查阶段暴露。

## Non-goals

- N1: 不执行真实部署或发布。

## Task Orchestration

- wave: 1
  - main-agent => 校验阶段化验收合同 (skill: $fast-flow)

## Acceptance & Validation

- A1 [contract/direct] phase declaration | evidence=`test:missing-phase` | assertions=`missing phase is rejected,live PR exists,current head CI/review converge,Step 5C Ready`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- 该 fixture 仅用于合同回放；已确定。
