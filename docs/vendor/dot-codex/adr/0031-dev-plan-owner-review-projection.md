# ADR 0031: Transient Owner Review Projection for Dev Plans

- Status: Accepted
- Date: 2026-10-25
- Related: `docs/adr/0030-dev-plan-single-source-wave-thread.md`

## Context

The canonical `$dev-plan` Markdown must remain strict enough for the checker and execution flow, but its task rows are not an efficient owner-facing review view. Maintaining a second task registry would reintroduce the duplication that ADR 0030 removed and would make the displayed plan another source of execution truth.

## Decision

Keep `Task Orchestration` as the only v2 execution contract and require new v2 tasks to carry `title`, `purpose`, and `outputs` as display metadata. After the canonical raw-plan passes validation, `bin/plan-cli.sh` derives a transient Markdown projection from the same parsed facts and writes it only to stdout or the current response.

The projection has nine fixed sections: decision card, goals, non-goals, wave and dependency graph, execution rules, task cards, constraints, acceptance checklist, and review/runtime closeout. The Mermaid graph may show only canonical waves, tasks, same-wave parallelism, and explicit dependencies. The projection is not persisted, is not reparsed, and is not accepted as raw-plan input. Historical JSONL remains on the explicit read-only legacy route and cannot enter the new generation path. File-based projection input is restricted to paths that resolve inside the candidate Worktree, and owner-facing metadata is escaped before Markdown or Mermaid rendering. The file route opens the resolved relative path through no-follow directory handles so validation and reading share the same candidate boundary.

## Alternatives Considered

- Keep a second human-readable task contract: rejected because it duplicates execution facts and creates reconciliation work.
- Ask the Agent to hand-write the review view: rejected because prose drift could hide missing tasks, dependencies, or acceptance bindings.
- Persist a rendered Markdown artifact: rejected because it creates another plan object that later turns could mistake for an execution input.

## Consequences

Owners receive a stable, readable review view with a Mermaid wave/dependency graph while the execution parser continues to consume one canonical contract. The display metadata slightly expands new v2 task rows, but historical JSONL is not migrated and remains covered by compatibility replay. The change affects Markdown plan presentation and validation boundaries only; Wave Thread runtime events, Worktrees, PR lifecycle, SHA lineage, archive, and release semantics are unchanged.
