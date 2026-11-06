# Parallel Direct PR Flow

## Context and Scope

Independent direct PRs do not need Initiative's Ticket, integration, or aggregate lifecycle. They still need a frozen ownership contract, durable recovery facts, and a safe boundary for optional merge delegation.

## Scope

This specification covers plan routing, native task envelopes, milestone reporting, metadata recovery, and direct merge-mode delegation for a `parallel-pr` cohort. It does not change Initiative's state machine or add a PR delivery role.

## Requirements

### REQ-PARALLEL-001 - Route only independent direct slices

The planner MUST select `parallel-pr` only for 2..8 independently acceptable direct PR tasks with one exact base, no dependency, no shared integration, and no aggregate acceptance.

### REQ-PARALLEL-002 - Freeze task contracts

Every `task:pr-<slug>` MUST declare disjoint `owned_surfaces`, named `consumed_contracts`, `depends_on=none`, and `merge_mode`. The task budget equals the frozen topology count.

### REQ-PARALLEL-003 - Use milestone coordination

The parent MUST create native tasks and accept implementation, Step 5C, merge/post-merge, blocked, and scope-change milestones. It does not maintain an active polling loop after implementation starts.

### REQ-PARALLEL-004 - Recover from durable metadata

Task titles and direct PR bodies MUST carry `parallel_cohort` and `parallel_task`. Task and PR metadata are sufficient to reconcile an existing task; no local cross-cohort ledger is required.

### REQ-PARALLEL-005 - Keep merge delegation fail-closed

Tasks MUST stop at `Step 5C Ready` by default. `merge-on-green` requires the frozen task identity, current direct PR metadata, current-head preflight, and safe repository-native merge/release serialization.

## Verification

- VER-PARALLEL-001: `bin/plan_contract_check.sh --cases` proves explicit and default routing, 2..8 bounds, exact task mapping, no dependency, and disjoint ownership. (covers: REQ-PARALLEL-001, REQ-PARALLEL-002)
- VER-PARALLEL-002: flow inspection and replay fixtures prove milestone-only parent coordination, scope-change revalidation, isolated failure, and metadata recovery. (covers: REQ-PARALLEL-003, REQ-PARALLEL-004)
- VER-PARALLEL-003: PR skill inspection and merge-mode fixtures prove direct role retention, ready-only default, and fail-closed merge delegation. (covers: REQ-PARALLEL-005)

## Related ADRs

- [0011-parallel-direct-pr-flow](../../adr/0011-parallel-direct-pr-flow.md)
