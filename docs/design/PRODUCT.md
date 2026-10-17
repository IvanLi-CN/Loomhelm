# Loomhelm product context

<!-- impeccable:product-schema 1 -->

This is supporting context for the single complete UI design. The [core specification](../specs/phase1-core/SPEC.md) remains the source of product requirements; design approval requires the owner's explicit confirmation of the complete design.

## Platform

web

## Users

The primary design scenario is one human owner using the self-hosted workspace from desktop and mobile devices, including concurrent use. The owner describes the desired continuity as a shared live workspace.

## Product Purpose

Connect durable project and task management with human-supervised Codex execution on selected paired hosts.

## Operating Context

The default entry is a global workbench spanning projects, sessions, pending decisions and exceptions. Users can enter a specific project or session from this shared context.

The global workbench prioritizes work requiring the user's intervention, including pending approvals and exceptions that require manual handling. Other sessions remain directly accessible in a compact list, with their full context available on selection.

The project workspace defaults to a compact task list with state grouping and filtering. Task business state and session execution state remain separately readable in that list.

Pending approvals can be handled in place from the global workbench. The user first expands the item's project/task association, host, complete operation request and relevant context, then explicitly approves or denies it. The full session remains accessible from that review.

Each task associates with at most one Codex session, its task session. Code review, research and similar supporting work generally use sub-agents within that session's delegation context. These activities do not require additional directly associated task sessions.

Opening a task enters one combined workspace containing its task session and task information. Desktop uses the conversation as the main area with goals, task state and artifacts beside it. Mobile offers the same information through panels within the task, retaining input and reading position when switching panels.

Sub-agent activity is presented as expandable branches within the task session. The default summary shows the assigned work, state and outcome; supported messages and tool activity can be inspected on expansion. Available detail must be reconciled against real event fixtures and public contracts.

The owner's existing project-engineering-workflow and related flows provide the engineering context. Detailed workflow modeling is deferred; the UI design must not invent a parallel engineering process.

Desktop and mobile offer the same capabilities. Layout and interaction adapt to the available screen and input method; mobile is a complete working surface.

The owner's concurrent Web/PWA clients share task, session and submitted-operation state in real time. Each client can continue authorized work without a device-specific takeover step. Opening the same session on another device does not itself transfer control or make that device an observer-only client.

Each session has a shared unsent conversation draft. The owner's clients can see and continue editing that draft in real time. Sending remains an explicit action; synchronizing a draft does not submit a control command.

Each client retains independent navigation and reading position. Changing the selected session, page or scroll position on one device does not move another device's view.

Actual permission limits, connection loss and conflicting execution remain distinct conditions to represent. Platform command coordination and reconciliation must support the shared-owner interaction model. Concurrent draft edits and disconnection recovery still require a defined interaction and actual supporting contract.

## Capabilities and Constraints

The initial scope includes projects, tasks, host pairing and status, new and existing desktop session paths, messages, tools, approvals and denial, interruption, control conflicts, uncertain results, reconnection, original artifacts and PWA installation, updates and offline behavior.

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

Detailed workbench layout, concurrent draft editing and recovery, treatment of other attention items and visual direction require further owner decisions. The confirmed compact project task list, combined task workspace and expandable sub-agent visibility do not approve the complete design.
