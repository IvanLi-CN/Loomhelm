# ADR 0008: U02 recovery completeness and caller identity handoff

## Context

The U02 project/task browser flow already persisted a caller-selected resource identity before a create request and kept ambiguous outcomes behind a reconciliation notice. Two gaps remained: a refresh could observe successful query promises without proving that every expected membership and relationship entry was present, and a principal transition could leave the previous principal's query cache alive while the loading assembly was being committed.

## Decision

Keep the caller-selected project/task ID as the creation correlation identity. The server uses an omitted ID generation path or the exact validated caller ID; explicit `null`, empty and malformed IDs are invalid, duplicate IDs are conflicts, and a response that does not echo the selected ID remains unresolved. The browser records that mismatch in the existing notice state and never retries the create request or replays requested relationships automatically.

Define a complete refresh as a successful, idle query with defined data for the project list, membership data for every returned project, the task list and relationship data for every returned task. Any query error, denied entry, omitted entry, undefined data or in-flight state retains the affected write barrier. A manual refresh reconciles persisted notices only after those reads complete; a remote notice-removal barrier is released only after the same check succeeds. Unrelated resource scopes remain writable.

When the browser assembly changes principal, including the transition through a loading assembly, cancel and remove every query keyed to the previous principal before committing the new assembly. Query keys still include principal and session generation, but generation separation is not treated as a substitute for eager cancellation and removal.

Recovery acknowledgements in ProjectForm and TaskForm use a stable form element with `tabIndex=-1` as the focus target; TaskRelationshipEditor uses its stable status element. When a focused acknowledgement button is removed by the state transition, focus returns to the stable target so the next keyboard action remains inside the active workflow.

## Consequences

The recovery path is conservative about incomplete reads and ambiguous creation results: it may keep a user blocked until a complete manual refresh or explicit acknowledgement, but it never turns a partial read into permission to repeat a side effect. The behavior changes are frontend and validation changes only; no database migration or new resident service is required.

The public identity and reconciliation requirements in the phase-one specification remain the source of truth. This ADR records the completeness, cache-lifecycle and focus-continuity implementation decisions for that contract; it does not claim authenticated production, Agent VM or deployment evidence.

## References

- [Phase-one specification](../specs/phase1-core/SPEC.md)
- [Implementation coverage](../specs/phase1-core/IMPLEMENTATION.md)
- [U02 partial relationship outcomes](../specs/phase1-core/HISTORY.md#partial-relationship-outcomes)
