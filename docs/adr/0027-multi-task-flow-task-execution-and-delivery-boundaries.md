# ADR 0027: Multi-task Flow task execution and delivery boundaries

## Context

The flow distinguishes Main Agent, delivery Agent and Task Agent, but a task was previously treated as if it always required a new conversation and a child PR. That interpretation over-split bootstrap preparation work and confused task execution with delivery-unit integration.

## Decision

Treat a task as a projection of task-scoped work atoms. Execution conversation and delivery artifact are explicit policies on the TaskDefinition/DeliveryUnitDefinition shells rather than independent orchestration facts. Main-owned bootstrap work is executed in the main conversation and normally enters the DeliveryUnit PR; independent implementation work uses a Task Agent and child PR; verification, rehearsal, deployment and release work normally produces structured evidence. A coordination task is not a canonical object and must not be created merely to represent waiting, integration or delivery-unit management.

Before selecting those execution policies, the Main Agent groups task-scoped contribution work by the requirement result it jointly delivers. Tasks that are necessary parts of one independently accepted result share a delivery unit; independently deliverable requirement results use separate delivery units. The grouping decision remains in the planning context and is persisted only through each atomic scope's `delivery_unit_id`; it is not represented by a second proposal object or inferred from PR count.

Use the delivery-unit execution policy as the owner of a regular delivery unit's integration branch, integration PR, merged-SHA CI, predeclared post-merge obligations and closeout. Task Agents own their own child PR merge, rebase, conflict resolution and task evidence. The delivery-unit owner does not merge, rebase or re-review normal child PRs; it handles only its own integration PR and facts that fail at the delivery-unit boundary. Bootstrap is main-owned and the Main Agent directly serves this execution policy.

Validate task policy combinations as a closed contract. Reject missing policies for new proposals and reject contradictory combinations such as Main Agent with a Task Agent conversation, a delivery Agent with a child PR, or a child PR without a Task Agent conversation. Historical schema2/contract2 ledgers without these fields remain readable and read-only, display the values as undeclared, and are never silently rewritten.

## Consequences

The ledger and dashboard distinguish atomic work from execution observations and external delivery facts. Plans no longer create child conversations or PRs merely because an atomic node exists. Delivery-unit integration is represented by delivery-unit scoped milestones, external facts and evidence; task-level PR ownership remains with the contribution Task.

## References

- [Multi-task Flow proposal quality gates](./0026-multi-task-flow-proposal-quality-gates.md)
- [客户端 Skills 与工程执行支持](../specs/client-skills/SPEC.md)
