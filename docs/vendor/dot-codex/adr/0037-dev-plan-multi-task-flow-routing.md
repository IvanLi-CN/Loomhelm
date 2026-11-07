# ADR 0037: Route Multi-task Flow Through Dev-plan

- Status: Superseded by [0040: Keep Dev-plan Standalone and Move Its Implementation to TypeScript](0040-dev-plan-standalone-typescript-finalizer.md)
- Related: `docs/adr/0035-task-orchestration-ledger.md`

## Context

The repository has an active `$multi-task-flow` coordinator with a dependency graph, runtime ledger, task conversations, child PRs, and parent-PR closeout. Treating it as outside `dev-plan` routing makes a plan lose the very facts that the coordinator needs to start safely and encourages a silent downgrade to one direct task. The retired `wave-thread` route is a compatibility concern, but it is not the same runtime model.

## Decision

Register `multi-task-flow` as an active top-level `flow_type` in `$dev-plan`. The raw plan binds exactly one top-level `$multi-task-flow` skill, preserves at least two task nodes and explicit dependency, ownership, and acceptance facts, and is rejected when it collapses to a single direct `main-agent` task.

Reuse the existing canonical v2 `batch -> wave -> task` plan syntax as the owner-facing projection format. For multi-task flow, waves are display and dispatch cohorts; the runtime ledger's explicit dependency graph is authoritative after approval. A task-local `$fast-flow` may run the task's direct PR stages without becoming another top-level flow or taking parent closeout ownership.

The approved plan crosses into runtime through a transient bridge source and a `dev_plan_handoff` envelope persisted on the initial plan revision. The bridge receives the owner-supplied opaque raw-plan digest, derives the exact task IDs from the already parsed canonical plan, computes the acceptance digest, and attaches the envelope in memory before `init`; it does not persist a second planning artifact or reparse Markdown. Runtime initialization rejects missing or mismatched bindings before creating the ledger.

## Consequences

`dev-plan` routing, shell contract checks, TypeScript validation, projection, and fixtures must all recognize the active multi-task route. Historical `wave-thread` Markdown remains rejected while historical JSONL remains replayable. There is one plan-to-ledger handoff and one runtime ledger, so the owner-facing plan and runtime state do not form competing coordination systems. The raw-plan digest remains an owner-facing identity; runtime verifies the provided digest shape and the complete structural mapping rather than silently re-parsing Markdown during ledger creation. Owned-surface comparison is lexical and repository-relative; runtime does not resolve host filesystem case-folding or symlink aliases. The approval boundary must provide canonical repository-relative paths when host-equivalent aliases matter.
