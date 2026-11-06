# Local Review Necessity And Evidence

## Related ADRs

- [0003 External Fact Delivery Gates](../../adr/0003-external-fact-delivery-gates.md)
- [0014 Direct Review Evidence](../../adr/0014-direct-review-evidence.md)
- [0016 Bind Review Repairs to Approved Scope](../../adr/0016-bind-review-repairs-to-approved-scope.md)
- [0017 Review Readiness And Runtime Launch](../../adr/0017-review-readiness-and-runtime-launch.md)
- [0032 Flow-Scoped Model Profile Allowlists](../../adr/0032-flow-scoped-model-profile-allowlists.md)
- [0038 Direct Review Terra Profile](../../adr/0038-direct-review-terra-profile.md)
- [0033 Empirical Acceptance and Repair Autonomy](../../adr/0033-empirical-acceptance-and-repair-autonomy.md)
- [0034 Priority-Aware Review Repair Eligibility](../../adr/0034-priority-aware-review-repair-eligibility.md)

## Context and Scope

This topic covers direct `normal`, `fast-track`, and `local-merge` delivery, PR create/merge handoffs, and continuation. Historical multi-conversation coordination remains a separate compatibility state machine. The flow receipt TypeScript adapter remains the validation/lifecycle helper, but is outside the review execution and delivery decision path. There is no separate review-loop Skill in this workflow; formal convergence is owned by the shared review-proof contract and its flow consumers.

Formal review has a Review Readiness gate: approved behavior and acceptance, scope, and required contracts must be stable; no design decision may remain unresolved; and the current Candidate must complete applicable validation and visual evidence before any formal lane launches at runtime. A plan records a Tier, rationale, runtime strategy, and profile recommendation, never a reviewer schedule or model identity. For a direct PR, `Step 4 Ready` records readiness and applicable pre-PR proof without completed PR-stage findings or dispositions; after exact live PR head/base binding, the CI tracker and PR-stage formal review start in the first round and the main Agent waits for both terminal states before convergence. Local-merge formal review still completes before Step 5L.

## Requirements

### REQ-DIRECT-REVIEW-EVIDENCE

Every direct delivery MUST record an Agent-owned Tier 1..4 assessment, rationale, and current base/head. Tier 1 has no review gate. Tier 2 permits advisory review. Tier 3 requires fresh clear evidence from contract, state-concurrency, failure-data-safety, and test-platform lanes. Tier 4 adds one or two selected dynamic lanes from ui-accessibility, security, database-migration, and release-infra.

For the PR path, `Step 4 Ready` MUST NOT require completed PR-stage findings or dispositions. After exact live PR head/base binding, required-CI tracking and fresh PR-stage formal lanes MUST start in the first round, and the main Agent MUST wait for both CI and all required lanes to reach terminal state before finding disposition, writing, commit, or a Repair Batch. The local-merge path MUST complete formal review before Step 5L.

Each required lane is a read-only sub-agent review in the candidate worktree. Its structured result binds the candidate `repo_root`, current base/head, reviewed scope, actual model and effort, and findings. A lane is terminal only when those fields and an explicit clear evidence status are present and bound to the current candidate; missing fields or non-clear status remain `unchecked`, and the reviewed scope must equal the lane's declared paths or invariants with no unknown schema fields. It does not depend on child IDs, transcripts, or a receipt ledger. Missing, malformed, stale, or unavailable evidence blocks Tier 3/4 delivery and remains `unchecked`. A complete terminal result with `evidence_status=clear` may contain a blocking finding; that finding is classified under the disposition rules below rather than being converted into an evidence-state failure.

Initial review runs every required lane for a ready Candidate. A repair refreshes lanes whose declared paths or invariants changed; retained results require inspectable source base/head and Git delta within the active run. Unknown scope, security, schema, transaction, protocol, concurrency, persistence, migration, or shared review-contract changes refresh every required lane. Ordinary target movement preserves the bound round under `../pr-freshness-gate/SPEC.md`; actually adopting a new review base refreshes all required lanes and binds that new SHA, with missing evidence remaining `unchecked`. Automatic cross-base reuse is unavailable. The parent groups root causes, validates repairs, and preserves the cumulative Repair Batch count for diagnosis and continuation; child lanes only report findings. The parent autonomously repairs proven in-scope findings within the selected flow's authorization, including after three batches. Near three batches or on a recurring root cause, it diagnoses scope, baseline, implementation and tests before continuing. No receipt-held permit, freeze, or retry state is used.

### REQ-DIRECT-REVIEW-DISPOSITION

Stateful/concurrent readiness MUST include executed behavioral validation of changed critical boundaries; check-only or blocked runs are insufficient. Evidence placement follows the shared workflow; cumulative repair accounting follows the review-proof contract and `../pr-convergence-batching/SPEC.md`.

The main Agent classifies every demonstrated finding from a terminal review result against the approved behavior, acceptance, and non-negotiable safety boundaries:

- `In-Scope Review Finding` enters the current Repair Batch only when its repair preserves the settled design and implementation scope, the terminal structured result contains a demonstrated finding, and the priority-aware repair threshold below is satisfied; only valuable, proven, in-scope items qualify, and late-PR resolution may explicitly hand an eligible item to follow-up;
- `Design-Returning Review Finding` stops ordinary repair and convergence and returns the task for a new design decision before any changed Candidate is reviewed;
- `Review Observation` is reported without creating a repair obligation or a new formal review wave.

Any other disposition token is malformed evidence and must fail closed before repair or clear classification. Missing readiness evidence is also not approval: formal launch requires an explicit successful readiness fact, and a missing fact blocks launch.

A formal review is clear when every required lane has valid terminal evidence, validation and applicable CI are clear, and there is no unresolved Design-Returning finding or `repair_required` resolution. A demonstrated P2/P3 or lower finding with `repair_not_required_low_priority` may accompany clear evidence and is reported at the next owner-facing stop. A suggestion without a demonstrated in-scope violation is a Review Observation. Missing, stale, malformed, or unavailable reviewer output remains `unchecked` evidence and is never fixed as a finding or treated as clear.

### REQ-DIRECT-REVIEW-REPAIR-THRESHOLD

The main Agent MUST classify priority after confirming that a finding is valuable, proven, in-scope, and not Design-Returning. `P0` and `P1` are high-priority; `P2`, `P3`, and lower values are low-priority. Unknown or missing priority remains unresolved and cannot be silently treated as low-priority.

The first Formal Review Wave for the current flow is the initial ready-Candidate wave before any Repair Batch has been counted. In that wave, an eligible P2-only finding MAY receive `repair_resolution=repair_required`; P3 and lower findings do not create a repair obligation. If the main Agent makes no write, a P2-only result may clear with `repair_resolution=repair_not_required_low_priority`.

From the second Formal Review Wave onward, a low-priority P2 MAY receive `repair_required` only when the terminal round also contains an eligible P0/P1 finding or a qualifying current-Candidate CI failure. A qualifying CI failure is attributable to in-scope code, tests, or configuration and is repairable under the selected flow. Infrastructure failure, flakiness, cancellation, timeout, missing results, or other unavailable CI evidence does not authorize an opportunistic P2 repair. P3 and lower findings remain non-blocking.

When a P0/P1 or qualifying CI trigger opens a Repair Batch, an eligible P2 may be included only when it shares the approved scope or affected invariant of that batch. An unrelated P2 receives `repair_not_required_low_priority`. A P3 change that is unavoidable collateral of an approved repair is recorded as collateral, not as a separate repair target.

The main Agent MUST record `repair_resolution` separately from the reviewer's three canonical dispositions. Allowed values are `repair_required`, `repair_not_required_low_priority`, and `deferred_follow_up`. The low-priority resolution is not a fourth reviewer disposition and does not turn a demonstrated finding into `Review Observation`. Design-Returning findings, safety boundaries, required acceptance, and other non-negotiable gates remain blockers regardless of priority.

### REQ-DIRECT-REVIEW-LATE-RESOLUTION

PR convergence follows the shared review-proof contract's Late PR resolution when the main Agent considers a concrete deferral after a terminal review/CI round. First preserve the valuable/proven/in-scope eligibility test; ineligible suggestions do not become repair or automatic follow-up work. PR-introduced P0/P1 findings stay prioritized in the current PR; unknown priority or attribution remains unresolved. Batch count alone neither requires deferral nor restricts in-scope repairs.

The main Agent MUST record `resolution=current_pr|deferred_follow_up` and the independent `repair_resolution` separately from the three canonical dispositions and unchanged reviewer schema, with finding reference, priority, PR-introduction evidence, reason and authorized handoff scope/status. An explicit deferred handoff may remove that item's source-review blocker while remaining a real defect awaiting follow-up; it does not waive validation, CI, empirical evidence or non-negotiable safety boundaries. A low-priority finding without a first-wave exception or P0/P1/qualifying-CI trigger may clear with `repair_not_required_low_priority` and no follow-up obligation. Deferral consumes no Repair Batch, resets no source count, and grants no new write authorization. Local-merge and standalone without an authorized PR path do not gain PR delivery behavior.

### REQ-DIRECT-REVIEW-MODEL

Direct review inherits the exact six-profile allowlist and lane-local selection contract from [Workflow Agent Model Selection](../workflow-agent-model-selection/SPEC.md): ordinary review uses profiles 1-3 and defaults to profile 1, complex or rigorous review uses profiles 3-4, and special or high-risk review uses profiles 5-6 with a lane-specific escalation reason. Each formal lane binds its own profile; four-to-six lane count does not replace that policy with a shared profile.

The ordered allowlist is:

1. `gpt-6-luna + high`
2. `gpt-6-luna + max`
3. `gpt-5.6-luna + xhigh`
4. `gpt-5.6-luna + max`
5. `gpt-6.1-terra + xhigh`
6. `gpt-6.1-sol + medium`

Only a complete owner-specified `model + effort` pair is an override. The flow passes that exact pair to runtime without capability prechecking or fallback; runtime support or rejection remains authoritative. Model-only or effort-only text is not an override.

Autonomous delegated launches are limited to `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`, and `gpt-5.6-luna`. A non-autonomous supported model requires the exact standalone first non-empty prompt line `agent-model: <model>`; `agent-model: auto` removes the override. The override is session-scoped until replaced or removed and is not inherited by a fresh task.

A live lane is waited on or relayed, and a terminal agent is retired rather than reused. A changed candidate requires a fresh `fork_turns=none` reviewer; an unaffected structured result may be retained only when its source facts and Git delta remain directly inspectable. Elapsed time alone is not review failure. A demonstrated issue whose remedy needs new behavior, a new contract, or wider scope is classified as `Design-Returning Review Finding` and ordinary repair/review stops until the design is resolved. Exhausting an orchestration wait budget is a non-terminal blocker, not review failure; only an explicit owner stop or terminal provider/runtime failure makes the lane unavailable. An

<!-- review-anchor-contract:mandatory-spec:start -->

owner-stopped lane is not retried by continuation without a new owner instruction or changed candidate, and live-lane uniqueness is scoped to the current flow invocation/thread. A non-terminal wait anchor carries `repo_root`, base SHA, head SHA, lane, scope, review profile, current locked flow, ownership promise, and cumulative Repair Batch count so continuation can only wait or relay that lane after verifying the matching Candidate; missing context requires owner input rather than a guessed relaunch. A continuation without the matching `repo_root`/base/head and count cannot relaunch or reset review work.

<!-- review-anchor-contract:mandatory-spec:end -->

## Verification

### VER-DIRECT-REVIEW-EVIDENCE covers: REQ-DIRECT-REVIEW-EVIDENCE, REQ-DIRECT-REVIEW-MODEL

- Tier 3/4 summaries bind the current base/head, lanes, scope, actual profile, and structured findings;
- changed scope reruns only affected lanes; high-risk, unknown, or adoption of a different review base reruns all required lanes, while ordinary target advancement waits for the round boundary;
- retained lanes are available only while their directly inspectable source result and Git delta remain in the active convergence run;
- direct-flow contract tests cover base-drift refresh, finding disposition, design-return stops, recovery-anchor fields, and owner-stop continuation behavior;
- the shared review contract and subagent status interface expose the complete recovery-anchor field set;
- PR convergence requires current review evidence together with validation, required CI, and live GitHub facts;
- direct PR evidence starts after exact live PR head/base binding in the first round with CI tracking, while local-merge evidence completes before Step 5L;
- The flow receipt adapter is not called to assess, run, retain, or finalize review.

### VER-DIRECT-REVIEW-DISPOSITION covers: REQ-DIRECT-REVIEW-DISPOSITION, REQ-DIRECT-REVIEW-REPAIR-THRESHOLD

- terminal findings are classified as In-Scope, Design-Returning, or Observation;
- observations remain report-only, low-priority accepted findings are recorded without blocking clear, design-returning findings stop ordinary convergence, and missing evidence remains `unchecked`;
- initial-wave P2-only repair, later P0/P1 or qualifying-CI triggers, unrelated P2 acceptance, P3 collateral handling, and next-stop owner reporting are covered by the priority-aware repair threshold.

### VER-DIRECT-REVIEW-LATE-RESOLUTION covers: REQ-DIRECT-REVIEW-LATE-RESOLUTION

- Replay covers eligibility before priority, autonomous repairs after three batches, diagnosis triggers, current-PR P0/P1, unknown attribution, mixed current/deferred findings, and explicit handoff evidence.
- A deferred-only candidate may clear review with valid terminal lanes; missing evidence, failed validation/CI, design returns and unresolved current-PR findings retain their blockers.
