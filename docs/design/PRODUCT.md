# Loomhelm product context

<!-- impeccable:product-schema 1 -->

This is supporting context for the single complete UI design. Read the main coordinator's [product requirements](../PRD.md) for complete product scope, journeys, business decisions and acceptance, then the [core specification](../specs/phase1-core/SPEC.md) for established engineering contracts, before this design context. Confirmed design decisions return to the product requirements through the main coordinator.

The complete PRD and complete UI design each require the owner's explicit confirmation. Proposed product defaults remain unapproved until answered; the existing design discussion and prototype can continue while those decisions are being resolved.

## Platform

web

## Users

The primary design scenario is one human owner using the self-hosted workspace from desktop and mobile devices, including concurrent use. The owner describes the desired continuity as a shared live workspace.

## Product Purpose

Connect durable project and task management with human-supervised Codex conversations in the owner's workspace.

## Operating Context

The top-level global navigation consists of Workbench and Tasks, both spanning projects. The workbench is the default entry and highlights pending decisions and exceptions. Tasks provides a cross-project view of work goals and progress. A collapsible Conversations group below those entries lists projectless conversations directly; there is no separate global Conversations button in navigation. The workbench's All Conversations action retains access to the cross-project conversation list and conversation creation.

The global workbench prioritizes work requiring the user's intervention, including pending approvals and exceptions that require manual handling. Other sessions remain directly accessible in a compact list, with their full context available on selection.

Tasks support list, board and graph views and remember the chosen view. The initial default is a compact list; the board groups by task business state. The graph combines project/task/subtask hierarchy with task dependencies, using distinct relationships. Both parent/child relationships and prerequisite dependencies may cross projects without changing either task's project, main session or execution ownership. Relationship endpoints remain subject to authorization; related content must not reveal protected tasks. Project views distinguish an authorized external task's actual project. All three present the same tasks and lead to the same task workspace. Task business state and conversation execution state remain separately readable.

Below the global entries, project navigation is a collapsible tree: the Projects root contains named projects, and each project directly contains its conversations. Project conversations appear whether or not they have a task; task association does not introduce a task level in this navigation tree. Projectless conversations remain directly accessible in the Conversations group and in the cross-project conversation list reached from the workbench. Choosing a project switches its context, where tasks and all project conversations are available. The global Tasks view is distinct because it spans projects. The selected navigation entry and page breadcrumb must identify the displayed scope consistently.

There is no user-facing host concept or host-management navigation in the current design. The owner has no current plan to connect multiple hosts. The installation uses one preconfigured logical execution environment; Server, Worker and Connector remain separate processes, and the execution machine may be separate from the platform. Connector enrollment, authentication, revocation and recovery belong to deployment administration. This simplification does not establish existing desktop-session control capability.

Pending approvals can be handled in place from the global workbench. The user first expands the item's project/task association, complete operation request, affected scope and relevant context, then explicitly approves or denies it. The full conversation remains accessible from that review.

Each task associates with at most one Codex session, its task session, and each session associates with at most one task. Only an unbound conversation and a task without a main conversation may be bound. Established bindings remain fixed in phase one: there is no replacement, detachment or cross-project migration. A project-associated standalone conversation can bind only to a task in that project. Code review, research and similar supporting work generally use sub-agents within that session's delegation context.

Conversations can be started independently from the workbench's All Conversations list, without first creating a task or selecting a project. Project selection is optional at creation, and standalone conversations support actual execution. Projectless conversations are creator-private. Before joining a task's project, the creator explicitly confirms that historical messages, execution and files will follow that project's permissions; unsent drafts remain private to that creator's own devices. Association continues the same conversation and preserves its messages, runs, events, file references and private shared draft. Failure leaves the original conversation, ownership and visibility intact.

Opening a task enters one combined workspace containing its task session and task information. Desktop uses the conversation as the main area with goals and task state beside it. Mobile offers the same information through conversation and task-information panels within the task, retaining input and reading position when switching panels.

There is no standalone artifacts module, global artifacts page or task artifacts panel. Files mentioned or produced during work belong to their conversation context. A remote file browser is a possible future capability to consider if needed; it is not added to the current design scope.

Sub-agent activity is presented as expandable branches within the task session. The default summary shows the assigned work, state and outcome; supported messages and tool activity can be inspected on expansion. Available detail must be reconciled against real event fixtures and public contracts.

The owner's existing project-engineering-workflow and related flows provide the engineering context. Detailed workflow modeling is deferred; the UI design must not invent a parallel engineering process.

Desktop and mobile offer the same capabilities. Layout and interaction adapt to the available screen and input method; mobile is a complete working surface.

The theme follows the operating system by default, with manual light and dark selection and a way to return to the system setting. Each client remembers its own theme choice independently. Both themes retain the same capabilities and information hierarchy.

The owner's concurrent Web/PWA clients share task, session and submitted-operation state in real time. Each client can continue authorized work without a device-specific takeover step. Opening the same session on another device does not itself transfer control or make that device an observer-only client.

Each session has a private unsent conversation draft shared only across the creating user's own authorized clients. Concurrent edits and reconnection conflicts automatically use the last modification, without asking the user to choose between copies. Sending consumes only the content actually sent and preserves subsequent input; synchronization and recovery never send a command. The public contract must define consistent modification ordering, deduplication and recovery.

Each client retains independent navigation and reading position. Changing the selected session, page or scroll position on one device does not move another device's view.

Actual permission limits, connection loss and conflicting execution remain distinct conditions to represent. Platform command coordination and reconciliation must support the shared-owner interaction model. The accepted draft policy still requires an actual supporting contract and multi-client verification.

## Capabilities and Constraints

The current UI scope includes global Workbench and Tasks, the projectless Conversations group, cross-project conversation access from the workbench, project switching, list/board/graph task views with remembered preference, task hierarchy and dependencies, standalone conversations with optional project selection and later task association, new and existing conversation paths, messages, tools, approvals and denial, interruption, control conflicts, uncertain results, reconnection, conversation-associated original files and PWA installation, updates and offline behavior. Remaining task-relationship, deletion and team-permission rules belong to the main coordinator's product interview. The core specification's original-file retention and access requirements do not imply a separate user-facing artifacts module.

Task business states are To do (待办), In progress (进行中), Blocked (阻塞), Done (完成) and Cancelled (取消), distinct from execution status. A completed run does not automatically complete its task. Offline control commands are never queued or automatically replayed. Existing active desktop-session control requires evidence from the actual same instance and remains unproven at this design baseline.

Autonomous master/project/task Agent orchestration is a future capability. The initial design must represent the verified capabilities of the current product.

## Brand Commitments

The product name is Loomhelm. The owner selected D, Glass / Layered (半透明材质), from an independent UI style sheet and accepted its displayed desktop/mobile light and dark specimens. Future page design must preserve this selected direction and the confirmed system/manual theme behavior. The D01 completion record now covers the approved information architecture, material details, page-level visual decisions, responsive layouts, UX states and implementation handoff; production implementation remains a separate engineering gate.

## Evidence on Hand

The product requirements are the product entry point; the core specification, implementation coverage, topic history and ADRs 0001 and 0002 provide engineering constraints and capability evidence. This design context supports those documents. Final handoff must incorporate the actual framework, sanitized content fixtures, public contracts and recovery/deployment inputs when available.

The owner accepted the desktop/mobile navigation images and the four D light/dark style specimens recorded in the [design surface brief](surface-brief.md#visual-evidence). Together with the D01 completion record, they establish the approved design package. All specimens use synthetic content; they do not establish real execution, synchronization or authorization behavior.

## Product Principles

- Optimize for an efficient workbench: quickly locate work, understand its state and act in context.
- Preserve feature parity between desktop and mobile.
- Support continuous work across the same owner's concurrently open devices.
- Keep cross-project work accessible from the default global workbench.
- Make approval, control authority and uncertain outcomes understandable before an action is taken.

## Open Design Decisions

Navigation hierarchy and its displayed desktop/mobile structural screenshots are accepted. D, Glass / Layered, and its displayed light/dark specimens are also accepted. The detailed workbench layout, attention items, page/component states and responsive workspaces are documented in the D01 package and included in the owner's completion confirmation. The main coordinator owns the remaining PRD business-rule interview; the design task consumes those answers without repeating the questions. The approved navigation, list/board/graph task views, standalone conversations, combined task workspace, expandable sub-agent visibility, binding/privacy/draft rules, five task states, cross-project task relationships, theme behavior and style specimens define the complete design package, but do not approve production implementation. The prototype remembers task view choices independently for global Tasks and each project on the current client. The integration implementation default is client-local persistence isolated by identity, workspace and global/project scope; it does not add a server preference resource or change another client's view, and it is not an owner-selected storage technology. Mock task relationships demonstrate the graph structure and do not establish backend support or a relationship-editing contract.
