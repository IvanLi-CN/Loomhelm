# PR 续推 skill 瘦身与诊断优先级收敛

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- session `019cecc3-be31-75e2-86f1-805dc93bd90d` 暴露出两层问题：
  - agent 在已有 `Review Policy Gate=success` 且描述明确为 `approval not required` 的前提下，仍把空 reviews 列表推断成“最可能缺 approval”；
  - 上一条回复已经给出“继续轮询 mergeable”或“直接继续合并流程”两个明确后续分支，用户只说泛化“继续”后，agent 没有续接该未完成分支，而是切回新的弱推断阻塞。
- 当前 PR 续推栈由 `$project-engineering-workflow`、`$flow-continue`、`$pr-create`、`$pr-merge` 共同定义，但 mergeability / wait-state / approval 诊断规则在多个 skill 中重复铺开，正文过长且 partial-read 场景下容易抓错主线。
- 仓库里已存在 `docs/specs/pr-freshness-gate/SPEC.md`、`docs/specs/pr-wait-state-closeout/SPEC.md`、`docs/specs/flow-continue-lock-guard/SPEC.md`、`docs/specs/pr-post-open-scope-freeze/SPEC.md` 等多轮补丁，说明问题不再是“缺一条单独规则”，而是需要把共享规则收敛成更短、更稳定的真相源，再让入口 skill 只保留自己的职责。

## 目标 / 非目标

### Goals

- 提炼一份共享 PR 诊断短规约，统一 `mergeable` 优先级、approval 正证据优先级、泛化 `继续` 的 promise-resume 规则，以及 wait-state 的停靠语义。
- 将 `$flow-continue`、`$pr-create`、`$pr-merge` 压缩成薄入口：只保留恢复/建 PR/merge 的职责、特殊例外和输出契约，不再重复整段 PR 诊断规则。
- 用 focused replay checker 把本次事故模式固化为可回放失败样例，并覆盖至少一个 conflict 误诊断负例和两个正例。
- 保证相关 skill 在 partial-read 场景下，前 100-150 行即可看到本次事故相关的关键禁止项。

### Non-goals

- 不重写整个软件工程流程，也不对 `fast-flow` / `normal-flow` / `local-merge-flow` 做第二轮全量瘦身。
- 不修改 `gh CLI` 远端控制面、Codex runtime 或官方 session 机制。
- 不引入新的测试框架或外部依赖。

## 范围（Scope）

### In scope

- 更新 `docs/specs/README.md` 与本规格。
- 新增共享 PR 诊断短规约引用资产。
- 更新 `$project-engineering-workflow`、`$flow-continue`、`$pr-create`、`$pr-merge`。
- 新增 focused replay checker 与 replay fixtures / cases。

### Out of scope

- 修改实现代码仓库的业务逻辑。
- 将现有所有 flow/prompt 入口统一迁移到新的资产结构。
- 为 skills 引入复杂 AST/LLM 级自动测试。

## 需求（Requirements）

### MUST

- 共享 PR 诊断短规约必须明确以下优先级：
  - `mergeable == false` 或 `mergeable_state == dirty`：conflict hard-stop。
  - `mergeable_state == behind`：先 freshness / branch-update，不得继续消耗 review/CI/spec-sync。
  - `mergeable_state == blocked`：若无 stale/conflict 事实，仅继续普通 checks/review/spec 门禁。
  - `PR.head.sha` 或 `PR.base.sha` 变化：旧 checks / proof / spec verdict 失效。
- 只要存在显式 approval 正证据，例如：
  - `Review Policy Gate` / status context 明示 `approval not required`
  - 或明示 `approval satisfied` 则 review approval gate 必须判 clear，禁止再用“reviews 为空”、`review comments=[]` 之类弱信号覆盖。
- 只有在存在直接负证据，或缺少更强证据且仓库规则明确要求 approval 时，才允许把“缺 approval”报告为 blocker。
- 若上一条 agent 回复已给出明确下一步分支，用户随后只说泛化“继续 / 推进流程 / 你直接做吧”，则必须优先续接那个未完成分支，不得临时改成新的弱推断阻塞。
- `$flow-continue`、`$pr-create`、`$pr-merge` 都必须引用同一份共享短规约，而不是各自重写一遍。
- focused replay checker 至少覆盖：
  - 真实 session `019cecc3-be31-75e2-86f1-805dc93bd90d`
  - 一个 `dirty/conflict` 被误报成 approval blocker 的负例
  - 一个 `blocked + approval not required` 的正例
  - 一个 `dirty/conflict` 被正确报告为冲突的正例

### SHOULD

- 入口 skill 的顶部可见区域（前 100-150 行）应直接出现“approval 正证据优先于空 reviews”和“generic continue 续接已承诺分支”的禁止项。
- 改造后，目标 skill 正文应显著缩短，重复说明集中到共享引用资产。

## 功能与行为规格（Functional/Behavior Spec）

### Shared PR diagnosis contract

- 共享短规约只承担四类判断：
  - mergeability 优先级；
  - approval 证据优先级；
  - promise-resume 规则；
  - 外部门禁等待态与 `下一门禁` 的区分。
- 共享 workflow 仍是 Step 5 的真相源，但具体 PR 诊断正文不再直接散落在每个入口 skill 中。

### Thin entry skills

- `$flow-continue`
  - 负责恢复顺序、flow 锁定、promise-resume、路由优先级。
  - 进入 PR 阶段后，只根据共享短规约决定去 `$pr-create` 或 `$pr-merge`，不再重复解释 approval/blocked/dirty 语义。
- `$pr-create`
  - 负责 PR 创建/复用、首轮 freshness gate、CI/review/spec 并行编排、wait-budget。
  - 仅保留“本 skill 的特殊例外”，例如本地 ahead 未 push 时允许先 push 再重读 mergeability。
- `$pr-merge`
  - 负责 merge 前 final refresh、behind/conflict 分流、fresh merge-proof gate、merge 与 cleanup。
  - 仅保留 merge-path 独有 guardrail；approval 解释统一引用共享短规约。

### Replay checker

- focused checker 读取 JSONL replay，提取：
  - mergeability 事实；
  - approval 正证据；
  - assistant 已承诺的 merge-path 分支；
  - generic continue；
  - assistant 的 approval-blocker 假设。
- 当 replay 命中以下模式时必须报错：
  - `approval not required` / `approval satisfied` 已出现，后续 assistant 仍把 approval 报成 blocker；
  - `mergeable_state == dirty` 或 `mergeable == false` 已出现，后续 assistant 仍把 approval 报成 blocker；
  - assistant 已承诺 merge-path 后续，generic continue 之后却没有续接该分支而改成 approval 弱推断。

## 验收标准（Acceptance Criteria）

- Given session `019cecc3-be31-75e2-86f1-805dc93bd90d` When 跑 focused replay checker Then 必须至少报出 `APPROVAL_EVIDENCE_IGNORED`，且最好同时报出 `PROMISED_MERGE_BRANCH_NOT_RESUMED`。

- Given replay 中已有 `mergeable_state == dirty` When assistant 结论说“最可能缺 approval” Then checker 必须报 `CONFLICT_MISDIAGNOSED_AS_APPROVAL`。

- Given replay 中已有 `approval not required` When assistant 仅报告“blocked 需继续看 mergeability/checks” Then checker 必须通过。

- Given replay 中已有 `mergeable_state == dirty` When assistant 结论直接报告冲突/不可合并 Then checker 必须通过。

- Given `$flow-continue` / `$pr-create` / `$pr-merge` 的顶部片段 When 只读前 100-150 行 Then 应能看到共享短规约引用、approval 正证据优先级、以及 generic continue 续接 promise 的关键约束。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `python3 -m py_compile bin/pr_skill_replay_check.py`
- `python3 bin/pr_skill_replay_check.py --cases docs/specs/pr-skill-diagnosis-thinning/replay/cases.txt`
- `git diff --check`

### Quality checks

- 目标 skill 的前 150 行人工 spot-check
- 重复规则 grep：确认 approval / mergeability 解释已集中到共享短规约

## 风险 / 假设

- 风险：若未来新增新的 PR 入口 skill/prompt，但不引用这份共享短规约，可能重新出现 partial-read 误诊断。
- 风险：skill 瘦身若删掉过多 merge-path 特例，可能损失已有边界条件；因此仅抽走共用规则，入口 skill 独有例外保留。
- 假设：以 focused replay checker 覆盖这次事故模式，足以替代大而全的 skill 自动化测试框架。

## 参考（References）

- Session `019cecc3-be31-75e2-86f1-805dc93bd90d`
- `sessions/2026/03/14/rollout-2026-03-14T22-32-57-019cecc3-be31-75e2-86f1-805dc93bd90d.jsonl`
- `docs/specs/pr-freshness-gate/SPEC.md`
- `docs/specs/pr-wait-state-closeout/SPEC.md`
- `docs/specs/flow-continue-lock-guard/SPEC.md`
