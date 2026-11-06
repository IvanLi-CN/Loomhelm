## Summary

- 固化 runtime formal review。

## Flow Decision

- `flow_type`: `fast-track`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `review_tier`: `Tier 3`
- `review_rationale`: `current-head proof is required`
- `runtime_review_strategy`: `readiness is incomplete; runtime formal lanes launch unconditionally`
- `review_profile_recommendation`: `recommend gpt-5.6-luna + medium`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 固化运行时审查。计划不包含 reviewer schedule。

## Non-goals

- N1: 不锁定具体 reviewer。

## Task Orchestration

- wave: 1
  - main-agent => 完成 readiness 和 PR 收口 (skill: $fast-flow)

## Acceptance & Validation

- A1 [contract/direct] readiness | scope=`plan` | phase=`pre_merge` | evidence=`test:review` | assertions=`runtime launch is readiness-gated,live PR exists,current head,Step 5C Ready`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- host profile resolution：已确定
