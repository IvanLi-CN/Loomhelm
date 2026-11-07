---
name: flow-continue
description: "Resume the current engineering flow from the next unfinished hard gate."
---

# Flow continue

Use for generic continuation or explicit `$flow-continue`. This is a recovery module, not a delivery mode.

## Restore order

1. latest explicit locked `flow_type` (including `$dev-plan` default locks and the `流程类型` line in its owner-facing decision card);
2. an unfinished ownership promise for a live task;
3. latest flow anchor and stop condition;
4. current flow stage;
5. verified repository, PR, CI, advisory-review, Spec, and release facts.

Only ask one question when those sources cannot identify a unique next gate. A newer explicit owner flow switch may replace the lock; changed Skill text or generic wording may not.

Historical multi-conversation coordination state remains read-only compatibility data and is not a current continuation route. An active top-level `flow_type=multi-task-flow` is current state, not historical coordination: resume `$multi-task-flow` from its authoritative ledger, and let a task-local `$fast-flow` resume only that task's direct PR stage. Do not infer a new flow or start a polling or heartbeat loop from legacy state.

## Routing

- Review disposition semantics come from the shared `../project-engineering-workflow/references/review-proof-short-contract.md` contract.
- For a late-PR follow-up handoff, recover the source repository/PR/base/head, cumulative repair count, authorized item list, deferral reasons and any follow-up PR. Finish the source's selected flow and owner merge gate first; after its actual merge, use the shared Authorized follow-up delivery rule to create or reuse one independent `$fast-flow` PR to Step 5C Ready. Keep awaiting-source-merge handoffs explicit; continuation neither resets the source count nor authorizes publication, scope expansion, or a recursive PR chain.
- When the locked flow came from an explicit `$dev-plan`, carry the existing plan sections and stop condition through the next legal handoff. At Step 5C, refresh the target-repository policy, current PR facts, and the runtime release decision card; do not reconstruct retired plan-level arrangement metadata. Refresh `release_expected` only from the post-merge contract. The decision-card boundary is defined by `../project-engineering-workflow/references/release-planning-short-contract.md`.

- <!-- review-anchor-contract:flow-continue:start -->
  live owned task: resume the same wait/relay path under `active-long-task-short-contract.md`; for a review wait anchor, require the same `repo_root`, `base_sha`, `head_sha`, `lane`, `scope`, `review_profile`, current locked flow, ownership promise, and cumulative Repair Batch count plus the empirical acceptance disposition and rationale, evidence status, Candidate SHA, phase-aware evidence identity (including `acceptance_id`, `phase`, `merge_sha`, and deployment identity when applicable), contract digest, scenario digest, and evidence locator before waiting/relaying. Do not launch a second reviewer. If that context is missing, ask the owner instead of guessing a lane identity;
  <!-- review-anchor-contract:flow-continue:end -->
- CI tracker continuation: for a `pr_head_ci` or `post_merge_target_ci` anchor, refresh the repository, branch, bound SHA, and child handle state first. A `pending_init|running` handle is waited on directly; a terminal `passed|failed` card is relayed; a terminal `incomplete|unavailable` or `interrupted|shutdown|not_found` handle is retired and replaced exactly once by a fresh `ci-tracker` with the same bound identity, retry history, and recovery anchor. Never call `resume_agent` on a completed handle or treat its previous card as fresh evidence. The child performs provider polling directly; the main Agent must not substitute a parent poller, watcher, transcript parser, or model retry.
- CI facts continuation uses `../project-engineering-workflow/references/ci-tracking-short-contract.md` as the only state matrix. Preserve `policy_state`, `checks_expected`, `ci_evidence`, and `gate_effect` separately; `unknown|unavailable` policy observation is typed evidence, not a required-check blocker and not proof of no checks. Refresh live PR mergeability first, route `DIRTY|CONFLICTING` to freshness/conflict handling, and never use `workflow_dispatch` to manufacture missing evidence.
- a review continuation must also carry the matching `repo_root`, current Candidate base/head, cumulative Repair Batch count, and ownership promise; without that anchor it is blocked and must not launch a duplicate reviewer or reset the repair count;
- an applicable `pre_merge` empirical acceptance continuation must also carry a matching current passed Candidate evidence card. `post_merge` continuation requires the actual Merge Receipt and matching `merge_sha`. `post_deploy` continuation additionally requires a matching structured `deployment_identity` whose source and bound SHA match the recorded merge. Missing or stale evidence blocks recovery and cannot be inferred as `not_required`.
- Historical coordinator JSONL, migration inputs, and replay fixtures are read-only compatibility data. Do not resume, dispatch, poll, or infer a current flow from those inputs.
- local Step 1-3: the locked `$normal-flow`, `$fast-flow`, or `$local-merge-flow`;
- active top-level `multi-task-flow`: resume `$multi-task-flow` from its ledger; a task-local direct PR resumes through `$fast-flow` without changing parent ownership;
- a direct-flow anchor with `adr_resolution=blocked`: retain its `adr_disposition`, `adr_refs`, and conflict facts, return to Step 2, resolve the decision through `$grill-with-docs`, then explicitly update every affected active Spec before resuming delivery;
- a direct-flow anchor with `adr_resolution=ready`: carry its exact `adr_refs` value, including `none`, through candidate/review routing and require its `ADR_REFS` revalidation by `$spec-sync`; any membership or blob drift returns to Step 2;
- normal/fast-track at Step 4 after a complete visual comparison: the shared workflow PR publication procedure (carry any explicit PR stop condition);
- before resuming direct PR publication, refresh current repository/PR facts and silently re-run pre-merge route resolution. An absent route resolves to `no-managed-route`; it is not an owner question and does not block `Step 5C Ready` or PR publication. Only explicit target-owned label groups may be reconciled;
- normal/fast-track with a displayed `视觉比较=需确认` result: wait for the owner's clear natural-language screenshot confirmation; do not enter PR publication for convergence;
- normal/fast-track after a render-surface/input change: return to the local Step 3/4 comparison loop; a no-local-source UI may use only the publication procedure with `mode=draft-bootstrap` to recreate its feedback state;
- local-merge at Step 4/5L: `$local-merge-flow` unless the owner explicitly switches to a PR path;
- open PR: refresh live facts and apply PR diagnosis §3; route necessary integration to the authorized writable path, ordinary convergence to publication, and final merge checks to the merge procedure;
- open PR with matching candidate: wait/relay an owned live review round first, handling target movement through PR diagnosis §3. After an actual candidate update, continue through publication with applicable validation, CI, and lane refresh under the review-proof contract; advisory findings cannot bypass required evidence. Terminal failure or owner-stop remains a blocker and is not relaunched without a new owner instruction or changed candidate;
- merged direct or parent PR with incomplete remote-head deletion, primary-base alignment, target CI, release, or post-merge flow receipt: the shared workflow PR merge procedure;
- merged direct or parent PR with pending phase-aware acceptance: keep the source merge fact and continue only from the matching `merge_sha`. Missing deployment authority or observation is an owner-action blocker, not a pass.
- when a displayed Step 5C card is followed by one clear natural-language owner message that includes the card's version expectation, treat that message as both confirmation and continuation when it is unambiguous; never convert it into a prescribed reply template or a second action prompt;
- post-merge cleanup: `$git-cleanup` only when `merge+cleanup` was explicitly selected.

## Guardrails

- Generic continuation confirms continuation; it does not waive gates, expand scope, grant remote mutation, approve a parent SHA, or switch to local-merge.
- Generic continuation does not waive recorded Tier 3/4 review evidence or create an unbounded repair loop. A convergence drag blocker remains unresolved until the owner changes scope or authorizes a follow-up PR.
- A `Design-Returning Review Finding` is a convergence blocker: do not continue ordinary repair or relaunch review until the design decision is resolved and the changed candidate has fresh lanes. A `Review Observation` remains report-only; a current-PR `In-Scope Review Finding` continues only through the bounded Repair Batch, while an authorized late deferral preserves its shared-contract follow-up handoff. Missing or stale review output remains an `unchecked` evidence blocker.
- An empirical run that fails after a comparable Candidate passed is an Empirical Regression: compare the two Candidate deltas once and stop in diagnosis-only handling. Generic continuation cannot start a new Repair Batch or formal review wave from that state.
- An owner-stopped review remains an unavailable blocker; continuation must not relaunch it without a new owner instruction or a changed candidate.
- ADR and Spec conflicts have no automatic priority. Continuation must keep them blocked until the active Spec contract is explicitly reconciled with the resolved ADR.
- A local Step 4 state is `可开 PR（local）`, never `Step 5C Ready`.
- A Draft PR still awaiting its remote-feedback comparison is a feedback state, not an open-PR convergence state; it may not be routed to CI/review/merge.
- PR blockers and target movement follow the PR diagnosis contract: conflicts take priority; ordinary `BEHIND` preserves the bound running round.
- Pre-merge route resolution is not a release receipt. Continuation must keep it separate from Step 6 `release_expected` and merge-SHA-bound publication evidence.
- Resume the owned round against its bound candidate under PR diagnosis §3; actual candidate/envelope mismatch is `input_stale`. A live matching tracker is waited on; terminal unavailable/incomplete recovery follows the CI rule above. Advisory review requires an explicit request and terminal formal lanes; required review unavailability remains a blocker.
- Receipt recovery is limited to validation and lifecycle facts. Historical review assessment, review wave, and convergence fields do not authorize or block `bind-pr`, post-merge receipt recovery, or closeout; refresh live PR identity, merge SHA, and finality facts instead.
- Receipt recovery must preserve the acceptance phase boundary: a Candidate-only card remains `pre_merge`, a Merge Receipt is required before `post_merge`, and a structured `deployment_identity` bound to that merge SHA is required before `post_deploy`. `merge-ready` must not be relabeled as `Flow Complete` during recovery.
- Historical coordination state is never a continuation signal; a missing current-flow fact remains a blocker instead of being reconstructed.
- Route and continue execution until the target flow's legal stop, a blocker, or terminal state; do not stop after merely naming the next Skill.

## Output

State the recovered outcome and next gate in natural Chinese. Emit an anchor only for a blocker or genuinely non-terminal handoff; include only facts needed to resume safely.
