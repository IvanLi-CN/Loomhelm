# Loomhelm master design surface

## Scope and Mode

The single owner-facing design entry is `design/index.html`. Its controlled structural prototype uses Operate mode; the surrounding review document uses Read mode. Supporting context and metadata remain under `docs/design/` and are not served with the prototype.

## Confirmed Direction

The owner has confirmed an efficient global workbench, attention-first hierarchy, in-place approval review, complete mobile capability parity and a task workspace combining one main session with task information. Native supporting sub-agent work is expandable within the main session. The owner's engineering flows remain external context.

The owner has accepted the navigation hierarchy and its desktop/mobile structural screenshots. The current render uses neutral structural styling; that acceptance does not select a product visual world or approve the complete design. The next design work concerns desktop/mobile layout, visual direction and complete interaction states.

The theme follows the operating system by default and supports manual light/dark selection. Desktop and mobile remember that preference independently. Both themes must preserve the same information hierarchy, controls and readable state distinctions.

## Tool Context

The default root invocation cannot resolve the scoped PRODUCT.md. Running `concept-seed --scope direction --mode operate` from `docs/design/` succeeded, with seed `f8d1abaf` and assigned grounded candidate 4, an incident-response workbench. That assignment informs a possible later visual direction; it does not override the owner's sequence or constitute a choice. No root PRODUCT.md, DESIGN.md or .impeccable is created.

## Structural Contract

The top-level global navigation is Workbench and Tasks. The workbench prioritizes a short attention queue with an adjacent or following request review and compact conversation access; its All Conversations action opens the cross-project conversation list and creation path. Global Tasks spans all projects and supports list/board/graph switching. Opening a task keeps its conversation, sub-agent activity, shared draft and task state in the same workspace. Mobile reorganizes conversation and task information into task-local panels with the same capabilities.

Below the global navigation, the Conversations group directly lists projectless conversations, replacing the former Unassigned Project label. No separate global Conversations button remains in navigation. The collapsible Projects tree contains named projects with conversation leaves directly underneath. Both task-associated conversations and project conversations without tasks are included, with task association readable as metadata. Desktop and mobile expose the same hierarchy. Clicking a project switches its context; the prototype offers task and conversation panels, and the latter includes all that project's conversations. The active leaf/context and breadcrumb track the displayed scope.

Project tasks support list, board and graph views. The prototype stores the chosen task view independently for global Tasks and each project in client-local prototype storage; the default is list. Navigation expansion and the project-content panel are client browsing state; the prototype does not synchronize them across devices.

Global Conversations includes task-associated and standalone conversations. New conversations can start without a task or project; project selection is optional. The standalone conversation workspace offers later task association while preserving the same conversation, messages, shared draft and reading position. A projectless conversation joins the selected task's project. The prototype offers tasks without a main conversation and a new-task path; it does not replace an existing task conversation or silently move an already scoped conversation across projects. These are prototype boundaries, not a settled reassignment contract.

The graph shows project/task/subtask containment with solid lines and prerequisite-to-dependent task edges with directed dashed lines. It supports scrolling, zoom and opening the same task nodes. Relationships use explicit mock fixtures and need a real public contract before implementation handoff; the prototype does not implement relationship editing.

The owner has ruled out a user-facing host concept and has no current multi-host connection plan. Host navigation, selectors and sample machine names are removed. The integrated contract uses one preconfigured logical execution environment, keeps Server/Worker/Connector separate and treats Connector administration as deployment-internal. The execution machine may be separate from the platform; existing desktop-session control still needs actual capability evidence.

Files stay in their conversation context. The owner has rejected a standalone artifacts module, including a global page and task-specific panel. A remote file browser is only a possible future capability, outside the current design scope.

All content is labeled demonstration data. Approval, input, conversation creation and task-association interactions update only prototype state. Real cross-client draft synchronization, Codex execution, original-file downloads and PWA installation are not implemented or accepted by this artifact. Scenario controls demonstrate intended state presentation only. Projectless conversation ownership and later project association require integration-owner reconciliation with the core project-permission contract.

## Open Decisions and Dependencies

The owner still needs to choose final visual direction, review detailed page layouts and confirm the complete design. The main coordinator owns the remaining PRD business-rule interview, including shared-draft concurrency/recovery; this design task consumes those answers without repeating the questions. F02, R02, F05 and RD03/G0 actual inputs must supply the framework, real fixtures, public interfaces and recovery/deployment contracts before final U01–U04 page/component/state/API handoff.

## Visual Evidence

The owner accepted this structural navigation set: Workbench and Tasks at the top, projectless conversation leaves under Conversations, and Projects → named project → conversation leaves. This is approval of the displayed navigation and screenshots, not final visual design or real backend behavior. The source is the login-free, mock-only `design/index.html?canvas=1`; viewport emulation uses desktop 1440×900 and mobile 393×852 CSS pixels. Trim-only normalization left both captures unchanged. The render source is unchanged from the accepted capture.

![Accepted desktop navigation](../../design/evidence/project-tree-desktop.png)

![Accepted mobile navigation](../../design/evidence/project-tree-mobile.png)
