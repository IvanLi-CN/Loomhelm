# ADR 0034: Complete atomic graph view and stable derived order

The viewer must preserve the canonical atomic graph as an observable fact even when validation finds a cycle, orphan node, missing dependency, or ordering conflict. We will render every persisted node and edge, mark the affected graph region with explicit diagnostics, and derive the detail-list order from a stable graph algorithm rather than storing a second `display_order` fact: use stable topological sorting for DAGs and a strongly connected component fallback for cyclic graphs, with node ID as the deterministic tie-breaker. Status icons remain the only status indicator; selection focus is the only extra item emphasis.

## Considered Options

- Persist a separate `display_order`: rejected because it duplicates dependency semantics and can conflict with `AtomicEdge`.
- Hide nodes that cannot be topologically sorted: rejected because the viewer must expose the exact invalid facts for diagnosis.
- Use input-array order as a fallback: rejected because it is not a stable, explainable ordering contract.

## Consequences

The graph projection and delivery-detail projection need shared ordering and validation diagnostics. Cyclic or otherwise invalid data remains visible and receives warning styling; the detail list may be a best-effort linearization, but it must state when no valid linear order exists. UI tests must cover complete rendering, stable ordering, anomaly markers, and the removal of automatic current-item emphasis.
