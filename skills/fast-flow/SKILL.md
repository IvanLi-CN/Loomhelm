---
name: fast-flow
description: "Fast-track delivery to merge-ready PR, merged-only, or merged+cleanup by intent."
disable-model-invocation: true
---

# Fast flow

Use for explicit fast-track intent, a `$dev-plan` locked with `flow_type=fast-track`, or a task-local direct PR inside an approved `flow_type=multi-task-flow` plan.

## Authorization

- Execute `$project-engineering-workflow` Step 1-4 and enter Step 5 automatically.
- Within approved scope, authorize local edits, validation, signed-off commits, push, PR create/update, and in-scope fixes driven by live CI, freshness, validation, contract sync, or canonical review dispositions.
- Within the same approved PR scope, the publication procedure may reconcile only release labels returned by an explicit target-repository policy. An absent route is `no-managed-route` and continues without label mutation. The generic flow never invents labels or changes repository policy.
- Do not treat this as authorization for destructive/external actions outside the PR, remote configuration changes, scope expansion, or PR merge.
- `main-agent` is the only writer; CI/review/docs sidecars are read-only.

## Stop conditions

- `merge-ready` (default): create/reuse one direct PR, converge its current head, and stop at live `Step 5C Ready`.
- For `flow_type=multi-task-flow`, this Skill governs only the selected task's direct PR. The parent `$multi-task-flow` coordinator retains the overall task graph, ledger, parent PR, and group closeout; the task's `merge-ready` stop does not complete the parent flow.
- `merge-only`: after Step 5C, continue through the shared workflow PR merge procedure; do not run local cleanup.
- `merge+cleanup`: continue through the shared workflow PR merge procedure, then the cleanup it delegates.
- Generic `continue/finish/watch` inherits the current condition. Plain `merge` means `merge-only`; only explicit merge-and-cleanup selects `merge+cleanup`.

## Flow-specific rules

- `Step 4 Ready` is not a stop. Continue into the shared workflow PR publication procedure. Step 5C confirmation and release inputs follow `../project-engineering-workflow/references/release-planning-short-contract.md`.
- Candidate freeze begins when a Step 4 candidate has completed applicable visual comparison: unchanged evidence needs no owner reply, while changed or unavailable evidence has a clear screenshot confirmation. A feedback-only Draft does not freeze it. New behavior requires explicit `same-PR reopen` or a follow-up PR.
- Review disposition, repair-batch, late-deferral, and lane-refresh semantics come from `../project-engineering-workflow/references/review-proof-short-contract.md`: only an eligible current-PR `In-Scope Review Finding` enters a bounded Repair Batch, an authorized late deferral follows follow-up delivery, a `Design-Returning Review Finding` returns to design, and a `Review Observation` is report-only.
- Formal review starts only after Review Readiness is true: approved behavior, acceptance, scope and required contracts settled, no design decision unresolved, current-candidate validation and applicable visual evidence complete. `Step 4 Ready` for a PR path does not require completed pr-stage findings or dispositions. After exact live PR head/base binding, start the CI tracker and pr-stage formal review in parallel in the first round, then wait for both terminal states before finding disposition, Repair Batch, writes, commits, or pushes. Local-merge continues formal review before Step 5L. A plan's Tier/profile text describes runtime strategy; it does not predeclare reviewer agents or model identities.
- Record the Agent's Tier 1..4 assessment and rationale before PR binding: no categorical rubric, Tier 1 has no review gate, Tier 2 permits advisory review only, Tier 3/4 enable the required proof gate. Tier 3/4 proof comes only from read-only sub-agents and is transport-neutral; child IDs, wrappers, transcript shape, and profile claims cannot satisfy or bypass it. Advisory review cannot replace required proof. This is workflow-owned, audit-only evidence.
- When `empirical_acceptance=required`, Review Readiness also requires a passed current Candidate evidence card from the shared empirical-acceptance contract; missing, stale, failed, or unavailable evidence blocks convergence and a failed run after a comparable pass routes to diagnosis-only handling.
- Acceptance is phase-aware: Review Readiness, PR convergence, and Step 5C consume only `pre_merge` evidence bound to the Candidate SHA. `post_merge` requires an actual Merge Receipt and its `merge_sha`; `post_deploy` additionally requires a structured `deployment_identity` bound to that merge SHA. `merge-ready` is a pre-merge handoff, never `Flow Complete`; missing merge or deployment identity is an owner-action blocker.
- A new PR head invalidates SHA-bound CI and validation evidence. Applicable visual evidence is refreshed only when the visible surface or its render inputs changed. Candidate evidence and lane refresh follow the review-proof contract; target movement follows PR diagnosis §3. Do not add a second AI merge review after clear evidence.
- Top-level multi-task coordination remains owned by `$multi-task-flow`; this Skill is the direct PR implementation and convergence path for the approved task scope only.

## Output

Lead with PR/check/review outcome and next action. Show machine recovery fields only for blockers, exhausted wait budget, or explicit audit. Never call a local Step 4 state `merge-ready`.
