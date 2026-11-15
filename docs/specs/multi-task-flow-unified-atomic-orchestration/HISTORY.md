# History

- 2026-11-11: Locked the unified atomic orchestration contract and implementation scope.
- 2026-11-12: Promoted the complete design into the topic SPEC and documented the implementation mapping, compatibility boundary and viewer entry points.
- 2026-11-13: Clarified the main-owned bootstrap start exception and fail-closed handling for uncertain or retained parent PR facts.
- 2026-11-13: Revalidated the topic contract after the mainline viewer and documentation synchronization.
- 2026-11-13: Closed bootstrap readiness consistently across engine, atomic validation and viewer projections, including provider identity, parent PR state and active workspace gates.
- 2026-11-13: Required explicit failed PR absence evidence and propagated DeliveryUnit gates into plan-level bootstrap readiness projections.
- 2026-11-13: Aligned engine bootstrap dispatch with the same explicit parent PR absence evidence required by validator and viewer.

- 2026-11-15: Added a fail-closed theoretical scheduling gate: plans with incomplete or indeterminate intervals cannot be approved or scheduled, incomplete viewers hide the timeline and list blockers, and user-visible planned time is relative hours from `0h` without date or timezone semantics.
- 2026-11-15: Required complete atomic graph rendering and stable derived detail ordering: invalid nodes and edges remain visible with diagnostics, DAGs use stable topological ordering, cyclic graphs use strongly connected component fallback, and the viewer does not persist a second display-order fact or automatic current-item emphasis.
