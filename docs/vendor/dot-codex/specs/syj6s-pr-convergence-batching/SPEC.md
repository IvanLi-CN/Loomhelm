# PR convergence batching

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

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
- 为自动收敛增加明确止损阈值，避免无界 review-fix-push 循环。

### Non-goals

- 不新增新的顶层三态字段。
- 不取消现有 shared wait budget，也不重写 freshness gate / wait-state closeout 的既有语义。
- 不修改 `gh CLI` 远端控制面，不引入新的远端自动化通道。
- 不把 `$local-merge-flow` 默认改成 PR 路径。

## 范围（Scope）

### In scope

- 更新 `$project-engineering-workflow` 的 Step 4/5 共享契约，并用 `ci-tracking-short-contract.md` 集中 CI tracker 不变量。
- 收紧 `$codex-review-loop` 的批量修复与验证策略。
- 收紧 `$pr-create` 的首轮并行与 checks 缺席诊断规则。
- 对齐 `$fast-flow` 与 `$pr-create` 的自动收敛边界。
- 更新 `docs/specs/README.md` 与本规格文档。

### Out of scope

- 变更任何运行时代码或 `gh CLI` 远端操作契约。
- 新增自动化测试框架。
- 修改 `Step 5L` 的本地合主干业务语义。

## 需求（Requirements）

### MUST

- 对高风险改动进入 PR 路径时，必须在首个远端变更前完成一次 `pre-PR local proof`。
- `pre-PR local proof` 不能替代 PR 阶段绑定当前 `PR.head.sha` 的 fresh review proof。
- 从 `normal-flow` / `local-merge-flow` 的本地 `Step 4 Ready` 恢复进入 PR 路径时，也必须重新检查这道高风险 gate；不得因为“之前已到 Step 4 Ready”就跳过 `pre-PR local proof`。
- 若当前 flow 尚未授权本地写入，`pre-PR local proof` 只能先以只读 proof 形式执行；只有主人已授权自动收敛时，才允许把它升级成会落本地修复提交的本地收敛。
- 任何被描述为 read-only 的 PR/local proof，都必须走单次直接 `codex review` 证据路径；不得借用可写的 `$codex-review-loop` 再靠文字声明“这次当作只读”。
- PR 首轮仍然允许 `CI-Operator` 与第一轮 PR-stage review 并行启动。
- `CI-Operator` 必须服从共享 CI tracking contract；其默认模型为 `gpt-5.6-luna + low`，override 不可用时可继承主 agent 配置，但不得改变 tracker 的只读职责。
- PR 阶段默认按根因批量修复；同一轮允许多 commit，但只允许一次 push。
- 验证 receipt 必须绑定当前 candidate 的输入、命令、acceptance evidence 和 SHA；它没有第二套验证分类、独立预算或锁。repair push 产生的新 `PR.head.sha` 必须重新建立当前 SHA 的 evidence。
- 若最新 `head_sha` 在 PR 创建或 push 后 `10 分钟` 内仍无 checks/workflow 证据，必须优先进入诊断；不得使用 dispatch，新 run 只允许在已有 run 明确属于瞬态基础设施失败时 rerun 一次。
- 但若能证明当前仓库/当前 SHA 本来就不期望自动 checks，则 absence 只能记为事实，不得单独上抛 blocker。
- 对同一个 open PR 的同一轮收敛会话，每个 review epoch 最多允许 `3` 个 repair permit；所有 code review wave（包括 repair）固定为 `4 x Luna+high` 加最多 `2` 条专项 lane。无进展可进入诊断，但不能在剩余 permit 尚未耗尽时使 epoch `NON_CONVERGENT`；repair push 产生的新 `PR.head.sha` 不会重置预算。
- 当 PR 收敛未在当前 turn 终态结束时，必须把 `PR收敛修复轮次=<n>/3` 及其 `PR预算绑定base_sha` / `PR预算绑定workflow_facts` 写入状态输出，供后续续推恢复预算。
- 若恢复时预算绑定缺失或已 stale，只能在能证明“当前 PR 事实集从未进入过自动 PR convergence / repair batch”时初始化 `0/3`；否则必须上抛 blocker，不得静默把在途 PR 的预算清零重开。
- final merge proof 是当前 SHA 的单条 `Sol` lane。其有效 blocker 必须回到当前 epoch 的剩余 repair permit，形成新 SHA 后再次完成普通 code review wave 和 final proof；只有 permit 已耗尽时才进入 convergence drag blocker。

### SHOULD

- 高风险改动的判定口径应在 shared workflow、review-loop、PR skill/prompt 里保持一致。
- 验证命令应由当前改动、仓库要求和已有 acceptance evidence 决定，并保持 receipt 的 current-SHA 绑定。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- Step 4 对于将要进入 PR 路径的 run，先判断是否命中高风险改动：
  - 命中条件至少包括：共享可变状态/持久化状态变更、明显 race-prone 或异步状态机流程、前后端契约同轮变化、workflow/prompt/skill 规则改动。
  - 命中后，进入 Step 5 前先执行一次本地 `pre-PR local proof`，并完成相关本地验证。
- Step 5 的首轮并行保持不变：
  - `main-agent` 负责首个 push / create-or-reuse PR；`CI-Operator` 只负责绑定当前 `PR.head.sha` 的 first-round CI tracking，并使用 `gpt-5.6-luna + low`。
  - `main-agent` 启动 tracker 后必须进入阻塞式 `wait_agent`，tracker 返回前不得自行轮询 CI。
  - `main-agent` 负责首轮 PR-stage review 与必要的本地修复。
- 首轮并行后进入 main-only convergence：
  - 合并本轮 review findings、CI failure pack 与 spec-sync 建议。
  - 按根因分组修复。
  - 按当前改动、仓库要求和 acceptance evidence 运行必要验证。
  - 一轮只 push 一次。
- 每份 validation receipt 只描述实际执行的输入、路径、命令、acceptance evidence 和 candidate SHA。相同 execution identity 可复用已通过的 receipt；任何新的 candidate SHA 都需要其自身的 evidence，且不消耗类别配额。
- Checks absence fast diagnosis：
  - 当最新 `head_sha` 在 PR 创建或 push 后 `10 分钟` 内没有 check runs / workflow evidence，必须优先读取 workflows / workflow runs / labels / trigger facts。
  - 仅当已有 run 明确属于瞬态基础设施失败时，允许对同一 SHA 做一次 rerun；不得 dispatch 新 workflow。
  - 若仍无证据，返回 actionable blocker，而不是继续视作纯等待态。

### Edge cases / errors

- `pre-PR local proof` 若在同一次本地 review-loop invocation 内完成修复并对最新 `head_sha` 给出 clear 结论，则该 proof 直接绑定最新 `head_sha`；只有当它对新 `head_sha` 没有给出最终 clear 结论时，旧 proof 才失效并需要重跑。
- 首轮并行后若 `PR.head.sha` 或 `PR.base.sha` 变化，PR 阶段 proof 和 CI 状态都必须按最新 PR 事实重置；repair permit 只按合法 epoch 规则继承或重开。
- `PR预算绑定workflow_facts` 只能包含稳定可重建的策略事实，不能包含 `checks_expected` 这类会随普通等待推进而变化的运行态诊断结果。
- 当自动收敛因阈值触发停止时，不得再用“继续自动修一点点”掩盖；必须显式说明当前属于 convergence drag blocker。
- 无进展诊断不会绕过或提前耗尽剩余 repair permit；只有三次 permit 用尽且仍有有效 blocker 才能进入 convergence drag blocker。

## 验收标准（Acceptance Criteria）

- Given 高风险改动即将从 Step 4 进入 PR 路径 When 命中风险判定 Then 流程必须先完成一次 `pre-PR local proof`，再允许首个远端变更。

- Given 首个 PR round 刚启动 When checks 与 PR-stage review 可以并行 Then 流程仍应并行启动，而不是整体串行化。

- Given 首轮仍需要创建 `CI-Operator` sub-agent When 外层流程启动该远端协作轨 Then 应使用 `model=gpt-5.6-luna` 与 `reasoning_effort=low`，并让 `main-agent` 通过阻塞式 `wait_agent` 等待 tracker 终态。

- Given 同一轮 PR-stage review 返回多条 in-scope findings When 主代理处理本轮阻塞项 Then 必须先按根因合并为一个修复批次，再进行一轮验证，并且该轮只 push 一次。

- Given 最新 `head_sha` 在 PR 创建或 push 后 `10 分钟` 内没有 checks/workflow 证据 When 流程评估当前门禁 Then 必须优先进入诊断路径；不得 dispatch 新 workflow，只有已存在的瞬态失败 run 才允许一次 rerun。

- Given 同一个 open PR 的同一轮收敛会话里，`PR.base.sha` / workflow 事实不变 When 三个 repair permit 已耗尽且 final merge proof 或普通 wave 仍有有效 blocker Then 自动收敛必须停止，并输出显式 convergence drag blocker。

- Given 当前 SHA 的 final merge proof 返回有效 blocker When 当前 epoch 仍有 repair permit Then 必须授权一个普通 repair wave；该 repair 产生的新 SHA 重新经历 `4 x Luna+high + 最多 2 条专项 lane` 的 code review，随后再运行新的单 lane final merge proof。

- Given `normal-flow` / `local-merge-flow` 从本地 `Step 4 Ready` 续推到共享 PR 路径 When 当前改动命中高风险 gate，且当前本地 `HEAD` 还没有绑定当前 base 事实的 `pre-PR local proof` Then 必须先补这次本地 proof，再允许首个远端 push / PR 创建。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: N/A
- Integration tests: 通过文档契约审阅与规则交叉检查验证
- E2E tests (if applicable): N/A

### Quality checks

- `git diff --check`
- 受影响 skill/prompt 中的 `pre-PR local proof`、`10 分钟`、`一次 push`、三次 repair permit 与 final merge proof 文案交叉检查

## 方案概述（Approach, high-level）

- 在 shared workflow 层定义何时前置 proof、何时进入 PR 并行、何时停止自动收敛。
- 在 review-loop 与 PR skill/prompt 层把 shared contract 翻译成执行规则，保证所有入口一致。
- 保留真正有价值的并行，把低效的小颗粒重复并行改成批量收敛。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：高风险改动判定过宽会增加本地 proof 次数；判定过窄则仍可能把明显问题拖到 PR 阶段。
- 风险：不同仓库的 workflow 触发方式不同，checks 缺席诊断只能定义“先查，再对已存在的瞬态失败 run rerun 一次”的保守路径。
- 需要决策的问题：None
- 假设：`10 分钟` checks 缺席诊断阈值和每个 epoch `3` 次 repair permit 阈值适合作为默认规则。

## 参考（References）

- Session `019cea6c-927c-79d2-83aa-50fb5073509e`
- `docs/specs/pr-freshness-gate/SPEC.md`
- `docs/specs/pr-wait-state-closeout/SPEC.md`
