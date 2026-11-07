# Fast-track merge intent closeout

> Historical audit note: this topic retains older heartbeat terminology and replay fixtures for compatibility. Current release-tracking behavior is defined by [Release Tracking](../release-tracking/SPEC.md) and the shared contract, which prohibit tracking automation and require manual `$flow-continue` recovery.

> 本文保留 fast-track closeout 的历史审计规范；当前 release tracking 行为以 `../release-tracking/SPEC.md` 与 shared contract 为准。实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## Related ADRs

- [0003 外部事实交付门禁](../../adr/0003-external-fact-delivery-gates.md)
- [0008 Direct PR Merge Preflight](../../adr/0008-direct-pr-merge-preflight.md)
- [0010 Post-Merge Flow Receipt Finality](../../adr/0010-post-merge-flow-receipt-finality.md)
- [0017 Review Readiness And Runtime Launch](../../adr/0017-review-readiness-and-runtime-launch.md)
- [0021 Runtime-Derived Pre-Merge Release Route](../../adr/0021-runtime-derived-pre-merge-release-route.md)
- [0032 Phase-Aware Acceptance Gates](../../adr/0032-phase-aware-acceptance-gates.md)

## 背景 / 问题陈述

- 历史 session `019cfa20-c48c-75e2-9acd-39c94c3e1201` 暴露出一个收尾语义缺口：Agent transcript proof 曾被误当成交付状态，导致“PR 已收敛”和“PR 已合并”混成一件事；当前合同改由外部事实判定。
- 顶层语义也存在错位：`AGENTS.md` 与 `skills/dev-plan/SKILL.md` 仍把 `fast-track` 教成“`push + PR + checks 结果明确 + review 循环结果明确` 即可收口”，但 `fast-flow` / Step 5 实际已经包含 merge-proof / cleanup 路径。
- 这不是单个判断条件漏掉，而是三个地方同时漂移：
  - 快车道 stop condition 必须区分普通“合并”和“合并并收尾”：普通“合并”是 `merge-only`，只有显式“合并并收尾”才是 `merge+cleanup`；
  - `Step 5C Ready` 缺少显式 handoff 语义，导致 `workflow PR publication procedure` 可以把 merge 请求降级成“只到 PR clear”；
  - Agent transcript proof 被错误地混入共享 `外部门禁等待态`，导致 PTC/direct transport 差异影响收尾。
- 新一轮 owner 需求又补出第四层语义：merge 后必须确认目标分支上由本次 merge SHA 触发的 CI，不能把其他 release / deploy / publish 或计划任务误归属于本次 merge。
- session `019f9ce7-e16d-7ea0-a42b-dd260a1e260a` 又暴露出 post-merge 最后一层缺口：`Release Snapshot` 已给出 `release_enabled=True` 与 `release_tag=0.63.12`，agent 却在实际 GitHub Release `0.63.12` 完成前结束，并且最终回复没有明确报告是否发版、版本号或发布链接。

## Context and Scope

### Goals

- 将 `fast-track` 终点语义显式拆成三档：
  - `merge-ready intent`：停在 latest PR 的 `Step 5C Ready`
  - `merge-only intent`：普通“合并/合并 PR/merge PR/merge”继续到 `workflow PR merge procedure` 完成 merge、删除同仓远端 PR head，并让 Git primary worktree 的 PR target base branch 包含最新 remote base，或进入明确的待决策/阻断状态，且不执行本地 cleanup
  - `merge+cleanup intent`：仅在主人明确“合并并收尾/merge and cleanup”时，完成 merge 后执行 cleanup
- 为 `PR_ROLE=direct|child|parent` 固化边界：child 合入后只等待 integration CI；parent 的最终 merge 必须由主人对最新 head SHA 明确批准，快车道和 generic continuation 都不能代替该批准。
- 让 `AGENTS.md`、`$fast-flow`、`$flow-continue`、shared Step 5、`workflow PR publication procedure`、`workflow PR merge procedure`、`$dev-plan` 使用同一套口径，避免旧文案把已锁定 session 的 stop condition 拉偏。
- 把“`merge-only` / `merge+cleanup` 一旦进入 shared Step 5 merge path，就默认允许 same-PR、in-scope writable convergence”写成共享 contract；`merge-ready` 只表示停在 `Step 5C Ready`，不携带这层可写语义。
- 把“活 proof / in-budget wait-state 不得提前收尾”的硬规则前置到共享短规约和入口 skill 顶部可见区。
- 为 merge 后目标分支上的 merge-SHA CI 引入共享 `Step 6 post-merge target-branch CI follow-up`：
  - CI 默认使用一个 `ci-tracker`（`gpt-6-luna + low`），主 agent 阻塞等待
  - sub-agent 创建或阻塞等待不可用时明确报告 `tracking unavailable`，不隐式接管 watcher 或主 Agent 轮询
  - 两种方式都不可安全建立时记录 `defer`，不由主 agent 轮询
- 将共享 Step 6 扩展为 post-merge delivery gate：Step 6A 保留 merge-SHA target CI，Step 6B 使用独立 release tracking contract 判定并跟踪仓库发布链；预期发版时必须等待实际 Release/package/container 终态。
- 让所有远端 merge 终态明确报告 `发布状态`；已发布时给出版本/tag、channel、绑定 SHA、链接、发布时间与产物摘要，未触发时给出判定证据。Agent 调用、review transcript 和子任务身份均不参与该门禁。
- 用 replay checker 固化本次事故，确保真实 session 与合成样例都能区分：
  - 提前 closeout
  - merge-ready 正常停靠
  - merge-only 正常 handoff / merge
  - merge+cleanup 正常 handoff / merge / cleanup
- 为 direct PR merge 提供窄职责、只读的 preflight；由 Agent 在最终 preflight 中锁定 live head，owner 不需要输入或复述 SHA。

### Non-goals

- 不重写整个软件工程流程，也不改变 `local-merge` 主路径终点模型。
- 不修改 `gh CLI` 远端控制面或 Codex runtime。
- 不把所有 skills 做审美式全量瘦身；只处理与本次事故直接相关的入口层和共享短规约。

## 范围（Scope）

### In scope

- 更新 `docs/specs/README.md` 与本规格。
- 更新共享短规约：
  - `skills/project-engineering-workflow/references/ci-tracking-short-contract.md`
  - `skills/project-engineering-workflow/references/release-tracking-short-contract.md`
  - `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
  - `skills/project-engineering-workflow/references/advisory-review-short-contract.md`
- 对齐并适度瘦身：
  - `AGENTS.md`
  - `skills/project-engineering-workflow/SKILL.md`
  - `skills/fast-flow/SKILL.md`
  - `skills/flow-continue/SKILL.md`
  - `skills/project-engineering-workflow/references/pr-publication-procedure.md`
  - `skills/project-engineering-workflow/references/pr-merge-procedure.md`
  - `skills/dev-plan/SKILL.md`
- 扩展 `bin/pr_skill_replay_check.py` 并新增 replay fixtures / cases。
- 新增 `skills/project-engineering-workflow/scripts/merge_preflight.py` 及其聚焦单元测试；新增 guarded-merge replay 回归案例。

### Out of scope

- 修改业务仓库代码。
- 新增第四个大型 checker。
- 追溯改写历史 spec 的验收标准；若有旧口径冲突，以本规格 supersede。

## Requirements

### MUST

### REQ-FTMI-001

Direct PR merge intent MUST bind to the explicit PR identity; the Agent MUST lock the live head from a final eligible preflight instead of asking the owner to provide or repeat a SHA.

### REQ-FTMI-002

The merge preflight MUST remain read-only and MUST check only live PR head/base, the candidate ref OID, and candidate worktree cleanliness, including all untracked files and submodule changes. Every local ref resolution MUST place Git's `--end-of-options` delimiter before the user-supplied ref.

### REQ-FTMI-003

The final direct merge MUST pass the locked head to `gh pr merge --match-head-commit`; stale snapshots, candidate drift, closed PRs, dirty worktrees, and unsupported head-guard capability MUST fail closed.

### REQ-FTMI-004

Child, checkpoint, and parent merge paths MUST retain their independent role-specific exact-SHA owner approval contracts.

### REQ-FTMI-005

Before a direct PR publication performs its first remote mutation, it MUST silently derive `pre_merge_release_route` from current target-repository and PR facts. An explicit valid repository contract or adopted project-local Policy MAY expose managed release-label groups. If no applicable route is exposed, the resolver MUST return `no-managed-route`, preserve an empty managed-label set, and continue publication without release-label mutation. The generic flow MUST not require an owner-supplied route or treat `unknown` as a publication gate. Only explicitly managed release-label groups may be reconciled, and unrelated labels MUST be preserved. This gate MUST NOT change the post-merge `release_expected` and actual-artifact contract. The route evidence MUST be a current structured card binding `target_repo`, `target_pr`, repository facts, PR facts, `route_source`, and `managed_release_labels`; before an open PR exists, `target_pr` MUST be explicit `null` and the PR facts MUST prove that no open PR exists for the exact head/base pair, including explicit `target_head` and `target_base` values matching those facts; after PR creation or reuse, it MUST be the positive PR number. `route_source=none` MUST carry an empty managed-label set.

- `fast-track` stop condition 必须按意图切换：
  - `准备好 PR / 预备合并 / 准备好合并 / 完成合并前准备` => `merge-ready`
  - `合并 / 合并 PR / merge PR / merge / 只合并 / 不收尾 / merge only / no cleanup` => `merge-only`
  - `合并并收尾 / 合并 PR 并收尾 / 推进到合并并收尾 / merge and cleanup / merge PR and cleanup` => `merge+cleanup`
- 泛化 `继续` 只能继承当前 stop condition，不得静默升级或降级；`合并 / 合并 PR / merge PR / merge` 是明确 merge-only 意图，不得静默升级成 cleanup。
- 共享 Step 5 到达 `Step 5C Ready` 后：
  - `merge-ready` 可以停下
  - `merge-only` 与 `merge+cleanup` 必须 handoff 到 `workflow PR merge procedure`
  - `merge-ready` / `Step 5C Ready` / `latest PR 可立即合并` 都是 live PR 当前状态表述，必须先确认 `PR状态=存在`；若当前仍无 open PR，只能表述为 `PR状态=不存在` 或本地 `可开 PR（local）`
  - 已锁定的 `fast-track` 不能把 Step 4/local proof 当作 terminal：task completion 前必须有 current-head live PR 创建/复用或事实证据，并完成 Step 5C 收敛。
- replay 只把当前 locked fast-track epoch 之后、同一事实卡中同时出现 `PR状态=存在` 与肯定的 current-head 绑定记录视为 live PR；任一后续旧、未定型、未知/不明/不确定/未确认或否定 live binding 的 head 描述都会失效既有 live fact，但“not stale / not unknown / no longer pending”等肯定 current-head 确认不得误作失效，且旧 flow、无关 `workflow_*` 字段均不得满足该门禁。
  - 一旦当前 stop condition 已是 `merge-only` / `merge+cleanup` 且 run 已进入 shared Step 5 merge path，默认允许 same-PR、in-scope writable convergence；覆盖 review-fix、CI/blocker fix、freshness `BEHIND`、conflict `DIRTY` / `CONFLICTING`、missing fresh merge-proof，以及这些 live facts 直接逼出的兼容修复
  - 上述可写收敛不会覆盖 `scope expansion`、`same-PR reopen`、权限/高风险门禁或 `convergence drag blocker`
  - 同一 PR 的受限修复只能沿现有 live PR/current-head 事实进入 fresh validation；findings 按根因形成一个 Repair Batch，只对最终 Candidate 刷新所需 lane，不得扩展范围
  - 普通“合并”完成 PR merge 后必须确认远端 PR head 已删除，并停在 `本地收尾=未执行`；不得删除本地分支或工作区；Git primary worktree 的 PR target base branch 必须包含最新 remote base，或明确报告 `主工作区基线更新=待主人决策/阻断` 与原因；这不是 cleanup
  - `主工作区基线更新=已更新` 表示 local base 已包含 remote base；在用户选择安全对齐并完成 rebase 后，local base 仍可保留本地 ahead commits。
  - plain merge 的自动更新只覆盖 clean exact match 或 clean ff-only；dirty/ahead/diverged primary base 不得被默默归为硬阻断或直接当作已更新，若用户可以选择安全对齐，必须报告 `主工作区基线更新=待主人决策`，并提供 `安全对齐 / 保持阻断 / 稍后处理` 三选项菜单。
  - 用户选择 `安全对齐` 时，skill 必须创建备份分支、stash dirty/untracked、把 local base rebase 到 remote base，然后把 stash apply 回 primary worktree 并保留 stash 备份；不得把 dirty/untracked 只留在 stash 里当作完成。
  - rebase 或 stash apply 冲突时，skill 必须停在可恢复状态，报告 backup branch、stash ref、当前 rebase/apply 状态；不得自动 abort 或自动选择 ours/theirs。
  - `main`/PR base branch 不得被 checkout 到 linked/disposable worktree；若 base branch 已由非 primary worktree 持有，merge-only 必须把主工作区基线更新报告为阻断而不是自动搬移
  - “合并并收尾 / 合并 PR 并收尾 / merge PR and cleanup”完成 PR merge 后必须进入 cleanup，包含安全删除已合并 PR head 本地分支与 PR 工作区；删除工作区是收尾的一部分
- 若 merge / cleanup 完成后，本次 merge SHA 在目标分支上触发的 CI 仍未终态，则 run 不得直接报 terminal success；必须先把共享 `Step 6 post-merge target-branch CI follow-up` 决议到 `none|sub-agent|defer`
- `Step 6` 默认使用绑定 merge SHA 的 sub-agent tracker；主 agent 通过运行时返回的 child handle 阻塞等待 tracker，不得自行轮询；tracker 不可用时报告 `tracking unavailable` 和未完成状态，不回退 watcher 或模型重试。direct/PTC transport 等价。
  - `Step 6` 的默认模型策略必须是：
    - PR CI 与 post-merge CI 观察：`gpt-6-luna` + `low`
  - merge 之后只允许对已存在且明确属于瞬态基础设施故障的 CI run rerun 一次；不得 dispatch 新 workflow、改代码、创建 follow-up PR 或直接写入 merged base
  - target-branch CI 终态后必须继续判定 `release_expected=true|false|unknown`；CI 内的 `Release Snapshot` / intent job 只能提供候选 version/tag/channel，不能证明实际发布
  - `release_expected=true` 时，仓库声明的 Release/package/container/管线所属 deployment 必须与起始 SHA、实际发布 SHA/version 形成可核验发布链并达到实际终态；否则不得报告成功收口
  - release tracking 使用 [Release Tracking](../release-tracking/SPEC.md) 的共享累计预算：无发布恢复操作 30 分钟，有已授权恢复操作最长一小时；预算耗尽必须返回 `发布状态=未终态` 与恢复锚点，不能把 target CI green 写成整个 run 完成
  - 发布失败只有已有任务授权绑定该发布身份和运行，且可证明该运行幂等、retry-safe 时才允许 rerun 已存在 run 一次；重跑后必须重新核实全部产物和部署，未解除失败或沿用重跑前成功证据均不得收口；不得盲目 dispatch、修改 merged code 或重复创建半发布产物
  - 每次远端 merge 最终输出必须有 `发布状态`；发布成功时核心元数据与产物摘要不得缺失，未触发时必须给出一行 live/repository-contract 证据
- Advisory review 仅为 Tier 1/2 或额外风险检查提供只读建议；其缺失、失败、未终态或 transcript 结构变化不得阻塞父 flow / PR skill，也不得被写成 merge proof。Tier 3/4 的 fresh current-head direct structured evidence 是独立强制门禁；缺失、不可用、stale、malformed 或 `unchecked` 时必须阻塞，有效 terminal evidence 中的 demonstrated finding 则按 `In-Scope Review Finding`、`Design-Returning Review Finding` 或 `Review Observation` disposition 处理。
- tracker 启动、认证、配额、provider、超时或终态不可得时，结论必须明确写 `tracking unavailable` 与未完成状态；不得改写为主 Agent 轮询、watcher 或自动模型重试。
- `bin/pr_skill_replay_check.py` 至少覆盖：
  - `ACTIVE_GATE_CLOSED_OUT_EARLY` 历史回归 fixture
  - 一个 `merge-ready` 正例
  - 一个 `merge+cleanup` 正例
  - 一个没有 open PR 却宣告 `Step 5C Ready` 的反例，必须报 `READY_CLAIM_WITHOUT_OPEN_PR`
  - 一个锁定 fast-track、以 Step 4/local proof task completion 但没有 live PR 的反例，必须报 `FAST_TRACK_STOPPED_BEFORE_PR`
- `merge_preflight.py` 必须只读检查 live PR head/base、candidate ref OID 和 candidate worktree；必须输出稳定 JSON，`validation=not_evaluated`，并使用 `eligible|blocked|input_stale|indeterminate` 与 `0|2|3|4|64` 退出合同。
- direct PR 的最终 merge 必须使用最后一次 `eligible` preflight 的 `merge_guard.locked_head` 作为 `--match-head-commit` 参数；能力缺失或快照/ 候选漂移必须 fail closed。

### SHOULD

- 入口 skill 顶部前 100-150 行应直接出现：
  - `merge-ready` vs `merge-only` vs `merge+cleanup` stop condition
  - `Step 5C Ready` handoff 规则
  - advisory review 不得替代 Tier 3/4 的强制 direct-evidence 门禁
- 共享真相源优先下沉到短规约，入口 skill 只保留职责、例外和输出契约，减少 partial-read 注意力漂移。

## 功能与行为规格（Functional/Behavior Spec）

### Fast-track stop condition

An authorized late-review follow-up uses the shared review-proof contract's Authorized follow-up delivery. First finish the source PR's selected flow; owner merge approval is still required. After source merge and required merge-scope facts, the same main Agent uses an independent topic branch from mainline containing the actual merge SHA and `$fast-flow` to follow-up `merge-ready / Step 5C Ready`, with its own validation, CI, tiered review, release card and owner-controlled merge. Preserve the source count and concrete authorized scope, cross-link both PRs, and reuse an existing matching follow-up. An unmerged source retains a pending handoff; this rule grants no read-only publication authority, scope expansion, or automatic recursive follow-up chain.

- `fast-track` 不再默认等同于“只把 PR 收到绿”。
- stop condition 来自最近一次明确意图，且对 generic continuation 稳定：
  - 若当前已是 `merge-ready`，后续泛化 `继续` 仍只推进到 `Step 5C Ready`
  - 若当前已是 `merge-ready`，后续明确 `合并 / 合并 PR / merge PR / merge` 必须把 stop condition 更新为 `merge-only`
  - 若当前已是 `merge+cleanup`，后续泛化 `继续 / 收尾` 必须继续 merge-path 并完成 cleanup
  - 若当前已是 `merge-only`，后续泛化 `继续` 只继承不收尾语义；后续明确“收尾/cleanup”才进入 `$pr-post-merge-cleanup`

### Shared Step 5 handoff

- `workflow PR publication procedure` 负责把 latest PR 收敛到 `Step 5C Ready`。
- `workflow PR merge procedure` 负责 final refresh、fresh merge-proof、merge、远端 PR head 删除、Git primary worktree 的 PR base 对齐或待决策/阻断报告，并且只在 `merge+cleanup` stop condition 下执行本地 cleanup；`merge-only` 只跳过本地 cleanup，不跳过 merge gate、远端分支删除或主工作区基线门禁。
- `Step 5C Ready` 本身不是“是否收尾”的答案；真正答案来自当前 stop condition。
- child PR 的 merge 不是独立任务的终态：它不触发 Step 6/release tracking，必须交回其已授权的任务协调上下文等待 integration CI 后才允许关闭 Ticket。
- parent PR 的 `Step 5C Ready` 仍不是最终 merge 授权；只有主人明确批准其当前 `PR.head.sha` 才能调用 `workflow PR merge procedure`。

### Direct PR merge preflight

- `skills/project-engineering-workflow/scripts/merge_preflight.py` 的核心输入是 `--repo`、`--pr` 和 `--candidate-root`；`--local-ref` 默认为 `HEAD`，`--expected-head` / `--expected-base` 只用于续推时检测快照漂移，`--pretty` 只改变显示。
- 脚本只调用只读的 `gh` / `git`：PR live head/base 由 GitHub 提供；candidate local OID 必须精确等于 live head；候选工作区用 porcelain v2、完整 untracked 和未忽略 submodule 状态检查。PR source branch、local/upstream 诊断和快照均写入 JSON，但不解析 `PR_ROLE`。
- `blocked` 表示 PR 非开放或候选工作区脏；`input_stale` 表示 candidate OID 或 expected head/base 不一致；必需事实读取失败为 `indeterminate`。脚本不判断 CI、review、Spec、视觉证据或 release，也不执行任何写操作。
- direct owner intent 绑定当前 PR 身份；完成所有修复和既有实时门禁后必须立即重跑 preflight，再以 `gh pr merge "$PR" --match-head-commit "$LOCKED_HEAD"` 合并。`--match-head-commit` 不可用时 fail closed；外部 head 漂移需重新取得当前 PR intent，同一 PR 范围内 Agent 产生的修复无需重新取得 intent 但必须重新验证。merge queue 入队不算合并终态。child/checkpoint/ parent 的独立精确 SHA 审批合同不变。

### Merge-path writable convergence

- `merge-ready` 只定义停靠点：latest PR 到达 `Step 5C Ready` 后可以停下，但不会自动授权在当前 PR 上继续产出新的 review-fix / merge-proof / freshness / conflict 修复提交。
- `merge-only` / `merge+cleanup` 则同时定义 merge-path 上的默认可写收敛语义：只要当前 run 已进入 shared Step 5 merge path，就默认允许 same-PR、in-scope writable convergence。
- 这层默认可写收敛覆盖：
  - reviewer feedback / review threads
  - current CI/blocker fixes
  - freshness `mergeStateStatus=BEHIND`
  - conflict `mergeStateStatus=DIRTY` / `mergeable=CONFLICTING`
  - missing fresh merge-proof
  - 以及上述 live facts 直接逼出的兼容修复
- 这层默认可写收敛不等于 `same-PR reopen`：
  - 不允许普通 merge-path 修复顺势扩范围
  - 不会重置 `PR收敛修复轮次` 或 `PR预算绑定*`
  - 仍受 shared `post-open scope freeze`、权限/风险门禁与 `convergence drag blocker` 限制

### Closeout guard

- Closeout 检查当前 PR、required CI、适用 validation、规则、发布事实，以及 Tier 3/4 所需的 fresh current-head direct structured evidence。Advisory review 仍可运行，但其 live 状态、结果或 transcript 形状不能阻止收口，也不能替代所需 evidence。

### Post-merge target-branch CI follow-up

- `merge-only` 与 `merge+cleanup` 都只解决“PR 已合 / 本地收尾是否完成”；如果目标分支上本次 merge SHA 的 CI 仍在运行，不能直接报告终态。
- `Step 6` 只追踪 `target_repo + target_branch + merge_sha` 对应的 `push` CI 与 CI check runs，排除 schedule、workflow_dispatch、release、deploy、publish。
- `后续追踪=sub-agent`：一个 `ci-tracker` 绑定一个 merge SHA；tracker 终态前主 agent 必须阻塞等待。
- `后续追踪=defer`：tracker 创建、认证、配额、provider、超时或终态不可用时，报告 `tracking unavailable` 与最小可恢复事实，不得让主 agent 自己轮询或启动 watcher。
- `Step 6` 不是 generic wait-state 的延长线，而是一次有明确 SHA 所有权的 CI 观察 barrier；已启动的 tracker 子代理直接执行 provider 轮询，不得再寻找或启动第二个 tracker；tracker 的运行时 handle 和终态由外部运行时提供，flow 不从 transcript 重建它们。
- `$flow-continue` 必须先刷新 tracker handle 状态：live handle 继续等待，终态 `passed|failed` 直接继承，终态 `incomplete|unavailable` 或 `interrupted|shutdown|not_found` 才能在保留同一 bound identity 和 retry history 的前提下创建一个新 tracker；completed handle 的旧卡不得作为新证据，不能用 `resume_agent` 把它当作 live handle。
- post-merge CI 失败时默认为 `report-only`；仅瞬态基础设施失败允许一次已有 run 的 rerun，其他失败唤醒主 agent 报告，不自动改代码。

### Post-merge repository release chain

- Step 6A target CI clear 后进入 Step 6B；release tracking 使用独立合同，避免把有副作用的发布 retry 语义混入 CI tracker。
- 发版预期由仓库 workflow/config/标签合同与绑定 merge SHA 的 live facts 共同决定。缺乏充分证据时保持 `unknown`，不能静默写成“未发版”。
- `Release Snapshot`、release intent、build artifacts 或 workflow green 只证明候选发布身份；`发布状态=已发布` 必须有实际 GitHub Release/package/container 等仓库声明产物终态。
- 专用 `release-tracker` 固定起始身份并另记实际发布 SHA；完整发布链、有限句柄等待、手动 `$flow-continue` 恢复、单次安全重跑与预算均由 [Release Tracking](../release-tracking/SPEC.md) 定义。Tracker 不可用不阻断已有授权的发布触发，但核验缺失仍保持流程未完成。本段中的旧 heartbeat 词汇仅用于历史审计兼容。
- 独立生产部署不自动进入本门禁；只有仓库把部署声明为同一 release pipeline 的组成部分时才跟踪。

### REQ-FTMI-006

At `Step 5C Ready`, `merge-ready`, `merge-only`, and `merge+cleanup` MUST read the target repository release policy and current PR facts, then return one Agent-default decision card containing publish applicability, components, channel, bump rule, predicted version, target repository/branch/PR, policy source, and collision policy. The pre-merge route is routing input only and MUST NOT establish that no release applies. Missing or conflicting policy or facts MUST remain `unknown`/blocked.

`merge-only` and `merge+cleanup` plans MUST express the existing executable rule through their current plan sections: target repository/branch, base-tag source, bump rule, channel, components, collision policy, and merge-SHA binding. They MUST NOT add retired plan-level release arrangement fields, new stop-condition values, or a final version string. Merge continuation MUST wait for explicit owner confirmation of the card, including the version expectation. One clear natural-language message MAY combine confirmation and the request to continue or merge; the Agent MUST NOT require a prescribed reply format or a second action turn. Only genuine ambiguity may trigger one concise clarification.

After merge, `release_expected` MUST be derived only from actual facts bound to `target_repo + target_branch + merge_sha`. Actual version, tag, artifacts, pipeline-owned deployments, and publication SHA MUST be verified, with a proven lineage to the fixed merge origin as defined by [Release Tracking](../release-tracking/SPEC.md). A pre-merge card, route result, CI snapshot, or release intent cannot prove post-merge publication or non- publication. Historical JSONL and history documents remain compatibility data, not new plan syntax.

### Phase-aware acceptance lifecycle

Every new direct/v1 acceptance item MUST declare `scope=plan` and `phase=pre_merge|post_merge|post_deploy`. `pre_merge` is the only phase consumed by Review Readiness, PR convergence, and Step 5C, and its evidence is bound to the Candidate SHA. `post_merge` can be recorded only after a real Merge Receipt and must bind its `merge_sha`. `post_deploy` additionally requires a structured `deployment_identity` whose source and bound SHA match the Merge Receipt SHA. A merge-ready decision card is not publication evidence and a merge-ready state is not Flow Complete. Missing authority for a later phase remains an owner-action blocker.

Historical JSONL that lacks phase is read-only compatible as `plan/pre_merge` only when its acceptance text contains no merge, release, deployment, or observation ambiguity. Ambiguous historical items are rejected and require a new plan; they are never silently promoted to a later phase.

### Replay checker

- focused checker 继续复用 `bin/pr_skill_replay_check.py`。
- 新增两类 finding：
  - `MERGE_INTENT_DROPPED_TO_PR_CONVERGENCE`
  - `ACTIVE_GATE_CLOSED_OUT_EARLY`
- Step 6 replay 只校验公开的外部 tracker card：`phase`、具体 `bound_sha`、合法 `terminal_state`、适用的 `result` 与外部 locator；它不要求同一 tracker 的启动记录、`wait_agent` 记录、child ID 或 transcript 状态卡，旧 transport 记录也不得污染外部事实。
- PR head 与 post-merge tracker 使用相同的 `phase + bound_sha + terminal_state` 外部 card 形状；direct、PTC 和其他运行时 transport 等价。checker 不解析任意 PTC JavaScript。
- 对历史回归 fixture，至少应能报出其中一个 finding。
- 必须识别流程锚点中的 stop condition 形式，例如 `收工条件=merge+cleanup` / `stop condition=merge+cleanup`，不能只识别自然语言指令。
- 必须识别 shell-wrapped `gh` merge 调用，例如 `/bin/zsh -lc 'gh pr merge ...'`、`bash -lc 'set -e; cd repo && gh pr merge ...'`。
- merge 证据必须出现在当前 active merge intent 之后，不能用早先 turn 的 merge 调用满足后续 intent。
- guarded-merge replay 必须把 `--match-head-commit <SHA>` 视为 merge 命令的必要 head guard；预检已锁定但 merge 命令缺少该 flag 时必须报 finding，不能用无 guard 的 merge 代替。

## Verification

### VER-FTMI-001

- covers: `REQ-FTMI-001`, `REQ-FTMI-003`
- `test_merge_preflight.py` and the guarded-merge replay cases verify direct intent binding, locked-head propagation, stale detection, and fail-closed behavior.

### VER-FTMI-002

- covers: `REQ-FTMI-002`
- `test_merge_preflight.py` verifies porcelain-v2 status coverage, exact local OID comparison, stable JSON, exit codes, and absence of mutating commands.

### VER-FTMI-003

- covers: `REQ-FTMI-004`
- Existing initiative/checkpoint replay suites remain unchanged and passing; the updated workflow PR merge procedure keeps their role-specific approval gates.

### VER-FTMI-004

- covers: `REQ-FTMI-005`
- `pr_skill_replay_check.py` and `flow_continue_replay_check.py` replay cases verify silent no-route continuation, target-managed label-only reconciliation, unmanaged-label protection, API label paths, and separation from Step 6 release evidence.

### VER-FTMI-005

- covers: `REQ-FTMI-006`
- `test_pr_skill_replay_check.py` verifies deterministic patch/minor/major and stable/rc candidates, component major alignment, and tag collision policy. Focused release-decision replay cases verify the confirmed card, missing card, missing confirmation, route absence, policy conflict, merge-SHA mismatch, and missing post-merge merge-SHA findings. `test_plan_contract_check.py` verifies retired plan fields, complete merge rules, final-version non-prefill, and historical JSONL compatibility.

## Acceptance Criteria

- Given `ACTIVE_GATE_CLOSED_OUT_EARLY` 历史回归 fixture When 跑 replay checker Then 必须至少报出 `ACTIVE_GATE_CLOSED_OUT_EARLY` 或 `MERGE_INTENT_DROPPED_TO_PR_CONVERGENCE`。

- Given `merge-ready intent` When latest PR 到达 `Step 5C Ready` Then skill 可停在可立即合并态，且 replay checker 通过。

- Given 当前事实是 `PR状态=不存在` When assistant 宣告 `Step 5C Ready` / `latest PR 可立即合并` Then replay checker 必须报 `READY_CLAIM_WITHOUT_OPEN_PR`，并要求改用 `可开 PR（local）` 或先进入 `workflow PR publication procedure`。

- Given 已锁定 `fast-track` When task completion 只记录 Step 4/local proof，且没有 live PR 事实 Then replay checker 必须报 `FAST_TRACK_STOPPED_BEFORE_PR`；有 current-head live PR 收敛事实时必须通过。

- Given `准备好合并 PR` When latest PR 到达 `Step 5C Ready` Then replay checker 必须按 `merge-ready` 处理，不能被 `合并 PR` 子串误判为 `merge-only`。

- Given `merge+cleanup intent` When latest PR 到达 `Step 5C Ready` Then flow 必须继续进入 `workflow PR merge procedure` 或已出现实际 merge 调用，且 cleanup 结果必须可验证。

- Given `merge-only` 或 `merge+cleanup` 已进入 shared Step 5 merge path When 当前剩余阻断主要是 reviewer feedback / review threads Then flow 必须直接续推到 `workflow PR publication procedure`，而不是再追问是否切到 PR convergence。

- Given `merge-only` 或 `merge+cleanup` 已进入 shared Step 5 merge path When latest `PR.head.sha` 缺 fresh merge-proof Then flow 必须允许 same-PR writable merge-proof convergence；若当前 run 停在“需要额外授权才能跑 writable review-loop”，则视为 contract 失败。

- Given `merge-only` 或 `merge+cleanup` 已进入 shared Step 5 merge path When live PR facts 显示 `mergeStateStatus=BEHIND`、`mergeStateStatus=DIRTY` 或 `mergeable=CONFLICTING` Then flow 必须继续 freshness / conflict auto-heal，而不是把 merge 请求降级成额外授权问题。

- Given `merge+cleanup intent` When cleanup proof 为正向值，但同句记录 `主工作区基线更新=阻断/待主人决策` Then replay checker 必须通过，不能把 merge scope 的阻断或待决策状态误判为 cleanup 未执行。

- Given `merge+cleanup intent` When 已存在正向 `cleanup_proof`，但共享 `Step 6` 仍是 `后续追踪=unchecked|blocked` Then flow 恢复必须回 `workflow PR merge procedure` 清掉 follow-up gate，不能再次续推 `$git-cleanup`。

- Given `merge+cleanup intent` When `cleanup_proof=blocked|pending|unchecked` 等非正向值，且共享 `Step 6` 仍是 `后续追踪=unchecked|blocked` Then flow 恢复不得把 cleanup 当作已完成；必须继续 `$git-cleanup`，不能直接回 `workflow PR merge procedure`。

- Given `merge-only` 或 `merge+cleanup` 已完成 merge-scope 与必要 cleanup When 本次 merge SHA 在目标分支上触发的 CI 仍未终态 Then flow 不得直接宣告 terminal success；必须先把共享 `Step 6` 决议成 `后续追踪=none|sub-agent|defer`。

- Given merge SHA 的目标分支 CI 仍在运行 When `Step 6` 需要建立 CI tracker Then flow 必须启动一个绑定该 SHA 的 `ci-tracker`，并让主 agent 进入阻塞式 `wait_agent`，不得由主 agent 轮询。

- Given target CI 的 `Release Snapshot` 输出 `release_enabled=True` 与候选版本 When 实际 Release/package/container 尚未终态 Then flow 必须继续 Step 6B，不能宣告 post-merge 完成或把 snapshot 写成已发版。

- Given 仓库合同与 live facts 证明本次 merge 不触发发版 When flow 输出最终 merge 结果 Then 必须用同一 `release_epoch + target_repo + target_sha` 的结构化 discovery 明确报告 `发布状态=未触发` 与判定依据，不能省略发版结论或复用无关/过期 skip evidence。

- Given 仓库发布链成功发布版本 When flow 报告 `发布状态=已发布` Then 版本/tag、channel、起始与实际发布 SHA、完整发布链、Release 或 workflow URL、发布时间和全部发布/部署产物摘要必须齐全并相互匹配；任何明确为 failed/cancelled/running 的 artifact 或父 release run 都不能作为发布成功证据。

- Given 仓库声明的 package/image 名称与 source repository 不同 When Step 6B 绑定实际发布产物 Then discovery 必须记录结构化 `release_surface_identities`，并按声明的产物身份验证 URL/tag/SHA；不得要求 image path 与 `target_repo` 字面相同。

- Given flow 报告 Release URL 或 workflow URL When Step 6B 宣告发布成功 Then 每个已报告链接必须绑定同一 release identity 的实际 artifact 或 `release_run_id` live fact，且版本 tag 的可选 `v` 前缀应按等价标识处理。

- Given 预期发版耗尽累计预算（无恢复操作 30 分钟，有已授权恢复操作最长一小时） When 当前 turn 停靠 Then 必须停止观察，报告 `发布状态=未终态`、post-merge 未完成与保留身份/重试记录的恢复锚点，供主人手动继续；本历史回放中的 heartbeat 术语不构成当前 tracking automation 要求。

- Given 发布 run 失败 When 缺少既有任务授权或该运行幂等、retry-safe 的 repo contract/live facts Then 不得自动 rerun；只有授权和安全证据均匹配同一发布身份与运行时才允许重跑一次，已用额度不因 tracker 或窗口重建恢复，且所有产物和部署必须有重跑后的成功证据。

- Given sub-agent 创建或阻塞等待不可用 When `Step 6` 需要 CI tracker Then flow 必须报告 `tracking unavailable`、`后续追踪=defer` 与恢复锚点，不把 watcher 或主 agent 轮询作为替代路径。

- Given 普通 `合并 / 合并 PR / merge PR` When PR merge 成功 Then flow 必须确认 `远端分支=不存在`、完成或待决策/阻断报告 Git primary worktree 的 PR base 对齐，并停在 `本地收尾=未执行`，不得调用 `$pr-post-merge-cleanup`，不得删除本地分支或 PR 工作区。

- Given 普通 `合并 / 合并 PR / merge PR` When PR merge 成功，primary base dirty/ahead/diverged 但可由用户选择安全对齐 Then flow 必须报告 `主工作区基线更新=待主人决策`，并提供 `安全对齐 / 保持阻断 / 稍后处理` 三选项菜单；不得只报告硬阻断后结束。

- Given 用户选择 `安全对齐` When skill 需要 stash dirty/untracked 才能 rebase local base Then skill 必须在 rebase 后把 stash apply 回 primary worktree，并保留 stash 备份；不得把 dirty/untracked 只留在 stash 中。

- Given 普通 `合并 / 合并 PR / merge PR` When replay 里出现 PR merge 调用、远端分支删除证据，且没有后续 `$pr-post-merge-cleanup` 调用或 cleanup 结果 Then replay checker 必须通过，因为普通合并不是收尾。

- Given 普通 `合并 / 合并 PR / merge PR` When PR merge 成功但没有远端 PR head 删除证据 Then replay checker 必须报 `REMOTE_BRANCH_NOT_DELETED_AFTER_MERGE`，不能把远端分支遗漏归到本地 cleanup。

- Given 普通 `合并 / 合并 PR / merge PR` When 只有 assistant 最终状态写 `远端分支=不存在`，但没有删除命令或工具输出 Then replay checker 必须报 `REMOTE_BRANCH_NOT_DELETED_AFTER_MERGE`。

- Given 普通 `合并 / 合并 PR / merge PR` When unrelated command output contains `remote branch: not found` or `[deleted]` Then replay checker 不能把它当成远端 head 删除证据。

- Given 普通 `合并 / 合并 PR / merge PR` When `gh pr merge --delete-branch` 合并成功但同一输出报告 branch delete 失败 Then replay checker 必须报 `REMOTE_BRANCH_NOT_DELETED_AFTER_MERGE`。

- Given 普通 `合并 / 合并 PR / merge PR` When 已知 `headRefName` 且删除输出里的 branch 不是该 PR head Then replay checker 必须报 `REMOTE_BRANCH_NOT_DELETED_AFTER_MERGE`。

- Given 普通 `合并 / 合并 PR / merge PR` When PR head 以自然句记录为 `PR head branch: topic.` Then replay checker 必须按 `topic` 匹配后续删除证据，不能把句尾标点当成分支名。

- Given 普通 `合并 / 合并 PR / merge PR` When PR head 来自 fork 或受权限/保护规则阻断无法删除 Then replay checker 允许带有 fork、权限或保护规则具体原因的远端删除豁免，不误报远端分支遗漏。

- Given 普通 `合并 / 合并 PR / merge PR` When replay 使用 `gh api repos/.../git/refs/heads/<branch> -X DELETE` Then replay checker 必须识别为远端 head 删除证据。

- Given 普通 `合并 / 合并 PR / merge PR` When `gh api ... -X DELETE` 输出 `gh:` 或 HTTP 4xx/5xx 错误 Then replay checker 必须报 `REMOTE_BRANCH_NOT_DELETED_AFTER_MERGE`。

- Given 普通 `合并 / 合并 PR / merge PR` When 工具输出确认 `remote branch: not found` Then replay checker 必须把它视为远端 head 已不存在，而不是通用命令失败。

- Given 普通 `合并 / 合并 PR / merge PR` When replay 使用 `git push origin --delete <branch>` 或 `git push origin -d <branch>` Then replay checker 必须识别为远端 head 删除证据。

- Given 普通 `合并 / 合并 PR / merge PR` When replay 使用 `git push origin --delete <branch> && gh pr view ...` Then replay checker 必须按第一个 shell segment 识别被删除分支，不能把后续命令参数当成分支名。

- Given 普通 `合并 / 合并 PR / merge PR` When merge 与 `git push origin --delete <branch>` 包在 `bash -lc` / `zsh -lc` 内 Then replay checker 必须递归解析 wrapper 内的 shell segment，并识别远端 head 删除证据。

- Given 普通 `合并 / 合并 PR / merge PR` When `git push origin --delete <branch>` 后接输出重定向或管道 Then replay checker 必须只用 `git push` 的 refspec 参数识别被删除分支，不能把重定向或管道参数当成分支名。

- Given 普通 `合并 / 合并 PR / merge PR` When replay 使用 `git push origin :refs/heads/<branch>` Then replay checker 必须把它归一为 `<branch>` 后与 PR head 匹配。

- Given 普通 `合并 / 合并 PR / merge PR` When merge 与远端删除写在多行 shell script 中 Then replay checker 必须按换行分段识别后续 `git push --delete`。

- Given 普通 `合并 / 合并 PR / merge PR` When PR head 包含 `+` 这类合法 ref 字符 Then replay checker 必须完整捕获分支名并与删除证据匹配。

- Given 普通 `合并 / 合并 PR / merge PR` When replay 没有 PR head 证据但删除了任意远端分支 Then replay checker 必须报 `REMOTE_BRANCH_NOT_DELETED_AFTER_MERGE`，不能把任意分支删除当成 PR head 删除。

- Given 普通 `合并 / 合并 PR / merge PR` When `git push --delete` 成功输出里的分支名包含 `error` / `failed` 等词 Then replay checker 仍必须识别 `[deleted] <branch>` 为成功删除证据。

- Given 普通 `合并 / 合并 PR / merge PR` When final closeout 写 `不是 fork PR head；远端分支=存在` Then replay checker 必须报 `REMOTE_BRANCH_NOT_DELETED_AFTER_MERGE`，不能把否定 fork 诊断当成删除豁免。

- Given 普通 `合并 / 合并 PR / merge PR` When final closeout 只写 `远端分支=阻断`，但没有 fork、权限或保护规则证据 Then replay checker 必须报 `REMOTE_BRANCH_NOT_DELETED_AFTER_MERGE`。

- Given `合并并收尾 / 合并 PR 并收尾 / merge and cleanup / merge PR and cleanup` When replay 里出现 PR merge 调用但没有后续 `$pr-post-merge-cleanup` 调用或 cleanup 结果 Then replay checker 必须报错，不能把“只合并未收尾”判为收尾完成。

- Given `merge+cleanup intent` When final closeout 只写英文 `Merged pull request ...; cleanup not executed` Then replay checker 必须报错，英文 merged wording 也算 merge success。

- Given `merge+cleanup intent` When PR merge 调用被 GitHub 拒绝且结果仍是未合并 Then replay checker 不得要求 cleanup proof，因为未合并 PR 没有 post-merge cleanup 前提。

- Given `merge+cleanup intent` When replay 只出现“本地收尾=完成”这类 assistant 总结，但没有 `$pr-post-merge-cleanup`、`cleanup_skill_invoked=yes` 或 `cleanup_proof` Then replay checker 必须报错，不能把总结文案当作 cleanup 证据。

- Given `merge+cleanup intent` When replay 出现“未调用 `$pr-post-merge-cleanup` / 本地收尾=未执行”这类否定句 Then replay checker 必须报错，不能把否定句中的 skill 名称当作 cleanup 证据。

- Given `merge+cleanup intent` When replay 出现“不会调用 / 不调用 `$pr-post-merge-cleanup`”这类否定句 Then replay checker 必须报错，不能把否定句中的 skill 名称当作 cleanup 证据。

- Given `merge+cleanup intent` When replay 只承诺稍后生成 `cleanup_proof`，或写出 `cleanup_proof=未检查` Then replay checker 必须报错，不能把字段名或 pending 值当作 cleanup 证据。

- Given `merge+cleanup intent` When replay 写出 `cleanup_proof=稍后生成 / later / future` Then replay checker 必须报错，不能把未来占位值当作 cleanup 证据。

- Given `merge+cleanup intent` When replay 只承诺“接下来会调用 `$pr-post-merge-cleanup`” Then replay checker 必须报错，不能把未来动作承诺当作 cleanup 证据。

- Given 普通 `合并 / merge` When replay 只有诊断命令或搜索结果提到 `gh pr merge` Then replay checker 必须报错，不能把命令文本命中当作真实 merge 调用。

- Given 普通 `合并 / merge` When replay 使用 `gh --repo owner/repo pr merge ...` Then replay checker 必须识别为真实 merge 调用，不能误报 dropped-to-PR-convergence。

- Given 普通 `合并 / merge` When replay 使用 `bash -lc` / `zsh -lc` 包裹真实 `gh pr merge ...` Then replay checker 必须识别为真实 merge 调用。

- Given 普通 `合并 / merge` When replay 使用 `set -e; cd repo && gh pr merge ...` 这类 shell script 包裹真实 merge Then replay checker 必须识别为真实 merge 调用。

- Given 普通 `合并 / merge` When replay 在同一 shell command 里先运行 `gh pr view ...` 再运行 `gh pr merge ...` Then replay checker 必须扫描后续 segment 并识别真实 merge 调用。

- Given 普通 `合并 / merge` When replay 使用 `shell` tool 的 `command: ["bash", "-lc", "gh pr merge ..."]` 数组形态 Then replay checker 必须识别为真实 merge 调用。

- Given 普通 `合并 / merge` When replay 使用 path-qualified `gh`，例如 `/opt/homebrew/bin/gh pr merge ...` Then replay checker 必须识别为真实 merge 调用。

- Given 普通 `合并 / merge` When replay 早先已有 merge 调用，但后续最新 merge intent 到达 `Step 5C Ready` 后未再次 merge Then replay checker 必须报错，不能用旧 merge 调用满足新 intent。

- Given 用户说 `准备好合并并收尾` When replay 到达 `Step 5C Ready` 后直接完成 Then replay checker 必须按 `merge+cleanup` 处理并报错，不能被 `准备好合并` 子串降级为 `merge-ready`。

- Given 普通 `合并 / merge` When replay 使用只读 `gh api repos/.../pulls/.../merge` 探测 merge 状态 Then replay checker 必须报错，只有显式 mutating method 的 `gh api` merge 调用才算真实 merge。

- Given 普通 `合并 / merge` When replay 只运行 `gh pr merge --help` Then replay checker 必须报错，help / non-execution flags 不能算真实 merge 调用。

- Given 早先是 `merge+cleanup intent` When 主人后来明确改成 `准备好 PR / merge-ready` Then replay checker 必须按最新 stop condition 处理，允许停在 `Step 5C Ready`。

- Given `merge+cleanup intent` When replay 只有诊断命令或搜索结果提到 `cleanup_proof=allowed_complete` Then replay checker 必须报错，cleanup proof 必须来自可信最终收尾状态。

- Given 同一流程锚点同时出现 `准备好合并` 与 `收工条件=merge+cleanup` When replay 到达 `Step 5C Ready` 后直接完成 Then replay checker 必须按 `merge+cleanup` 处理并报错。

- Given direct PR 已通过最终 merge preflight 并锁定 live head When replay 出现真实 `gh pr merge` 调用 Then 调用必须带 `--match-head-commit <locked head>`；缺少该参数必须报 `MERGE_HEAD_GUARD_MISSING`，能力不支持时必须 fail closed。

- Given assistant 流程锚点包含 `收工条件=merge+cleanup` 且同句备注 `no cleanup proof yet` When replay 到达 `Step 5C Ready` 后直接完成 Then replay checker 必须保留 `merge+cleanup` 锚点并报错。

- Given assistant 只是列出“准备好 PR / 合并 PR / 合并并收尾”作为选项 When 没有 user cleanup intent 且没有 assistant `merge+cleanup` state anchor Then replay checker 不得把选项文本记录为实际 cleanup intent。

- Given Tier 1/2 flow 的 advisory review 尚未终态或 transcript 不可用 When 当前 PR、required CI、validation 与发布事实均已终态 Then replay checker 不得因 advisory review 状态或 transcript 形状阻止 closeout。

- Given Tier 3/4 flow 的 current-head direct structured evidence 缺失、不可用、stale、malformed 或为 `unchecked` When 当前 PR、required CI、validation 与发布事实均已终态 Then replay checker 必须阻止 closeout，直到对应 direct evidence 对当前 base/head 具备有效 terminal result，并完成 disposition；terminal `evidence_status=clear` 携带的 demonstrated finding 不得仅因存在 blocker 字样而被改写为 `unchecked`。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `python3 -m unittest discover -s skills/project-engineering-workflow/scripts -p 'test_merge_preflight.py'`
- `python3 -m py_compile bin/pr_skill_replay_check.py`
- `python3 bin/pr_skill_replay_check.py --cases docs/specs/fast-track-merge-intent-closeout/replay/cases.txt`
- `python3 bin/instruction_architecture_check.py --repo-root .`
- `bun run bin/plan_contract_check.ts --cases skills/dev-plan/references/replay-cases/CASES.txt`
- `git diff --check`

### Quality checks

- 目标 skill 前 150 行人工 spot-check
- 确认 shared contract 承担主语义，入口 skill 不再大段重复

## 风险 / 假设

- 风险：若未来新增新的 PR 入口 skill/prompt，但没有引用 shared short contract，可能再次把 `Step 5C Ready` 误当成统一终点。
- 风险：过度瘦身会漏掉现有边界条件，因此本次只下沉共享语义，不删除入口 skill 的专属 guardrail。
- 假设：focused replay checker 足以覆盖这类流程语义回归，不需要为 skills 引入更重的自动化框架。

## 参考（References）

- Session `019cfa20-c48c-75e2-9acd-39c94c3e1201`
- `sessions/2026/03/17/rollout-2026-03-17T12-49-37-019cfa20-c48c-75e2-9acd-39c94c3e1201.jsonl`
- `docs/specs/pr-skill-diagnosis-thinning/SPEC.md`
- `docs/specs/flow-continue-lock-guard/SPEC.md`
- `docs/specs/review-proof-dedupe-wait-guard/SPEC.md`
