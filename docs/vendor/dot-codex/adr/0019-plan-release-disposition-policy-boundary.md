# ADR 0019: Plan Release Disposition Policy Boundary

## Status

Superseded by [ADR 0021](0021-runtime-derived-pre-merge-release-route.md)

## Context

Direct delivery plans previously reached PR publication without an owner-visible pre-merge release route. Post-merge release tracking already has a separate merge-SHA-bound contract, but nothing required the plan or publication procedure to surface the target repository's release decision before labels or PR state were changed.

The target repository may have its own release contract or an already-adopted project-local Policy Skill. Those owners define their version, label, channel, tag, and workflow vocabulary. dot-codex must remain compatible with them without installing, copying, or interpreting the Policy implementation.

## Decision

Every direct `normal`, `fast-track`, and `local-merge` plan has exactly one non-empty `release_disposition` in `Flow Decision`. The value is preserved as opaque repository-native text. The literal `unknown` is permitted as a plan value but blocks the first remote PR/label mutation and `Step 5C Ready` until the owner supplies a route fact.

Before PR publication, the workflow re-resolves the current route from the target repository's checked-in contract and any already-adopted project-local Policy Skill. A determined route may reconcile only release-label groups that the target repository declares as managed, preserving unrelated labels. dot- codex defines no release enum and does not copy Policy grammar or Policy-owned version-impact states.

`release_disposition` is not a version decision, release authorization, release receipt, `release_expected`, or publication proof. After a remote merge, the existing Step 6 release contract remains authoritative and requires merge-SHA-bound actual artifact evidence.

## Consequences

- Plans expose the missing decision before remote delivery begins.
- Repeated or recovered publication re-checks current repository facts instead of trusting a stale plan route.
- Repositories without a Policy keep their native route; repositories with a Policy keep ownership of its durable evidence and grammar.
- Unknown routes fail closed before remote mutation, while post-merge release tracking remains unchanged.

## Supersession

This decision made the plan carry a route that the generic workflow could not reliably derive. ADR 0021 removes that owner-facing field and makes the pre-merge route a runtime-derived publication fact.

## Related Specs

- [Dev plan goals-first](../specs/dev-plan-goals-first/SPEC.md)
- [Fast-track merge intent closeout](../specs/fast-track-merge-intent-closeout/SPEC.md)
