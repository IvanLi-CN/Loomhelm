# ADR 0038: Direct Review Terra Profile

- Status: Accepted
- Date: 2026-11-02
- Supersedes: Direct Review portion of [0032 Flow-Scoped Model Profile Allowlists](0032-flow-scoped-model-profile-allowlists.md)
- Related: `docs/specs/workflow-agent-model-selection/SPEC.md`

## Context

The direct-review policy needs a higher-effort profile for special and high-risk lanes. The previous fifth and sixth profiles both used `gpt-6.1-sol`, which did not provide the requested model/effort separation for those lanes.

## Decision

Keep the Code Review allowlist ordered and lane-local, changing only its final two profiles:

1. `gpt-6-luna + high`
2. `gpt-6-luna + max`
3. `gpt-5.6-luna + xhigh`
4. `gpt-5.6-luna + max`
5. `gpt-6.1-terra + xhigh`
6. `gpt-6.1-sol + medium`

The runtime direct-review capability table and autonomous model set include `gpt-6.1-terra + xhigh`. Owner-specified complete model/effort overrides keep their existing exact-forwarding behavior.

## Consequences

Special and high-risk review selection now distinguishes the Terra xhigh and Sol medium profiles. The active workflow Specs, runtime policy, tests, and review contract must retain the same ordered list.
