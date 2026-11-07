# ADR 0024: Stop-Condition-Driven Release Decision

## Status

Accepted

## Context

Release applicability has two different evidence boundaries. Before merge, the Agent can inspect target-repository policy and current PR facts and show the owner a default decision. After merge, only facts bound to the target repository, target branch, and actual merge SHA can establish the release expectation and artifact identity. Encoding the pre-merge decision as plan arrangement keys caused stale planning metadata to look like runtime release authority.

## Decision

New plans keep the existing `Flow Decision`, `收口条件`, `Assumptions/Defaults`, and `Acceptance & Validation` sections. They do not add release-arrangement fields, release stop-condition values, or a final version string. Historical JSONL and history documents remain readable as historical data.

At Step 5C, the runtime reads target-repository policy and current PR facts and returns an Agent default decision card covering publish applicability, components, channel, bump rule, predicted version, target identity, policy source, and collision policy. Missing or conflicting inputs are unknown/blocked; absence of a pre-merge route is not a no-release decision. Merge continuation requires explicit owner confirmation of the card, including the version expectation. An objection returns to the release decision. One clear natural-language owner message may combine this confirmation with the request to continue or merge. The Agent must not require a prescribed reply string, field order, or separate action turn; it asks one concise clarification only when applicability or version expectation is genuinely ambiguous.

For `merge-only` and `merge+cleanup`, existing plan prose locks the target repository/branch, base-tag source, bump rule, channel, components, collision policy, and merge-SHA binding. It locks the rule and inputs, never the final version string. After merge, the workflow verifies actual version, tag, artifact identity, and merge SHA from `target_repo + target_branch + merge_sha`; `release_expected` is a post-merge fact only. Conflicting or missing facts stay unknown/blocked and never silently mean no release.

## Consequences

- Plans remain stable behavior descriptions rather than a second release decision interface.
- Step 5C has an explicit owner-visible decision and confirmation boundary.
- Merge-only execution cannot silently re-decide locked release inputs after the merge; post-merge verification is bound to the actual merge SHA.
- The prior plan-level arrangement decision is retained only for historical compatibility and audit.

## Supersedes

- [ADR 0023: Dev-Plan Release Delivery Scope](0023-dev-plan-release-delivery-scope.md)
