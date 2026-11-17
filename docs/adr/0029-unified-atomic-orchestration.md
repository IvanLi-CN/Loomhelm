# ADR 0029: Unified atomic orchestration

## Context

The previous ledger carried task atoms, group atoms, coordination states and aggregate graph facts in parallel. Those representations could disagree about dependency order and business status.

## Decision

Use one canonical graph of atomic work and milestone nodes. Task and DeliveryUnit remain peer domain objects whose dependencies and business status are derived from the graph. Runtime agent observations are kept separate from business state. Lifecycle preset atoms carry an explicit `lifecycle_role` (`prepare-parent`, `prepare-branch`, `create-pr`, `merge-pr`, or `closeout`); IDs are not a semantic source for new writes, and historical ID compatibility is bounded by owner scope and complete suffix matching. Contract 6 accepts strict discriminated unions for scope, lifecycle, PR facts, lifecycle roles and milestone conditions, while contracts 2 through 5 remain read-only or explicit-migration sources.

## Consequences

Dependency validation, milestone evaluation and status projection have one source of truth. Legacy records need explicit migration when their semantics cannot be inferred mechanically. The viewer can offer an atomic review mode without maintaining a second graph.
