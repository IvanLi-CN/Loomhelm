# PR conflict auto heal

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 当前 PR 流在 `mergeable_state=dirty` / `mergeable=false` 时，虽然共享 freshness gate 已把它定义成 conflict，但后续 checks/workflow 缺席诊断仍可能把这类 PR 当成“没有 Actions 证据”的普通等待或人工决策。
- GitHub 官方文档明确说明：`pull_request` 事件的 workflow 在 PR 存在 merge conflict 时不会运行；相对地，`pull_request_target` 即使 PR 有冲突也会运行，但默认应谨慎使用，因为安全边界不同。
- 现状的结果是：真正的 merge conflict 既可能被隐藏成“workflow 没出来”，也可能被升级成“请主人决定要不要处理冲突”，与 PR 自动收敛目标相违背。

## 目标 / 非目标

### Goals

- 把“Actions/checks 缺席其实是 PR 冲突”前移成 shared Step 5 的明确诊断分支。
- 在已进入 PR convergence / merge 授权边界的 run 中，遇到真实 conflict 时自动解冲、重跑验证、推回 PR，并继续后续收敛。
- 保持现有 `CI-Operator` 结果枚举不变，把冲突继续表达为 freshness / mergeability gate，而不是新增第五种 CI 状态。
- 明确冲突修复属于当前 open PR 在 freeze 下允许留存的修复白名单，而不是 scope expansion。

### Non-goals

- 不把仓库 workflow 统一改成 `pull_request_target`。
- 不改 `gh CLI` 远端操作契约，也不新增新的远端自动化通道。
- 不重写现有 review-loop 预算、wait budget 或 `blocked` 的普通语义。

## 范围（Scope）

### In scope

- 新增本规格并更新 `docs/specs/README.md`。
- 更新 shared PR diagnosis contract 与 `$project-engineering-workflow` 的 Step 5 文案。
- 更新 `$pr-create`、`$pr-merge`、`$flow-continue` 的冲突分流与 auto-heal 路径。
- 扩展 `bin/pr_skill_replay_check.py` 与新增 replay fixtures / cases。

### Out of scope

- 修改业务实现仓库代码。
- 重构整个 `CI-Operator` 协议。
- 为所有历史 session 补录真实回放。

## 需求（Requirements）

### MUST

- 当 open PR 的最新 `head_sha` 长时间没有任何 check runs / workflow evidence 时，必须先刷新 live PR 事实，再决定是 `checks_expected=no`、dispatch/rerun，还是 freshness/conflict gate。
- 若刷新后的 PR 命中 `mergeable_state=dirty` 或 `mergeable=false`：
  - 在已授权 PR remote mutation / convergence / merge 的 flow 中，必须自动进入 conflict-resolution path；
  - 不得因为“发现了冲突”本身停下要求主人继续决定。
- 冲突修复必须遵循当前 run 已锁定的同步模式：
  - 显式 `MODE=rebase` / linear-history-only：走本地 rebase + force-push 路径；
  - 其他默认路径：走 merge-based sync / conflict resolution。
- 由当前 `mergeable_state=dirty` / `mergeable=false`、`PR.base.sha` 前进或 main-sync 直接逼出的修复，必须视为当前 PR 的 allowed same-PR fix，不得误判成 scope expansion。
- `CI-Operator` 结果枚举继续保持 `CI_GREEN | CI_NOT_EXPECTED | NEED_CODE_FIX | INFRA_BLOCKED`。

### SHOULD

- 对 `pull_request` 触发的仓库，规则应明确写出“冲突 PR 可能根本不会产生 workflow run”，避免后续再次把 absence 当成 `CI_NOT_EXPECTED`。
- 对 `pull_request_target`、manual-only、label-gated 的仓库，仍应按真实 trigger facts 判断，不把所有 absence 都误判成 conflict。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- Shared Step 5 中，workflow/check absence diagnosis 必须先执行一次 live PR refresh：
  - 若 PR 仍 `mergeable_state=behind`：回 freshness/behind gate；
  - 若 PR 变成 `mergeable_state=dirty` 或 `mergeable=false`：回 freshness/conflict gate；
  - 只有 freshness 仍 clear 时，才允许继续判定 `checks_expected=no` 或 dispatch/rerun。
- Conflict-resolution gate：
  - 复用当前 PR 的 live `BASE_REF` / `BASE_REMOTE` / `BASE_REPO` 与当前锁定的 `MODE`；
  - 自动在可写 checkout 中完成 merge/rebase 型冲突处理；
  - 完成后重跑必要本地验证 / spec-sync；
  - 推回当前 PR head；
  - 以最新 `PR.head.sha` / `PR.base.sha` 重新建立 freshness、CI、review proof 与 spec verdict。
- `post-open scope freeze`：
  - 冲突修复属于 allowed same-PR fix；
  - 仅当混入新的验收/UI/Story/polish 需求时，才继续按 scope expansion 阻断。

### Edge cases / errors

- 若缺失 workflow evidence 的真正原因是 manual-only / label-gated / `pull_request_target`，且 live PR facts 未显示 `dirty/false`，则仍按既有 checks-expected 诊断继续。
- 若自动解冲过程中缺少权限、`BASE_REF` / `BASE_REMOTE` / `BASE_REPO` 不能唯一解析、或代理无法给出一致的冲突解决结果，允许上抛真实 blocker。
- 每次 conflict-repair push、rebase、merge commit 或 `PR.base.sha` 变化，都会使旧 CI/review/spec verdict 失效。

## 验收标准（Acceptance Criteria）

- Given open PR 的最新 `head_sha` 在 `pull_request` 路径上没有任何 Actions/check evidence When live PR refresh 发现 `mergeable_state=dirty` Then 流程必须进入 conflict-resolution path，而不是继续 absence wait、`CI_NOT_EXPECTED` 或 dispatch-only 路径。

- Given 当前 run 已授权 PR convergence / merge When PR 因 `mergeable_state=dirty` 或 `mergeable=false` 命中冲突 Then 代理必须自动完成解冲收敛所需的写入路径，而不是停下要求主人决定是否继续。

- Given 当前 open PR 在 freeze 状态下发生真实冲突 When 代理准备提交 conflict repair Then 这批修复必须被判为 allowed same-PR fix，而不是 scope expansion。

- Given 仓库是 manual-only / label-gated，或 `pull_request_target` 仍能在冲突 PR 上运行 When checks/workflow 缺席但 live PR 未显示 `dirty/false` Then 流程不得误报 conflict auto-heal。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `python3 -m py_compile bin/pr_skill_replay_check.py`
- `python3 bin/pr_skill_replay_check.py --cases docs/specs/pr-skill-diagnosis-thinning/replay/cases.txt`
- `python3 bin/pr_skill_replay_check.py --cases docs/specs/pr-conflict-auto-heal/replay/cases.txt`
- `git diff --check`

### Quality checks

- 受影响 skill 的前 150 行人工 spot-check，确认冲突 auto-heal 口径前置可见。
- grep 交叉检查：`mergeable_state=dirty`、`mergeable=false`、`workflow evidence`、`scope freeze` 的新口径一致。

## 方案概述（Approach, high-level）

- 保持 `CI-Operator` 结果协议稳定，把冲突继续作为 freshness/mergeability gate 处理。
- 在 absence diagnosis 前强制回读 PR 真相；只有 freshness 仍 clear 才允许继续做 no-checks 诊断。
- 把冲突修复明确纳入 shared whitelist，避免自动解冲被 freeze gate 二次拦住。

## 风险 / 假设

- 风险：若某些仓库的 workflow policy 依赖额外外部状态而本地规则未覆盖，absence diagnosis 仍可能需要仓库级补充线索。
- 风险：自动解冲只在代理能给出一致解决结果时安全；复杂冲突仍可能上抛真实 blocker。
- 假设：GitHub 官方 `pull_request` / `pull_request_target` 触发语义可作为本仓库 PR diagnostics 的稳定事实来源。

## 参考（References）

- GitHub Docs, “Events that trigger workflows”: `pull_request` workflows do not run when the pull request has a merge conflict. https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows
- GitHub Docs, “Troubleshooting required status checks”: `pull_request_target` workflows run even if the pull request has a merge conflict. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/troubleshooting-required-status-checks
