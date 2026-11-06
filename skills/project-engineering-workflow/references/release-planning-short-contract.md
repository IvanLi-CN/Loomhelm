# Pre-Merge Release Decision Short Contract

This reference defines the runtime decision at Step 5C. It is deliberately not a plan schema and does not add fields, stop-condition values, or a final version to a new `<proposed_plan>`. Existing `Flow Decision`, `Acceptance & Validation`, and `Assumptions/Defaults` sections describe the behavior and the applicable stop; historical sessions may retain retired arrangement metadata for audit only.

## Decision card

For `merge-ready`, `merge-only`, and `merge+cleanup`, read the target repository's native release policy and current PR facts at Step 5C. Return one Agent default decision card containing:

- publish applicability (`yes`, `no`, or `unknown`/blocked);
- release components, channel, bump rule, predicted version, target repository, target branch/PR, policy source, collision policy, required preparation and release trigger;
- the current pre-merge route as routing input only, never as proof that no release applies.

Structured cards use `contract_version=3`, with `required_preparation` and `release_trigger` as nonempty, resolved descriptions for `publish=yes`. Unversioned historical cards remain replayable; unsupported versioned cards are rejected and historical cards cannot infer these newly explicit inputs.

The card is re-evaluated when the current PR or policy facts change. Missing or conflicting policy/facts return `unknown`/blocked. A missing `pre_merge_release_route` is `no-managed-route` for label routing only; it must not silently become a no-release decision.

## Owner gate and locked inputs

The owner must explicitly confirm the displayed card and its version expectation before merge continuation. One clear natural-language owner message is sufficient and may combine card confirmation, the version expectation, and the request to continue or merge. The Agent MUST NOT require a prescribed reply string, field order, or response format, and MUST NOT split a clear confirmation into a second confirmation/action turn. Ordinary prose such as "the card looks good; use version 1.2.4 and merge" is valid when it is unambiguous. A generic continuation without a recoverable version expectation is insufficient; ask one concise natural-language clarification only when the applicability or version expectation is genuinely missing or ambiguous. An objection returns to the release decision and does not authorize merge or publication.

An unambiguous confirmation of a complete `publish=yes` card together with a merge request authorizes its stated preparation and release trigger. It does not authorize independent operations outside the card. Retain this decision across continuation; recheck policy, inputs, and merge identity after merge. If facts drift or authorization is unclear, block the affected action rather than silently treating the release as inapplicable.

For `merge-only` and `merge+cleanup`, the existing plan prose must make the executable inputs/rule reviewable: target repository and branch, base-tag source, bump rule, channel, components, collision policy, and merge-SHA binding. The plan may record a rule and a predicted runtime result, but it must never prefill the final version string or final tag.

## Post-merge boundary

After merge, evaluate `release_expected` only from actual facts bound to `target_repo + target_branch + merge_sha`. Verify the actual version, tag, artifact identity, and merge SHA. Pre-merge cards, route cards, CI snapshots, and release intent do not prove a release. Unknown or conflicting post-merge facts remain unknown/blocked; the workflow never silently assumes no release.
