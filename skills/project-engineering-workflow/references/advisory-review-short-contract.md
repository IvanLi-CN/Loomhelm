# Advisory Review Contract

Use this contract for optional independent review during a delivery flow. An advisory review improves the candidate; it is not a merge gate and does not decide whether the candidate is merge-ready. It cannot replace the mandatory `review-proof-short-contract.md` evidence when a Tier 3/4 direct delivery flow requires it.

## Applicability

- An advisory reviewer starts only when explicitly requested by the owner or main Agent, and only after all formal lanes reach terminal state.
- It never occupies a formal review slot while a required lane is live or pending. The caller supplies an explicit supported model and effort; its profile is a quality/cost recommendation, not task identity or delivery proof.

## Runtime boundary

- The reviewer may be launched through direct Agent calls or Programmatic Tool Calling (PTC). The runtime owns child identity and waiting; callers must not reconstruct either from transcript files.
- A reviewer is read-only and returns findings with concrete file/behavior evidence. The main Agent applies the canonical disposition and the shared priority-aware `repair_resolution`: an `In-Scope Review Finding` joins the normal Repair Batch only when the current Formal Review Wave and CI state satisfy that threshold, a `Design-Returning Review Finding` stops ordinary convergence, and a `Review Observation` remains report-only. Advisory output alone never creates a Repair Batch or turns a later-wave P2 into an authorized repair.
- Missing, failed, or malformed reviewer output is reported as advisory review unavailable. That advisory result remains non-blocking, but it must not be misreported as successful required Tier 3/4 evidence.

## Delivery boundary

- No ledger receipt, review wave, repair permit, profile attestation, or transcript digest is required for advisory review.
- Step 5C uses the current PR head, required checks, validation receipts, and other applicable external facts. Advisory findings are context for the main Agent, not a substitute for those facts.
