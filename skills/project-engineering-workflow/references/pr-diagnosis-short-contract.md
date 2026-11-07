# Shared PR Diagnosis Short Contract

Use this contract for shared Step 5, `$flow-continue`, and the workflow PR publication/merge procedures. Callers should reference it instead of restating the same PR heuristics. Generic active-long-task ownership, legal stop reasons, and default polling cadence follow `references/active-long-task-short-contract.md`; this file keeps only PR-specific promise-resume and external-wait heuristics.

## 1. Platform Live Truth Source

- Before saying why a PR currently cannot merge, refresh the live PR fact set through `bin/code_hosting.ts`. Minimum surfaces:
  - provider-normalized PR state, closed/merged status, draft, mergeability, head SHA, base SHA, and target/source refs
  - provider-normalized commit status, check/workflow runs, and review-policy contexts bound to the current SHA
  - add reviews / review comments / review threads only when the live status surfaces still leave review policy as a real candidate blocker
- The current blocker must be inferred from that live platform fact set, not from prior assistant prose, old status summaries, or carried flow text.
- Historical assistant text may still resume a promised next branch or stop condition, but it is never blocker evidence.
- If live platform facts conflict with historical prose, trust the live facts.
- `merge-ready` / `Step 5C Ready` / `latest PR 可立即合并` are live-PR state words, not local Step 4 words. Callers may use them only after current facts already prove `PR状态=存在`; before that, the correct wording is `PR状态=不存在` or `可开 PR（local）`.

## 2. Live Reducer Priority

- `state == MERGED` or `mergedAt != null` means the PR is already merged; do not diagnose a current merge blocker.
- `closed == true && mergedAt == null` means the PR is closed without merge; do not invent a still-running merge blocker.
- `isDraft == true` means draft gate comes before checks/review/proof.
- `mergeable == CONFLICTING` or `merge_state == DIRTY` means the PR is at the conflict gate. Ordinary checks/review/spec gates pause until conflict handling finishes.
- `merge_state == BEHIND` records target drift; apply §3 at the review-round boundary rather than restarting live work.
- For an open PR, `mergeable == UNKNOWN` or `merge_state == UNKNOWN` is not, by itself, proof of review/check failure. Refresh and continue using current live status surfaces instead of backfilling a blocker from history.
- `merge_state == BLOCKED` is only a top-level gate shape; keep reducing it through current live checks/review/rules facts instead of reporting raw `BLOCKED` as the final reason.
- Reduce `BLOCKED` using current live surfaces in this order:
  1. running/failed required checks or workflows
  2. explicit negative review-policy evidence
  3. directly visible unresolved review-thread / conversation blockers
  4. required deployment / merge queue / repository ruleset blockers
  5. only if none of the above are visible, report `platform live blocked; exact gate not yet surfaced` and ask for another live refresh rather than guessing `approval` or replaying assistant history

## 3. Round Boundary And Integration

- Before a new or restarted round of CI tracking or formal review, refresh live PR base/head and bind its candidate once. Handle `DIRTY` or `CONFLICTING` first. Required-CI suppression or demonstrated invalidation of an interface, dependency, or validation assumption requires prompt diagnosis; candidate writes still wait for owned review/CI tasks to terminate.
- Ordinary target advancement or `BEHIND` alone does not cancel, rebind, or restart a running round. Record the latest target and finish the bound review and CI, including remaining lane launches. At the round boundary, inspect accumulated target changes once and combine necessary alignment with the next candidate update. Before another round, resolve required freshness, actual conflicts, or demonstrated integration incompatibility; divergence alone does not mandate rebase.
- Align within existing flow authorization. When alignment is necessary, an explicitly fixed target or missing rewrite authorization is an immediate blocker; a recorded starting SHA alone does not fix the delivery target. Repeated target movement uses the existing wait budget and repository integration mechanism; budget exhaustion reports a blocker rather than an unlimited rebase/review loop.
- Old checks, proof, and spec verdicts keep their original base/head identity. An actual candidate head or review-base change requires rebinding and applicable fresh evidence, never relabeling old results. A live head change invalidates the round; diagnose it and settle owned tasks before launching replacements. PR-body writes require the publication envelope's current identity; Step 5C and merge retain their final live-fact, evidence, freshness, and repository-rule gates. `BLOCKED` without conflict facts follows §2.

## 4. Conflict-Suppressed CI

- CI absence, tracker ownership, four-field facts, and rerun boundaries follow `ci-tracking-short-contract.md`; this section only adds PR freshness/conflict precedence.
- Before classifying CI absence, retain the adapter's `policy_state` / `checks_expected` / `ci_evidence` / `gate_effect` values as separate facts. `policy_state=unknown|unavailable` is a typed provider observation, not evidence for either `CI_NOT_EXPECTED` or a required-check failure.
- For pull-request workflows, conflict alone may suppress runs. If the refresh shows `merge_state == DIRTY` or `mergeable == CONFLICTING`, classify the situation as `conflict-suppressed CI`.
- `conflict-suppressed CI` is never ordinary `外部门禁等待态`. Route straight back to freshness/conflict handling. In auto-convergence / merge-authorized runs, that means conflict auto-heal rather than a new owner question.

## 5. Approval Evidence Priority

- Before approval can affect routing, read the current status / Review Policy Gate surface when available.
- Explicit positive review-policy evidence wins:
  - `approval not required`
  - `approval satisfied`
- Empty reviews, missing review comments, or “no human review yet” are weak signals only. They must not override explicit positive evidence.
- If the live status surfaces already say review policy is clear, an empty reviews list must not become the reported blocker just because historical assistant text mentioned approval.
- Do not read empty reviews as the default explanation for `merge_state == BLOCKED`; review only becomes the blocker when current live surfaces expose direct negative review-policy evidence or unresolved review blockers.
- Only report approval as a blocker when there is direct negative evidence, or when no stronger evidence exists and repository policy still clearly requires approval.

## 6. Promise-Resume And Wait-State

- If the previous assistant reply already offered explicit next actions, and the user then says generic `继续 / 推进流程 / 你直接做吧`, resume the highest-priority unfinished promised branch unless new direct evidence overrides it.
- Shared wait budget covers platform-visible running gates such as checks/workflows, mergeability recompute, and branch-update visibility.
- In authorized PR convergence, pure external wait is not a valid stop point until the shared wait budget is exhausted.
- If wait budget is exhausted, the conclusion must say `等待预算耗尽`, and `流程锚点.下一门禁` must point back to `继续轮询当前外部门禁等待态`, not to the completion of the currently running gate.

## 7. Intent-Sensitive Stop Condition

- Stop-condition words and live-state words are separate contracts:
  - `merge-ready` can be the intended PR-stage stop condition in a plan or route decision;
  - but a current-state claim such as `merge-ready` / `Step 5C Ready` / `latest PR 可立即合并` still requires live `PR状态=存在`.
- `merge-ready`: `准备好 PR / 预备合并 / 准备好合并 / 完成合并前准备`; may stop at `Step 5C Ready`.
- `merge-only`: `合并 / 合并 PR / merge PR / merge / 只合并 / 不收尾 / merge only / no cleanup`; must continue into the workflow PR merge procedure, delete the remote PR head branch, then stop without local cleanup.
- `merge+cleanup`: `合并并收尾 / 推进到合并并收尾 / merge and cleanup`; must merge, then cleanup. Cleanup includes deleting PR worktrees when safe.
- Generic `继续 / 收尾` inherits the current stop condition; latest explicit plain `合并` resolves to `merge-only`.
- Once the current stop condition is `merge-only` or `merge+cleanup` and the run has entered the shared Step 5 merge path, same-PR in-scope writable convergence is authorized by default:
  - included: reviewer-feedback repair, CI/blocker repair, freshness `merge_state=BEHIND`, conflict `merge_state=DIRTY` / `mergeable=CONFLICTING`, missing required Tier 3/4 review proof, and compatibility repairs directly forced by those live facts;
  - excluded: scope expansion, `same-PR reopen`, permissions/risk blockers, and `convergence drag blocker`;
  - `merge-ready` does not carry this writable-convergence default by itself.

## 8. Advisory Review Boundary

- Advisory review is launched only when explicitly requested, and only after all required formal lanes reach terminal state; it may not consume a slot while a formal lane is live or pending. This is supplemental: Tier 3/4 readiness still requires the direct structured evidence in `references/review-proof-short-contract.md`.
- A reviewer task is an execution aid, not a PR fact. Its presence, completion, transcript shape, and findings do not create or clear a Tier 3/4 proof gate. The PR diagnosis reducer uses live PR, CI, validation, rules, release, the recorded review tier, and current-head review evidence when required.

## 9. Convergence Stop-Loss

- Apply the diagnosis and disposition in `review-proof-short-contract.md`; carried `PR收敛修复轮次` is the same cumulative `repair_batches_used`. Batch count alone does not block authorized in-scope repair. Design-returning findings follow the review contract.

## 10. Output Coherence

- If current facts do not yet prove `PR状态=存在`, conclusions must not say `merge-ready`, `Step 5C Ready`, or `latest PR 可立即合并`; use `PR状态=不存在` or `可开 PR（local）` instead.
- If current facts are `merge_state == DIRTY` or `mergeable == CONFLICTING`, `流程锚点.下一门禁` must point to conflict/freshness handling, never to “wait for checks/proof/mergeability to finish”.
- If current facts remain `merge_state == BLOCKED`, and the current live checks / review-policy / review-thread / deployment-or-rules surfaces still do not expose the concrete blocker, the conclusion must say `代码托管平台当前仍将该 PR 标记为 blocked，但具体门禁尚未在可见状态面中显出`, and `流程锚点.下一门禁` must point to `继续刷新当前 PR 的 live checks/review/rules surfaces` (or an equivalent live-refresh wording).
- In that exact `blocked-but-unsurfaced` case, do not rewrite the conclusion as `缺 approval`, `缺 review`, `等 checks`, or any other guessed gate.
- If stop reason is `convergence drag blocker`, the conclusion must say so explicitly and recommend a `follow-up PR` by default.
