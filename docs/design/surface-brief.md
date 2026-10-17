# Loomhelm master design surface

## Scope and Mode

The single owner-facing design entry is `design/index.html`. Its controlled structural prototype uses Operate mode; the surrounding review document uses Read mode. Supporting context and metadata remain under `docs/design/` and are not served with the prototype.

## Confirmed Direction

The owner has confirmed an efficient global workbench, attention-first hierarchy, in-place approval review, complete mobile capability parity and a task workspace combining one main session with task information. Native supporting sub-agent work is expandable within the main session. The owner's engineering flows remain external context.

The owner-pinned sequence proceeds through information architecture and a clickable prototype before final desktop/mobile visuals. The current render therefore uses neutral structural styling; it does not select or approve a product visual world. The next owner review concerns layout and operation paths.

## Tool Context

The default root invocation cannot resolve the scoped PRODUCT.md. Running `concept-seed --scope direction --mode operate` from `docs/design/` succeeded, with seed `f8d1abaf` and assigned grounded candidate 4, an incident-response workbench. That assignment informs a possible later visual direction; it does not override the owner's sequence or constitute a choice. No root PRODUCT.md, DESIGN.md or .impeccable is created.

## Structural Contract

The global navigation is Workbench, Tasks and Conversations. The workbench prioritizes a short attention queue with an adjacent or following request review and compact conversation access. Global Tasks spans all projects and supports list/board/graph switching. Conversations focuses on conversation activity across projects. Opening a task keeps its conversation, sub-agent activity, shared draft and task state in the same workspace. Mobile reorganizes conversation and task information into task-local panels with the same capabilities.

Named projects appear below the global navigation and switch the current project context. Project tasks support the same three views. The prototype stores the chosen view independently for global Tasks and each project in client-local prototype storage; the default is list. The active navigation entry and breadcrumb track the actual global or project scope.

Global Conversations includes task-associated and standalone conversations. New conversations can start without a task or project; project selection is optional. The standalone conversation workspace offers later task association while preserving the same conversation, messages, shared draft and reading position. A projectless conversation joins the selected task's project. The prototype offers tasks without a main conversation and a new-task path; it does not replace an existing task conversation or silently move an already scoped conversation across projects. These are prototype boundaries, not a settled reassignment contract.

The graph shows project/task/subtask containment with solid lines and prerequisite-to-dependent task edges with directed dashed lines. It supports scrolling, zoom and opening the same task nodes. Relationships use explicit mock fixtures and need a real public contract before implementation handoff; the prototype does not implement relationship editing.

The owner has ruled out a user-facing host concept and has no current multi-host connection plan. Host navigation, selectors and sample machine names are removed. The integrated contract uses one preconfigured logical execution environment, keeps Server/Worker/Connector separate and treats Connector administration as deployment-internal. The execution machine may be separate from the platform; existing desktop-session control still needs actual capability evidence.

Files stay in their conversation context. The owner has rejected a standalone artifacts module, including a global page and task-specific panel. A remote file browser is only a possible future capability, outside the current design scope.

All content is labeled demonstration data. Approval, input, conversation creation and task-association interactions update only prototype state. Real cross-client draft synchronization, Codex execution, original-file downloads and PWA installation are not implemented or accepted by this artifact. Scenario controls demonstrate intended state presentation only. Projectless conversation ownership and later project association require integration-owner reconciliation with the core project-permission contract.

## Open Decisions and Dependencies

The owner still needs to review the structural composition, choose final visual direction, resolve shared-draft concurrency/recovery behavior and confirm the complete design. F02, R02, F05 and RD03/G0 actual inputs must supply the framework, real fixtures, public interfaces and recovery/deployment contracts before final U01–U04 page/component/state/API handoff.
