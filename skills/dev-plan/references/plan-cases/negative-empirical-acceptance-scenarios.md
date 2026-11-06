# Empirical acceptance without scenarios

## Summary

- 验证 required 经验性验收必须列出场景和期望结果。

## Flow Decision

- `flow_type`: `normal`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `empirical_acceptance`: `required`
- `empirical_acceptance_rationale`: `外部行为无法由确定性本地验证证明。`
- `review_tier`: `Tier 1`
- `review_rationale`: `该样例只检查计划合同。`
- `runtime_review_strategy`: `Tier 1 不启动 formal review；仅执行计划合同校验。`
- `review_profile_recommendation`: `Tier 1 不需要 formal lane profile；如需 sidecar 由运行时单独选择。`
- 开发基线：`origin/main`

## Goals

- G1: 拦截空泛经验性验收。 required 计划必须列出可观察场景与期望结果。

## Non-goals

- N1: 不运行外部观察。

## Task Orchestration

- wave: 1
  - main-agent => 校验经验性验收合同 (skill: $normal-flow)

## Acceptance & Validation

- A1 [contract/direct] acceptance contract | scope=`plan` | phase=`pre_merge` | evidence=`test:plan-contract` | assertions=`external behavior is validated by deterministic tests`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- 该样例仅用于合同回放：已确定
