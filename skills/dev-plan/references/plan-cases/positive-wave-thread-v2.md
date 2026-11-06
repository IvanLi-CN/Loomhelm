# Wave Thread v2 batch plan raw-plan fixture

## Summary

- 固定一个多波次父子批次和一个直接批次，验证四层交付拓扑及阶段验收绑定。
- 本 raw-plan fixture 给出 A1-A10 的离线 scope/phase/locator 映射；A10 的 live PR、CI、formal review 和 Step 5C 事实仍由 delivery gate 在候选 PR 上单独证明。

## Flow Decision

- `flow_type`: `wave-thread`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `empirical_acceptance`: `not_required`
- `empirical_acceptance_rationale`: `批次、波次、任务和验收绑定由确定性本地契约与离线回放证明。`
- `review_tier`: `Tier 3`
- `review_rationale`: `v2 状态、事件和兼容适配需要当前候选的完整 formal review。`
- `runtime_review_strategy`: `Review Readiness 通过后创建 required formal lanes。`
- `review_profile_recommendation`: `四个 formal lane 建议使用 gpt-5.6-luna + xhigh，不预设审查者身份。`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 固定父子批次的多波次编排和直接批次的单任务最终 PR。每个批次声明自己的观察期限、依赖、条件和验收证据。

## Non-goals

- N1: 不创建真实任务、PR、发布或部署资源。

## Task Orchestration

- batch:batch-a [parent-child] => target=integration/main;depends_on=none;condition=true;acceptance=A1,A6,A7,A8,A9;observation_window=2026-12-31T00:00:00Z;parent_branch=integration/main;child_pr=required;topology=sibling-prs;event_protocol=wave-thread/v2;release_policy=branch-preview
  - wave: 1
    - task:task-a1 [gpt-6-luna, max] => owned_surfaces=src/a;depends_on=none;condition=true;acceptance=A2;skill=$wave-thread-flow;title=Prepare canonical facts;purpose=Validate the canonical batch and task facts before projection.;outputs=validated parser facts for the first wave
  - wave: 2
    - task:task-a2 [gpt-5.6-luna, xhigh] => owned_surfaces=src/b;depends_on=task-a1/integrated;condition=true;acceptance=A3;skill=$wave-thread-flow;title=Project the review view;purpose=Render the approved owner-facing view from validated facts.;outputs=transient Markdown projection
- batch:batch-b [direct] => target=main;depends_on=none;condition=true;acceptance=A4,A10;observation_window=2026-12-31T00:00:00Z;parent_branch=main;child_pr=none;topology=direct-final-pr;event_protocol=wave-thread/v2;release_policy=branch-preview
  - wave: 1
    - task:task-b1 [gpt-5.6-luna, max] => owned_surfaces=src/c;depends_on=none;condition=true;acceptance=A5;skill=$wave-thread-flow;title=Verify delivery boundaries;purpose=Confirm direct-batch delivery and candidate isolation.;outputs=delivery validation evidence

## Acceptance & Validation

- A1 [contract/direct] batch topology | scope=`batch:batch-a` | phase=`pre_merge` | evidence=`test_wave_thread_v2.ts::WaveThreadV2Tests.test_default_parent_child_batch_can_have_multiple_waves` | assertions=`one parent PR across multiple waves`
- A2 [behavior/direct] first task | scope=`task:task-a1` | phase=`pre_merge` | evidence=`test_wave_thread_v2.ts::WaveThreadV2Tests.test_multi_wave_batch_can_advance_before_future_wave_tasks_exist` | assertions=`task integration and archive precede dependent wave`
- A3 [behavior/direct] dependent task | scope=`task:task-a2` | phase=`pre_merge` | evidence=`test_wave_thread_v2.ts::WaveThreadV2Tests.test_multi_wave_batch_can_advance_before_future_wave_tasks_exist` | assertions=`later wave waits for integrated task`
- A4 [contract/direct] direct topology | scope=`batch:batch-b` | phase=`pre_merge` | evidence=`test_wave_thread_v2.ts::WaveThreadV2Tests.test_direct_mode_implementation_pr_is_final_pr` | assertions=`implementation PR is final PR`
- A5 [behavior/direct] direct task | scope=`task:task-b1` | phase=`pre_merge` | evidence=`test_wave_thread_v2.ts::WaveThreadV2Tests.test_direct_mode_implementation_pr_is_final_pr` | assertions=`direct readiness does not archive itself`
- A6 [permission/direct] closeout boundary | scope=`batch:batch-a` | phase=`pre_merge` | evidence=`test_wave_thread_v2.ts::WaveThreadV2Tests.test_parent_child_finalize_requires_conversation_archive_receipt` | assertions=`parent-child closeout requires native archive receipt`
- A7 [migration/direct] v1 compatibility | scope=`batch:batch-a` | phase=`pre_merge` | evidence=`test_wave_thread_v2.ts::WaveThreadV2Tests.test_v1_upgrade_is_read_only_and_preserves_default_batch` | assertions=`legacy state maps to one default batch without mutating input`
- A8 [behavior/direct] completion timeout | scope=`batch:batch-a` | phase=`post_deploy` | evidence=`test_wave_thread_v2.ts::WaveThreadV2Tests.test_observation_deadline_records_timeout_without_resetting_deadline` | assertions=`timeout preserves absolute deadline and blocks dispatch`
- A9 [mechanical/direct] replay quality | scope=`batch:batch-a` | phase=`pre_merge` | evidence=`skills/wave-thread-flow/scripts/wave_thread_replay_check.ts::check_v2_recovery` | assertions=`offline v2 event protocol deferred delivery merge gate and recovery replay pass`
- A10 [contract/direct] final delivery | scope=`batch:batch-b` | phase=`pre_merge` | evidence=`test_wave_thread_v2.ts::WaveThreadV2Tests.test_direct_mode_implementation_pr_is_final_PR` | assertions=`offline direct topology is proven; live PR CI review and Step 5C remain delivery-gated`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- 本 fixture 只证明本地 parser、状态机和离线 replay；不宣称原生 Codex 事件往返成功。已确定。
