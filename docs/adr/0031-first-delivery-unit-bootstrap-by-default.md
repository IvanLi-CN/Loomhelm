# First delivery unit is bootstrap by default

## Context

The current runtime permits every delivery unit to default to `regular`, so a plan can omit the initial main-owned preparation boundary even when the first unit contains repository specification, workspace preparation, or parent PR setup.

## Decision

Require the first delivery unit in a new run to be `bootstrap` by default. Bootstrap remains main-owned, has no independent delivery conversation, and owns the initial specification, workspace and first parent PR boundary. Permit a first `regular` delivery unit only when the proposal records a specific exception reason and evidence in its acceptance contract. The exception must be visible before approval and cannot be inferred from ordering, ownership or omitted fields.

## Responsibilities

The Main Agent owns the run-wide dependency graph, approvals, dispatch decisions, delivery-unit ordering, exceptional changes and final closeout. The Delivery Agent owns one delivery unit's parent branch, parent PR, merged-SHA CI, declared post-merge release, deployment and verification obligations, follow PR reconciliation and closeout. The Task Agent owns one task's atoms, execution evidence, child PR, rebase and child PR merge; it escalates only facts that cross the delivery-unit boundary.

## Consequences

Plans have a predictable main-owned entry boundary while retaining an auditable escape hatch for work that genuinely starts as a regular delivery unit. Waiting, integration and delivery-unit management remain delivery-unit coordination state and milestones rather than coordination tasks. Runtime enforcement and proposal validation must preserve historical ledgers while rejecting an unreasoned first-regular proposal.
