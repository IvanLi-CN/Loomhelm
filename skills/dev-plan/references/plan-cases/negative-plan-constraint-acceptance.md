# Invalid constraint raw-plan fixture

## Summary

- 这个计划错误地把约束指向不存在的验收项。

## Flow Decision

- `flow_type`: `normal`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- 开发基线：`origin/main`

## Goals

- G1: 建立范围合同。交付受限的计划输出格式。

## Constraints

- C1: 验收必须使用受控输入。 | applies_to=`A9`

## Non-goals

- N1: 不修改外部项目文档。

## Task Orchestration

- wave: 1
  - main-agent => 验证合同 (skill: $normal-flow)

## Acceptance & Validation

- A1 [contract/direct] plan format | scope=`plan` | phase=`pre_merge` | evidence=`test:format` | assertions=`constraint is linked`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- 本地 checker 可用：已确定。
