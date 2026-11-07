# Retired Dev-plan Bridge for Multi-task Flow

> Retired by [ADR 0040](../../adr/0040-dev-plan-standalone-typescript-finalizer.md). This file remains only as read-only historical compatibility documentation. New `$dev-plan` and `$multi-task-flow` flows MUST NOT use this bridge.

## Boundary

`multi-task-flow` is an active top-level `flow_type` in `$dev-plan`. The plan selects exactly one top-level flow skill, `$multi-task-flow`, and carries the owner-facing facts needed to approve a dependency-driven run.

The plan's canonical `batch -> wave -> task` hierarchy is a projection format. It preserves task identity, dependency edges, owned surfaces, dispatch profiles, and acceptance scopes for review. Waves group display and dispatch cohorts; they do not create an implicit global barrier for the runtime scheduler.

## Handoff

After the owner approves the plan, the coordinator passes a transient `dev_plan_handoff_source` to `$multi-task-flow init`. The source contains the owner-supplied opaque raw-plan digest, canonical task surfaces, and canonical acceptance scopes. The runtime bridge derives task IDs from the already parsed canonical plan nodes, computes the acceptance digest, attaches the envelope in memory, and then validates it before `LedgerStore.create`. It does not persist a handoff artifact or reparse owner-facing Markdown. The resulting init payload contains the following `initial_plan.dev_plan_handoff` envelope:

```json
{
  "flow_type": "multi-task-flow",
  "raw_plan_digest": "<owner-supplied opaque sha256 digest>",
  "acceptance_digest": "<sha256 of the canonical acceptance scopes>",
  "task_ids": ["task-a", "task-b"],
  "task_surfaces": [
    {"task_id": "task-a", "owned_surfaces": ["src/a"]},
    {"task_id": "task-b", "owned_surfaces": ["src/b"]}
  ],
  "acceptance_scopes": [
    {"acceptance_id": "A1", "scope": "batch:core", "owner_id": "core"},
    {"acceptance_id": "A2", "scope": "task:task-a", "owner_id": "task-a"},
    {"acceptance_id": "A3", "scope": "task:task-b", "owner_id": "task-b"}
  ]
}
```

The runtime verifies the envelope's digest shape, task-node identity, exact initial group ownership, repository-relative disjoint owned surfaces, canonical acceptance digest, and complete group/task scope ownership before `LedgerStore.create`. A missing or mismatched envelope fails with `INVALID_PLAN_HANDOFF` and creates no run files. After a dynamic cut, a changed task group requires both the cut event and assignment history. The raw-plan digest is the identity supplied by the approved `$dev-plan` boundary; runtime validates its shape and preserves it but does not derive or authenticate it from Markdown. The ledger is a runtime state store, not a second plan or a replacement for the owner-facing acceptance contract. The coordinator owns group and parent-PR closeout.

Owned-surface comparison is lexical and repository-relative. This runtime boundary does not resolve host filesystem case-folding or symlink aliases; the approval boundary must provide canonical repository-relative paths when host-equivalent aliases matter.

For programmatic callers that already carry an envelope, `init` accepts the equivalent `initial_plan.dev_plan_handoff` form directly. A caller must not send both forms: the source is the single approved-plan-to-runtime transfer boundary.

An individual task may enter `$fast-flow` for its direct PR. That nested flow owns only the task's implementation, validation, review, and direct PR stop condition. It must not alter the parent `flow_type`, create a second top-level flow binding, or claim group completion.

Historical `wave-thread` plans remain a separate replay-only compatibility route and are not upgraded by this bridge.
