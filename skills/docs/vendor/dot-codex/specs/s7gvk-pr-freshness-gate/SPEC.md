# PR freshness gate

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 现有 PR 流程会在 PR 已经 `mergeable_state=behind` 时，继续消耗 review-loop、CI 等高成本收敛动作。
- `019ce2c6-a339-77b0-9044-2903ee310ee2` 已复盘出明确回归样例：`2026-03-12T19:19:40Z` 读取 PR #119 时已经得到 `mergeable_state=behind`，但流程直到 `2026-03-12T19:30:42Z` merge API 被 repository rules 拒绝后，才开始 `update_pull_request_branch`。
- 不做前置门禁的代价是重复等待过时 checks、重复补旧 `head.sha` 的 review proof，以及在 stale branch 上做无效收敛。

## 目标 / 非目标

### Goals

- 把 PR 代码过时、branch behind、merge conflict 从 merge 失败后的补救，前移成 Step 5A 的共享 freshness gate。
- 让 `behind` 在授权的 PR 流里自动收敛，避免继续浪费 review/CI 资源。
- 明确 `blocked` 不等于 conflict/stale branch，避免误判。
- 明确 `PR.head.sha` 或 `PR.base.sha` 变化会使旧 checks、旧 review proof、旧 spec verdict 失效。

### Non-goals

- 不新增新的统一状态字段。
- 不重写 `$codex-review-loop` 的 profile 体系。
- 不改 `gh CLI` 远端控制面或引入新的远端自动化通道。

## 范围（Scope）

### In scope

- 更新 `$project-engineering-workflow` 的 Step 5 共享契约。
- 收紧 `$pr-create` 的 PR 创建后顺序门禁、等待语义与 stale-state 重置规则。
- 收紧 `$pr-merge` 的 mergeable 判定、最终 merge 前刷新与 stale-head 错误回退。
- 对齐 `$fast-flow` 与 `$flow-continue` 的授权与恢复语义。

### Out of scope

- 为 skills 引入新的自动化测试框架。
- 修改实现阶段本地 Step 1-4 的基线同步策略。
- 引入新的 PR body 字段或新的 GitHub 状态模型。

## 需求（Requirements）

### MUST

- `mergeable_state=behind` 必须在 PR 并行收敛和 merge API 尝试之前处理。
- `mergeable == false` 或 `mergeable_state == dirty` 必须在高成本收敛动作之前阻断。
- 在已授权远端变更的 PR 流里，`behind` 必须自动走 branch update 或 rebase 路径。
- 任意 `PR.head.sha` 或 `PR.base.sha` 变化，必须使旧 checks、旧 review proof、旧 spec-sync verdict 失效。
- merge 前必须做一次最终 PR refresh；若 freshness gate 不再 clear，不得调用 merge API。

### SHOULD

- `blocked` 状态应继续依赖 checks/review/spec 事实判定，而不是直接按 conflict 处理。
- 轮询中的 stale-state 变化应立即返回 freshness gate，而不是继续等待旧状态。

### COULD

- 后续补充更多 session 回放样例作为文档化回归集。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- PR 一旦存在，必须先跑 freshness gate，确认当前 PR 对应的 `head.sha` / `base.sha` 仍是可收敛对象。
- 如果 PR `behind`，且当前 flow 已授权远端更新：
  - `MODE=rebase` / linear-history-only: 走本地 `$update-baseline` rebase + force-push。
  - 其他默认路径：走 GitHub `update_pull_request_branch`。
- freshness gate clear 后，才允许启动或恢复 `CI-Operator`、PR-stage review-loop、spec-sync 与 PR body rewrite。
- merge 前必须重新读取 PR；若 base 在 checks 变绿后又前进，旧绿灯作废，重新进入 freshness gate。

### Edge cases / errors

- `mergeable_state=blocked` 但只是 checks/reviews 未满足时，不应误判成 conflict。
- `update_pull_request_branch` 或 rebase 后，即使 `PR.head.sha` 已变化，也必须等到 `mergeable_state != behind` 才能离开 freshness gate。
- merge API 若返回 stale-head / expected checks / repository rule violation 类错误，必须回读 PR 再决定是 freshness gate 还是普通 checks gate，不能直接按普通失败结束。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| `$project-engineering-workflow` Step 5 | skill contract | internal | Modify | None | main-agent | `$pr-create`, `$pr-merge`, `$fast-flow`, `$flow-continue` | 新增 shared PR freshness gate |
| `$pr-create` PR-stage setup | skill contract | internal | Modify | None | main-agent | PR 创建与首轮收敛路径 | freshness gate 前置 |
| `$pr-merge` merge gate | skill contract | internal | Modify | None | main-agent | merge / cleanup 路径 | merge 前最终 refresh |

### 契约文档（按 Kind 拆分）

None

## 验收标准（Acceptance Criteria）

- Given PR 已存在且 `mergeable_state=behind` When 进入 PR 阶段 Then 下一动作必须是 freshness gate 收敛，而不是继续启动或等待 review-loop / CI / spec-sync。

- Given PR `mergeable == false` 或 `mergeable_state == dirty` When 刚完成 PR 读取 Then 流程必须在高成本收敛动作之前阻断。

- Given PR `mergeable_state == blocked` 且只是 checks 未完成 When 进入 merge 判定 Then 流程继续 checks/review/spec 门禁，不把它误判为 conflict。

- Given checks 已绿但 base 又前进 When merge 前最终 PR refresh 发现 `behind` 或 base/head 事实变化 Then 旧 checks / review proof / spec verdict 作废，流程回到 freshness gate。

- Given merge API 返回 stale-head / expected checks / repository rule violation 类错误 When 重新读取 PR Then 流程必须按最新 PR 事实重新进入 freshness gate 或 checks gate，而不是停留在旧结论上。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: N/A
- Integration tests: 通过静态回放与文档契约交叉审阅验证
- E2E tests (if applicable): N/A

### UI / Storybook (if applicable)

- Stories to add/update: N/A
- Visual regression baseline changes (if any): N/A

### Quality checks

- 文档 diff 自检
- `git diff --check`

## Visual Evidence

本规格不需要 PR 图片证据。

## 方案概述（Approach, high-level）

- 以共享契约约束顺序，再在具体 skill 里把行为细节补齐。
- 尽量复用现有 `update_pull_request_branch` 与 `$update-baseline` 路径，不新增新的远端变更机制。
- 用 `head.sha` / `base.sha` 的失效语义收束“旧绿灯继续沿用”的问题。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：不同 GitHub 仓库规则对 stale-head 错误文案不同，只能按“同类信号”归并处理。
- 需要决策的问题：None
- 假设（需主人确认）：`Auto Heal` 仅在已授权 PR 远端变更的 flow 内自动执行。

## 参考（References）

- Session `019ce2c6-a339-77b0-9044-2903ee310ee2`
- PR #119 回放证据：`2026-03-12T19:19:40Z` 已读到 `mergeable_state=behind`，`2026-03-12T19:30:42Z` merge API 才暴露 stale-branch 问题
