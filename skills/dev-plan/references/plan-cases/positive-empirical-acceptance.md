# Direct empirical acceptance plan

## Summary

- 建立一个需要外部行为观察的 direct 变更计划。

## Flow Decision

- `flow_type`: `fast-track`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `empirical_acceptance`: `required`
- `empirical_acceptance_rationale`: `外部设备响应无法由确定性仓库内测试完整证明。`
- `review_tier`: `Tier 3`
- `review_rationale`: `当前 Candidate 需要完整 direct review evidence。`
- `runtime_review_strategy`: `Review Readiness 通过后运行时创建 fresh required formal lanes。`
- `review_profile_recommendation`: `四至六个 formal lane 建议使用 gpt-6-luna + high pair。`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 绑定经验性验收。在 review 前观察指定外部场景并记录当前 Candidate 的结果。

## Non-goals

- N1: 不接入具体设备驱动或厂商协议实现。

## Task Orchestration

- wave: 1
  - main-agent => 完成经验性验收并收敛 current head (skill: $fast-flow)

## Acceptance & Validation

- A1 [contract/direct] empirical acceptance | scope=`plan` | phase=`pre_merge` | evidence=`scenario:device-response@lab-run` | assertions=`scenario=unchanged-source-response,expected=stable-acceptance-at-current-head,live PR exists,current head CI/review converge,Step 5C Ready`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- 外部观察证据由调用方提供：已确定
