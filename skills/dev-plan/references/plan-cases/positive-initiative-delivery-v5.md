<proposed_plan>

# Initiative Delivery v5

## Summary

- 结论：消费已批准 `$to-tickets` topology，并使用 `prd/<topic>` branch-push Child Integration CI。

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
- `plan_kind`: `delivery`
- `spec_disposition`: `reuse`
- `spec_path`: `docs/specs/demo-initiative/SPEC.md`
- `adr_contracts`: `none`
- `tracking_issue_url`: `https://github.com/acme/example/issues/100`
- `bootstrap_contract_digest`: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
- `ticket_topology_source`: `to-tickets`
- `ticket_topology_digest`: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`
- `ticket_source_sha`: `1111111111111111111111111111111111111111`
- `native_task_budget`: `2`
- 开发基线：`14b1b6de04b4925b94f0694a4197c44175a66d9e`

## Goals

- G1: 绑定已发布 topology 为至少两个 Ticket 的独立验收、独立合并与 Wave 集成创建任务编排，并保留 source freeze。

## Non-goals

- N1: 不修改 `$to-tickets` Issue body 或增加额外 Ticket。

## Task Orchestration

- wave: 1
  - task:issue-101 [gpt-6-sol, xhigh] => 实现 #101 child PR (skill: $initiative-flow)
- wave: 2
  - task:issue-102 [gpt-6-sol, xhigh] => 实现 #102 child PR (skill: $initiative-flow)

## Acceptance & Validation

- task:issue-101 => acceptance_scope=technical-only; evidence=tests@task; owner_gate=none; completion_gate=integration
- task:issue-102 => acceptance_scope=technical-only; evidence=tests@task; owner_gate=none; completion_gate=integration

## Assumptions/Defaults

- Runtime release behavior is derived from target repository policy and current PR facts; the Agent default decision card reports publish applicability, components, channel, bump rule, and predicted version, shows the policy source, and requires owner confirmation including the version expectation; missing/conflicting inputs remain unknown/blocked. 已确定。
- `$to-tickets` topology 已获批准并已发布：已确定 </proposed_plan>
