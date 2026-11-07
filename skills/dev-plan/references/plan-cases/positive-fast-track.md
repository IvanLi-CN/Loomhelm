# Plan contract raw-plan fixture

## Summary

- 交付一个可直接创建并收敛 PR 的 Fast-track 变更。

## Flow Decision

- `flow_type`: `fast-track`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `empirical_acceptance`: `not_required`
- `empirical_acceptance_rationale`: `当前验收由确定性本地测试和 current-head CI 证明。`
- `review_tier`: `Tier 3`
- `review_rationale`: `当前 head 需要完整 direct review evidence。`
- `runtime_review_strategy`: `readiness、验证和适用证据完成后运行时创建 required lanes。`
- `review_profile_recommendation`: `四至六个 formal lane 建议使用 gpt-6-luna + high pair。`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 收敛当前 PR。创建或复用 PR，并把 current head 的 CI/review 收敛到 Step 5C。

## Non-goals

- N1: 不 push debug logs，也不合并 PR 或执行本地 cleanup。

## Task Orchestration

- wave: 1
  - main-agent => 创建或复用 PR 并收敛 current head (skill: $fast-flow)

## Acceptance & Validation

- A1 [contract/direct] current-head PR convergence | scope=`plan` | phase=`pre_merge` | evidence=`test:raw-plan` | assertions=`live PR exists,current head CI/review converge,Step 5C Ready`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- PR 的远端写入由已锁定的 Fast-track 授权：已确定。
