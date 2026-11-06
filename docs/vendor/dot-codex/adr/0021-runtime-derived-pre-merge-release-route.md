# ADR 0021: Runtime-Derived Pre-Merge Release Route

## Status

Accepted

## Context

The generic delivery flow introduced `release_disposition` as a required plan field so PR publication could avoid guessing release labels. In practice, the generic workflow did not own the target repository's release vocabulary, and repositories without a release surface had no value to provide. A plan could therefore carry `unknown` through implementation and validation, then stop at the first PR mutation even when the safe result was simply to leave release labels alone.

The target repository or an adopted project-local policy may still define a managed release-label contract. That contract must remain authoritative, but its absence is a normal repository state rather than an owner decision.

## Decision

Remove `release_disposition` from the direct plan contract. PR publication derives an internal `pre_merge_release_route` immediately from current repository and PR facts:

1. An explicit, valid repository contract or adopted project-local Policy Skill may return a managed route and its owned release-label groups.
2. An absent, unsupported, or non-applicable contract returns `no-managed-route`, with an empty managed-label set. Publication continues without release-label mutation.
3. The generic workflow never invents release labels and never asks the owner to classify an absent route. A conflicting or malformed explicit policy is reported as a policy diagnostic; it does not become an owner-supplied `unknown` value or a generic PR publication blocker.

The route evidence is runtime state, not a plan decision. Post-merge release tracking remains independent and is still the only source of `release_expected`, version, tag, and actual publication evidence.

## Consequences

- Repositories with no release surface proceed through PR publication silently.
- Release-label reconciliation remains possible only when the target repository explicitly owns and exposes the label group.
- The plan no longer stores a stale or opaque copy of live repository policy.
- Release policy parsing is localized to publication-time route resolution; historical plan text may retain the old field as compatibility metadata, but it has no gating authority.

## Related Specs

- [Dev plan goals-first](../specs/dev-plan-goals-first/SPEC.md)
- [Fast-track merge intent closeout](../specs/fast-track-merge-intent-closeout/SPEC.md)
