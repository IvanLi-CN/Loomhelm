---
status: accepted
supersedes: 0013-review-necessity-tiering.md (receipt orchestration only)
---

# Direct Review Evidence

Tier 3/4 review should protect delivery without making a local ledger the review scheduler, repair controller, or merge authority.

## Decision

- Required review is direct structured evidence from read-only sub-agents bound to the current base/head and declared scope.
- Tier 3 uses four fixed lanes; Tier 4 adds one or two relevant dynamic lanes.
- Initial evidence covers all required lanes. Repairs rerun affected lanes; unknown, high-risk, or base-drift repairs rerun all required lanes.
- Lane profiles are cost/quality guidance, not concurrency or model ceilings.
- `flow_receipt.py` remains validation and lifecycle infrastructure. Its review orchestration is a retirement target: it does not create review waves, freeze a candidate, consume repair permits, or decide whether review evidence is sufficient. Its retained `bind-pr`, post-merge, and close paths require only live PR identity, merge SHA, finality, and validation lifecycle facts; old assessment, review-wave, and convergence fields remain audit history.

## Consequences

Review work is scheduled directly against the current diff. PR convergence uses current review evidence, validation, CI, and GitHub facts, avoiding ledger-specific retries and state transitions.
