# Plan contract raw-plan fixture

## Summary

- 交付一个 Fast-track 变更。

## Flow Decision

- `flow_type`: `fast-track`
- `flow_source`: `user_explicit`
- `lock_status`: `locked`
- 开发基线：`origin/main`
- 收口条件：`merge-ready / Step 5C Ready`

## Goals

- 目标：收敛当前 PR。创建或复用 PR，并验证其收口事实。

## Non-goals

- 不合并 PR 或执行本地 cleanup。

## Task Orchestration

- wave: 1
  - main-agent => 创建或复用 PR (skill: $fast-flow)

## Acceptance & Validation

- A1 [contract/direct] live PR exists, current head CI/review converge, Step 5C Ready | scope=`plan` | phase=`pre_merge` | evidence=`test:raw-plan` | assertions=`checker result is recorded`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- 验收命令可在本地执行：已确定。
