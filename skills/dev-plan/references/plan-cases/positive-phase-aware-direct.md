# Phase-aware direct plan contract fixture

## Summary

- 修正 direct/v1 验收合同的生命周期阶段边界。

## Flow Decision

- `flow_type`: `fast-track`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- `empirical_acceptance`: `not_required`
- `empirical_acceptance_rationale`: `合同、解析器、回放和身份校验均可由确定性本地测试证明。`
- `review_tier`: `Tier 3`
- `review_rationale`: `当前 Candidate 需要完整 direct review evidence。`
- `runtime_review_strategy`: `Review Readiness 通过后运行时创建 required lanes。`
- `review_profile_recommendation`: `四至六个 formal lane 建议使用 gpt-5.6-luna + xhigh pair。`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 让验收证据绑定到正确的 PR 生命周期阶段。合并前验证 Candidate，合并后验证 Merge Receipt，部署后验证已签名的部署提供方回执。

## Non-goals

- N1: 不执行真实部署、生产重试或版本发布。

## Task Orchestration

- wave: 1
  - main-agent => 完成阶段化验收合同并收敛当前 PR (skill: $fast-flow)

## Acceptance & Validation

- A1 [contract/direct] Candidate acceptance | scope=`plan` | phase=`pre_merge` | evidence=`test:pre-merge` | assertions=`candidate_sha binds current PR head,Review Readiness consumes only pre_merge,live PR exists,current head CI/review converge,Step 5C Ready`
- A2 [contract/direct] Merge acceptance | scope=`plan` | phase=`post_merge` | evidence=`test:post-merge` | assertions=`merge_sha binds actual Merge Receipt,post_merge remains pending before merge`
- A3 [contract/direct] Deployment acceptance | scope=`plan` | phase=`post_deploy` | evidence=`test:post-deploy` | assertions=`deployment identity source and bound SHA match merge_sha,post_deploy follows merge_sha lineage`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- 正式和非正式版本都只能基于已合并 PR 的实际 `merge_sha` 推导；已确定。
- 本 fixture 仅验证确定性合同，不执行真实部署或发布；已确定。
