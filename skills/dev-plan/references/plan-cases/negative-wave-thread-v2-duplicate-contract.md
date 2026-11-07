# Wave Thread v2 duplicate contract negative fixture

## Summary

- 验证新 raw-plan 拒绝重复的 Wave Thread Contracts 区段。

## Flow Decision

- `flow_type`: `wave-thread`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `empirical_acceptance`: `not_required`
- `empirical_acceptance_rationale`: `duplicate section rejection is deterministic`
- `review_tier`: `Tier 1`
- `review_rationale`: `contract-only negative fixture`
- `runtime_review_strategy`: `no formal review lane`
- `review_profile_recommendation`: `no formal lane profile`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 拒绝重复的 v2 任务合同。只允许 Task Orchestration 作为新 raw-plan 的唯一机器合同。

## Non-goals

- N1: 不创建任务、PR 或运行时资源。

## Task Orchestration

- batch:batch-a [parent-child] => target=integration/main;depends_on=none;condition=true;acceptance=A1;observation_window=2026-12-31T00:00:00Z;parent_branch=integration/main;child_pr=required;topology=sibling-prs;event_protocol=wave-thread/v2;release_policy=branch-preview
  - wave: 1
    - task:task-a1 [gpt-6-luna, max] => owned_surfaces=src/a;depends_on=none;condition=true;acceptance=A2;skill=$wave-thread-flow;title=Canonical task;purpose=Exercise the duplicate contract rejection.;outputs=negative finding evidence

## Wave Thread Contracts

- batch:batch-a => mode=parent-child;target=integration/main;depends_on=none;condition=true;acceptance=A1;observation_window=2026-12-31T00:00:00Z
- task:task-a1 => owned_surfaces=src/a;depends_on=none;condition=true;acceptance=A2;skill=$wave-thread-flow

## Acceptance & Validation

- A1 [contract/direct] duplicate contract | scope=`batch:batch-a` | phase=`pre_merge` | evidence=`skills/bin/test_wave_thread_plan_contract.ts` | assertions=`stable duplicate-contract finding; Agent default decision card includes version-expectation confirmation`
- A2 [contract/direct] task binding | scope=`task:task-a1` | phase=`pre_merge` | evidence=`skills/bin/plan_contract_check.ts` | assertions=`canonical task fields remain parseable`

## Assumptions/Defaults

- The Agent default release decision card reports publish applicability, components, channel, bump rule, predicted version, target repository, policy source, unknown/blocked conflicts, and version expectation：已确定。
- This is a negative raw-plan fixture：已确定。
