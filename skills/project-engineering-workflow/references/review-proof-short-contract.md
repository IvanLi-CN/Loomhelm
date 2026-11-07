# Tiered Direct Review Evidence

Direct delivery starts with an Agent-owned Tier 1..4 review necessity assessment. The assessment is kept with the task or PR convergence summary and states the rationale, current base SHA, and current head SHA. There is no automatic task-category rubric and no `flow_receipt.ts` command.

## Execution order

### 1. Confirm readiness

Formal review has a readiness gate: approved behavior, acceptance, scope, and required contracts are settled; no design decision remains unresolved; current Candidate validation and applicable visual evidence are complete. Stateful/concurrent changes require executed behavioral validation of the changed critical boundaries; a check-only build or blocked run is insufficient. Missing facts return to design or the evidence gate. A plan recommends strategy and profile; it does not schedule reviewers.

When the direct plan declares `empirical_acceptance=required`, Review Readiness also requires the passed current Candidate evidence card from `empirical-acceptance-short-contract.md`. Missing, stale, failed, or unavailable empirical evidence is an evidence-gate blocker, not an In-Scope finding. An empirical failure after a comparable pass is diagnosis-only and does not open another Repair Batch or formal review wave. This readiness rule consumes only `pre_merge` evidence. `post_merge` and `post_deploy` acceptance belong to the post-merge closeout contract and must bind a Merge Receipt/`merge_sha`, with a structured `deployment_identity` whose source and bound SHA match the merge required for the deployment phase. They cannot block pre-merge convergence and cannot be reported as complete before their phase is reached.

### 2. Launch the required lanes

- Tier 1: no code review is required.
- Tier 2: advisory review is optional and never a delivery gate.
- Tier 3: fresh clear review evidence from the four fixed lanes is required.
- Tier 4: the four fixed lanes plus one or two relevant dynamic lanes are required. Dynamic lanes are `ui-accessibility`, `security`, `database-migration`, and `release-infra`.

Formal lanes are created at runtime after readiness for the current Candidate. For a direct PR, formal lanes launch after exact live PR head/base binding in the same first round as the CI tracker. For local-merge, formal lanes complete before Step 5L. Tier 3's four fixed lanes define the initial complete coverage, and Tier 4 adds one or two selected dynamic lanes. This lane count is not a fixed reviewer count for every later Repair Batch. Every changed Candidate uses a fresh `fork_turns=none` reviewer for each refreshed lane; a terminal reviewer is retired and never reused.

### 3. Wait for the complete round

The main Agent waits for all required lanes and CI to reach terminal state before disposition, writing, a Repair Batch, commit, or push. Pass the outstanding handles to the native batch-wait tool; a return may report only some terminal lanes. Keep those results and wait on the remaining handles until the entire round is terminal. A first result is not completion of the round.

The active-task ownership promise persists across continuation: wait on or relay a live lane for the same Candidate and lane. Missing matching anchors block reviewer launch; a second invocation relays the owned lane instead of duplicating it. Terminal reviewers are retired under the launch rule above.

Tier 3/4 evidence is unavailable when a selected reviewer cannot inspect the current candidate, returns malformed structured findings, or is stale for its declared scope. A complete terminal result with `evidence_status=clear` may report a blocking issue as a demonstrated finding; the main Agent classifies that finding and does not relabel the evidence as `unchecked`. Elapsed time alone is not a review failure; only a terminal provider/runtime failure, owner stop, or missing/invalid terminal result is unavailable.

<!-- review-anchor-contract:canonical:start -->

An exhausted wait budget keeps the lane `running` with a recovery anchor carrying `repo_root`, `base_sha`, `head_sha`, `lane`, `scope`, `review_profile`, `current_locked_flow`, `ownership_promise`, `repair_batches_used`, `empirical_acceptance`, `empirical_acceptance_rationale`, `empirical_evidence_status`, `empirical_candidate_sha`, `acceptance_contract_digest`, `scenario_set_digest`, and `evidence_locator`; it does not launch a duplicate or become unavailable. An owner-stopped lane remains unavailable until a new owner instruction or changed candidate permits a fresh reviewer.

<!-- review-anchor-contract:canonical:end -->

### 4. Classify findings after the complete round

The main Agent classifies every demonstrated finding in a terminal structured result against the approved behavior, acceptance, and non-negotiable safety boundaries. The reviewer reports facts; the main Agent owns this scope disposition and writes it into the current review evidence:

For migration findings, first compare the approved goals, existing contracts, baseline behavior and candidate delta. A demonstrated migration regression may be in scope. A limitation explicitly accepted by the existing contract does not itself require a stronger guarantee; a new guarantee returns to design. When attribution is unclear, investigate before disposition. Baseline behavior does not waive an applicable failed acceptance or non-negotiable safety boundary. Priority, reviewer count, or file ownership alone does not establish scope.

- `In-Scope Review Finding`: a demonstrated violation whose repair preserves the settled design and implementation scope. Only valuable, proven, in-scope items qualify for repair; priority and the current review-wave trigger then determine whether the finding receives a repair obligation or is accepted as a non-blocking low-priority item. Eligible current-PR items enter the single root-cause `Repair Batch`, subject to the repair threshold and late-PR resolution below.
- `Design-Returning Review Finding`: a demonstrated issue whose remedy needs new behavior, a new contract, or wider scope. A change to external-response assumptions, timing, retries, permission/state transitions, or acceptance semantics is Design-Returning unless the settled contract specifies the exact correction. It stops ordinary repair and review convergence; the task returns to design before a changed Candidate is reviewed.
- `Review Observation`: a suggestion that does not demonstrate an in-scope violation. It is reported without a repair obligation or another formal wave.

Any other disposition token is malformed evidence. It is rejected as invalid and cannot enter a Repair Batch, become report-only, or satisfy clear. An `In-Scope Review Finding` also requires at least one demonstrated finding in the terminal structured result; an empty finding list cannot authorize repair.

A formal review is clear when every required lane has valid terminal evidence, validation and applicable CI are clear, and there is no unresolved Design-Returning finding or `repair_required` resolution. An in-scope P2/P3 or lower finding with `repair_not_required_low_priority` may accompany clear evidence and must be reported at the next owner-facing stop. A qualifying CI failure remains a repair trigger or an evidence gate according to the policy below; infrastructure, unavailable, or malformed CI evidence never becomes a repair authorization. Missing, stale, malformed, or unavailable reviewer output is `unchecked` evidence and is never repaired as a finding or treated as clear. This classification applies to every current Candidate without a version-specific mode.

#### Priority-aware repair threshold

After the complete Formal Review Wave, classify findings against approved behavior, acceptance, and non-negotiable safety boundaries before applying this threshold. `P0` and `P1` are high-priority findings; `P2`, `P3`, and lower priorities are low-priority findings. An unknown or missing priority remains unresolved and cannot be silently treated as low priority.

The initial Formal Review Wave is the first ready-Candidate wave before any Repair Batch has been counted for the current flow. In that wave, an eligible P2-only result may receive an optional `repair_required` resolution and enter a single Repair Batch. A P3-only or lower-priority result does not create a repair obligation. If no write is made, the candidate may clear with the low-priority finding recorded for the next owner-facing stop.

From the second Formal Review Wave onward, a low-priority finding enters a Repair Batch only when the current terminal round also contains an eligible P0 or P1 finding, or a qualifying terminal CI failure. A qualifying CI failure is one on the current Candidate that is attributable to in-scope code, tests, or configuration and whose repair is authorized by the selected flow. CI infrastructure failure, flakiness, cancellation, timeout, missing results, or other unavailable evidence remains a CI/evidence blocker and does not authorize an opportunistic P2 repair.

When a P0/P1 or qualifying CI trigger opens a Repair Batch, an eligible P2 may be repaired in that same root-cause batch when it shares the approved scope or the batch's affected invariant. An unrelated P2 remains `repair_not_required_low_priority`. P3 and lower findings remain non-blocking and report-only; a P3 change that is unavoidable collateral of an approved repair is recorded as collateral, not as a separate repair target.

The main Agent records `repair_resolution` separately from the reviewer's canonical disposition: `repair_required`, `repair_not_required_low_priority`, or `deferred_follow_up`. The first two are current-Candidate decisions; `deferred_follow_up` retains the existing late-PR handoff contract. A low-priority resolution is not a fourth reviewer disposition and never changes a demonstrated finding into `Review Observation`. `Design-Returning Review Finding`, safety boundaries, required acceptance, and other non-negotiable gates remain blockers regardless of P-level.

#### Late PR resolution

For PR convergence, apply this policy when considering a concrete deferral after the final Candidate has completed validation and the entire review/CI round is terminal. Batch count alone does not require deferral. Review executions do not count as Repair Batches. Local-merge and standalone calls without an authorized PR delivery path retain their existing behavior.

First establish repair eligibility: valuable, proven, and in-scope. Speculation, preference-only changes without demonstrated value, and unrelated historical defects do not enter either a Repair Batch or an automatic follow-up. Apply the priority-aware repair threshold before considering a current-PR repair: low-priority findings that do not have the initial-wave exception or a P0/P1/qualifying-CI trigger receive `repair_not_required_low_priority`. Design-Returning remains a design return; Observations remain report-only; unavailable evidence remains `unchecked`.

For each eligible In-Scope finding considered for deferral, the main Agent records `resolution=current_pr|deferred_follow_up` and the independent `repair_resolution` in its current evidence, with a finding reference, priority, evidence of whether this PR directly introduced it, and the reason and handoff status. This is main-Agent disposition evidence, not a fourth canonical disposition or a reviewer schema extension. Demonstrated PR-introduced P0/P1 items stay prioritized for current-PR repair and are not automatically deferred. Unknown priority or attribution stays unresolved until assessed, rather than being silently downgraded. A low-priority item without the initial-wave exception or a P0/P1/qualifying-CI trigger may clear with `repair_not_required_low_priority`; an eligible item with a trigger remains `repair_required` unless an authorized concrete deferral is recorded.

A deferred item remains a real defect. It ceases to block the source review only with a concrete, authorized follow-up scope and a recorded deferral reason; before source merge, its handoff is explicitly awaiting that merge, not an already completed fix or PR. Keep the item list, source repository/PR/base/head, source repair count, authorization, and any existing follow-up PR in the current evidence and PR summary so continuation can recover the same work. Do not add a tracked queue, issue, or ledger. Deferral alone changes no Candidate, consumes no Repair Batch, and launches no reviewer. It never waives required CI, current validation, empirical acceptance, or non-negotiable safety boundaries; an applicable failed gate remains unresolved.

### 5. Group the batch and count before writing

A `Formal Review Wave` (one review round) starts with a bound base/head and ends with terminal structured results from every required lane and terminal applicable CI. It contains read-only review lanes and CI tracking, not finding disposition or repair. The parent flow then applies the priority-aware repair threshold and groups demonstrated in-scope findings and qualifying CI code/test/configuration failures by root cause into one `Repair Batch`, recording affected invariants, regression checks, and publication boundary in its active anchor. Intermediate commits do not launch reviewers; only the final candidate starts another round. Target movement follows PR diagnosis §3.

The parent flow counts each batch before its first repair write; CI-only behavior repairs share the same count. A low-priority P2-only initial-wave repair consumes the same batch count when the main Agent elects to write it. A low-priority result accepted without a write consumes no batch and launches no new review. Preserve cumulative `repair_batches_used` across SHA changes, publication, rebases, continuation, and compaction; child invocations inherit this count. Baseline-only updates and result collection neither consume a behavior-repair batch nor reset it. Near three batches or when a root cause recurs, diagnose the approved scope, baseline, implementation and tests before the next repair; simplify or revert the task's own unnecessary complexity where justified. The parent autonomously continues eligible in-scope repairs under the selected flow, including the fourth and later batches. Count alone neither stops writing nor requires owner authorization. Verification follows every repair. Design-returning findings stop ordinary repair under the disposition above.

### 6. Validate and refresh the final candidate

Validate the root-cause repairs before reviewing the batch's final candidate.

After complete initial coverage, refresh affected lanes when the Git delta proves their scope. Retain unaffected results only within the active run while source base/head, structured result, and relevant delta remain inspectable; refreshed results bind the current head. Unknown scope, security, schema, transaction, protocol, concurrency, persistence, migration, or shared review-contract changes refresh every required lane. Base drift observed during a round follows PR diagnosis §3; actually adopting a different review base refreshes every required lane and replaces active `base_sha` before new evidence. Missing new-base evidence is `unchecked`; automatic cross-base proof reuse is unavailable.

Once current evidence is clear, Step 5C or Step 5L continues with factual base/head, CI, validation, repository rules, and clean-candidate checks; it does not add another AI review.

#### Authorized follow-up delivery

The main Agent finishes the source PR's selected flow first. A source at Step 5C still needs owner merge approval; retain its handoff instead of creating a stacked PR or merging it automatically. After source merge and applicable merge-scope facts are established, recheck the authorized item list against the latest target mainline containing the actual source merge SHA, then start one independent topic branch and `$fast-flow` delivery for that list. Reuse an already matching follow-up PR on continuation. Link the source and follow-up PRs in both directions; reach follow-up `merge-ready / Step 5C Ready` with its own validation, CI, tiered review evidence, and release decision card. Its merge remains owner-controlled.

Only existing authorization for that follow-up scope and external delivery permits publication; read-only review creates no such authorization. Retain the source identity and cumulative count, while the independent follow-up owns its own Candidate, evidence, and count. This handoff authorizes one follow-up delivery, not an automatic recursive PR chain or expansion beyond its item list. Missing authorization, unresolved source merge, or new design needs remain explicit handoffs under their existing owner gates.

## Lane result and profile

Each formal lane is a read-only sub-agent review in the current candidate worktree. Its structured result names the candidate `repo_root`, lane, base SHA, head SHA, an actual host-supported model/effort pair, reviewed paths or invariants, and findings. Child IDs, transcripts, runtime events, and provider metadata are neither required nor accepted as evidence.

### Autonomous direct-review profiles

The `code-review` flow has exactly this ordered allowlist for autonomous selection:

1. `gpt-6-luna + high`
2. `gpt-6-luna + max`
3. `gpt-5.6-luna + xhigh`
4. `gpt-5.6-luna + max`
5. `gpt-6.1-terra + xhigh`
6. `gpt-6.1-sol + medium`

Ordinary review may use profiles 1-3 and defaults to profile 1 when no stronger distinction is available. Complex or rigorous review should use profiles 3-4. Special or high-risk review should use profiles 5-6 and MUST record the lane-specific reason for escalation. The reason may be natural language, but it must identify the affected lane and the escalation rationale; natural-language or non-English lane aliases are valid when they identify the affected boundary; no fixed `lane=...; reason=...` serialization is required. These are flow policy profiles, not a runtime capability table; a runtime-supported pair does not enter this allowlist automatically. There is no concurrency limit imposed by this workflow. Autonomous direct-review selection remains strictly limited to the six profiles above; only a complete owner `model + effort` override may bypass that flow allowlist. The former four to six concurrent lanes heuristic, including its `gpt-5.6-luna + medium` recommendation, is retired and does not select a profile.

Every formal lane selects its profile independently. The fixed `contract`, `state-concurrency`, `failure-data-safety`, and `test-platform` lanes and any selected dynamic lane do not inherit a profile from another lane, and the invocation's lane count does not turn the selection into a global profile. Plan text provides guidance but never fixes reviewer identity; runtime launch records the actual pair used for each lane. Historical coordinator v2 inputs that reach Step 5C use this same Tier 3/4 Review Readiness and fresh-lane launch contract. Their task dispatch locks remain a separate compatibility policy and do not select or name formal review lanes.

An invocation-wide owner override applies to every formal lane in that invocation unless the owner names a narrower lane. A lane-named override applies only to that lane. An override is complete only when it contains both `model` and `effort`; a model-only or effort-only instruction is not an override. A complete owner-specified pair may bypass this flow allowlist, and the flow MUST pass that exact pair to the runtime without pre-checking whether it is executable. Runtime acceptance or rejection is authoritative and is reported as is; the flow MUST NOT silently replace a failed pair. Overrides do not change the allowlist and are not inherited by another flow, task, or invocation.
