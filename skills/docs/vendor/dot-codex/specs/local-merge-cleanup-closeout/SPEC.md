# Local merge cleanup closeout

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 当前 `$local-merge-flow` 对本地 cleanup 只有结果字段，没有稳定的决策树；一旦碰到“主人明确保留的无关脏文件 + 隔离 worktree 合主干 + 本地 topic 分支回收”这种组合场景，agent 就容易临场判断。
- 这类临场判断会把本该自动完成的收尾拖成 `本地收尾=部分完成`，并把 `git branch -D` 一类已可安全自动执行的动作晚抛给主人，导致收尾体验发涩。
- 不修这个问题，`local-merge` 路径仍会反复出现“代码其实已经合进主干，但最后一步 cleanup 解释不清、恢复不顺”的回归。

## 目标 / 非目标

### Goals

- 为 `$local-merge-flow` 明确本地 cleanup 决策树，覆盖无关脏工作区保留、隔离 merge worktree 回收、切回基线分支与 topic 分支删除。
- 让 `本地收尾=完成/部分完成/未执行` 由可核验的 closeout gate 决定，而不是由 agent 手写解释。
- 让 `$flow-continue` 能把“已本地合入但 cleanup 未完成”恢复成明确的 `Step 5L.4` cleanup 门禁，而不是重新回到 merge 授权或笼统说明。

### Non-goals

- 不把 `$pr-post-merge-cleanup` 抽成新的共享 cleanup 框架。
- 不改 PR merge / remote branch cleanup 语义。
- 不要求 agent 处理主人明确保留的无关脏文件内容本身。

## 范围（Scope）

### In scope

- 更新 `docs/specs/README.md` 与本规格文档。
- 更新 `$local-merge-flow` 与共享 `Step 5L.3/5L.4` cleanup 契约。
- 更新 `$flow-continue` 与 `/prompts:advance-flow` 的 local cleanup 恢复语义。
- 新增 `skills/local-merge-flow/scripts/` 下的 closeout context / gate / tests。

### Out of scope

- 变更 `$pr-post-merge-cleanup` 现有 closeout gate。
- 引入新的测试框架或新的 GitHub 状态字段。

## 需求（Requirements）

### MUST

- 若当前 main worktree 存在与本次 local merge 无关的脏改动，且可通过隔离 worktree 完成 merge / cleanup，则 `$local-merge-flow` 不得仅因 `git status` 非空就阻断。
- `cleanup_proof` 除现有基础字段外，必须新增固定语义字段：
  - `dirty_worktree_policy=clean/preserved_unrelated/skipped_conflict/user_decision_required`
  - `topic_branch_action=not_needed/deleted_safe/deleted_forced/skipped`
  - `merge_worktree_status=not_applicable/removed/still_present/skipped`
  - `pending_cleanup_action=none/switch_to_base/delete_topic_branch/remove_merge_worktree/ask_user`
- `本地收尾=完成` 必须允许 `worktree_clean=no`，但仅限 `dirty_worktree_policy=preserved_unrelated` 且当前已回到 `base_branch`、topic 分支已回收、merge worktree 已回收、`pending_cleanup_action=none` 的场景。
- topic 分支删除必须固定为：先尝试 `git branch -d`；若已确认该分支已合入目标基线、未被任何 worktree checkout、且失败原因只是“not fully merged”，则自动升级到 `git branch -D`。
- 若 `本地合入状态=已合入` 且 `本地收尾!=完成`，恢复层必须把下一个门禁解释成 `Step 5L.4 cleanup` 的第一个未完成动作，而不是重新进入 merge proof 或泛化解释。

### SHOULD

- local closeout gate 的字段与命名应尽量贴近现有 PR closeout gate，减少 agent 切换上下文时的心智负担。
- 回归测试至少覆盖：无关脏文件保留但收尾完成、需要切回基线分支、merge worktree 未回收。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 当主人在 `Step 5L Ready` 后批准“合并/收尾”，若当前主工作区存在无关脏改动：
  - 先分类为 `preserved_unrelated` 或 `skipped_conflict`
  - `preserved_unrelated` 时允许在隔离 merge worktree 完成合主干
  - merge 后若普通 `git switch <base_branch>` 可成功，则回到基线分支并继续 cleanup
  - 若切回会覆盖无关脏改动，记为 `pending_cleanup_action=switch_to_base`，并降级为 `本地收尾=部分完成`
- 当本地 topic 分支已并入目标基线，但 `git branch -d` 因 squash/rebase 语义报“not fully merged”：
  - 若该分支未被任何 worktree checkout，且本地分支头与已合入目标一致，自动执行 `git branch -D`
  - `cleanup_proof.topic_branch_action` 记录为 `deleted_forced`
- 当 merge worktree 仍在 `git worktree list` 中：
  - gate 必须禁止 `本地收尾=完成`
  - `pending_cleanup_action=remove_merge_worktree`

### Edge cases / errors

- 若普通 `git switch <base_branch>` 已被 Git 拒绝，不得猜测“应该也许能安全切”；必须保留当前工作区并降级为 `部分完成`。
- 若 topic 分支仍被任一 worktree checkout，禁止直接 `git branch -D`；必须先把未释放的 worktree 作为 cleanup 缺口报告。
- 若 merge worktree 路径未知，则 `merge_worktree_status` 只能是 `not_applicable`；不得伪装成 `removed`。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| `$local-merge-flow.cleanup_proof` | skill contract | internal | Modify | None | main-agent | `$local-merge-flow`, `$flow-continue` | 新增 closeout 决策字段 |
| `local closeout gate/context` | script | internal | New | None | main-agent | `$local-merge-flow` | 以 live git 事实判定 `本地收尾` |

### 契约文档（按 Kind 拆分）

None

## 验收标准（Acceptance Criteria）

- Given 主工作区保留无关脏文件，且 merge / cleanup 可在隔离 worktree 完成 When agent 执行 local merge cleanup Then 只要当前已回到基线分支、topic 分支已回收、merge worktree 已回收，允许给出 `本地收尾=完成`。

- Given topic 分支已经合入目标基线，`git branch -d` 仅因“not fully merged”失败 When agent 评估本地 cleanup Then 它应自动转为安全校验后的 `git branch -D`，而不是把该动作晚抛给主人。

- Given `本地合入状态=已合入` 且 `本地收尾=部分完成` When `$flow-continue` 恢复流程 Then 它必须把下一门禁恢复为 `Step 5L.4 cleanup` 的第一个未完成动作。

- Given merge worktree 仍存在于 `git worktree list` When closeout gate 评估 `cleanup_proof` Then 不得返回 `本地收尾=完成`。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: 新增 local closeout context / gate 单测
- Integration tests: 回归执行既有 `pr-post-merge-cleanup` closeout tests，确保未破坏 PR cleanup 语义
- E2E tests (if applicable): N/A

### Quality checks

- `python3 skills/local-merge-flow/scripts/test_closeout_context.py`
- `python3 skills/local-merge-flow/scripts/test_closeout_gate.py`
- `python3 skills/pr-post-merge-cleanup/scripts/test_closeout_context.py`
- `python3 skills/pr-post-merge-cleanup/scripts/test_closeout_gate.py`
- `git diff --check`

## Visual Evidence

## 方案概述（Approach, high-level）

- 复用现有 PR closeout 的思路，但只在 `local-merge` 路径补一套轻量、明确的 gate。
- 把“脏工作区是否允许完成 cleanup”从二元 clean/dirty 改成带语义的 policy，再由 gate 决定是否可完成。
- 让恢复层把 `部分完成` 视为真实的 cleanup 门禁，而不是一次失败解释。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：若后续又新增新的 local-merge prompt 入口但没同步这套规则，仍可能出现入口不一致。
- 需要决策的问题：None
- 假设：主人明确保留的无关脏文件不应阻止其余 cleanup 对象被完整回收。

## 参考（References）

- `skills/pr-post-merge-cleanup/SKILL.md`
- `skills/pr-post-merge-cleanup/scripts/closeout_context.py`
- `skills/pr-post-merge-cleanup/scripts/closeout_gate.py`
