# Workflow Agent Model Selection

## Related ADRs

- [0003 External Fact Delivery Gates](../../adr/0003-external-fact-delivery-gates.md)
- [0014 Direct Review Evidence](../../adr/0014-direct-review-evidence.md)
- [0017 Review Readiness And Runtime Launch](../../adr/0017-review-readiness-and-runtime-launch.md)
- [0034 Priority-Aware Review Repair Eligibility](../../adr/0034-priority-aware-review-repair-eligibility.md)
- [0038 Direct Review Terra Profile](../../adr/0038-direct-review-terra-profile.md)

## Context and Scope

Workflow launch settings remain explicit while direct review evidence stays independent from task identity, child provenance, transcript shape, and receipt ledgers. Trackers retain their separate external-fact responsibility.

Runtime formal review requires Review Readiness: approved behavior and acceptance, scope, and required contracts are stable; no design decision is unresolved; and the current Candidate has completed applicable validation and visual evidence. Plans recommend a tier-consistent strategy and supported profile set, while each formal reviewer identity is created fresh at runtime.

The retired review-orchestration ladder in the flow receipt adapter is outside this active policy and remains unchanged; this Spec does not restore or reclassify it.

## Requirements

### REQ-DIRECT-REVIEW-MODEL

- `code-review` MUST use exactly this ordered allowlist for autonomous selection:
  1. `gpt-6-luna + high`
  2. `gpt-6-luna + max`
  3. `gpt-5.6-luna + xhigh`
  4. `gpt-5.6-luna + max`
  5. `gpt-6.1-terra + xhigh`
  6. `gpt-6.1-sol + medium`
- Ordinary review MAY use profiles 1-3 and MUST default to profile 1 when no stronger distinction is available. Complex or rigorous review SHOULD use profiles 3-4. Special or high-risk review SHOULD use profiles 5-6 and MUST record a natural-language lane-specific escalation reason; the contract does not require a fixed serialization such as `lane=...; reason=...`.
- The actual supported model/effort pair is recorded in each review result. Autonomous selection uses `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`, or `gpt-5.6-luna`. A current task's explicit `agent-model: <model>` directive remains a session-scoped model-family selection; it is not a complete direct-review owner override. A direct-review exception requires an explicit complete `model + effort` pair. Direct plan guidance names a supported pair without fixing reviewer identity; runtime launch resolves the actual pair on the current host. A higher model or effort records a lane-specific escalation reason.
- The workflow does not impose a concurrency cap. Autonomous direct-review selection remains strictly limited to the six profiles above; only a complete owner `model + effort` override may bypass that flow allowlist. An unavailable reviewer is never treated as clear.
- Autonomous delegated launches are limited to `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`, and `gpt-5.6-luna`. A non-autonomous supported model requires the exact standalone first non-empty prompt line `agent-model: <model>`; `agent-model: auto` removes the override. The override is session-scoped until replaced or removed and is not inherited by a fresh task.

- A live lane is waited on or relayed; a terminal agent is retired and is not reused for formal review. A changed candidate receives a fresh `fork_turns=none` reviewer. Elapsed time alone is not review failure, and an exhausted orchestration wait budget remains a non-terminal blocker until the owner continues or explicitly stops the lane. An owner-stopped lane is not retried by continuation without a new owner instruction or changed candidate; live-lane uniqueness is scoped to the current flow invocation/thread. A
  <!-- review-anchor-contract:workflow-model-spec:start -->
  non-terminal wait anchor carries `repo_root`, base SHA, head SHA, lane, scope, review profile, current locked flow, ownership promise, and cumulative Repair Batch count; missing context requires owner input rather than a guessed relaunch.
  <!-- review-anchor-contract:workflow-model-spec:end -->
- The main Agent classifies every demonstrated finding against the approved behavior, acceptance, and safety boundaries. An `In-Scope Review Finding` follows the shared review-proof contract's current-PR repair or authorized late follow-up resolution; a `Design-Returning Review Finding` stops ordinary repair and returns the task to design, and a `Review Observation` is reported without creating a repair obligation. Missing, stale, malformed, or unavailable review output remains `unchecked` evidence and is never treated as a finding or clear result.

  Any disposition outside those three values is malformed and must fail closed before repair or clear classification. An In-Scope disposition also requires a demonstrated finding in the terminal structured result; missing readiness evidence blocks launch rather than implying approval.

### REQ-FLOW-PROFILE-ALLOWLIST

- The supported runtime capability table and flow profile allowlists MUST remain separate. Direct Review names its reasoning field `effort`; a historical coordinator task envelope names the native reasoning field `thinking`. In a compatibility input that uses generic `model + effort` wording for both flows, the historical coordinator's `effort` value maps to the single native `thinking` field and MUST NOT create a second persisted key or alias. Unless the owner directly specifies a complete pair using the current flow's field, autonomous selection MUST use only the allowlist of the current flow.
- A runtime-supported model or flow-specific reasoning level MUST NOT become available to a flow automatically. A selected pair MUST NOT be silently replaced by another pair after a runtime failure; the runtime error is reported as-is.
- A direct owner specification MAY bypass the current flow allowlist. The flow MUST pass the exact pair to the runtime without pre-checking whether it is executable; runtime support or rejection remains the runtime's decision. For Direct Review, model-only or effort-only is incomplete; for historical coordinator input, model-only or thinking-only is incomplete.
- An invocation-wide owner override applies to all lanes or tasks in that invocation unless the owner names a narrower lane or task. A named override applies only to that target, does not change either allowlist, and is not inherited by another flow or task.
- covers: VER-FLOW-PROFILE-POLICY

### REQ-CODE-REVIEW-PROFILES

- `code-review` MUST allow exactly these ordered profiles for autonomous selection:
  1. `gpt-6-luna + high`
  2. `gpt-6-luna + max`
  3. `gpt-5.6-luna + xhigh`
  4. `gpt-5.6-luna + max`
  5. `gpt-6.1-terra + xhigh`
  6. `gpt-6.1-sol + medium`
- Ordinary review MAY use profiles 1-3 and MUST default to profile 1 when no stronger distinction is available. Complex or rigorous review SHOULD use profiles 3-4. Special or high-risk review SHOULD use profiles 5-6 and MUST record the escalation reason.
- Every formal Code Review lane MUST select its profile independently. Each fixed or selected dynamic lane MAY use the complete six-profile allowlist, and a named owner override applies only to its named lane.
- covers: VER-FLOW-PROFILE-POLICY

### REQ-TRANSPORT-NEUTRAL-EVIDENCE

- A Tier 3/4 lane is a completed read-only sub-agent result bound to its base, head, scope, profile, and complete clear structured findings. Missing or non-clear evidence remains `unchecked` and cannot satisfy the gate; unknown fields and scope mismatches are also invalid. A clear terminal result may contain a blocking finding; that finding is classified by disposition and does not make otherwise valid evidence unavailable.
- Evidence must not require child IDs, PTC parsing, task metadata, transcript shape, or flow-receipt recording. Advisory review cannot replace a required lane.

### REQ-TRACKER-PROFILE

- A tracker binds one external CI or release target and returns its terminal external facts. Auth, quota, provider, timeout, or terminal failure remains explicit `unavailable` and does not cause a parent poller or model retry.
- Release observation recovery follows [Release Tracking](../release-tracking/SPEC.md): same-chat scheduling preserves the explicit profile, original identity, retry record, and deadline rather than switching models.

## Verification

### VER-MODEL-SELECTION covers: REQ-DIRECT-REVIEW-MODEL, REQ-TRANSPORT-NEUTRAL-EVIDENCE, REQ-TRACKER-PROFILE

- direct review output exposes its actual profile and any high-effort reason;
- multiple lanes may run concurrently without a workflow-imposed ceiling;
- required evidence is accepted from the current structured result without a receipt ledger or transcript-derived identity.
- direct-flow profile tests cover recovery-anchor fields and continuation's no-relaunch behavior for owner-stopped or terminally unavailable review.
- Subagent status output exposes base/head, lane, scope, profile, locked flow, and ownership promise for a non-terminal review anchor.

### VER-FLOW-PROFILE-POLICY covers: REQ-FLOW-PROFILE-ALLOWLIST, REQ-CODE-REVIEW-PROFILES

- Contract checks MUST verify the exact flow-specific profile lists, independent Code Review lane selection, task-locked historical coordinator profiles, invocation/target override scope, and the separation between flow allowlists and runtime support.
