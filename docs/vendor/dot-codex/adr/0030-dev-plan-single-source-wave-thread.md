# ADR 0030: Single Source for Wave Thread v2 Plans

- Status: Accepted
- Date: 2026-10-25
- Related: `docs/adr/0029-wave-thread-delivery-batches.md`

## Context

Wave Thread v2 raw-plans previously repeated batch and task fields in both `Task Orchestration` and `Wave Thread Contracts`. The duplicate view made human-readable plans longer and forced the checker to prove equality between two representations of the same contract. It also blurred the boundary between new plan generation and historical JSONL replay.

## Decision

Use `Task Orchestration` as the only canonical v2 plan contract. Batch lines carry the existing batch fields plus `parent_branch`, `child_pr`, `topology`, `event_protocol`, and `release_policy`; nested task lines remain the source of owned surfaces, dependencies, conditions, acceptance IDs, and `$skill`.

New raw-plans reject `## Wave Thread Contracts` with the stable finding code `WAVE_THREAD_V2_DUPLICATE_CONTRACT`. Historical JSONL that already contains the duplicated section remains readable through an explicit read-only legacy adapter. The adapter is selected only by the session JSONL route and cannot validate or generate a new raw-plan.

## Alternatives Considered

- Keep both sections and improve their prose: rejected because duplication still creates two machine sources and requires cross-section equality checks.
- Move the second section to a separate renderer or artifact: rejected because it would introduce another input that an Agent must read and maintain.
- Drop historical compatibility: rejected because old session JSONL remains a supported read-only replay input.

## Consequences

New plans are shorter and have one authoritative manifest for parsing, while legacy replay retains a narrow compatibility branch. The parser and shell checker now have separate canonical and legacy entry points; tests must cover both paths. This decision changes Markdown plan parsing only and does not alter Wave Thread runtime events, Worktrees, PR lifecycle, SHA lineage, archive, or release semantics.
