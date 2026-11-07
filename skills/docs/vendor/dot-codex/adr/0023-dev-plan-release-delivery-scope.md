# ADR 0023: Dev-Plan Release Delivery Scope

## Status

Superseded by [ADR 0024](0024-stop-condition-driven-release-decision.md)

## Context

An explicit development plan can reach a PR-ready stop without saying whether version release work belongs to the plan. The runtime publication route and post-merge release evidence are deliberately derived from live repository facts, so adding a runtime-facing release decision to the plan would recreate the boundary rejected by [ADR 0021](0021-runtime-derived-pre-merge-release-route.md).

## Decision (Historical)

Explicit `$dev-plan` delivery plans declare a separate release arrangement in `Flow Decision`: `release_scope`, `release_reason`, `release_entrypoint`, and `release_followup`. The arrangement is required for `normal`, `fast-track`, `local-merge`, `parallel-pr`, and `initiative`, while `implement-only`, ordinary Plan Mode, and non-`$dev-plan` work remain outside the contract.

The arrangement has three scopes. `included` carries affirmative, unconditional release work, release evidence, and a release-capable stop in the same plan. Modal or conditional release wording does not satisfy `included`. `deferred` names the post-stop repository-native entrypoint, prerequisites, and pending version or channel decision. `not-applicable` records the checked absence of a release mechanism or the reason release is not required and uses `none` as its entrypoint. `normal` and `local-merge` remain in the arrangement contract but cannot use `included`, because their legal stops do not authorize a release terminal state. The fields describe intended handoff only; they do not authorize publishing, merge, tagging, label mutation, deployment, or any other runtime operation.

Historical JSONL without the new fields remains valid. A historical explicit `$dev-plan` plan that starts declaring one of the new fields is validated as a complete arrangement, preventing partial migrations without rewriting old sessions. `release_disposition` remains historical compatibility metadata and cannot satisfy this contract.

## Consequences (Historical)

- New plans make release scope visible before implementation starts.
- The shared workflow can carry the plan arrangement through its legal stop without treating it as release proof.
- Repositories without a release mechanism can state that fact explicitly, while repositories with a later release can hand off from a deferred stop.
- ADR 0021 remains the authority for runtime pre-merge route derivation and actual post-merge release facts.
