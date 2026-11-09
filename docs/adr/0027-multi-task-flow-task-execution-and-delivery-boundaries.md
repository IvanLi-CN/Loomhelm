# ADR 0027: Multi-task Flow task execution and delivery boundaries

## Context

The flow distinguishes Main Agent, delivery Agent and Task Agent, but a task was previously treated as if it always required a new conversation and a child PR. That interpretation over-split bootstrap preparation work and confused task execution with delivery-unit integration.

## Decision

Treat a task as a schedulable and verifiable work item whose execution conversation and delivery artifact are explicit policies rather than defaults. Each task declares an `execution_owner`, `conversation_policy` and `delivery_policy`. Main-owned bootstrap work is executed in the main conversation and normally enters the parent PR; independent implementation work uses a Task Agent and child PR; verification, rehearsal, deployment and release work normally produces structured verification evidence without a child PR. A coordination task is created only when it has an independent, observable deliverable.

Use the delivery Agent as the owner of a regular delivery unit's parent branch, parent PR, merged-SHA CI, predeclared post-merge obligations and closeout. Task Agents own their own child PR merge, rebase, conflict resolution and task evidence. The delivery Agent does not merge, rebase or re-review normal child PRs; it handles only its own parent PR and facts that fail at the delivery-unit boundary. Bootstrap is main-owned and the Main Agent directly serves as its delivery Agent.

Validate task policy combinations as a closed contract. Reject missing policies for new proposals and reject contradictory combinations such as Main Agent with a Task Agent conversation, a delivery Agent with a child PR, or a child PR without a Task Agent conversation. Historical schema2/contract2 ledgers without these fields remain readable and read-only, display the values as undeclared, and are never silently rewritten.

## Consequences

The ledger and dashboard can distinguish a work item from its execution conversation and delivery artifact. Plans no longer create child conversations or PRs merely because a task node exists. Delivery-unit integration is limited to parent-PR and closeout facts, while task-level quality and PR ownership remain with the Task Agent.

## References

- [Multi-task Flow proposal quality gates](./0026-multi-task-flow-proposal-quality-gates.md)
- [客户端 Skills 与工程执行支持](../specs/client-skills/SPEC.md)
