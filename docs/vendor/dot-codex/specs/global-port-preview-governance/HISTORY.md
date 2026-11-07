# Global port preview governance 演进历史（#sz4cs）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `sz4cs` expanded from “preview URL provenance” into a broader `$browser-open-page` governance contract so isolated browser-state separation now follows the same topic-level policy surface.
- `$browser-open-page` now treats `isolatedContext` as opt-in, task-scoped state isolation: shared context remains the default, every isolated task must declare `task_scope_id` + `isolation_reason`, and one task may reuse only one isolated context.
- Current current-truth docs later renamed the formal browser entrypoint from `$browser-open-page` to `$browser-surface`; this history keeps the old name where it reflects the original rollout vocabulary.
- The contract intentionally blocks a second `isolatedContext` in the same task instead of auto-rewriting the request, because silent rewriting would hide upstream task-modeling mistakes and weaken auditability.
- Default automatic port allocation uses `10000+` deterministic scope-random candidate blocks so new worktrees do not cluster around a fixed low starting block while still preserving reproducible `scope_id` behavior.
- Earlier local-preview routing distinguished existing Chrome state from plain localhost validation. The current route instead defaults to `$agent-browser`; Chrome control and DevTools require explicit exception reasons.
- The current browser policy does not permit a project-owned headless fallback after an `$agent-browser` failure, and synthetic debugging-browser bootstrap remains blocked by default.
- Lease ownership checks now keep first PID binding compatible while requiring an expected PID for ownership-sensitive wrapper heartbeats and releases.
- Startup registration now claims the inspected lease state under the registry lock before updating PID/session metadata.
- Preview wrappers claim the lease before binding their listener, preventing a failed claim from temporarily occupying an owner-facing port.
- Preview wrappers now hold the registry lock through listener binding and reject duplicate startup, preventing active-owner replacement and PID-before-listener GC races.
- Failed claim verification or persistence now stops the listener that was created during startup, keeping service cleanup aligned with the lease transaction.
- `826a50f` docs: enforce local preview port governance
- `c530b57` chore: retire legacy service manager stack
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#sz4cs`.
