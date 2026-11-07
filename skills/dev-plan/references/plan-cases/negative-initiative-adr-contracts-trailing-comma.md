<proposed_plan>

# Initiative Bootstrap

## Summary

- 结论：建立 Initiative identity、Spec、Tracking Issue 与 topology handoff。

## Flow Decision

- `flow_type`: `initiative`
- `flow_source`: `default_initiative_complexity`
- `lock_status`: `locked`
- `integration_branch`: `prd/demo-initiative`
- `schema_version`: `5`
- `initiative_contract_version`: `5`
- `promotion_policy`: `checkpointed`
- `integration_ci_surface`: `branch-push`
- `integration_ci_check`: `quality`
- `plan_kind`: `bootstrap`
- `spec_disposition`: `reuse`
- `spec_path`: `docs/specs/demo-initiative/SPEC.md`
- `adr_contracts`: `docs/adr/0001-current-decision.md@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,`
- 开发基线：`origin/main`

## Goals

- 目标 1: 建立 Bootstrap 合同解析 Spec，创建 Tracking Issue，并为至少两个 Ticket 的独立验收、独立合并和 Wave 集成交接 Parent。

## Non-goals

- 不创建 child Issue 或 native Ticket task。

## Task Orchestration

- bootstrap:
  - main-agent => 建立 Spec contract 与 Tracking Issue handoff (skill: $initiative-flow)

## Acceptance & Validation

- A1 [contract/direct] Bootstrap contract | evidence=`bin/plan_contract_check.ts` | assertions=`native task budget is zero`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- GitHub 与 Codex native task Worktree 可用：已确定 </proposed_plan>
