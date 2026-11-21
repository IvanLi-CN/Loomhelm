# Tiered Direct Review Evidence

Direct delivery starts with an Agent-owned Tier 1..4 review necessity assessment. The assessment is kept with the task or PR convergence summary and states the rationale, current base SHA, and current head SHA. There is no automatic task-category rubric and no `flow_receipt.ts` command.

## Execution order

### 1. Confirm readiness

Formal review has a readiness gate: approved behavior, acceptance, scope, and required contracts are settled; no design decision remains unresolved; current Candidate validation and applicable visual evidence are complete. Stateful/concurrent changes require executed behavioral validation of the changed critical boundaries; a check-only build or blocked run is insufficient. Missing facts return to design or the evidence gate. A plan recommends strategy and profile; it does not schedule reviewers.

When the direct plan declares `empirical_acceptance=required`, Review Readiness also requires the passed current Candidate evidence card from `empirical-acceptance-short-contract.md`. Missing, stale, failed, or unavailable empirical evidence is an evidence-gate blocker, not an In-Scope finding. An empirical failure after a comparable pass is diagnosis-only and does not open another Repair Batch or formal review wave. This readiness rule consumes only `pre_merge` evidence. `post_merge` and `post_deploy` acceptance belong to the post-merge closeout contract and must bind a Merge Receipt/`merge_sha`, with a structured `deployment_identity` whose source and bound SHA match the merge required for the deployment phase. They cannot block pre-merge convergence and cannot be reported as complete before their phase is reached.

### 2. Launch the required lanes

- Tier 1: no code review is required.
- Tier 2: advisory review is optional and never a delivery gate.
- Tier 3: one comprehensive read-only reviewer is required.
- Tier 4: one comprehensive read-only reviewer plus one or two risk-selected specialist reviewers is required. Specialist lanes are `ui-accessibility`, `security`, `database-migration`, and `release-infra`; record each selected lane's concrete risk and scope.

The `comprehensive` lane reviews the complete base-to-head Candidate diff and relevant surrounding contracts and call paths. Its coverage checklist is `contract`, `state-concurrency`, `failure-data-safety`, and `test-platform`; report coverage or a reason for non-applicability for every dimension. These dimensions are not separate reviewers or independent review evidence. Missing coverage remains `unchecked`. A specialist supplements comprehensive coverage rather than replacing it. If the comprehensive reviewer cannot cover a material boundary, the main Agent resolves the coverage gap and selects Tier 4 when specialist review is needed before clear.

Formal lanes are created at runtime after readiness for the current Candidate. For a direct PR, formal lanes launch after exact live PR head/base binding in the same first round as the CI tracker. For local-merge, formal lanes complete before Step 5L. Every new formal review round launches a fresh, isolated reviewer for every launched lane, including specialists: it starts without any previous round's context, findings, or session, and terminal reviewers are retired and never resumed or reused. `references/reviewer-lane.md` owns the lane prompt, the canonical result schema and the launch rule. Supply the approved scope, contracts, exact repo/base/head, validation evidence, and coverage checklist explicitly. Repair rounds also receive the Scope Envelope and Repair Manifest and independently inspect the complete current base-to-head diff, including interactions and newly introduced regressions; checking only the previous findings or repair delta is insufficient. Prior approval is not current proof.

Continue waiting on an unfinished matching round instead of spawning a duplicate. A completed review for an unchanged Candidate and review base remains reusable within its valid active run; a new round requires a new review need, not merely another continuation invocation.

### 3. Wait for the complete round

The main Agent waits for all required lanes and CI to reach terminal state before disposition, writing, a Repair Batch, commit, or push. Wait on every outstanding lane, because a return may report only some terminal results. Keep those results and wait on the remaining handles until the entire round is terminal. A first result is not completion of the round.

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

#### Scope Envelope and Repair Write Gate

Before the first formal review wave, the main Agent records a `Scope Envelope` bound to the approved behavior and Candidate. It contains the approved outcomes, acceptance clauses, allowed path prefixes, explicitly allowed contract or documentation updates, excluded areas, and Candidate base/head. The envelope is a review input and a write gate; a plan sentence, reviewer suggestion, historical defect, or newly discovered dependency cannot expand it implicitly.

Every terminal finding must name the envelope item, affected path or invariant, and the exact acceptance evidence it violates. A finding without that mapping cannot authorize a write. Before any Repair Batch write, the main Agent emits an immutable `Repair Manifest` containing only mapped findings, allowed files, invariant, regression check, and expected final behavior. A repair may touch an unlisted file only when it is an explicitly declared generated or mechanically required companion. Any other new file, contract change, test expansion, refactor, cleanup, or behavior change is `Scope-Returning` and stops convergence for owner or design resolution.

The post-repair review compares the Candidate against both the original Scope Envelope and the batch Repair Manifest. Passing tests or a reviewer request cannot retroactively make an out-of-envelope change in scope. If the diff cannot prove that a changed path is covered by the envelope, refresh is insufficient: stop, revert the out-of-envelope change, or return to design with a new approved envelope.

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

The parent flow counts each batch before its first repair write; CI-only behavior repairs share the same count. A low-priority P2-only initial-wave repair consumes the same batch count when the main Agent elects to write it. A low-priority result accepted without a write consumes no batch and launches no new review. Preserve cumulative `repair_batches_used` across SHA changes, publication, rebases, continuation, and compaction; child invocations inherit this count. Baseline-only updates and result collection neither consume a behavior-repair batch nor reset it. After the first Repair Batch, the active Scope Envelope and Repair Manifest remain binding; a second batch must prove that the same approved invariant still fails and may not be opened solely because adjacent work was discovered. #### Review round budget

The Repair Batch count above bounds writing. It does not bound review, because a wave can end without any repair: a changed base, a changed Candidate, a retired legacy ledger, an owner reopen, or a malformed round all discard a wave without consuming a batch. Counting batches alone therefore lets a run review forever while making no progress.

`review_rounds` is the separate cumulative count of waves that did not clear the Candidate. It lives in `review.cumulative`, not in an epoch, so opening a new epoch cannot reset it. Every non-clearing wave increments it exactly once, whatever caused the round to end; there is no exemption for infrastructure-unavailable lanes, base drift, Candidate change, or owner reopen.

After three non-clearing rounds, the flow stops and requires explicit owner authorization. The authorization is bound to an owner message the same way a convergence reopen is: an `owner:<ref>` reference, a sha256 of the reason text, and a user message id that is consumed once. A bare assertion of approval is not authorization, because the party being bounded must not author its own approval. One authorization unlocks exactly one additional round; it is spent by that round or dropped when the round clears, and never carries over. Reaching the cap is a blocker, not `unchecked` evidence: report the accumulated rounds, the changed paths, and the remaining findings, then wait for the owner. A clearing round consumes nothing, and a low-priority result accepted without a write still counts its round because the review effort was spent.

Near three batches or when a root cause recurs, stop automatic same-PR writing and return a `convergence-drag blocker` with the accumulated manifests, changed paths, and remaining findings. Continuing requires a newly approved envelope or an explicitly authorized follow-up PR; it is never an automatic fourth-or-later same-PR repair. Verification follows every repair. Design-returning and Scope-Returning findings stop ordinary repair under the disposition above.

### 6. Validate and refresh the final candidate

Validate the root-cause repairs before reviewing the batch's final candidate.

Every changed Candidate refreshes the comprehensive lane with a new sub-agent reviewing the complete current diff. Refresh affected specialist lanes when the Git delta proves their scope; retain unaffected specialist results only within the active run while source base/head, structured result, and relevant delta remain inspectable. Reassess specialist selection when risk changes. Unknown scope, security, schema, transaction, protocol, concurrency, persistence, migration, or shared review-contract changes refresh every required lane. Base drift observed during a round follows PR diagnosis §3; actually adopting a different review base refreshes every required lane and replaces active `base_sha` before new evidence. Missing new-base evidence is `unchecked`; automatic cross-base proof reuse is unavailable.

Once current evidence is clear, Step 5C or Step 5L continues with factual base/head, CI, validation, repository rules, and clean-candidate checks; it does not add another AI review.

#### Authorized follow-up delivery

The main Agent finishes the source PR's selected flow first. A source at Step 5C still needs owner merge approval; retain its handoff instead of creating a stacked PR or merging it automatically. After source merge and applicable merge-scope facts are established, recheck the authorized item list against the latest target mainline containing the actual source merge SHA, then start one independent topic branch and `$fast-flow` delivery for that list. Reuse an already matching follow-up PR on continuation. Link the source and follow-up PRs in both directions; reach follow-up `merge-ready / Step 5C Ready` with its own validation, CI, tiered review evidence, and release decision card. Its merge remains owner-controlled.

Only existing authorization for that follow-up scope and external delivery permits publication; read-only review creates no such authorization. Retain the source identity and cumulative count, while the independent follow-up owns its own Candidate, evidence, and count. This handoff authorizes one follow-up delivery, not an automatic recursive PR chain or expansion beyond its item list. Missing authorization, unresolved source merge, or new design needs remain explicit handoffs under their existing owner gates.

## Lane result and profile

Each formal lane is a read-only review in the current candidate worktree, launched through the runtime's own sub-agent facility as described in `references/reviewer-lane.md`. The parent flow owns the lane's `requested_profile`, candidate repo/base/head/scope binding, and non-empty attempt ID, and passes the profile pair to that launch. The structured result carries findings and summary only; the receipt binds it to the candidate, lane, and reviewed scope and does not contain a provider identity claim. Completed receipts record `profile_verification=request_recorded` and `effective_profile=null`; a startup-unavailable attempt records only the parent request and startup observation and cannot satisfy the lane. Child IDs, transcripts, runtime events, and provider metadata are neither required nor accepted as evidence.

### Autonomous direct-review profiles

Choose one complete requested pair per reviewer based on the review scope. The recommended profiles for autonomous direct review are:

- `gpt-5.6-luna + medium` for routine review of a small, clear diff.
- `gpt-5.6-luna + xhigh` for rigorous review, including review policy changes and complex repairs.
- `gpt-6.1-sol + low` when the review needs stronger cross-file reasoning with a low effort budget.

Each repository may apply a more specific request policy. Record the reason when choosing a profile for a specialist or escalating beyond routine review. An explicit complete owner override applies as described below. These recommendations are request policy, not provider capability or effective-profile evidence. A runtime rejection remains unavailable; never silently substitute a pair.

Every formal lane records its parent-owned requested profile independently. The `comprehensive` lane and any selected specialist lane do not inherit a profile from another lane, and the invocation's lane count does not turn the selection into a global profile. Plan text provides guidance but never fixes reviewer identity; the runtime records the requested pair and leaves the effective pair unknown. Historical coordinator v2 inputs that reach Step 5C use this same Tier 3/4 Review Readiness and fresh-lane launch contract. Their task dispatch locks remain a separate compatibility policy and do not select or name formal review lanes.

An invocation-wide owner override applies to every formal lane in that invocation unless the owner names a narrower lane. A lane-named override applies only to that lane. An override is complete only when it contains both `model` and `effort`; a model-only or effort-only instruction is not an override. Where the selected repository policy permits an override, explicit owner authorization is required; the flow passes that exact pair to the runtime and records the request without pre-checking whether it is executable. Runtime acceptance or rejection is authoritative and is reported as is; the flow MUST NOT silently replace a failed pair. Overrides do not change the recommendations and are not inherited by another flow, task, or invocation.

拓扑与 reviewer 生命周期的决策依据见 [ADR 0043](../../../docs/adr/0043-comprehensive-reviewer-lifecycle.md)。旧 review-wave ledger adapter 的四 lane topology 仅为历史兼容，按 retirement inventory 保留，不约束当前直接交付。
