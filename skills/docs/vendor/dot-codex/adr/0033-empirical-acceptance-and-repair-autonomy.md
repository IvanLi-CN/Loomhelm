---
status: accepted
---

# ADR 0033: Empirical Acceptance and Repair Autonomy

## Status

Accepted. Supersedes [ADR 0020](0020-empirical-acceptance-review-gate.md).

## Context

Empirical acceptance establishes whether an accepted behavior can be proven by deterministic repository-local validation. A separate cumulative Repair Batch count provides useful continuity and a signal of repeated work. Making the fourth repair depend on a new owner approval does not establish correctness or diagnose an expanding design, and interrupts authorized work.

## Decision

- Retain ADR 0020 decisions 1–5: proofability determines whether an obligation applies; evidence binds the Candidate, acceptance contract, scenario set, outcome and locator; applicable passed evidence gates review and readiness; changes to accepted external behavior return to design; a failed empirical run after a comparable pass is diagnosis-only.
- Continuation anchors retain the obligation, current evidence, Candidate and cumulative Repair Batch count. Missing or mismatched facts block recovery rather than being inferred or reset.
- Within the selected flow and approved scope, the main Agent decides and executes eligible repairs without per-batch owner approval. Near three batches or when the same root cause recurs, it diagnoses the approved scope, baseline, implementation and tests before continuing. A new behavior, contract or wider scope follows the existing design and owner-decision boundary.

## Consequences

- Empirical evidence and safety gates remain independent of repair count.
- A count supports diagnosis and continuation without imposing a repair authorization budget.
- A failed empirical comparison remains diagnosis-only; it is not an automatic repair authorization.

## Related Specs

- [Empirical Acceptance Review Gate](../specs/empirical-acceptance-review-gate/SPEC.md)
- [Local Review Necessity And Evidence](../specs/mandatory-local-review-proof/SPEC.md)
- [PR Convergence Batching](../specs/pr-convergence-batching/SPEC.md)
