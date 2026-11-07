# Plan task metadata raw-plan fixture

## Summary

- 交付带普通任务元数据的范围合同。

## Flow Decision

- `flow_type`: `normal`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `empirical_acceptance`: `not_required`
- `empirical_acceptance_rationale`: `该格式合同只由确定性本地检查证明。`
- `review_tier`: `Tier 1`
- `review_rationale`: `本计划只校验任务格式，不需要 formal review gate。`
- `runtime_review_strategy`: `Tier 1 不启动 formal review；仅执行计划合同校验。`
- `review_profile_recommendation`: `Tier 1 不需要 formal lane profile；如需 sidecar 由运行时单独选择。`
- 开发基线：`origin/main`

## Goals

- G1: 建立范围合同。交付受限的计划输出格式。

## Non-goals

- N1: 不修改外部项目文档。

## Task Orchestration

- wave: 1
  - main-agent => 为任务对象增加 owner: "frontend" 元数据，并以 adr: 记录架构决定 (skill: $normal-flow)

## Acceptance & Validation

- A1 [contract/direct] plan format | scope=`plan` | phase=`pre_merge` | evidence=`test:format` | assertions=`task metadata remains valid`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- 本地 checker 可用：已确定。
