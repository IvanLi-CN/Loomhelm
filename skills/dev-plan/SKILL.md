---
name: dev-plan
description: Produce a decision-complete proposed plan.
---

# Dev Plan

Use only when the owner explicitly invokes `$dev-plan` in Plan Mode. Produce one temporary `<proposed_plan>`; never create a plan file, progress ledger, or persisted handoff artifact. Durable product or engineering truth belongs in the owning Spec, ADR, Solution, or project document. `$dev-plan` is standalone and does not invoke, import, route to, or exchange machine contracts with a runtime coordinator.

## Routing

Resolve one top-level `flow_type` before writing the plan:

- `fast-track`: the default direct delivery path for one parent or one task PR.
- `normal`, `local-merge`, and `implement-only`: only when explicitly chosen.

Ask one routing question only when this cannot be decided from the request and repository facts. The selected flow has one matching flow skill; it is not combined with another top-level flow.

## Task Orchestration Contract

`$dev-plan` does not define or select a multi-conversation runtime route. Any runtime coordinator has its own independent input contract and lifecycle.

The `Task Orchestration` contract is the canonical source for batch, wave, task, dependency, owned-surface, acceptance, and skill facts.

A parent-child batch owns exactly one parent PR and may contain multiple continuous waves. A direct batch owns no parent PR, exactly one wave, and exactly one task whose implementation PR is the final PR. Create multiple batches only when separate main-branch merges are necessary.

Each task has a stable ID, isolated worktree, disjoint `owned_surfaces`, consumed contracts, dependencies, and task/batch acceptance binding. Each batch line declares an absolute ISO-8601 `observation_window` deadline plus `parent_branch`, `child_pr`, `topology`, `event_protocol`, and `release_policy`. Each task line may retain its exact locked `[model, thinking]` dispatch profile and `$skill` binding in compatibility input. That profile is a dispatch lock, not a formal-review lane identity, and is never reselected from new Markdown routing.

Same-wave tasks target their batch parent branch as sibling direct PRs; dependent tasks are placed in later waves. One approved plan authorizes only its in-scope dispatch, ready-child merges, and planned release checkpoints. A parent-child batch keeps its final parent PR merge owner-controlled; a direct batch keeps its single final implementation PR owner-controlled. The parent never polls or creates a heartbeat; task and batch events follow their recorded event protocol.

The contract must state a release policy of `branch-preview` or `trunk-only` and why. It must not introduce a tracking issue, aggregate PR, stacked PR, child PR chain, or second planning ledger. At the pre-merge boundary, the runtime displays the existing Agent default release decision card; owner confirmation remains required before merge continuation.

## Owner Review Projection

For an explicit `$dev-plan` request, first emit and validate the canonical raw-plan. Only after the checker passes, derive the transient owner-facing Markdown view from the same parsed canonical facts. The projection is written to stdout or the current response, is not persisted, is never reparsed as an execution contract, and cannot replace the raw-plan input. Native Codex Plan Mode without an explicit `$dev-plan` invocation remains unchanged.

The canonical `Task Orchestration` section is the only source for batch, wave, task, dependency, owned-surface, acceptance, and skill facts. Existing fast-track fixtures that use the older direct single-task shape remain on the explicit compatibility projection until they are migrated. New v2 tasks also declare `title`, `purpose`, and `outputs` in the task field list so the projection can explain the work without maintaining a second task registry. Compatibility direct plans project every direct task line accepted by the TypeScript checker, including the usual single `main-agent` shape, without inventing a second task registry. Historical JSONL may omit these display fields and remains limited to the explicit read-only compatibility route.

The owner-facing projection uses these sections in order: `决策卡`, `目标`, `不包含的工作`, `波次与依赖`, `执行规则`, `任务卡`, `约束`, `验收清单`, and `Review、运行时门禁与收口`. Its `波次与依赖` section contains a Mermaid graph derived only from canonical waves, tasks, same-wave parallelism, and explicit dependencies. The `任务卡` section displays every canonical task and every non-empty canonical batch lifecycle field. Displayed fields include target, parent branch, child PR, topology, event protocol, release policy, condition, acceptance, and observation window.

Direct task cards preserve the canonical `[model, effort]` profile and every accepted inline `$skill` annotation when present.

The `验收清单` section uses two phase headings: `PR 合并前验收` and `PR 合并后验收`. Under each heading, render one readable card per canonical acceptance item rather than a wide table. Each card shows its ID, proof target, pass conditions, and evidence; when scope is present, show it as a labeled field. Cards under the post-merge heading also show the applicable trigger, such as `Merge Receipt 已存在` or `部署身份已核验`. Keep each assertion and evidence item on its own semantic line so long text wraps naturally and is not forced into equal-width columns. The projection must not emit a long-text acceptance table or maintain a second machine-readable manifest. Review Readiness, PR convergence, and Step 5C consume only the pre-merge cards.

Task cards and acceptance items are views of canonical facts, not new machine-readable batch/task syntax. The historical coordinator contract section remains forbidden in new raw-plans and is accepted only by historical JSONL compatibility.

The `决策卡` retains the canonical flow lock as `流程类型`, so `$flow-continue` can resume the locked route without treating the projection as a new execution contract. Flow Decision fields are read only from unfenced list items with optional indentation, and fenced examples never affect routing.

Optional task profiles use the same supported model/effort matrix as the runtime profile checker.

## Plan Shape

Keep these headings in order: `Summary`, `Flow Decision`, `Goals`, optional `Constraints`, `Non-goals`, `Task Orchestration`, `Acceptance & Validation`, and `Assumptions/Defaults`. A Task Orchestration plan does not add a second task registry or a historical coordinator contract section.

- `Flow Decision` has `flow_type`, `flow_source`, `lock_status=locked`, and a concrete `开发基线` and delivery target branch. Direct flows that reach Step 5C state review tier, rationale, runtime review strategy, and profile recommendation. Release behavior is expressed through the existing `Flow Decision`, `Acceptance & Validation`, and `Assumptions/Defaults` prose; do not add plan-level release arrangement fields, predicted/final version fields, or new stop-condition values.
- Pre-merge release routing is resolved at PR publication from current repository and PR facts. An absent or non-applicable route silently becomes `no-managed-route`, with no release-label mutation. Only explicit target-owned policy may expose managed labels. This runtime fact never proves `release_expected`, publication, or a release artifact; those remain post-merge facts.
- For a plan whose stop reaches Step 5C, state that the runtime will display an Agent default decision card after reading target-repository policy and current PR facts. The card covers publish applicability, components, channel, bump rule, and predicted version; it is a runtime result, not a plan field.
- `merge-only` and `merge+cleanup` plans must state the complete executable release rule in the existing sections: target repository and branch, base-tag source, bump rule, channel, components, collision policy, and merge-SHA binding. They must never prefill a final version string. The owner must explicitly confirm the displayed card and version expectation before merge continuation; an objection returns to the release decision.
- Missing or conflicting repository policy or current facts resolve to `unknown`/blocked. An absent pre-merge route is not evidence that no release applies. Historical sessions may retain retired arrangement metadata for compatibility, but new plan Markdown must not reproduce it or use it as a release gate.
- Runtime details are defined by `../project-engineering-workflow/references/release-planning-short-contract.md`; this reference does not add plan fields.
- Direct plans declare exactly one `empirical_acceptance` value of `required` or `not_required` plus one non-empty `empirical_acceptance_rationale` in `Flow Decision`. `required` means that at least one acceptance criterion needs observation outside deterministic repository-local validation; its Acceptance & Validation items name the observable scenarios and expected results. `not_required` names why every acceptance criterion is deterministically proven. This is a proofability assessment, not a task-category shortcut.
- `Summary` states only the purpose, scope, stopping point, and key decisions; `Goals` state the results to achieve; and `Acceptance & Validation` names acceptance IDs and observable evidence without repeating task fields.
- Goals and non-goals are the scope contract. Constraints only narrow an existing goal or acceptance and do not become task items.
- For a large migration, explain its size, behavior boundaries to preserve, optional restructuring costs, and a smaller staged option in the existing plan sections. Do not treat optional improvements as migration requirements.
- Task items use continuous Waves and one inline `$skill` reference. Waves are display groups for the plan and do not create a runtime execution ledger.
- Compatibility acceptance items add explicit `scope=task:<id>` or `scope=batch:<id>` and `phase=pre_merge|post_merge|post_deploy`. The pre-merge gate consumes only `pre_merge`.
- New direct/v1 acceptance items must explicitly declare `scope=plan` and `phase=pre_merge|post_merge|post_deploy`. `pre_merge` binds to Candidate/PR head evidence, `post_merge` binds to a real Merge Receipt and `merge_sha`, and `post_deploy` binds to that `merge_sha` plus a structured `deployment_identity` whose source and bound SHA match the merge.
- Historical direct/v1 JSONL is read-only compatibility input. An old item without `scope`/`phase` maps to `plan/pre_merge` only when its target, evidence, and assertions contain no merge, release, deploy, or observation wording; an ambiguous item is rejected instead of guessed.
- `merge-ready / Step 5C Ready` is the pre-merge stopping point, not Flow Complete. `merge-only` enters post-merge processing only after owner confirmation and a real Merge Receipt. Missing publication or deployment authority remains an owner-action blocker and is never inferred as `not_required`.
- Acceptance items are concrete evidence and assertions. Compatibility input maps every task or batch to its declared scope, phase, evidence, and assertions; `observed` also states its observation plan.
- Do not repeat a task list, batch manifest, or second machine-readable contract in `Summary`, `Goals`, `Acceptance & Validation`, or another section. Keep exact machine tokens, IDs, paths, commands, and `$skill` references unchanged; readability comes from section responsibility and ID references, not duplicate content. The historical coordinator contract section is accepted only when reading historical JSONL through the explicit compatibility path and must never be generated in a new raw-plan.
- Assumptions are execution-impacting and marked `已确定`, `待确认`, or `未检查`.

## Final Check

The explicit `$dev-plan` route has one public finalization command.

It rejects NUL-containing input before invoking the raw checker and runs the canonical raw-plan checker internally.

It derives the projection only after that check passes, validates the projection, and returns the single final `pass` or `reject` result:

```bash
bin/plan-cli.sh --input <raw-plan.md>
```

The launcher is the trusted boundary: it clears Bun and Node preload environment variables and selects `bin/plan_bunfig.toml`. Direct `bun run bin/plan_review_view.ts` remains a development-only diagnostic path and is not a secure interface for untrusted candidate input.

The finalizer has one public result: `pass` emits the projection and permits the explicit plan response; `reject` emits stable findings, no compliant projection, and blocks execution.

The `$dev-plan` response wraps a passing projection in exactly one `<proposed_plan>` block.

Use `bun run bin/plan_contract_check.ts --plan -` only for focused raw-contract diagnostics or fixture tests.

Its standalone `PASS` is not an explicit `$dev-plan` finalization result.

For historical replay fixtures or runtime input, validate the in-memory state and task events with the dedicated compatibility checker before dispatch. Do not write the state into the project repository.

The TypeScript checker is the source of truth for exact field, executor, topology, and acceptance syntax.

The projection adapter must cover every direct task form accepted by that checker and reject any task it cannot project instead of silently omitting it.

Keep plan prose concise and write owner-facing text in Simplified Chinese unless the owner requests another language.

File inputs must resolve inside the candidate Worktree.

Use stdin or the current response for an in-memory raw-plan, and never point the projection entrypoint at runtime `CODEX_HOME` or another repository.

The file route must read through a no-follow traversal of every absolute candidate-root component and the requested path so a symlink swap cannot escape that boundary.

The requested path must name a regular file; non-regular inputs are rejected before reading.

Do not feed the projection, a historical JSONL session, or a persisted copy back into the raw-plan checker as a new plan.
