---
name: project-engineering-workflow
description: "Single source of truth for software delivery flow."
---

# Project engineering workflow

This is the deep shared module for the direct stages of `normal`, `fast-track`, and `local-merge`. Flow entry skills provide authorization and stop conditions; this skill owns shared stages. `multi-task-flow` is also an active top-level route, but it enters this module only for a task-local direct PR. The 主 Agent（main Agent） owns the task graph, ledger, parent PR, and delivery-unit closeout.

## Interface

Inputs:

- `flow_type=normal|fast-track|local-merge` for a single worker's direct flow
- `flow_type=multi-task-flow` for parent coordination; its task-local direct PRs use the normal direct stages above
- `stop_condition`
- verified repository, branch, PR, and task facts

Outputs:

- current stage
- the first unfinished applicable gate
- terminal, blocked, or flow-defined handoff state

Never infer one flow's authorization from another. Top-level multi-task coordination owns its own task facts; this shared module owns only the direct PR stages and gates for an individual task. Internal review/CI sidecar runs remain read-only.

## Shared contracts

Read a reference only when entering its phase:

- live task ownership: `references/active-long-task-short-contract.md`
- empirical acceptance: `references/empirical-acceptance-short-contract.md`
- PR diagnosis: `references/pr-diagnosis-short-contract.md`
- CI tracking: `references/ci-tracking-short-contract.md`
- tiered local review proof: `references/review-proof-short-contract.md`
- optional advisory review: `references/advisory-review-short-contract.md`
- validation receipts: `references/execution-receipt-short-contract.md`
- pre-merge release decision: `references/release-planning-short-contract.md`
- post-merge release: `references/release-tracking-short-contract.md`
- PR publication operation: `references/pr-publication-procedure.md`
- PR merge operation: `references/pr-merge-procedure.md`

The release decision reference describes runtime behavior at the Step 5C boundary. It does not add a plan schema: ordinary workflow execution reads the target repository policy and current PR facts, returns the Agent default card, and keeps post-merge release facts owned by their existing contract.

The references own delivery criteria and return cards. `${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/bin/flow_receipt.ts --repo <candidate>` is validation/lifecycle audit infrastructure; it does not schedule, validate, or gate code review. Callers must not restate the references.

The shared workflow owns formal review directly through the shared review-proof contract. There is no separate review-loop Skill in the delivery path.

## Invariants

- `main-agent` is the sole file writer in a direct flow (`main-agent` 是唯一修复者). Sidecars inspect CI, review, Spec, or Solution state; the Release Tracker's only permitted mutation is the explicitly authorized safe rerun defined by its shared contract.
- Work proceeds in order. A blocker asks one decision-changing question; milestones alone are not approval gates.
- Every accepted slice follows implement -> relevant validation -> conventional signed-off commit.
- Current live facts outrank prior prose. Evidence retains its bound identity; target movement during a review round follows PR diagnosis §3.
- Evidence placement: freeze tracked source, tests, contracts, and docs before final validation. Keep current-SHA results in active flow evidence or SHA-bound external artifacts; result collection leaves the candidate unchanged and starts no review wave. Prepare repository-required tracked records before freeze, naming the implementation/run described. Real repairs invalidate affected evidence; required CI passes on the live PR head.
- CI gate semantics are owned by `references/ci-tracking-short-contract.md`: keep `policy_state`, `checks_expected`, `ci_evidence`, and `gate_effect` separate. A confirmed `policy_state=none` may produce `CI_NOT_EXPECTED`; a provider policy observation error remains typed evidence and does not by itself become a required-check blocker or a no-check success. The live PR reducer decides the gate after freshness/conflict precedence.
- Remote mutation, destructive work, and scope expansion remain inside the caller's authorization.
- Before the first PR publication mutation, derive the runtime `pre_merge_release_route` from current repository and PR facts. An explicit valid repository contract or adopted project-local Policy Skill may expose managed release-label groups. An absent, unsupported, or non-applicable contract resolves to `no-managed-route` with an empty managed-label set; publication continues and the generic flow does not ask the owner to classify the route.
- Pre-merge route evidence is routing input only. It does not establish `release_expected`, a version, a release tag, or publication. Step 6 keeps its merge-SHA-bound release contract as the sole source of actual release facts.
- Acceptance is phase-aware: `pre_merge` consumes only Candidate/PR-head evidence; `post_merge` requires a real Merge Receipt and its `merge_sha`; and `post_deploy` additionally requires a structured `deployment_identity` whose source and bound SHA match that merge SHA. Review Readiness, PR convergence, and Step 5C consume only `pre_merge` items.
- At Step 5C for `merge-ready`, `merge-only`, and `merge+cleanup`, return a decision card covering publish applicability, components, channel, bump rule, predicted version, target identity, and policy source. `merge-ready` may stop after displaying the card; `merge-only` and `merge+cleanup` require explicit owner confirmation including the version expectation before merge continuation. One clear natural-language owner message may provide that confirmation and the continuation request together; callers must not require a fixed reply format or a second action turn. Missing or conflicting policy/facts are `unknown`/blocked; `no-managed-route` is not a no-release decision.
- A direct flow records an Agent-chosen Tier 1..4 necessity assessment and concise rationale in its current review evidence before PR convergence or terminal local-merge completion. There is no automatic task-category rubric. Tier 1 has no review gate; Tier 2 permits optional advisory review; Tier 3 and Tier 4 require clear evidence produced by read-only sub-agents.
- `merge-ready / Step 5C Ready` is a pre-merge stop, never Flow Complete. `merge-only` enters post-merge processing only after owner confirmation and an actual Merge Receipt. Missing publish facts or deployment identity is an owner-action blocker; it is not inferred as `not_required`.
- Direct review's exact six-profile allowlist, lane-local selection, complete-pair owner override scope, runtime-owned errors, and refresh rules belong to `references/review-proof-short-contract.md`; consult it at Review Readiness.
- A formal review wave must reach terminal structured results for every required lane before the main Agent writes the candidate. The main Agent then applies the finding disposition in `review-proof-short-contract.md`: only an eligible current-PR `In-Scope Review Finding` that meets the priority-aware repair threshold enters one root-cause Repair Batch; a low-priority finding may be recorded as `repair_not_required_low_priority` and accompany a clear review without blocking delivery. An authorized late deferral follows that contract's Late PR resolution and Authorized follow-up delivery rules. A `Design-Returning Review Finding` stops ordinary convergence, and a `Review Observation` is report-only. Intermediate local commits do not create review work, and only the batch's final candidate is reviewed again. If the affected lane set cannot be proven from the Git delta, refresh every required lane.
- The initial Formal Review Wave permits an optional P2-only repair. From the second wave onward, a low-priority P2 may enter a Repair Batch only with an eligible P0/P1 finding or a qualifying current-Candidate CI failure; P3 and lower findings remain non-blocking. A qualifying CI failure is attributable to in-scope code, tests, or configuration. CI infrastructure failure, flakiness, cancellation, timeout, missing results, and other unavailable evidence remain CI/evidence blockers and do not authorize opportunistic repair. The main Agent reports accepted low-priority findings at the next owner-facing stop. Safety boundaries, required acceptance, and `Design-Returning` findings retain their own hard gates regardless of priority.
- Formal review has a Review Readiness gate before any lane launch: approved behavior, acceptance, scope and required contracts are settled, no design decision is unresolved, and current-candidate validation plus applicable visual evidence are complete. Tier and profile recommendations in a plan are runtime guidance, not a reviewer schedule. The initial Tier 3/4 coverage is created fresh for the ready Candidate; later Repair Batches refresh only provably affected lanes; the review-proof contract owns conservative full refresh and review-base adoption.
- When a direct plan declares `empirical_acceptance=required`, the current Candidate must carry a passed, SHA/contract/scenario-bound evidence card from `references/empirical-acceptance-short-contract.md` before local readiness, formal review, Step 5C, or Step 5L. A missing, stale, failed, or unavailable card blocks the gate without creating a Repair Batch.

## Applicability gates

Determine applicability from current evidence; absent relevance means the gate is omitted, not serialized as `unchecked`:

- Spec: applicable when an existing Spec owns the changed behavior or the work introduces/changes a durable contract. New Specs are slug-only and include all three companion files.
- ADR: applicable only to a hard-to-reverse, non-obvious architecture or boundary decision with a real tradeoff. An existing accepted decision is linked, a new decision is created, and a semantic decision change creates a successor ADR that supersedes the old one. Editorial corrections may update the existing ADR.
- Solution: applicable when focused lookup finds related reusable knowledge or the work produces a reusable cross-task lesson.
- Project Docs: applicable when project structure, usage, maintenance, or other human-facing current truth changes.
- Visual evidence: applicable only when the candidate changes an owner-visible UI, display, or rendered artifact.
- Release: applicable only after a remote direct or parent PR merge when repository and live facts identify a release surface.

When applicable, invoke the owning Skill and require its positive evidence before advancing. Do not copy its procedure here.

## Stages

### Step 1: execution context

1. Resolve a concrete development base and delivery target: explicit owner ref, unique open-PR base, explicit integration upstream, otherwise repository mainline. A starting SHA alone does not fix the target.
2. Establish a non-default topic branch through `$git-branch`; a detached/default-branch clean worktree is preparation, not a blocker.
3. Inspect dirty state. Preserve unrelated user changes; ambiguity that would move or commit them is a blocker.
4. Inspect target divergence through `$git-sync ACTION=check`; perform alignment only for an explicit requirement or demonstrated integration need under PR diagnosis §3 and current authorization. Result: `Step 1 Ready`.

### Step 2: durable contracts

1. Set `spec_disposition=link|update|create|supersede|not_needed` from the applicability rule.
2. When applicable, create/update the canonical Spec before implementation; use `$docs-migrate` when only legacy planning material exists.
3. Set `adr_disposition=link|create|supersede|not_needed`, `adr_refs=<repo-relative path>@<Git blob SHA>|none`, and `adr_resolution=ready|blocked`.
4. A qualified but unresolved ADR decision is `adr_resolution=blocked` and must be resolved through `$grill-with-docs` before implementation. ADR and Spec have no automatic precedence: a conflict stays blocked until the affected active Spec is explicitly updated.
5. Perform focused Solution lookup only when task terms or changed paths match actual solution/legacy knowledge content.

Result: `Step 2 Ready` with every applicable contract executable and `adr_resolution=ready`. The ADR fields are flow facts only; do not add them to `flow_receipt.ts`.

### Step 3: delivery slices

For each atomic slice:

1. implement only approved scope;
2. run covering validation; establish a small behavioral pass before expanding stateful/concurrent work, following the review-readiness contract;
3. sync an applicable Spec immediately when its contract changed, otherwise at candidate time;
4. revalidate the frozen ADR path/blob membership at the candidate state with `ADR_REFS="$adr_refs" bash skills/spec-sync/scripts/spec_drift_check.sh ...`; drift returns the flow to Step 2;
5. commit a complete, reversible slice with English conventional message and `--signoff`.

Before leaving Step 3, settle applicable Solution and Project Docs work. For owner-visible Web components in repositories that already use Storybook, `$storybook-stories` owns the stable component states. Full-page flows prefer a qualified `ui_demo` when available.

Result: `Step 3 Ready`.

### Step 4: local candidate

1. Resolve canonical `BASE_REF`, `BASE_REMOTE`, and PR-capable `BASE_REPO` from live facts; local-merge may omit `BASE_REPO`.
2. Synchronize verified same-topic upstream changes when needed; inspect the canonical base through `$git-sync ACTION=check` and apply PR diagnosis §3 before choosing alignment. If HEAD changes, rerun affected validation and applicable Spec checks.
3. If visual evidence applies and local rendering/testing is possible, complete the relevant local test and run `$ui-visual-evidence`. A `视觉比较=一致` result completes this gate without an owner reply. A `视觉比较=需确认` result must show the current comparison and receive a clear natural-language confirmation before PR publication or reuse. That confirmation only accepts the shown screenshots; it does not authorize delivery. The resulting Task Evidence Set is a Step 4B handoff for the current task; if it is missing on resume, rerun Step 4B instead of inferring paths from a Spec/Plan.
4. If visual evidence applies but no local render/test source is feasible, record the blocker and use the PR publication procedure with `mode=draft-bootstrap` only under existing or explicit delivery authorization to create or reuse a feedback Draft. The Draft must not bind the receipt, start convergence, formal review, required-CI tracking, or merge. Once remote feedback images exist, `$ui-visual-evidence` compares them before normal continuation.
5. A changed rendered surface or render input returns the work to the visual comparison loop. A metadata-only evidence-persistence commit can proceed without a new owner response only after a current comparison establishes that the inner UI is unchanged.
6. Freeze the candidate under the evidence-placement invariant; resolve ambiguous uncommitted files before final validation.
7. Before PR convergence or Step 5L completion, confirm Review Readiness and record the Agent's tier and rationale. For a PR path, `Step 4 Ready` records readiness, current validation, applicable visual evidence, and any required high-risk `pre-PR local proof`; it does not require completed PR-stage structured findings or dispositions. After the exact live PR base/head is bound, the PR path creates its fresh formal evidence; local-merge still completes formal review before Step 5L. Tier 1/2 require only the assessment; optional advisory review does not create a formal proof record. Do not invent a categorical rubric. This is direct task evidence, not a `flow_receipt.ts` record. If empirical acceptance applies, carry its current evidence card and contract digest into the same Candidate evidence before reporting Step 4 Ready. A changed Candidate invalidates the card and returns to validation.

Result: `Step 4 Ready`, meaning local `can-open-PR`; it does not imply an open or merge-ready PR.

### Step 5L: local merge variant

Only `local-merge` enters this branch. Complete the current local base/head assessment and tiered evidence under `references/review-proof-short-contract.md`, then stop at `Step 5L Ready` for owner approval. After approval, refresh base/head and merge locally with `MODE=merge`; do not rebase/reset/force-push implicitly. Cleanup runs only for explicit `merge+cleanup` through `$git-cleanup MODE=local-merge`.

### Step 5: PR variant

`normal` enters only after continuation; `fast-track` enters automatically. Before the publication procedure pushes, creates, updates, or labels a PR, it must silently derive the current pre-merge release route. A missing or non-applicable route becomes `no-managed-route` and performs no release-label mutation; an explicit route may reconcile only release-label groups owned by the target repository, preserving unrelated labels. Use `references/pr-publication-procedure.md` to create/reuse and converge one PR only after every applicable visual comparison is complete and the current task's Step 4B Task Evidence Set handoff is present. Missing handoff is a blocker that requires rerunning Step 4B; never infer it from Spec/Plan history. Unchanged evidence needs no reply, while changed or unavailable comparisons need the owner's clear screenshot confirmation. A live PR must exist before using `merge-ready` or `Step 5C Ready`. `merge-ready` stops at `Step 5C Ready` after the current decision card is displayed; `merge-only` and `merge+cleanup` continue through `references/pr-merge-procedure.md` only after explicit owner confirmation. The confirmation may be one clear natural-language message that also requests continuation; do not prescribe a response template or ask for a separate action message. Apply `references/pr-diagnosis-short-contract.md` §3 before convergence launch. After the exact live PR base/head is bound, start the CI tracker and fresh PR-stage formal review in the same first round and wait for both to reach terminal state before finding disposition, any Repair Batch, or main-agent write, commit, or push. Handle accumulated target movement at that boundary under PR diagnosis §3. Step 5C requires the current CI classification from `references/ci-tracking-short-contract.md` (a proven `CI_GREEN` or `CI_NOT_EXPECTED`, or a live reducer result that keeps a provider observation explicitly unresolved without treating it as a project blocker), applicable validation, visible repository rules, and tiered evidence under `references/review-proof-short-contract.md`. Empirical regressions enter diagnosis-only handling under `references/empirical-acceptance-short-contract.md`; optional advisory review follows its shared contract.

Draft bootstrap is optional for multi-slice or slow-CI work after one complete tested slice. For UI work it is additionally the only fallback when no local evidence source exists; that Draft remains feedback-only until its remote feedback has completed the same visual comparison gate. It freezes approved Goals, not unfinished implementation, and returns to Step 3.

### Step 6: post-merge

When the source PR carries an authorized late-review handoff, finish its selected merge-scope obligations first, then run the review-proof contract's Authorized follow-up delivery through an independent `$fast-flow` to Step 5C Ready. Keep the source and follow-up identities, budgets and merge approvals distinct; an unmerged source retains its pending handoff at the existing owner gate.

Only merged direct or parent PRs enter. Once live PR facts confirm the merge and actual merge SHA (the Merge Receipt), start merge-SHA target CI tracking and independently evaluate release applicability and begin any authorized preparation that does not depend on CI terminal success. Follow the target repository's gates before dispatch; do not delay either track for unrelated merge-scope cleanup. The ledger's terminal post-merge receipt is recorded later, after CI and release finality; it is not the launch prerequisite. `release_expected` exists only as this post-merge fact. Expected releases must reach actual publication or a reported failed/incomplete state; CI or release-intent snapshots and pre-merge route evidence are not publication proof. Child PRs return their merge facts to their owning coordinator; the parent PR remains the final owner-facing surface.

For a task that owns an Agent VM, invoke `$agent-vm`'s Finish policy after merge to decide whether VM work remains and verify closure when it does not. Release may precede remote-only CI/release waits; continue those waits under their existing contracts. Keep the VM when post-merge work still needs it.

## Recovery and output

- `$flow-continue` restores the locked flow, ownership promise, latest anchor, then live facts, and resumes the first unfinished applicable gate.
- Owner-facing output starts with the outcome and next action. Machine fields appear only for blockers, non-terminal recovery, or explicit audit.
- A live long task remains owned until terminal, actionable blocker, owner decision, or its contract's exhausted wait budget.
- When the task owns an Agent VM, use `$agent-vm`'s Retain and renew policy at phase/readiness handoffs and its Finish policy at actual task completion or cancellation, including work without a PR. These policies govern the current session only; a flow stop or intermediate reply does not itself establish task completion. Report the retention purpose/deadline or observed closure outcome through that Skill.

## Entry map

- `normal`: `$normal-flow`
- `fast-track`: `$fast-flow`
- `local-merge`: `$local-merge-flow`
- resume: `$flow-continue`
- PR convergence: `references/pr-publication-procedure.md`
- PR merge: `references/pr-merge-procedure.md`
