# Loomhelm product context

<!-- impeccable:product-schema 1 -->

This is supporting context for the single complete UI design. The [core specification](../specs/phase1-core/SPEC.md) remains the source of product requirements; design approval requires the owner's explicit confirmation of the complete design.

## Platform

web

## Users

The primary design scenario is one human owner using the self-hosted workspace from desktop and mobile devices, including concurrent use. The owner describes the desired continuity as a shared live workspace.

## Product Purpose

Connect durable project and task management with human-supervised Codex conversations in the owner's workspace.

## Operating Context

The global navigation consists of Workbench, Tasks and Conversations. All three span projects. The workbench is the default entry and highlights pending decisions and exceptions. Tasks provides a cross-project view of work goals and progress; Conversations provides cross-project access to conversations and their recent activity.

The global workbench prioritizes work requiring the user's intervention, including pending approvals and exceptions that require manual handling. Other sessions remain directly accessible in a compact list, with their full context available on selection.

Tasks support list, board and graph views and remember the chosen view. The initial default is a compact list; the board groups by task business state. The graph combines project/task/subtask hierarchy with task dependencies, using distinct relationships. All three present the same tasks and lead to the same task workspace. Task business state and conversation execution state remain separately readable.

Below the three global entries, project navigation is a collapsible tree: the Projects root contains named projects, and each project directly contains its conversations. Project conversations appear whether or not they have a task; task association does not introduce a task level in this navigation tree. Projectless conversations remain directly accessible in a separate group and in global Conversations. Choosing a project switches its context, where tasks and all project conversations are available. The global Tasks view is distinct because it spans projects. The selected navigation entry and page breadcrumb must identify the displayed scope consistently.

There is no user-facing host concept or host-management navigation in the current design. The owner has no current plan to connect multiple hosts. The installation uses one preconfigured logical execution environment; Server, Worker and Connector remain separate processes, and the execution machine may be separate from the platform. Connector enrollment, authentication, revocation and recovery belong to deployment administration. This simplification does not establish existing desktop-session control capability.

Pending approvals can be handled in place from the global workbench. The user first expands the item's project/task association, complete operation request, affected scope and relevant context, then explicitly approves or denies it. The full conversation remains accessible from that review.

Each task associates with at most one Codex session, its task session. Code review, research and similar supporting work generally use sub-agents within that session's delegation context. These activities do not require additional directly associated task sessions.

Conversations can be started independently from the global Conversations entry, without first creating a task or selecting a project. Project selection is optional at creation. A standalone conversation can later associate with a task; when a projectless conversation is associated, it joins that task's project. The association continues the same conversation, including its existing messages and shared unsent draft, rather than starting a replacement conversation. A task still has at most one directly associated main conversation.

Opening a task enters one combined workspace containing its task session and task information. Desktop uses the conversation as the main area with goals and task state beside it. Mobile offers the same information through conversation and task-information panels within the task, retaining input and reading position when switching panels.

There is no standalone artifacts module, global artifacts page or task artifacts panel. Files mentioned or produced during work belong to their conversation context. A remote file browser is a possible future capability to consider if needed; it is not added to the current design scope.

Sub-agent activity is presented as expandable branches within the task session. The default summary shows the assigned work, state and outcome; supported messages and tool activity can be inspected on expansion. Available detail must be reconciled against real event fixtures and public contracts.

The owner's existing project-engineering-workflow and related flows provide the engineering context. Detailed workflow modeling is deferred; the UI design must not invent a parallel engineering process.

Desktop and mobile offer the same capabilities. Layout and interaction adapt to the available screen and input method; mobile is a complete working surface.

The owner's concurrent Web/PWA clients share task, session and submitted-operation state in real time. Each client can continue authorized work without a device-specific takeover step. Opening the same session on another device does not itself transfer control or make that device an observer-only client.

Each session has a shared unsent conversation draft. The owner's clients can see and continue editing that draft in real time. Sending remains an explicit action; synchronizing a draft does not submit a control command.

Each client retains independent navigation and reading position. Changing the selected session, page or scroll position on one device does not move another device's view.

Actual permission limits, connection loss and conflicting execution remain distinct conditions to represent. Platform command coordination and reconciliation must support the shared-owner interaction model. Concurrent draft edits and disconnection recovery still require a defined interaction and actual supporting contract.

## Capabilities and Constraints

The current UI scope includes global Workbench, Tasks and Conversations, project switching, list/board/graph task views with remembered preference, task hierarchy and dependencies, standalone conversations with optional project selection and later task association, new and existing conversation paths, messages, tools, approvals and denial, interruption, control conflicts, uncertain results, reconnection, conversation-associated original files and PWA installation, updates and offline behavior. Projectless conversation authorization and execution, later task association and the task-relationship contract need integration-owner reconciliation with the owner's direction. The core specification's original-file retention and access requirements do not imply a separate user-facing artifacts module.

Task progress and execution status are distinct. Offline control commands are never queued or automatically replayed. Existing active desktop-session control requires evidence from the actual same instance and remains unproven at this design baseline.

Autonomous master/project/task Agent orchestration is a future capability. The initial design must represent the verified capabilities of the current product.

## Evidence on Hand

The core specification, implementation coverage, topic history and ADRs 0001 and 0002 define the baseline. Final handoff must incorporate the actual framework, sanitized content fixtures, public contracts and recovery/deployment inputs when available.

## Product Principles

- Optimize for an efficient workbench: quickly locate work, understand its state and act in context.
- Preserve feature parity between desktop and mobile.
- Support continuous work across the same owner's concurrently open devices.
- Keep cross-project work accessible from the default global workbench.
- Make approval, control authority and uncertain outcomes understandable before an action is taken.

## Open Design Decisions

Detailed workbench layout, concurrent draft editing and recovery, treatment of other attention items and visual direction require further owner decisions. The global navigation, list/board/graph task views, standalone conversations, combined task workspace and expandable sub-agent visibility do not approve the complete design. The prototype remembers task view choices independently for global Tasks and each project on the current client. The integration implementation default is client-local persistence isolated by identity, workspace and global/project scope; it does not add a server preference resource or change another client's view, and it is not an owner-selected storage technology. Reverse session/task cardinality and reassignment remain open. Mock task relationships demonstrate the graph structure and do not establish backend support or a relationship-editing contract.
