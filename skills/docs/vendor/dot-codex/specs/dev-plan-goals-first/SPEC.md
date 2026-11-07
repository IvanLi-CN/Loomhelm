# Dev plan goals-first and scope constraints

## Context and Scope

This topic defines the explicit `$dev-plan` output contract. It covers temporary plan structure, internal scope-authority checks, and validation boundaries. Native Plan Mode without an explicit `$dev-plan` invocation remains outside this contract.

## Terms and Interfaces

- `Scope Authority`: the Agent's internal check that a material Goal or Non-goal is authorized by a concrete owner request or a valid current Spec/ADR statement.
- `Plan Constraint`: a `C*` condition that narrows an authorized Goal or `A*` acceptance without authorizing new scope.
- `Material claim`: a Goal, Non-goal, acceptance assertion, or process gate that changes scope, behavior, evidence, or delivery authorization.
- `Release Decision Card`: the runtime Step 5C result derived from target repository policy and current PR facts. It is not a plan field or post-merge release evidence.
- Interface: canonical raw-plan Markdown validated by `bun run bin/plan_contract_check.ts --plan -`; explicit `$dev-plan` final output is produced by the trusted `bin/plan-cli.sh` launcher and wrapped once in `<proposed_plan>`.

## Requirements

### REQ-DEVPLAN-001

An explicit `$dev-plan` MUST emit `Summary`, `Flow Decision`, `Goals`, `Non-goals`, `Task Orchestration`, `Acceptance & Validation`, and `Assumptions/Defaults` in that order. When a condition limits validation or delivery, it MUST emit `Constraints` after `Goals` and before `Non-goals`.

### REQ-DEVPLAN-002

Before emitting a plan, the Agent MUST perform Scope Authority analysis without asking the owner to locate or restate sources. Repository evidence, model inference, a generic approval, a rejection of an earlier proposal, or a validation condition MUST NOT independently authorize a material Goal, Non-goal, artifact, external action, or delivery obligation.

### REQ-DEVPLAN-003

Final plan text MUST NOT include a `Scope Basis`, an equivalent source/authorization/provenance heading, direct quotations of owner messages, or a mapping from plan items to their conversation, contract, ADR, derivation, or flow provenance. The plan MUST remain a temporary execution specification and MUST NOT create a persistent plan ledger.

### REQ-DEVPLAN-004

When present, every Constraint MUST use a stable `C*` id and bind to one or more existing `A*` acceptance items. A Constraint qualifies an authorized Goal or acceptance only; it MUST NOT be the sole basis for a Task Orchestration item or a new implementation mechanism. Task Orchestration MUST NOT reference a declared `C*` id. The checker MUST reject provenance sections or mappings, malformed constraints, duplicate constraints, constraints that reference unknown acceptance items, and task items that reference a declared Constraint.

### REQ-DEVPLAN-005

Flow-specific process contracts MUST remain owned by the selected flow skill. A default fast-track plan MUST retain its live PR, current-head, and Step 5C convergence assertions; a Constraint MUST NOT turn a flow gate into product scope.

### REQ-DEVPLAN-006

Direct `normal`, `fast-track`, and `local-merge` plans MUST NOT require an owner-supplied release disposition. The pre-merge release route MUST be derived at publication time from current repository and PR facts. When no explicit valid repository contract or adopted project-local Policy exposes a managed route, the resolver MUST return `no-managed-route` with no managed release labels and publication MUST continue. The route MUST NOT determine post-merge `release_expected`, version, tag, or publication evidence.

### REQ-DEVPLAN-007

New plans MUST express release behavior through the existing `Flow Decision`, `收口条件`, `Assumptions/Defaults`, and `Acceptance & Validation` sections. They MUST NOT add plan-level release arrangement fields, release stop-condition values, or a final version string. For a Step 5C stop, the plan MUST make the runtime Agent default decision card displayable: publish applicability, components, channel, bump rule, predicted version, target identity, and policy source are named as runtime outputs. For `merge-only` and `merge+cleanup`, the existing prose MUST state the complete executable rule and locked inputs: target repository/branch, base-tag source, bump rule, channel, components, collision policy, and merge-SHA binding. The plan MUST never turn a predicted version into a prefilled final version.

The runtime MUST require explicit owner confirmation of the Step 5C card, including the version expectation, before merge continuation. Missing or conflicting policy/facts MUST resolve to unknown/blocked; an absent `no-managed-route` result MUST NOT be interpreted as no release. After merge, `release_expected` MUST be derived only from actual `target_repo + target_branch + merge_sha` facts and actual version/tag/artifact identity. 其他直接流程的历史 JSONL 和历史文档继续作为兼容输入或证据保留，不定义新计划语法；Wave Thread 合同不再受支持。

### REQ-DEVPLAN-008

Wave Thread 协调合同和历史状态兼容能力已经移除。新 raw-plan 与历史 JSONL 中的 Wave Thread flow_type 都必须被拒绝；不得恢复、派发或回放旧协调任务。共享编排解析器仅保留现行多任务流程需要的 batch、wave、task、依赖、owned surfaces 与分阶段验收能力，不构成显式 `$dev-plan` 的新入口。新 raw-plan 必须拒绝重复 `## Wave Thread Contracts`，历史 JSONL 不得通过专属兼容路径读取该区段。

The human-readable sections have distinct responsibilities: `Summary` states purpose, scope, stopping point, and key decisions; `Goals` state results; and `Acceptance & Validation` names acceptance IDs and observable evidence without repeating task fields or creating a second task registry.

### REQ-DEVPLAN-009

An explicit `$dev-plan` MUST use one finalization result that combines canonical raw-plan validation and owner-facing projection validation.

`pass` MUST emit the projection and permit the plan response.

`reject` MUST return stable findings, emit no compliant projection, and block execution.

The raw checker remains a diagnostic dependency and MUST NOT be treated as a separate final success state.

The projection MUST be derived from the same parsed canonical facts.

It MUST contain these sections in this order: `决策卡`, `目标`, `不包含的工作`, `波次与依赖`, and `执行规则`.

The remaining sections are `任务卡`, `约束`, `验收清单`, and `Review、运行时门禁与收口`.

Its wave/dependency graph MUST contain only canonical waves, tasks, same-wave parallelism, and explicit dependencies.

Projection output MUST remain transient and MUST NOT be reparsed as an execution contract.

The `任务卡` section MUST display every canonical task and every non-empty canonical batch lifecycle field.

Displayed lifecycle fields include target, parent branch, child PR, topology, event protocol, release policy, condition, acceptance, and observation window.

The `验收清单` section MUST display every canonical acceptance ID under the phase headings `PR 合并前验收` and `PR 合并后验收`.

Each acceptance item MUST be rendered as a readable card rather than a multi-column table. The card MUST display the canonical ID, proof target, pass conditions, and evidence; it MUST display scope when the canonical item has one. Post-merge and post-deploy cards MUST display their applicable trigger. The projection MUST keep assertions and evidence as semantic lines and MUST NOT use fixed-width or equal-width columns for long acceptance text.

Projection validation MUST reject a view that omits a canonical task, batch, displayed field, acceptance item, or required card field, duplicates an acceptance ID, or emits a long-text acceptance table.

The finalizer MUST reject NUL-containing input before invoking the raw checker.

It MUST accept every direct task form accepted by the raw checker, including optional whitespace around `=>`.

It MUST preserve the canonical `[model, effort]` profile form in the owner-facing task card and reject rather than silently omit any task it cannot project.

It MUST preserve direct-task skill annotations wherever the accepted task syntax places them.

It MUST normalize accepted flow aliases before choosing the canonical parser.

It MUST reject duplicate route-driving `Flow Decision` or `Task Orchestration` sections before deriving display facts.

File traversal MUST open every absolute tool-root component without following symlinks and MUST reject non-regular inputs without blocking.

Historical compatibility MUST count proposed-plan markers only outside fenced examples.

It MUST stop extraction at the first valid unfenced closing marker and reject extra markers in both the parser and JSONL shell route.

Flow Decision route fields MUST be parsed from the same unfenced list-item grammar in the shell checker, Python finalizer, and continuation replay checker.

The grammar MUST allow leading spaces or tabs before a list item, while fenced examples MUST be ignored.

The owner-facing `决策卡` MUST preserve the canonical flow lock as `流程类型`.

This allows continuation to recover the locked route without reparsing the projection as an execution contract.

New v2 tasks MUST declare non-empty `title`, `purpose`, and `outputs` fields in `Task Orchestration`.

旧协调任务的三档 Profile allowlist 和缺失字段兼容路径不再可用。现行共享多任务解析器按自身 Profile 与字段合同验证输入。

New raw-plan output MUST NOT contain a second machine-readable batch/task registry or `Wave Thread Contracts`.

The shared orchestration checker MUST apply the same Constraint-reference and persisted-plan-artifact guards to canonical task display metadata as to other Task Orchestration task text.

This includes task lines with their required `[model, effort]` profile.

The v2 parser and projection MUST preserve that locked profile.

The v2 guard MUST cover plan, progress-log, decision-log, and handoff-log planning artifacts while retaining the existing product-surface exemptions.

A product task that imports or processes user-provided `PLAN.md` content is not itself a persisted planning artifact.

Shell and Python contract routes MUST normalize CRLF input and accept the same whitespace-tolerant section-heading form.

The historical compatibility parser MUST parse only the content between the single unfenced `<proposed_plan>` and `</proposed_plan>` markers.

Content outside that block MUST NOT affect validation, and extra markers MUST reject the input.

A new raw-plan checker and finalizer MUST reject an unterminated Markdown fence.

Owner-facing projection text MUST prevent bare URL/autolink syntax from creating external Markdown links.

Direct finalizer calls with unencodable Unicode input MUST return a stable rejection finding rather than raising an uncaught encoding error.

The selected tool root is the root containing the finalizer entrypoint, its imported contract modules, and its paired raw-plan checker. For ordinary business projects, the caller MUST select a trusted installed tool root and MAY invoke its absolute entrypoint from any working directory with canonical raw-plan input on stdin. The business project root does not select the checker or extend the file-input boundary.

For dot-codex development, the caller MUST select the current candidate Worktree as tool root; runtime `CODEX_HOME` and other checkouts MUST NOT provide the entrypoint or its dependencies for candidate validation.

File `--input` paths MUST be inside the selected tool root; relative paths are relative to that root. Stdin permits input from outside the root without relaxing file traversal. Entrypoint, modules, checker, and file input MUST retain no-follow and regular-file protections; symlinked source paths MUST be rejected.

## Verification

### VER-DEVPLAN-001

- Method: `bun run bin/plan_contract_check.ts --plan <fixture>`.
- covers: `REQ-DEVPLAN-001`, `REQ-DEVPLAN-003`, `REQ-DEVPLAN-004`
- Pass condition: plans without provenance sections pass; provenance-heading variants and mappings, malformed constraints, duplicate constraints, constraints targeting unknown acceptance items, and task references to declared Constraints fail.

### VER-DEVPLAN-002

- Method: `bun test bin/tests/plan` plus replay cases.
- covers: `REQ-DEVPLAN-002`, `REQ-DEVPLAN-005`
- Pass condition: final-plan checks reject provenance leakage while Constraint fixtures bind only existing acceptance items and fast-track gates remain enforced.

### VER-DEVPLAN-003

- Method: `bun run bin/plan_contract_check.ts --plan -` and focused plan fixtures.
- covers: `REQ-DEVPLAN-006`
- Pass condition: direct plans pass without a `release_disposition`; legacy occurrences remain readable compatibility metadata and do not create a publication gate.

### VER-DEVPLAN-004

- Method: `bun test bin/tests/plan`, `bun run bin/plan_contract_check.ts --cases skills/dev-plan/references/replay-cases/CASES.txt`, and `bun run bin/instruction_architecture_check.ts --repo-root .`.
- covers: `REQ-DEVPLAN-007`.
- Pass condition: new raw plans reject retired arrangement fields, expose a displayable Step 5C decision card, and keep merge-only/merge+cleanup inputs executable without a final version string; 其他直接流程的 historical JSONL remains readable; missing/conflicting route, policy, version-rule, component, major alignment, and tag-collision cases resolve to unknown/blocked rather than no release; shared contract consumers and the runtime boundary stay aligned.

### VER-DEVPLAN-005

- Method: `bun test bin/tests/plan/orchestration.test.ts`、`bun test bin/tests/plan` 与历史直接流程的 JSONL 回归集。
- covers: `REQ-DEVPLAN-008`.
- Pass condition: 旧 Wave Thread Skill、CLI 和状态机缺席，历史 Wave Thread 计划被拒绝；现行多任务共享解析器保留正向与错误输入验证。

### VER-DEVPLAN-006

- Method: `bin/plan-cli.sh --input skills/dev-plan/references/plan-cases/positive-fast-track.md`, `bun test bin/tests/plan`, the independent tool-root invocation tests, and the candidate context validation sequence.
- covers: `REQ-DEVPLAN-009`.
- Pass condition: the finalizer returns one `pass` with the nine-section projection, Mermaid graph, and phase-grouped acceptance cards; raw, legacy, duplicate-contract, missing-display-metadata, projection-drift, forbidden-table, and tool-root boundary failures return one `reject` with no projection or execution permission.

### VER-DEVPLAN-007

- Method: `bun test bin/tests/plan` and the historical replay cases.
- covers: `REQ-DEVPLAN-004`, `REQ-DEVPLAN-008`, and the 共享编排与历史直接流程的 guard boundary.
- Pass condition: 共享多任务 display metadata 和 Profile cannot bypass Constraint-reference or plan/progress-log/decision-log/handoff-log artifact checks; direct raw plans reject unterminated fences; historical parsing and the JSONL shell route agree on whitespace-padded wrapper markers and reject contract data outside the proposed-plan block.

## Related ADRs

- [Scope authority and topic Spec boundaries](../../adr/0004-scope-authority-and-topic-spec-boundaries.md)
- [Keep plan authorization internal and model validation limits as constraints](../../adr/0006-internal-plan-authorization-and-scope-constraints.md)
- [Runtime-derived pre-merge release route](../../adr/0021-runtime-derived-pre-merge-release-route.md)
- [Stop-condition-driven release decision](../../adr/0024-stop-condition-driven-release-decision.md)
- [Single source for Wave Thread v2 plans](../../adr/0030-dev-plan-single-source-wave-thread.md)
- [Transient owner review projection for dev plans](../../adr/0031-dev-plan-owner-review-projection.md)
- [Single finalization gate for dev-plan owner review](../../adr/0032-dev-plan-single-finalization-gate.md)

## References

- `./IMPLEMENTATION.md`
- `./HISTORY.md`
