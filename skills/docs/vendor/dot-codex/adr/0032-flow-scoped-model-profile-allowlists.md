# ADR 0032: Flow-Scoped Model Profile Allowlists

- Status: Accepted; Direct Review portion superseded by [0038 Direct Review Terra Profile](0038-direct-review-terra-profile.md)
- Date: 2026-10-26
- Related: `docs/specs/workflow-agent-model-selection/SPEC.md`

## Context

The runtime can support more model/effort pairs than a particular workflow should select autonomously. Treating the runtime capability table as the flow policy would make Code Review and Wave Thread drift together, while a strict pre-check would prevent the owner from deliberately requesting a different pair and let the flow hide the runtime's actual error.

The retired review-orchestration ladder in `bin/flow_receipt.py` is outside this decision and remains unchanged; this policy does not restore or reclassify that historical boundary.

## Decision

Keep separate, exact profile allowlists for Code Review and Wave Thread. Code Review lanes choose independently from this ordered six-profile allowlist (the direct-review portion is superseded by ADR 0038):

1. `gpt-6-luna + high`
2. `gpt-6-luna + max`
3. `gpt-5.6-luna + xhigh`
4. `gpt-5.6-luna + max`
5. `gpt-6.1-terra + xhigh`
6. `gpt-6.1-sol + medium`

### Wave Thread task profiles

Wave Thread tasks choose and lock one of this ordered three-profile allowlist:

1. `gpt-6-luna + max`
2. `gpt-5.6-luna + xhigh`
3. `gpt-5.6-luna + max`

The native task pair is `model` + `thinking`, where `thinking` is the native reasoning-effort field. Without a direct owner instruction, autonomous selection is limited to the corresponding allowlist. A complete owner instruction containing both `model` and `thinking` may bypass that allowlist; the flow passes the exact pair to the runtime without a capability pre-check, and the runtime remains responsible for accepting or rejecting it. An invocation-wide override covers all tasks in that invocation unless the owner names a narrower task. Model-only or thinking-only instructions are not complete overrides. The flow does not silently replace a failed selection, and future runtime capabilities do not enter either allowlist automatically.

## Consequences

The same runtime may expose profiles that neither flow selects by default. Code Review evidence can use lane-specific profiles, while Wave Thread recovery preserves task identity and its selected profile. Allowlist changes are explicit policy changes rather than incidental runtime discovery.
