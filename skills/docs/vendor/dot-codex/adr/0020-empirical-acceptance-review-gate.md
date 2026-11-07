---
status: superseded
---

# ADR 0020: Empirical Acceptance Review Gate

## Status

Superseded by [ADR 0033](0033-empirical-acceptance-and-repair-autonomy.md).

## Context

The direct-review contract requires applicable validation before formal review, and it limits ordinary review repair to three bounded Repair Batches. That contract does not identify when acceptance requires observation of external behavior, nor does it bind that observation to the exact Candidate and accepted behavior. An Agent can therefore start formal review after repository-local validation even when a later repair changes a physical, timing, or protocol assumption that only empirical validation can verify.

The existing Review Readiness and finding-disposition rules must remain generic. HIL is an important instance of this problem, but the durable boundary is any acceptance criterion that deterministic repository-local validation cannot prove.

## Decision

1. A direct flow must declare an Empirical Acceptance Obligation when an acceptance criterion depends on external behavior that repository-local, deterministic validation cannot prove. The declaration is based on the criterion's proofability, not a task category, changed-file heuristic, or reviewer preference.
2. An applicable obligation has current Empirical Acceptance Evidence bound to the exact Candidate SHA, acceptance-contract digest, required scenario set, outcome, and an inspectable evidence locator. The record belongs to current Candidate/flow evidence; it is not a tracked receipt ledger and does not become direct review proof.
3. Formal review, PR convergence, and local-merge readiness require passed current evidence for every applicable obligation. A Candidate SHA change or acceptance-contract change makes affected evidence stale.
4. A proposed repair is Design-Returning when it changes an external-behavior contract, including source-response assumptions, timeouts, retries, permission/state transitions, or the acceptance semantics themselves, unless the accepted contract already states the exact behavior and evidence proves the Candidate violates it.
5. A failed empirical run after a comparable passed Candidate is an Empirical Regression. The flow becomes diagnosis-only: it compares the exact passing and failing Candidates and does not open another ordinary Repair Batch or formal review wave. The failure does not by itself attribute cause to a reviewer or a particular repair.
6. Continuation anchors carry the Empirical Acceptance Obligation and current evidence state together with the Candidate and cumulative Repair Batch count. Generic continuation cannot infer, reset, or waive either state. A fourth Repair Batch still requires explicit owner authorization bound to the current Candidate anchor.

## Consequences

- Empirical validation becomes a first-class admission condition rather than a late confirmation after review repairs.
- Reviewers may report a concern, but they cannot silently redefine an externally observable contract through an In-Scope repair.
- A hardware or integration regression is diagnosed from evidence instead of being treated as automatic proof that review was wrong.
- `flow_receipt.py` remains validation/lifecycle audit infrastructure and does not regain review orchestration or delivery-gate authority.

## Alternatives Rejected

- Limit the rule to firmware or HIL: rejected because the governing distinction is proofability of an acceptance criterion, not implementation technology.
- Add a durable review/repair receipt ledger: rejected because direct review evidence intentionally remains independent of receipt orchestration.
- Allow every empirical failure to enter the next Repair Batch: rejected because it recreates the review/HIL alternation this decision prevents.

## Related Specs

- [Empirical Acceptance Review Gate](../specs/empirical-acceptance-review-gate/SPEC.md)
- [Local Review Necessity And Evidence](../specs/mandatory-local-review-proof/SPEC.md)
