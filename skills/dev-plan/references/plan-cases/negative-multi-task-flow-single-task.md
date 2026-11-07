# Multi-task flow downgrade fixture

## Summary

- 验证 `multi-task-flow` 不得退化成单个 direct `main-agent` 任务。

## Flow Decision

- `flow_type`: `multi-task-flow`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `empirical_acceptance`: `not_required`
- `empirical_acceptance_rationale`: `拓扑门禁由本地契约检查证明单任务降级必须失败`。
- `review_tier`: `Tier 3`
- `review_rationale`: `单任务拓扑不满足多任务路由。`
- `runtime_review_strategy`: `Review Readiness 通过后创建 required formal lanes。`
- `review_profile_recommendation`: `formal lane 建议使用 gpt-5.6-luna + xhigh。`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 保留多任务拓扑门禁。单个 direct 任务必须被识别为降级，而不是被当作完整的多任务计划。

## Non-goals

- N1: 不创建真实任务、PR、发布或部署资源。

## Task Orchestration

- batch:multi-core [parent-child] => target=main;depends_on=none;condition=true;acceptance=A1;observation_window=2026-12-31T00:00:00Z;parent_branch=main;child_pr=required;topology=sibling-prs;event_protocol=multi-task-flow/v1;release_policy=branch-preview
  - wave: 1
    - task:task-a [gpt-6-luna, max] => owned_surfaces=src/a;depends_on=none;condition=true;acceptance=A1;skill=$multi-task-flow;title=Direct implementation;purpose=Implement the direct task.;outputs=Implementation changes

## Acceptance & Validation

- A1 [contract/direct] multi-task topology | scope=`task:task-a` | phase=`pre_merge` | evidence=`skills/bin/tests/plan/multi-task-flow.test.ts::single-task topology downgrade` | assertions=`a single task node is rejected`

## Assumptions/Defaults

- 本 fixture 只用于验证多任务不能降级为单任务。已确定。
- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
