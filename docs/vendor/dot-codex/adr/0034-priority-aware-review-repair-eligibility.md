---
status: accepted
---

# ADR 0034: Priority-Aware Review Repair Eligibility

Formal review must preserve genuine defects without turning every low-priority finding into another repair wave. The workflow therefore keeps the canonical finding classifications from [ADR 0016](0016-bind-review-repairs-to-approved-scope.md), but adds a main-Agent repair threshold: an initial Formal Review Wave may optionally repair an eligible P2-only finding; later P2 repair requires an eligible P0/P1 finding or a qualifying current-Candidate CI failure in the same root-cause batch. P2/P3-only results may clear with an explicit `repair_not_required_low_priority` resolution and are reported at the next owner-facing stop. P3 and lower findings are not independent repair targets.

`Design-Returning Review Finding`, safety boundaries, required acceptance, and unavailable or failed evidence retain their existing gates regardless of priority. The retired standalone review-loop Skill is outside this workflow decision and is not a second convergence path.

## Consequences

- Low-priority findings remain visible without forcing a repair batch or a new review wave.
- A first-wave P2 repair consumes the ordinary cumulative Repair Batch count; accepting the finding without a write consumes no batch.
- A qualifying CI failure can justify a related P2 repair after the initial wave, while infrastructure or unavailable CI evidence cannot.
- The canonical reviewer disposition schema remains unchanged; the threshold is recorded as main-Agent `repair_resolution` evidence.
