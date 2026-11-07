# Multi-task flow plan raw-plan fixture

## Summary

- 固定一个由三个独立任务组成的依赖图，验证 `multi-task-flow` 作为顶层 flow_type 时保留任务边界、依赖和按范围验收事实。
- 任务内部的 direct PR 收口由运行时 task agent 进入 `$fast-flow`，不改变本计划的顶层 flow_type。

## Flow Decision

- `flow_type`: `multi-task-flow`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `empirical_acceptance`: `not_required`
- ``empirical_acceptance_rationale``: `任务拓扑、依赖和验收绑定由确定性本地契约与投影测试证明。
- `review_tier`: `Tier 3`
- `review_rationale`: `多任务依赖图、任务边界和父级收口需要当前候选的完整 formal review。`
- `runtime_review_strategy`: `Review Readiness 通过后创建 required formal lanes。`
- `review_profile_recommendation`: `formal lane 建议使用 gpt-5.6-luna + xhigh，不预设审查者身份。`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 通过显式任务节点、任务依赖和 owned surfaces 描述可并行的多任务交付拓扑。批次和任务的验收项必须分别绑定到自己的 scope。

## Non-goals

- N1: 不创建真实任务、PR、发布或部署资源。

## Task Orchestration

- batch:multi-core [parent-child] => target=main;depends_on=none;condition=true;acceptance=A1;observation_window=2026-12-31T00:00:00Z;parent_branch=main;child_pr=required;topology=sibling-prs;event_protocol=multi-task-flow/v1;release_policy=branch-preview
  - wave: 1
    - task:task-a [gpt-6-luna, max] => owned_surfaces=src/a;depends_on=none;condition=true;acceptance=A2;skill=$multi-task-flow;title=Prepare task A;purpose=Validate the first independently owned task boundary.;outputs=validated task A facts
    - task:task-b [gpt-5.6-luna, xhigh] => owned_surfaces=src/b;depends_on=none;condition=true;acceptance=A3;skill=$multi-task-flow;title=Prepare task B;purpose=Validate the second independently owned task boundary.;outputs=validated task B facts
  - wave: 2
    - task:task-c [gpt-5.6-luna, max] => owned_surfaces=src/c;depends_on=task-a/integrated,task-b/integrated;condition=true;acceptance=A4;skill=$multi-task-flow;title=Integrate task C;purpose=Consume both completed task facts without changing their ownership.;outputs=validated integration facts

## Acceptance & Validation

- A1 [contract/direct] multi-task batch topology | scope=`batch:multi-core` | phase=`pre_merge` | evidence=`bin/tests/plan/orchestration.test.ts::multi-task-flow canonical facts` | assertions=`top-level multi-task flow preserves one parent batch and three task nodes`
- A2 [behavior/direct] task A boundary | scope=`task:task-a` | phase=`pre_merge` | evidence=`bin/tests/plan/review.test.ts::multi-task-flow projection` | assertions=`task A retains its owned surface and acceptance scope`
- A3 [behavior/direct] task B boundary | scope=`task:task-b` | phase=`pre_merge` | evidence=`bin/tests/plan/review.test.ts::multi-task-flow projection` | assertions=`task B retains its owned surface and acceptance scope`
- A4 [contract/direct] task C dependency | scope=`task:task-c` | phase=`pre_merge` | evidence=`bin/tests/plan/orchestration.test.ts::multi-task-flow canonical facts` | assertions=`task C keeps explicit integrated dependencies on task A and task B`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- The target repository and branch are read from current PR facts; the release decision card remains a runtime result and does not prefill a final version. 已确定。
- 本 fixture 只证明本地 parser、依赖图和 owner-facing projection；不宣称原生任务事件往返成功。已确定。
