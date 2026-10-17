# Loomhelm master design surface

## Scope and Mode

The single owner-facing design entry is `design/index.html`. Its controlled structural prototype uses Operate mode; the surrounding review document uses Read mode. Supporting context and metadata remain under `docs/design/` and are not served with the prototype.

## Confirmed Direction

The owner has confirmed an efficient global workbench, attention-first hierarchy, in-place approval review, complete mobile capability parity and a task workspace combining one main session with task information. Native supporting sub-agent work is expandable within the main session. The owner's engineering flows remain external context.

The owner has accepted the navigation hierarchy and its desktop/mobile structural screenshots. The current render uses neutral structural styling; that acceptance does not select a product visual world or approve the complete design. The owner has directed that overall visual style be settled before further page-level refinement. The next design step compares visual directions using the same workbench content in the single master design entry; detailed desktop/mobile layouts and complete interaction states follow the selected direction.

The theme follows the operating system by default and supports manual light/dark selection and returning to the system setting. Desktop and mobile remember that preference independently. Both themes must preserve the same information hierarchy, controls and readable state distinctions.

## Tool Context

The default root invocation cannot resolve the scoped PRODUCT.md. Running `concept-seed --scope direction --mode operate` from `docs/design/` succeeded, with seed `f8d1abaf` and assigned grounded candidate 4, an incident-response workbench. That assignment informs a possible later visual direction; it does not override the owner's sequence or constitute a choice. No root PRODUCT.md, DESIGN.md or .impeccable is created.

## Structural Contract

The top-level global navigation is Workbench and Tasks. The workbench prioritizes a short attention queue with an adjacent or following request review and compact conversation access; its All Conversations action opens the cross-project conversation list and creation path. Global Tasks spans all projects and supports list/board/graph switching. Opening a task keeps its conversation, sub-agent activity, shared draft and task state in the same workspace. Mobile reorganizes conversation and task information into task-local panels with the same capabilities.

Below the global navigation, the Conversations group directly lists projectless conversations, replacing the former Unassigned Project label. No separate global Conversations button remains in navigation. The collapsible Projects tree contains named projects with conversation leaves directly underneath. Both task-associated conversations and project conversations without tasks are included, with task association readable as metadata. Desktop and mobile expose the same hierarchy. Clicking a project switches its context; the prototype offers task and conversation panels, and the latter includes all that project's conversations. The active leaf/context and breadcrumb track the displayed scope.

Project tasks support list, board and graph views. The prototype stores the chosen task view independently for global Tasks and each project in client-local prototype storage; the default is list. Navigation expansion and the project-content panel are client browsing state; the prototype does not synchronize them across devices.

All Conversations includes task-associated and standalone conversations. New conversations can start without a task or project; project selection is optional. Task and conversation bindings are one-to-one and remain fixed in phase one. The prototype offers unoccupied tasks and a new-task path, preserving the same conversation, history, private draft and reading position. A creator-private projectless conversation joins the chosen task's project only after an explicit history-sharing confirmation; the draft remains private to the creator's own devices. Existing project conversations can bind only within that project. There are no replacement, detachment or cross-project migration actions.

Task business states are To do, In progress, Blocked, Done and Cancelled. Run completion does not automatically complete a task. The prototype's list, five-column board, graph, filters and task workspace use this same vocabulary. Concurrent drafts and reconnect conflicts automatically adopt the last modification; sending consumes only sent content and retains newer input, and recovery never sends. Real cross-client ordering, deduplication, privacy enforcement and recovery remain public-contract and backend verification work, not capabilities proved by the single-client mock.

The graph distinguishes task containment from prerequisite-to-dependent task edges. Both may cross projects; neither relationship changes a task's own project, main session or execution ownership. Project containment and task parentage are separate relationships, so a cross-project child must not appear to belong to its parent's project. In a project view, authorized external endpoints carry their actual project; unauthorized task contents must not be exposed through related nodes, previews or labels. The current structural prototype uses same-project mock containment with solid lines and directed dashed dependency edges, supports scrolling, zoom and opening the same task nodes, and does not yet demonstrate cross-project endpoints. Cross-project fixtures and presentation must be included when the graph receives the selected visual direction. Real relationship contracts and authorization remain implementation handoff dependencies; the prototype does not implement relationship editing.

The owner has ruled out a user-facing host concept and has no current multi-host connection plan. Host navigation, selectors and sample machine names are removed. The integrated contract uses one preconfigured logical execution environment, keeps Server/Worker/Connector separate and treats Connector administration as deployment-internal. The execution machine may be separate from the platform; existing desktop-session control still needs actual capability evidence.

Files stay in their conversation context. The owner has rejected a standalone artifacts module, including a global page and task-specific panel. A remote file browser is only a possible future capability, outside the current design scope.

All content is labeled demonstration data. Approval, input, conversation creation, history-sharing confirmation and task-association interactions update only prototype state. Real cross-client draft synchronization, authorization, Codex execution, original-file downloads and PWA installation are not implemented or accepted by this artifact. Scenario controls demonstrate intended state presentation only. Confirmed product rules come from the main coordinator's PRD; remaining relationship-scope, deletion and team-permission choices are not inferred here.

## Open Decisions and Dependencies

The owner still needs to choose final visual direction, review detailed page layouts and confirm the complete design. The main coordinator owns the remaining PRD business-rule interview; this design task consumes those answers without repeating the questions. F02, R02, F05 and RD03/G0 actual inputs must supply the framework, real fixtures, public interfaces and recovery/deployment contracts before final U01–U04 page/component/state/API handoff.

## Visual Evidence

The owner accepted this structural navigation set: Workbench and Tasks at the top, projectless conversation leaves under Conversations, and Projects → named project → conversation leaves. This is approval of the displayed navigation and screenshots, not final visual design or real backend behavior. The source is the login-free, mock-only `design/index.html?canvas=1`; viewport emulation uses desktop 1440×900 and mobile 393×852 CSS pixels. Trim-only normalization left both captures unchanged. These images document the accepted navigation structure; subsequent interaction states are reviewed separately.

![Accepted desktop navigation](../../design/evidence/project-tree-desktop.png)

![Accepted mobile navigation](../../design/evidence/project-tree-mobile.png)
