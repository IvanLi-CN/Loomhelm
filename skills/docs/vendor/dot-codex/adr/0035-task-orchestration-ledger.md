# ADR 0035: Task Orchestration Ledger

- Status: Accepted
- Related: `docs/adr/0029-wave-thread-delivery-batches.md`

## Context

An owner-approved task orchestration coordinates concurrent task conversations, PR integration and dynamic parent PR cuts. Agents need a recoverable shared record that remains available across conversation interruptions and independent Worktrees.

## Decision

Keep one authoritative JSON ledger per orchestration under the multi-task-flow Skill's own data directory. Serialize ledger updates with an operating-system process lock and atomic replacement, and record external operation claims before invoking the platform. The ledger retains unresolved claims until the external result can be verified. A read-only dashboard projects the ledger; it is not a second source of state.

Dependencies are explicit task and milestone facts, not waves. The coordinator and task conversations remain separately owned. Native thread creation and platform operations use their respective existing boundaries.

This decision applies only to the multi-task-flow Skill. Legacy conversation-local coordination contracts remain read-only compatibility surfaces and are not modified by this Skill.

## Consequences

The ledger survives individual task Worktrees and allows reliable concurrent bookkeeping on one machine. Its schema, locking, recovery, resource cleanup and local service require explicit validation. Ambiguous native operations remain blocked rather than being guessed or retried.
