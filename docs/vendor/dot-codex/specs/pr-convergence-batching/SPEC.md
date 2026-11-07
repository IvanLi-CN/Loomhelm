# PR convergence batching

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

Tier 3/4 review requirements in this specification are superseded by `../mandatory-local-review-proof/SPEC.md`. Its receipt review terminology is legacy cleanup context and is not a direct-flow entry point.

## Related ADRs

- [0016 Bind Review Repairs to Approved Scope](../../adr/0016-bind-review-repairs-to-approved-scope.md)
- [0017 Review Readiness And Runtime Launch](../../adr/0017-review-readiness-and-runtime-launch.md)
- [0033 Empirical Acceptance and Repair Autonomy](../../adr/0033-empirical-acceptance-and-repair-autonomy.md)
- [0034 Priority-Aware Review Repair Eligibility](../../adr/0034-priority-aware-review-repair-eligibility.md)

## Context and Scope

This topic covers direct PR convergence batching, current-candidate review evidence, and the boundary between repair, design return, and observation. Tier 3/4 lane composition remains owned by `../mandatory-local-review-proof/SPEC.md`.

Formal review readiness requires approved behavior and acceptance, scope, and required contracts to be stable, no design decision to remain unresolved, and the current Candidate to have completed applicable validation and visual evidence. Only then does runtime launch create fresh formal lanes; plan text contains tier-consistent readiness-gated runtime strategy and a concrete host-supported model/effort pair recommendation, not reviewer identities. A lane is terminal only with complete clear structured evidence bound to the current base/head; otherwise it remains `unchecked`; its scope must match the declared lane scope and its schema may not contain unknown fields. A clear terminal result may still contain a blocking finding, which is handled by the disposition rules rather than treated as unavailable evidence.

For a direct PR, `Step 4 Ready` records Review Readiness, current validation, visual evidence, and applicable high-risk `pre-PR local proof`; it does not require completed PR-stage findings or dispositions. After exact live PR base/head binding, fresh PR-stage formal review starts in the same first round as CI tracking, and the main Agent waits for both to reach terminal state before finding disposition or a Repair Batch. Local-merge retains its formal-review-before-Step-5L boundary.

Disposition input is equally closed: only the three canonical finding dispositions are valid, unknown tokens remain malformed evidence, and an In-Scope disposition requires a demonstrated finding in the terminal result. The main Agent records the separate `repair_resolution` after applying the priority-aware repair threshold; `repair_not_required_low_priority` is not a reviewer disposition. Missing readiness evidence blocks runtime launch rather than implying approval.

## 背景 / 问题陈述

- 现有 PR 流程虽然已经具备 freshness gate、wait-state closeout 与首轮并行编排，但仍容易在 review-fix 阶段退化成“发现一条修一条、每修一次就整套再跑”的长尾收敛。
- session `019cea6c-927c-79d2-83aa-50fb5073509e` 给出了明确样例：PR 创建约在 `2026-03-14T05:04:55Z`，最终收口说明约在 `2026-03-14T07:06:59Z`；后半段主要耗时不是单次 CI 排队，而是多轮 review-fix-validate-push 循环，以及 checks 缺席后的额外诊断。
- 当前 shared workflow 只规定了“首轮并行、后续单写入、一轮一次 push”，但还没有把“哪些改动必须在 PR 前先做本地 proof”“如何把验证证据绑定当前 candidate”“什么时候应该停止自动收敛并上抛”写成硬规则。

## 目标 / 非目标

### Goals

- 保留 PR 首轮 `checks + PR-stage review` 的真正并行优势，不把流程整体串行化。
- 在高风险改动进入 PR 路径前，前置一次 `pre-PR local proof`，把明显的状态一致性/并发/契约问题留在本地解决。
- 把 PR 阶段的修复策略固定成“按根因批量修复 + 一轮一次 push + 按当前改动和仓库要求选择验证”。
- 当 checks/workflow 在最新 `head_sha` 上迟迟没有出现时，尽快进入诊断并报告，而不是继续空等。
- 对反复修复触发根因诊断，避免无进展的 review-fix-push 循环。
- 让 UI 候选先在本地完成可验证证据和基线比较；只有可见变化或不可比较时才询问主人。仅无本地证据源时使用 feedback-only Draft PR。

### Non-goals

- 不新增新的顶层三态字段。
- 不取消现有 shared wait budget 或最终合并门禁；主干变化的轮内/轮末处理由 `../pr-freshness-gate/SPEC.md` 规定。
- 不修改 `gh CLI` 远端控制面，不引入新的远端自动化通道。
- 不把 `$local-merge-flow` 默认改成 PR 路径。
- 不修改外部 CI/release workflow 配置或已锁定的 workflow PR merge procedure Phase B 顺序。

## 范围（Scope）

### In scope

- 更新 `$project-engineering-workflow` 的 Step 4/5 共享契约，并用 `ci-tracking-short-contract.md` 集中 CI tracker 不变量。
- 由当前 candidate worktree 中运行时创建的 fresh、只读 formal reviewer 提供 proof；每个 changed Candidate 使用 `fork_turns=none`，由 `main-agent` 承担批量修复与验证。
- 收紧 workflow PR publication procedure 的首轮并行与 checks 缺席诊断规则。
- 对齐 `$fast-flow` 与 workflow PR publication procedure 的自动收敛边界。
- 更新 `docs/specs/README.md` 与本规格文档。

### Out of scope

- 变更任何运行时代码或 `gh CLI` 远端操作契约。
- 新增自动化测试框架。
- 修改 `Step 5L` 的本地合主干业务语义。

## Requirements

### MUST

- 对高风险改动进入 PR 路径时，必须在首个远端变更前完成一次 `pre-PR local proof`。
- `pre-PR local proof` 与 PR-stage proof 都必须绑定各自 candidate 的 `repo_root + head_sha + base_sha + review_profile`；不得用旧 SHA proof 改写或 attestation 成新 SHA clear。
- When a follow-up PR is merged into its parent before parent convergence, the active flow must refresh the parent PR locator, base ref/SHA, head ref, and runtime head evidence; the merged follow-up locator is stale and cannot be reused.
- Historical replay fixtures MUST remain portable across branch switches, detached checkouts, base advancement, and candidate edits. Their provenance MUST NOT be compared to the current checkout as live candidate proof or refreshed to chase its SHA/digest. Current candidate identity and validation outcomes belong to runtime flow evidence; isolated digest tests may still verify content, mode, stability, and clean-state safeguards.
- HTML block starts, including standalone arbitrary tags, terminate lazy blockquote continuation; multiline comments, `script`, and `style` blocks are non-operative until their closing marker, while inline HTML remains paragraph content for active-text classification.
- UI-affecting candidate 若可本地测试/渲染，必须先完成测试、展示候选证据并与关联基线比较，才可创建或复用 PR。无可见差异不打扰主人；可见变化或不可比较时只需主人清楚地确认展示截图。渲染面或输入变化后回到比较循环。
- 只有本地 render/test source 确实不可行的 UI 可使用 `MODE=draft-bootstrap`。该 Draft 仅供反馈，远端反馈完成同一比较门禁前不得 `bind-pr`、启动 CI tracking、正式 review、full convergence 或 merge；之后以当前 candidate 走一次普通 bind 和收敛。
- 从 `normal-flow` / `local-merge-flow` 的本地 `Step 4 Ready` 恢复进入 PR 路径时，也必须重新检查这道高风险 gate；不得因为“之前已到 Step 4 Ready”就跳过 `pre-PR local proof`。
- 所有 shared PR/local proof 都必须来自当前 candidate worktree 中运行时创建的 `fork_turns=none` 只读 formal reviewer；是否授权写入只控制 `main-agent` 能否根据 findings 修复，不改变 reviewer 权限。
- formal review lane 必须终态结束并返回完整 structured result；缺字段或不可解析结果不能判定 clear。
- `Step 4 Ready` 只证明可安全进入 PR publication；它不得要求已经完成 PR-stage structured findings 或 dispositions。当前 exact live PR base/head 绑定成功后，`CI-Operator` 与第一轮 fresh PR-stage formal review 在同一轮并行启动；两者未全部终态前，main-agent 不得进行 finding disposition、Repair Batch、写入、commit 或 push。local-merge 仍在 Step 5L 前完成 formal review。
- `CI-Operator` 必须服从共享 CI tracking contract；其默认模型为 `gpt-5.6-luna + low`，每次 native launch 都携带完整 explicit model/effort pair。若 override 在 child start 前 unavailable/unsupported，只可使用调用方选择的不同完整 pair 重试一次；不得继承主 agent 配置，也不得改变 tracker 的只读职责。
- PR 阶段默认按根因形成一个 `Repair Batch`；同一 batch 允许多 commit，但只在最终 candidate boundary 一次 push。
- 验证 receipt 必须绑定当前 candidate 的输入、命令、acceptance evidence 和 SHA；它没有第二套验证分类、独立预算或锁。repair push 产生的新 `PR.head.sha` 必须重新建立当前 SHA 的 evidence。
- checks/workflow 是否出现按当前 CI tracking contract 诊断；该 contract 为每个 tracker 从启动开始提供 `600 seconds (10 minutes)` 的 bounded wait/polling budget；等待本身不构成 review 失败，预算耗尽仍按现有 SHA、retry 与 terminal-state 规则处理。
- 但若能证明当前仓库/当前 SHA 本来就不期望自动 checks，则 absence 只能记为事实，不得单独上抛 blocker。
- 正式 review 首轮覆盖全部 required lanes；修复前必须等待该 Formal Review Wave 全部终态。主代理随后按批准行为、验收和安全边界为每条 finding 写入一种 disposition，并应用共享的 priority-aware repair threshold：首次 Formal Review Wave 中最高只有 P2 时允许可选 P2 修复；后续只有 P0/P1 或可归因于当前 Candidate 的代码、测试或配置 CI 失败时，才允许把同批次、同范围的 P2 顺手修复。P2/P3 低优先级结果可以用 `repair_not_required_low_priority` 通过并在下一停靠点报告；P3 不成为独立修复目标。`Design-Returning Review Finding` 立即停止普通收敛并返回设计，`Review Observation` 只报告且不启动新 formal review wave。中间 local commit 不启动 reviewer，只有最终 Candidate 进入新的 review boundary。
- 父代理自主处置授权范围内的 repair；接近三批或同一根因反复出现时，先诊断范围、基线、方案与测试，再决定下一步，不按批次数停止或请求逐批授权。
- Tier 3/4 的 lane profile 遵循共享 [Workflow Agent Model Selection](../workflow-agent-model-selection/SPEC.md) exact six-profile direct-review allowlist，并按 lane 独立选择；四至六条 lane 不会改写该名单。完整 owner `model + effort` pair 原样交给 runtime，runtime 负责支持与错误，flow 不做 capability precheck 或 fallback。

### REQ-PR-CONVERGENCE-DISPOSITION

After all required lanes reach terminal state, the main Agent classifies each demonstrated finding as `In-Scope Review Finding`, `Design-Returning Review Finding`, or `Review Observation`, then records the independent `repair_resolution`. Only eligible current-PR items in the first class that meet the priority-aware threshold enter one root-cause Repair Batch; a low-priority item may instead receive `repair_not_required_low_priority` and accompany a clear result. The second canonical class stops ordinary convergence; the third is report-only. Authorized late deferrals retain their In-Scope identity and follow the shared review-proof resolution and handoff contract. Missing, stale, malformed, or unavailable review output is `unchecked` evidence, not a finding. A blocking finding in otherwise valid terminal evidence remains a finding and follows the disposition rules. The active flow anchor retains repo_root, base SHA, head SHA, lane scope, review profile, current locked flow, ownership promise, and cumulative Repair Batch count for recovery. For migration, the main Agent compares the approved goals and existing contracts with baseline behavior and the candidate delta before classification. A migration regression is eligible for in-scope repair; a baseline limitation explicitly accepted by the settled contract does not itself require a stronger guarantee. A new guarantee returns to design. Unclear attribution requires investigation; existing safety and acceptance gates still apply.

### REQ-PR-CONVERGENCE-FREEZE

The shared workflow's evidence-placement invariant MUST govern candidate freeze and result storage. Final result collection preserves the tested candidate and starts no formal wave; actual repairs invalidate affected evidence, and required CI passes on the live PR head. Repository-required tracked records are prepared before freeze and identify the implementation/run described.

### REQ-PR-CONVERGENCE-BUDGET

The parent/main Agent MUST apply the priority-aware repair threshold, count a Repair Batch before its first repair write, and combine demonstrated review findings and qualifying CI code/test/configuration failures by root cause after both tracks reach terminal state. Child invocations inherit the cumulative count and do not run independent repair loops. CI-only behavior repairs share this count. A P2-only repair chosen in the initial Formal Review Wave consumes the same batch count; a low-priority result accepted without a write consumes no batch and starts no new review. Candidate changes, evidence commits, PR creation, rebases, continuation, and compaction MUST preserve it. A baseline-only update or report-only evidence collection neither consumes a behavior-repair batch nor resets it. Near three batches or when a root cause recurs, diagnose the approved scope, baseline, implementation and tests; simplify or revert the task's own unnecessary complexity where justified, then continue eligible in-scope repairs under the selected flow. The count is not a write budget or an owner approval gate. A new mechanism or acceptance decision returns to design.

One Formal Review Wave is the fixed-base/head interval from launching review and CI through terminal results from both tracks. Disposition and repair occur outside that interval. Ordinary target advancement keeps the running wave bound; the parent handles accumulated target changes at its end under `../pr-freshness-gate/SPEC.md`, without automatically promoting proof across bases.

### REQ-PR-CONVERGENCE-LATE-FOLLOW-UP

After completed final-Candidate validation and all-terminal review/CI, the main Agent may apply the shared Late PR resolution to a concrete deferral. Qualification remains valuable, proven and in-scope; PR-introduced P0/P1 stay prioritized for current-PR repair. A P2/P3 accepted by the priority-aware threshold is not a deferred defect and creates no follow-up obligation. Ineligible suggestions are not follow-up work. Unknown priority/attribution stays unresolved; deferral preserves the source count and grants no new write authority. Batch count alone does not require a deferral or another owner authorization.

An authorized concrete handoff removes only that item's source-review blocker, not its defect identity or independent CI/validation/safety gates. The source PR reaches its selected stop first. After actual source merge and required merge-scope obligations, the same main Agent MUST recheck the authorized list against the target mainline containing the merge SHA and use one independent `$fast-flow` through follow-up Step 5C Ready. Before merge, retain the awaiting-source-merge anchor rather than creating a stacked PR or merging without approval. Preserve source identity/count, authorization, item evidence/reasons and any matching follow-up PR across continuation; reuse that PR and cross-link both PRs. The follow-up owns separate evidence and count. Read-only calls gain no publication authority, and one handoff does not authorize recursive PR chains or unrelated scope.

### SHOULD

- 高风险改动的判定口径应在 shared workflow、native review profile、PR skill/prompt 里保持一致。
- 验证命令应由当前改动、仓库要求和已有 acceptance evidence 决定，并保持 receipt 的 current-SHA 绑定。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- Step 4 对于将要进入 PR 路径的 run，先判断是否命中高风险改动：
  - 命中条件至少包括：共享可变状态/持久化状态变更、明显 race-prone 或异步状态机流程、前后端契约同轮变化、workflow/prompt/skill 规则改动。
  - 命中后，进入 Step 5 前先执行一次本地 `pre-PR local proof`，并完成相关本地验证。
- Step 5 的首轮并行保持如下顺序：
  - `main-agent` 负责首个 push / create-or-reuse PR，并先绑定当前 exact live PR base/head；随后 `CI-Operator` 与 runtime-created fresh formal reviewers 在同一轮启动，前者只负责当前 `PR.head.sha` 的 first-round CI tracking，并使用 `gpt-5.6-luna + low`。
  - The main-agent waits for both CI tracker and PR-stage formal review to reach terminal state; either live track blocks polling, finding classification, writing, commit, push, or Repair Batch launch.
  - 两条轨道都终态后，`main-agent` 聚合其结果并负责必要修复。
- UI 的进入条件在首个远端 mutation 之前执行：本地可验证路径在比较完成后才允许 publish/create；无本地源路径只允许 Draft bootstrap，直到远端反馈完成比较门禁。
- 首轮并行后进入 main-only convergence：
  - 合并本轮 review findings、CI failure pack 与 spec-sync 建议。
  - 按根因分组修复。
  - 按当前改动、仓库要求和 acceptance evidence 运行必要验证。
  - 一轮只 push 一次。
- 每份 validation evidence 只描述实际执行的输入、路径、命令、acceptance evidence 和 candidate SHA。相同 execution identity 可复用已通过的 evidence；任何新的 candidate SHA 都需要其自身的 evidence。
- CI tracking wait budget：每个 bound SHA 的 tracker 从启动开始最多等待/轮询 `600 seconds (10 minutes)`；预算内保持同一 SHA 绑定，即使匹配 run 仍处于运行中也不得仅因等待经过而提前结束。
- Checks absence fast diagnosis：
  - 当最新 `head_sha` 没有 check runs / workflow evidence 时，按 CI tracking contract 读取 workflows / workflow runs / labels / trigger facts；等待时长不构成 review 失败。
  - 仅当已有 run 明确属于瞬态基础设施失败时，允许对同一 SHA 做一次 rerun；不得 dispatch 新 workflow。
  - 若仍无证据，返回 actionable blocker，而不是继续视作纯等待态。

### Edge cases / errors

- Repair Batch 的最终提交会产生新 candidate SHA，使旧 review proof stale；中间 local commit 不创建 reviewer 任务。不得用 scoped delta attestation 把旧 review clear 重绑到新 head。Required CI 同样服从当前 GitHub head truth。
- Missing, stale, malformed, or unavailable review evidence is `unchecked` evidence rather than a repair finding. A suggestion without a demonstrated in-scope violation is a `Review Observation`; a remedy that needs new behavior, contract, or wider scope is a `Design-Returning Review Finding`.
- `PR预算绑定workflow_facts` 只能包含稳定可重建的策略事实，不能包含 `checks_expected` 这类会随普通等待推进而变化的运行态诊断结果。
- blocking fingerprint 首次不减少时进入根因诊断；诊断不会绕过高风险 lane 刷新或其他证据门禁。
- Draft feedback 期间只有批准 Goals 内、用于获得可确认 UI 证据的反馈修复可临时越过 post-open scope freeze；它不是正式 review wave 或 Repair Batch。

## 验收标准（Acceptance Criteria）

- Given 候选已经验证且所有 review/CI 结果终态，主代理考虑延期 When 主 Agent 处置仍有修复资格的问题 Then 当前 PR 直接引入的 P0/P1 优先留在当前 PR，其余合格问题评估明确延期；不合格建议不会进入后续 PR，未知归属不默认降级，延期不计新批次或豁免其他门禁。

- Given 第一次 Formal Review Wave 的终态结果最高只有 P2 When 主 Agent 评估当前 Candidate Then 可以选择把符合范围和根因条件的 P2 纳入一个 Repair Batch；P3 及更低问题不产生修复义务，未写入时以 `repair_not_required_low_priority` 通过并在下一 owner-facing 停靠点报告。

- Given 第二次或之后的 Formal Review Wave When 终态结果没有 P0/P1 且没有可归因于当前 Candidate 的代码、测试或配置 CI 失败 Then P2/P3 及更低问题不得创建 Repair Batch，review 仍可通过并报告低优先级问题。

- Given 第二次或之后的 Formal Review Wave 含有 P0/P1 或符合条件的 CI 失败 When 同一批次内还有符合范围和根因条件的 P2 Then 可以把该 P2 顺手纳入同一 Repair Batch；不相关 P2 和所有 P3 及更低问题仍不成为独立修复目标。

- Given 已授权延期清单及来源 PR 合并事实 When 当前 flow 完成来源 PR 的必要合并收尾并续推 Then 从包含实际 merge SHA 的主干创建或复用独立 fast-flow 后续 PR，交付到 Step 5C Ready 并双向引用；来源未合并、未授权发布或试图递归开 PR 时保留原有 owner 边界。

- Given 高风险改动即将从 Step 4 进入 PR 路径 When 命中风险判定 Then 流程必须先完成一次 `pre-PR local proof`，再允许首个远端变更。

- Given 首个 PR round 刚启动 When exact live PR base/head 已绑定且 checks 与 PR-stage review 可以并行 Then CI tracker 与 PR-stage review 必须在同一轮启动；两者都终态前不得进行 finding disposition、Repair Batch 或额外 push。

- Given 流程报告 `Step 4 Ready` 并将进入 direct PR path When 当前 Candidate 已完成 Review Readiness 和适用的 pre-PR local proof Then 该状态不得被解释为已经完成 PR-stage findings 或 dispositions。

- Given 当前 flow 为 `local-merge` When 流程进入 Step 5L Then required formal review evidence 必须已在 Step 5L 之前完成。

- Given 首轮仍需要创建 `CI-Operator` sub-agent When 外层流程启动该远端协作轨 Then 应使用 `model=gpt-5.6-luna` 与 `reasoning_effort=low`，并让 `main-agent` 通过阻塞式 `wait_agent` 等待 tracker 终态。

- Given 同一轮 PR-stage review 返回多条 in-scope findings When 主代理处理本轮阻塞项 Then 必须先按根因合并为一个修复批次，再进行一轮验证，并且该轮只 push 一次。

- Given checks/workflow 尚未提供当前 head 的终态事实 When 流程评估当前门禁 Then 按 CI tracking contract 诊断；不得因等待时长自动重启 review 或 workflow。

- Given 当前 head 的匹配 CI 仍在运行，且 tracker 尚未达到 `600 seconds (10 minutes)` 的 bounded wait/polling budget When tracker 继续观察当前 bound SHA Then 必须继续等待/轮询同一 SHA，不得仅因经过短暂等待就重绑定、重试或报告 tracker 终态。

- Given tracker 达到 `600 seconds (10 minutes)` 的 bounded wait/polling budget When 匹配 CI 仍未形成终态 Then 必须沿用现有 SHA binding、一次 transient rerun 与 terminal-state/recovery-card 规则收尾，不得创建 replacement run 或改变 retry history。

- Given 同一个 open PR 的普通 repair 已进行三次且仍有有效 blocker When 主代理完成范围、基线、方案与测试诊断 Then 主代理可在既有授权内继续修复，不因批次数请求主人批准。

- Given 同一根因反复出现 When 下一次修复尚未开始 Then 先复核目标、原有契约和新引入的复杂度，再决定是否简化实现；新增设计要求返回设计。

- Given 当前 Candidate 的正式 lane 返回有效 blocker When required lanes 已全部终态且 blocker 在 scope 内 Then 按根因形成一个 Repair Batch；最终 Candidate 只刷新受影响 lane，未知/高风险或实际采纳新 review base 则刷新全部 required lanes 并绑定新 base。仅观察到主干推进不在轮内触发刷新。

- Given 当前 Candidate 的正式 lane 返回一条 observation 或 design-returning finding When required lanes 已全部终态 Then observation 只进入报告，design-returning finding 停止普通 repair；二者都不得被当作自动修复任务。

- Given `normal-flow` / `local-merge-flow` 从本地 `Step 4 Ready` 续推到共享 PR 路径 When 当前改动命中高风险 gate，且当前本地 `HEAD` 还没有绑定当前 base 事实的 `pre-PR local proof` Then 必须先补这次本地 proof，再允许首个远端 push / PR 创建。

- Given 本地可测试的 UI candidate 已完成证据 When 当前比较发现可见差异或无法比较，且主人尚未确认展示截图 Then 流程不得创建/reuse PR 进入收敛，必须等待自然语言确认或回到本地 Step 3/4；比较一致时不应产生这项等待。

- Given UI 没有可用本地 render/test source When 需要主人反馈 Then 只允许创建/reuse feedback-only Draft PR；远端反馈尚未完成比较时不得绑定 receipt、启动 CI/review 或 merge，完成比较后的 current candidate 才恢复普通 workflow PR publication procedure。

## Verification

### VER-PR-CONVERGENCE-BOUNDARIES covers: REQ-PR-CONVERGENCE-FREEZE, REQ-PR-CONVERGENCE-BUDGET

- Instruction architecture checks require operative candidate-freeze, result-placement, repair count, diagnosis and freshness relationships while allowing concise equivalent wording. Rewording, missing/example-only rules, and reversed repair-count order have focused coverage.
- Review lifecycle tests retain the cumulative count, autonomous in-scope repair and diagnosis trigger. These checks validate the instruction contract; they do not intercept a live Agent's writes or replace its flow anchor.

### VER-PR-CONVERGENCE-DISPOSITION covers: REQ-PR-CONVERGENCE-DISPOSITION

- review findings use the three dispositions after terminal lane coverage;
- only in-scope findings that meet the priority-aware threshold create a bounded Repair Batch;
- initial-wave P2-only repair, later P0/P1 or qualifying-CI triggers, low-priority accepted findings, P3 collateral handling, and next-stop owner reporting are covered by the review lifecycle checks;
- design-returning findings stop ordinary convergence and observations do not create repair work or a new formal review wave;
- the fourth and later in-scope Repair Batches do not require per-batch owner authorization.

### VER-PR-CONVERGENCE-LATE-FOLLOW-UP covers: REQ-PR-CONVERGENCE-LATE-FOLLOW-UP

- `bin.test_agent_profiles` replays eligibility before priority, autonomous repairs, deferred-only versus mixed review clear, independent evidence gates, and source-merge-bound fast-flow continuation without duplicate or recursive PR delivery.
- `bin.test_instruction_architecture_check` checks entry references to the shared resolution/handoff owner; the three canonical dispositions and reviewer result schema remain unchanged.

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: `python3 -m unittest bin.test_instruction_architecture_check`
- Integration tests: 通过文档契约审阅与规则交叉检查验证
- E2E tests (if applicable): N/A

### Quality checks

- `git diff --check`
- 受影响 skill/prompt 中的 Formal Review Wave、Repair Batch、Lane Refresh Set 与无固定分钟数文案交叉检查
- active direct-flow consumer 不得把 receipt、repair permit、review-wave 或 convergence-reopen 作为正式 review gate
- `docs/specs/pr-convergence-batching/replay/first-round-parallel-barrier.json` 必须以 fixture-driven parser cases 覆盖 active PR-stage barrier、active quoted legacy serial-gate rejection、long-fence/indented-code/thematic-break/lazy-quote non-operative required-text rejection、explicit thematic-break blockquote closure、four-space 与 mixed-tab lazy quote continuation、quote 内 heading/HTML block 后的 lazy quote closure、inline HTML 与 quote-marker-after-tab paragraph continuation、quote markers inside top-level fences、quote-prefixed fence boundaries、invalid backtick fence info strings、inline-code contract text、tab-indented fence markers、explicit and unprefixed quote-fence closure followed by a top-level fence、blank-quote closure、unclosed-fence forbidden-gate scanning、historical snapshot false-positive protection。Focused test 必须校验 fixture case 名称唯一且完整，并将其 PR/base/branch 元数据识别为历史来源，禁止把它当成当前 Candidate 证明；live PR open/base/head 事实仍由代码托管 adapter 与 formal evidence card 在运行时核对。隔离仓库测试继续验证 strict canonical GitHub repository identity、tracked content/mode、index flags 隐藏修改、symlink、逐项稳定性与前后 clean-state 边界。
- `python3 bin/pr_skill_replay_check.py --cases docs/specs/pr-skill-diagnosis-thinning/replay/cases.txt`
- `python3 bin/instruction_architecture_check.py --repo-root .`

## 方案概述（Approach, high-level）

- 在 shared workflow 层定义何时前置 proof、何时进入 PR 并行、何时停止自动收敛。
- 在 native review contract 与 PR skill/prompt 层把 shared contract 翻译成执行规则，保证所有入口一致。
- 保留真正有价值的并行，把低效的小颗粒重复并行改成批量收敛。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：高风险改动判定过宽会增加本地 proof 次数；判定过窄则仍可能把明显问题拖到 PR 阶段。
- 风险：不同仓库的 workflow 触发方式不同，checks 缺席诊断只能定义“先查，再对已存在的瞬态失败 run rerun 一次”的保守路径。
- 需要决策的问题：None
- 假设：外部 CI 等待时长不作为 review 失败或自动重启条件，repair 诊断由 direct review contract 统一持有。

## 参考（References）

- Session `019cea6c-927c-79d2-83aa-50fb5073509e`
- `docs/specs/pr-freshness-gate/SPEC.md`
- `docs/specs/pr-wait-state-closeout/SPEC.md`
