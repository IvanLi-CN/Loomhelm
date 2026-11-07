<proposed_plan>

# Initiative Bootstrap

## Summary

- 结论：建立 V5 Initiative identity 与 Bootstrap Integration CI activation 前置条件。

## Flow Decision

- `flow_type`: `initiative`
- `flow_source`: `default_initiative_complexity`
- `lock_status`: `locked`
- `integration_branch`: `prd/demo-initiative`
- `final_base`: `main`
- `schema_version`: `5`
- `initiative_contract_version`: `5`
- `promotion_policy`: `checkpointed`
- `integration_ci_surface`: `branch-push`
- `integration_ci_check`: `quality`
- `plan_kind`: `bootstrap`
- `spec_disposition`: `reuse`
- `spec_path`: `docs/specs/demo-initiative/SPEC.md`
- `adr_contracts`: `none`
- 开发基线：`14b1b6de04b4925b94f0694a4197c44175a66d9e`

## Goals

- G1: 建立 Bootstrap 合同。为至少两个 Ticket 的独立验收、独立合并和 Wave 集成解析 Spec、绑定正确 activation SHA，并在 ready 后发布 Tracking Issue 与 topology。

## Non-goals

- N1: 不创建 child Issue 或 native Ticket task。

## Task Orchestration

- bootstrap:
  - main-agent => 建立 Spec contract 与 Bootstrap Integration CI activation (skill: $initiative-flow)

## Acceptance & Validation

- A1 [contract/direct] Bootstrap contract | evidence=`skills/bin/plan_contract_check.ts` | assertions=`V5 schema and branch-push check are fixed,bootstrap has no native task budget`

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- GitHub 与 Codex native task Worktree 可用：已确定 </proposed_plan>
