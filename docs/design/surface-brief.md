# Loomhelm master design surface

## Scope and Mode

The single owner-facing design entry is `design/index.html`. Its controlled structural prototype uses Operate mode; the surrounding review document uses Read mode. Supporting context and metadata remain under `docs/design/` and are not served with the prototype.

## Confirmed Direction

The owner has confirmed an efficient global workbench, attention-first hierarchy, in-place approval review, complete mobile capability parity and a task workspace combining one main session with task information. Native supporting sub-agent work is expandable within the main session. The owner's engineering flows remain external context.

The owner-pinned sequence proceeds through information architecture and a clickable prototype before final desktop/mobile visuals. The current render therefore uses neutral structural styling; it does not select or approve a product visual world. The next owner review concerns layout and operation paths.

## Tool Context

The default root invocation cannot resolve the scoped PRODUCT.md. Running `concept-seed --scope direction --mode operate` from `docs/design/` succeeded, with seed `f8d1abaf` and assigned grounded candidate 4, an incident-response workbench. That assignment informs a possible later visual direction; it does not override the owner's sequence or constitute a choice. No root PRODUCT.md, DESIGN.md or .impeccable is created.

## Structural Contract

The global entry prioritizes a short attention queue with an adjacent or following request review and compact session access. Projects use compact task lists. Opening a task keeps its conversation, sub-agent activity, shared draft and task state in the same workspace. Mobile reorganizes conversation and task information into task-local panels with the same capabilities.

Named projects lead directly to their task lists. There is no duplicate generic "Projects and tasks" navigation item leading to the same selected project. The active project and breadcrumb track both its list and task workspace.

Files stay in their conversation context. The owner has rejected a standalone artifacts module, including a global page and task-specific panel. A remote file browser is only a possible future capability, outside the current design scope.

All content is labeled demonstration data. Approval and input interactions update only prototype state. Real cross-client draft synchronization, host/Codex execution, original-file downloads and PWA installation are not implemented or accepted by this artifact. Scenario controls demonstrate intended state presentation only.

## Open Decisions and Dependencies

The owner still needs to review the structural composition, choose final visual direction, resolve shared-draft concurrency/recovery behavior and confirm the complete design. F02, R02, F05 and RD03/G0 actual inputs must supply the framework, real fixtures, public interfaces and recovery/deployment contracts before final U01–U04 page/component/state/API handoff.
