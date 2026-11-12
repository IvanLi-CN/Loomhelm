# ADR 0029: Unified atomic orchestration

## Context

The previous ledger carried task atoms, group atoms, coordination states and aggregate graph facts in parallel. Those representations could disagree about dependency order and business status.

## Decision

Use one canonical graph of atomic work and milestone nodes. Task and DeliveryUnit remain peer domain objects whose dependencies and business status are derived from the graph. Runtime agent observations are kept separate from business state. Contract 3 accepts strict discriminated unions for scope, lifecycle, PR facts and milestone conditions, while contract 2 remains a read-only migration source.

## Consequences

Dependency validation, milestone evaluation and status projection have one source of truth. Legacy records need explicit migration when their semantics cannot be inferred mechanically. The viewer can offer an atomic review mode without maintaining a second graph.
