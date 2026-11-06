# Missing direct review tier

## Summary

- 交付一个 direct fast-track 计划。

## Flow Decision

- `flow_type`: `fast-track`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- G1: 收敛当前 PR。创建或复用 PR，并收敛 current head。

## Non-goals

- N1: 不扩大已批准范围。

## Task Orchestration

- wave: 1
  - main-agent => 创建或复用 PR 并收敛 current head (skill: $fast-flow)

## Acceptance & Validation

- A1 [contract/direct] current-head PR convergence | scope=`plan` | phase=`pre_merge` | evidence=`test:raw-plan` | assertions=`live PR exists,current head,Step 5C Ready`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- host profile resolution：已确定
