---
status: accepted
supersedes: 0012-mandatory-local-review-proof.md (universal direct-flow requirement only)
---

# Review Necessity Tiering

ADR 0012 restored a mandatory local `ReviewReceipt` for every direct delivery flow. That universal requirement protects correctness but imposes the same review latency on changes where an Agent concludes code review is not needed. ADR 0003 remains authoritative for CI, release, tracker, PR, and post-merge external facts.

## Decision

- Every new direct `normal`, `fast-track`, `local-merge`, and direct parallel-PR flow records an Agent-owned review necessity assessment before PR binding or terminal local-merge completion. Workflow evidence stores a tier and concise rationale. Before PR binding, a changed candidate may be reassessed with its prior assessment retained as history; receipt binding does not lock or gate that workflow evidence.
- The Agent selects Tier 1 through Tier 4 from the actual work. There is no automatic classifier, task-category mapping, or prescribed rubric.
- Tier 1 has no code-review delivery gate. Tier 2 permits optional advisory review, which remains informational. Tier 3 requires the existing fresh clear four-lane current-head `ReviewReceipt`. Tier 4 requires that proof plus one or two Agent-selected dynamic lanes.
- Tier 3/4 preserve all required-proof properties from ADR 0012: clean exact base/head binding, read-only-sub-agent structured result, transport independence, sub-agent unavailability blocking, current-head invalidation, three repair permits, explicit convergence reopen, and no AI merge-review duplication after clear proof.
- Existing active or already-bound direct workflow evidence that predates assessment remains subject to the caller's current workflow contract. The receipt ledger keeps historical assessment fields readable without using them as a lifecycle gate. Archived historical receipt bytes remain unchanged.
- `initiative-flow` retains its independent review-proof state machine.

## Consequences

Direct delivery no longer waits for mandatory local review when the recorded Agent assessment is Tier 1 or Tier 2. The assessment remains visible and immutable, so the absence of proof is deliberate and auditable. Tier 3/4 do not gain an advisory compatibility bypass.
