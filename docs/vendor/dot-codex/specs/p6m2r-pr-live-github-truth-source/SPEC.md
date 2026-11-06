# PR live GitHub 真相源

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 这轮问题不是缺少某一条 `behind` / `dirty` 规则，而是 agent 在解释“PR 为什么现在不能 merge”时，仍会把历史 assistant 回答、旧状态总结或空 reviews 之类弱信号当成当前 blocker 依据。
- 通过 `gh CLI` 刷新的 GitHub 当前事实面已经足够给出当前 blocker：`gh pr view --json state,closed,mergedAt,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefOid,reviewDecision,statusCheckRollup` 提供 PR 状态、mergeability 与 head/base SHA 等核心事实，`gh api` / `gh run` 提供 checks、workflow 与 review-policy 事实。
- live 样本已经说明旧做法会误导：
  - `IvanLi-CN/codex-vibe-monitor#144`：通过 `gh CLI` 刷新的事实集里 reviews 为空，但 `Review Policy Gate=success`，不能把空 reviews 报成 approval blocker。
  - `IvanLi-CN/codex-vibe-monitor#323`：通过 `gh CLI` 读取时 PR 已 `merged=true` / `state=closed`，不应该再把历史 blocker 口径延续到当前结论里。

## 目标 / 非目标

### Goals

- 把“当前 PR blocker 真相源”明确收敛到 `gh CLI` 刷新的 GitHub 当前事实集，而不是 assistant 历史回答。
- 统一 shared Step 5、`$flow-continue`、`$pr-create`、`$pr-merge` 与 `pr-*` prompts 的口径。
- 明确历史 assistant 文本只能用于 promise-resume / stop condition，不得用于当前 blocker inference。

### Non-goals

- 不恢复 replay 驱动的诊断策略，也不新增 replay fixtures。
- 不改 `gh CLI` 远端控制面，不新增外部服务。
- 不重写整个 Step 5 工作流，只收紧 blocker 真相源与 reducer 顺序。

## 范围（Scope）

### In scope

- `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`
- `prompts/pr-create.md`
- `prompts/pr-merge.md`
- `docs/specs/README.md`

### Out of scope

- `bin/pr_skill_replay_check.py`
- focused replay fixtures / cases
- 业务仓库代码实现

## 需求（Requirements）

### MUST

- 在报告“PR 当前为什么不能 merge”前，必须先用 `gh CLI` 刷新当前 GitHub 事实集，最少包括：
  - `gh pr view --json state,closed,mergedAt,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefOid,reviewDecision,statusCheckRollup`（或等价 `gh api` 字段）
  - `gh api` / `gh run` 提供的 current commit status、check runs、workflow runs 与 review-policy 事实
- 只有当 live status 仍把 review policy 留作真实候选 blocker 时，才继续读取 reviews / review comments。
- 历史 assistant 回答、旧状态总结、流程锚点都不得直接作为“当前 PR blocker”证据。
- 历史 assistant 文本只允许用于：
  - 续接已经承诺的下一步分支
  - 保留当前 stop condition / merge intent
- shared reducer 必须先看 live `state/merged/draft/mergeable/mergeable_state/head.sha/base.sha`，再判定 draft / conflict / behind / blocked / checks / review。
- `mergeable_state=blocked` 只能视为顶层 gate shape，必须继续按 live `checks/workflows -> review policy -> review threads -> deployments/merge queue/rules` 下钻；若当前 live surfaces 仍未显出具体 gate，只能报告“GitHub 当前仍将该 PR 标记为 blocked，但具体门禁尚未在可见状态面中显出”或等价当前事实描述，不得猜成 approval blocker。
- `approval not required` / `approval satisfied` / `Review Policy Gate=success` 这类 live 正证据优先于空 reviews、空 comments、旧 prose。
- `PR.head.sha` 或 `PR.base.sha` 一旦变化，旧 blocker 口径、checks/proof/spec verdict 失效，必须按新的 live fact set 重算。

### SHOULD

- shared contract 与入口 skill 顶部 100-150 行内应直接出现“当前 blocker 以 `gh CLI` 刷新的 GitHub 当前事实集为准”的约束。
- prompts 也应把这条约束写成无参数执行前置条件，避免入口遗漏。

## 功能与行为规格（Functional/Behavior Spec）

### Live truth-source reducer

- 对 open PR，当前 blocker 只由当前通过 `gh CLI` 刷新的 GitHub 当前事实集推导。
- `state=closed && merged=true`：报告已合并，不再诊断当前 blocker。
- `state=closed && merged=false`：报告已关闭未合并，不再虚构“仍在等待”的 blocker。
- `draft=true`：draft gate 优先。
- `mergeable=false` 或 `mergeable_state=dirty`：冲突 gate 优先。
- `mergeable_state=behind`：freshness / branch update 优先。
- `mergeable_state=blocked`：继续下钻当前 live checks / review / rules；`blocked` 本身不是最终解释。
- `mergeable_state=blocked` 的下钻顺序固定为：先 checks/workflows，再 review policy，再 unresolved review blockers，再 deployments/merge queue/rules；若都没显出来，也只能停在“GitHub 当前仍将该 PR 标记为 blocked，但具体门禁尚未在可见状态面中显出”。
- 若因 `mergeable_state=blocked` 停下且细因仍未显出，对外固定话术应为：`GitHub 当前仍将该 PR 标记为 blocked，但具体门禁尚未在可见状态面中显出`；下一门禁固定写成“继续刷新当前 PR 的 live checks/review/rules surfaces”或等价 live-refresh 语句。
- open PR 的 `mergeable=null` 或 `mergeable_state=unknown` 不是 approval/check failure 的直接证据；必须继续看 live status surfaces，而不是用历史 assistant 口径补空白。

### Promise-resume boundary

- `继续 / 推进流程 / 你直接做吧` 仍可继承最近一次已承诺分支。
- 但继承的是“下一步走哪条路”，不是“当前 blocker 是什么”。
- 一旦进入 PR 阶段，blocker 解释必须重新从 live PR facts 起算。

## 验收标准（Acceptance Criteria）

- Given `IvanLi-CN/codex-vibe-monitor#144` When 通过 `gh CLI` 刷新的 GitHub 事实集显示 reviews 为空且 `Review Policy Gate=success` Then skill / prompt 契约不得再把 approval 缺失写成默认 blocker。

- Given `IvanLi-CN/codex-vibe-monitor#323` When 通过 `gh CLI` 刷新的 GitHub 事实集显示 `state=closed` 且 `merged=true` Then 契约必须把它归为“已合并”，而不是沿用旧 blocker 口径。

- Given 已缓存的 assistant 文本仍在说“可能缺 review” When 当前通过 `gh CLI` 刷新的 GitHub 事实集显示 `mergeable_state=behind` Then 下一门禁必须回到 freshness / branch update，而不是继续报 approval blocker。

- Given 当前通过 `gh CLI` 刷新的 GitHub 事实集只显示 `mergeable_state=blocked` When checks/workflows 与 review-policy live surfaces 仍未暴露具体负证据 Then 契约只能输出“GitHub 当前仍将该 PR 标记为 blocked，但具体门禁尚未在可见状态面中显出”或继续刷新，不得把 `blocked` 直接翻译成“缺 approval”。

- Given 当前通过 `gh CLI` 刷新的 GitHub 事实集仍停在 `mergeable_state=blocked` 且细因未显出 When agent 需要对外停下并给主人一个恢复锚点 Then 结论必须使用固定话术“GitHub 当前仍将该 PR 标记为 blocked，但具体门禁尚未在可见状态面中显出”，且下一门禁必须指向继续刷新 live surfaces，而不是猜测性的 approval/checks 结论。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `git diff --check`
- 人工 spot-check：shared contract、`$flow-continue`、`$pr-create`、`$pr-merge` 与两个 `pr-*` prompts 顶部片段

### Quality checks

- grep/spot-check 确认相关入口都出现了 “当前 blocker 以 `gh CLI` 刷新的 GitHub 当前事实集为准 / assistant 历史回答不能当 blocker 依据” 的硬规则

## 风险 / 假设

- 风险：若未来新增其他 PR 入口而未引用 shared contract，可能重新引入“看 assistant 旧回答猜 blocker”的回归。
- 假设：`gh CLI` 继续稳定提供读取 PR 状态、checks/workflows 与 review-policy 所需的字段与事实面。

## 参考（References）

- `gh CLI` live sample: `IvanLi-CN/codex-vibe-monitor#144`
- `gh CLI` live sample: `IvanLi-CN/codex-vibe-monitor#323`
- `docs/specs/pr-skill-diagnosis-thinning/SPEC.md`
- `docs/specs/pr-freshness-gate/SPEC.md`
