---
name: project-engineering-workflow
description: "Single source of truth for software delivery flow."
---

# Project engineering workflow

Deep shared module for the direct stages of `normal`, `fast-track`, and `local-merge`. Flow entry skills provide authorization and stop conditions; this skill owns shared stages. `multi-task-flow` is also an active top-level route, but enters this module only for a task-local direct PR; the 主 Agent（main Agent） owns that task graph, ledger, parent PR, and delivery-unit closeout.

## Interface

Inputs: `flow_type=normal|fast-track|local-merge` for a single worker's direct flow, or `flow_type=multi-task-flow` for parent coordination whose task-local direct PRs use the same direct stages; plus `stop_condition` and verified repository, branch, PR, and task facts.

Outputs: current stage, the first unfinished applicable gate, and the terminal, blocked, or flow-defined handoff state.

Never infer one flow's authorization from another. Top-level multi-task coordination owns its own task facts; this module owns only the direct PR stages and gates for an individual task. Internal review/CI sidecar runs stay read-only.

## Shared contracts

Read a reference only when entering its phase:

- live task ownership: `references/active-long-task-short-contract.md`
- delivery invariants in detail: `references/delivery-invariants.md`
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

The references own delivery criteria and return cards. `${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/bin/flow_receipt.ts --repo <candidate>` is validation/lifecycle audit infrastructure; it does not schedule, validate, or gate code review. Callers must not restate the references. Formal review runs directly under the review-proof contract; there is no separate review-loop Skill in the delivery path.

## Invariants

Each rule below is owned in full by `references/delivery-invariants.md`:

- `main-agent` is the sole writer; sidecars and sub-agents stay read-only.
- Work proceeds in order. A blocker asks one decision-changing question; milestones alone are not approval gates. Every accepted slice follows implement -> relevant validation -> conventional signed-off commit.
- Current live facts outrank prior prose; evidence retains its bound identity, and target movement during a review round follows PR diagnosis §3. Required CI passes on the live PR head (`live-head-ci`).
- Evidence placement: freeze tracked source, tests, contracts, and docs before validation; keep current-SHA results in active flow evidence or SHA-bound external artifacts, and result collection leaves the candidate unchanged (`candidate-freeze`, `result-placement`, `result-only`). Release route, the Step 5C decision card, and phase-aware acceptance follow the reference.
- A direct flow records an Agent-chosen Tier 1..4 necessity assessment and rationale before PR convergence or terminal local-merge completion; there is no automatic task-category rubric. Findings are classified as `In-Scope Review Finding`, `Design-Returning Review Finding`, or `Review Observation`; an empirical failure after a comparable pass is diagnosis-only.
- Review Readiness requires approved behavior, acceptance, scope and required contracts settled, validation and applicable visual evidence complete, and no design decision unresolved. Readiness, the Repair Batch threshold, Scope Envelope and Repair Manifest gating, and empirical acceptance follow `references/review-proof-short-contract.md` and the reference above.
- Remote mutation, destructive work, and scope expansion remain inside the caller's authorization.

## Applicability gates

Determine applicability from current evidence; absent relevance means the gate is omitted, not serialized as `unchecked`:

- Spec: applicable when an existing Spec owns the changed behavior or the work introduces or changes a durable contract. New Specs are slug-only and include all three companion files.
- ADR: applicable only to a hard-to-reverse, non-obvious architecture or boundary decision with a real tradeoff. Link an existing accepted decision, create a new one, or create a successor ADR that supersedes the old one on a semantic decision change. Editorial corrections may update the existing ADR.
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
4. Inspect target divergence through `$git-sync ACTION=check`; align only for an explicit requirement or demonstrated integration need under PR diagnosis §3 and current authorization.

Result: `Step 1 Ready`.

### Step 2: durable contracts

1. Set `spec_disposition=link|update|create|supersede|not_needed` from the applicability rule.
2. When applicable, create or update the canonical Spec before implementation; use `$docs-migrate` when only legacy planning material exists.
3. Set `adr_disposition=link|create|supersede|not_needed`, `adr_refs=<repo-relative path>@<Git blob SHA>|none`, and `adr_resolution=ready|blocked`.
4. A qualified but unresolved ADR decision is `adr_resolution=blocked` and must be resolved through `$grill-with-docs` before implementation. ADR and Spec have no automatic precedence: a conflict stays blocked until the affected active Spec is explicitly updated.
5. Perform focused Solution lookup only when task terms or changed paths match actual solution or legacy knowledge content.

Result: `Step 2 Ready` with every applicable contract executable and `adr_resolution=ready`. The ADR fields are flow facts only; do not add them to `flow_receipt.ts`.

### Step 3: delivery slices

For each atomic slice:

1. implement only approved scope;
2. run covering validation; establish a small behavioral pass before expanding stateful or concurrent work, following the review-readiness contract;
3. sync an applicable Spec immediately when its contract changed, otherwise at candidate time;
4. revalidate the frozen ADR path/blob membership at the candidate state with `ADR_REFS="$adr_refs" bash skills/topic-spec/scripts/spec_drift_check.sh ...`; drift returns the flow to Step 2;
5. commit a complete, reversible slice with an English conventional message and `--signoff`.

Before leaving Step 3, settle applicable Solution and Project Docs work. For owner-visible Web components in repositories that already use Storybook, `$storybook-stories` owns the stable component states. Full-page flows prefer a qualified `ui_demo` when available.

Result: `Step 3 Ready`.

### Step 4: local candidate

1. Resolve canonical `BASE_REF`, `BASE_REMOTE`, and PR-capable `BASE_REPO` from live facts; local-merge may omit `BASE_REPO`.
2. Synchronize verified same-topic upstream changes when needed; inspect the canonical base through `$git-sync ACTION=check` and apply PR diagnosis §3 before choosing alignment. If HEAD changes, rerun affected validation and applicable Spec checks.
3. When visual evidence applies and local rendering or testing is possible, complete the relevant local test and run `$ui-visual-evidence`. `视觉比较=一致` completes this gate without an owner reply; `视觉比较=需确认` must show the current comparison and receive a clear natural-language confirmation before PR publication or reuse. That confirmation only accepts the shown screenshots and does not authorize delivery. The resulting Task Evidence Set is a Step 4B handoff for the current task; if it is missing on resume, rerun Step 4B instead of inferring paths from a Spec or Plan.
4. If visual evidence applies but no local render or test source is feasible, record the blocker and use the PR publication procedure with `mode=draft-bootstrap` only under existing or explicit delivery authorization. That Draft must not bind the receipt, start convergence, formal review, required-CI tracking, or merge; once remote feedback images exist, `$ui-visual-evidence` compares them before normal continuation.
5. A changed rendered surface or render input returns the work to the visual comparison loop. A metadata-only evidence-persistence commit can proceed without a new owner response only after a current comparison establishes the inner UI is unchanged.
6. Freeze the candidate under the evidence-placement invariant; resolve ambiguous uncommitted files before final validation.
7. Confirm Review Readiness and record the Agent's tier and rationale. For a PR path, `Step 4 Ready` records readiness, current validation, applicable visual evidence, and any required high-risk `pre-PR local proof`; it does not require completed pr-stage structured findings or dispositions. After the exact live PR base/head is bound, the PR path creates fresh formal evidence; local-merge still completes formal review before Step 5L. Tier 1/2 need only the assessment; optional advisory review creates no formal proof record. Carry any applicable empirical acceptance card and contract digest into the same Candidate evidence.

Result: `Step 4 Ready`, meaning local `can-open-PR`; it does not imply an open or merge-ready PR.

For a PR path, formal lanes launch after the exact live PR base/head is bound, and the ci tracker and fresh pr-stage formal review in the same first round. Then wait for both to reach terminal state before finding disposition, any Repair Batch, or main-agent write, commit, or push. `Step 4 Ready` does not require completed pr-stage structured findings or dispositions. Local-merge still completes formal review before Step 5L.

### Step 5L: local merge variant

Only `local-merge` enters here. Complete the current local base/head assessment and tiered evidence under `references/review-proof-short-contract.md`, then stop at `Step 5L Ready` for owner approval. After approval, refresh base/head and merge locally with `MODE=merge`; never rebase, reset, or force-push implicitly. Cleanup runs only for explicit `merge+cleanup` through `$git-cleanup MODE=local-merge`.

### Step 5: PR variant

`normal` enters only after continuation; `fast-track` enters automatically. `references/pr-publication-procedure.md` owns creation, reuse, and convergence; run it only after every applicable visual comparison is complete and the Task Evidence Set handoff is present. Missing handoff is a blocker that requires rerunning Step 4B; never infer it from Spec or Plan history.

Before the publication procedure pushes, creates, updates, or labels a PR, derive the pre-merge release route per `references/release-planning-short-contract.md` and the target repository policy. Only an explicit target-owned route may reconcile release labels; an absent route is `no-managed-route` and mutates nothing.

Draft bootstrap is optional for multi-slice or slow-CI work after one complete tested slice, and is the only fallback when no local evidence source exists. That Draft stays feedback-only until its remote feedback completes the same visual comparison gate. It freezes approved Goals, not unfinished implementation, and returns to Step 3.

### Step 6: post-merge

Only merged direct or parent PRs enter. When the source PR carries an authorized late-review handoff, finish its selected merge-scope obligations first, then run the review-proof contract's Authorized follow-up delivery through an independent `$fast-flow` to Step 5C Ready; keep source and follow-up identities, budgets, and merge approvals distinct.

Once live PR facts confirm the merge and actual merge SHA (the Merge Receipt), start merge-SHA target CI tracking and independently evaluate release applicability, beginning any authorized preparation that does not depend on CI terminal success. Follow target repository gates before dispatch and do not delay either track for unrelated merge-scope cleanup.

`references/pr-merge-procedure.md` then owns the merge operation, the safe primary-base alignment plan, and its structured result; a successful remote `pr-merge` alone is not a terminal workflow state. The ledger's terminal post-merge receipt is recorded after CI and release finality and is not the launch prerequisite.

For a task that owns an Agent VM, invoke `$agent-vm`'s Finish policy after merge to decide whether VM work remains and verify closure when it does not. Release may precede remote-only CI or release waits; keep the VM when post-merge work still needs it.

## Recovery and output

- `$flow-continue` restores the locked flow, ownership promise, latest anchor, then live facts, and resumes the first unfinished applicable gate.
- Owner-facing output starts with the outcome and next action. Machine fields appear only for blockers, non-terminal recovery, or explicit audit.
- A live long task remains owned until terminal, actionable blocker, owner decision, or its contract's exhausted wait budget.
- When the task owns an Agent VM, apply its Retain and renew policy at phase or readiness handoffs and its Finish policy at actual task completion or cancellation, including work without a PR. A flow stop or intermediate reply does not establish task completion.

## Entry map

- `normal`: `$normal-flow`
- `fast-track`: `$fast-flow`
- `local-merge`: `$local-merge-flow`
- resume: `$flow-continue`
- PR convergence: `references/pr-publication-procedure.md`
- PR merge: `references/pr-merge-procedure.md`
