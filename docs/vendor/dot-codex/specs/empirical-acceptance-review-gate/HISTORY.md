# Empirical Acceptance Review Gate History

> This document records topic-local lifecycle and compatibility facts. The current decision is in `docs/adr/0033-empirical-acceptance-and-repair-autonomy.md`; ADR 0020 is historical.

## Lifecycle / Compatibility

- Exact Candidate binding remains required; result placement follows the workflow invariant so a successful observation does not create another SHA. The optional receipt contract carries no universal placement policy.
- This active topic defines a shared direct-flow contract. It supplements, and does not replace, current validation, CI, visual evidence, or local review proof requirements.
- HIL and other external-system checks are instances of the same proofability boundary; no hardware-specific compatibility mode is introduced.

## Replacements / Background

- The topic closes the gap between generic Review Readiness wording and empirical acceptance that can be invalidated by a review repair.
- Direct review remains independent of receipt-led review orchestration.

## Related Changes

- [ADR 0020](../../adr/0020-empirical-acceptance-review-gate.md)
- Direct plan, review readiness, continuation, and replay contracts now consume the Candidate-bound evidence card; external-system execution remains owned by the calling project.
- Evidence hardening now rejects same-Candidate regressions, sentinel or blank locators, and decorated scenario/expected placeholders before diagnosis-only classification.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
