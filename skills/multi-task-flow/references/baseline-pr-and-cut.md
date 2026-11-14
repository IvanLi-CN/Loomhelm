# Baseline, PR and cut contract

本文件承载 workspace、development baseline、PR、merge、follow-up 和动态 cut 的详细规则。

## Workspace 与 baseline

创建时的 `native_evidence.initial_head` 只是创建快照，不是开发基线。正式派发必须包含 run/target、仓库、归属、范围、基线和验收要求。

Delivery Agent 必须 fetch 已核验远端主干并记录真实 SHA 和 `fetched_at`；Task Agent 继承所属交付单元当前父分支已核验 SHA。只允许在本次新建、干净且 Codex 归属一致的工作区建立分支；fetch 失败、脏工作区或归属不明时阻塞，不覆盖文件、不用缓存替代 fetch。

主对话通过 `resource-update` 注册 active worktree/branch；目标 owner 使用 `lifecycle-record` 记录 `workspace_ready`。新 CLI dispatch 还需 `baseline: { sha, head, clean: true, source, fetched_at? }`，SHA 必须匹配 HEAD，交付单元的 fetch 时间不能早于 dispatch，任务 SHA 必须匹配交付单元 current SHA。

Contract 3 首次使用 `development-baseline-sync` 的 `mode: "initial"` 建立 baseline；父分支通过 reconcile、merge 或 cut 推进后，使用 `mode: "refresh"` 携带 previous receipt 和匹配的 lineage event，再重新记录生命周期。baseline sync 只记录已经完成的证据，不 fetch、reset、rebase、创建 PR、改变 owner 或代替 cut。

## PR 与 merge

任务或交付单元 Agent 每次 merge 前都使用 `merge-claim`，通过绑定的 Git provider 核对真实 PR identity、目标、head/base、检查和质量证明，再用 `merge-resolve` 写回 provider receipt。脚本输入只是 Agent 报告，不是独立 provider 证据；unknown 保留占用并先对账。

共享交付拓扑的唯一交付单元 PR 同时服务 contribution Task，不创建 child PR。多贡献拓扑中，child PR 合并由实现批准覆盖，交付单元 PR 仍需要针对该单元的 `protected-approve`。

child PR 冲突或检查失败时，Task Agent 先判断是否由自身变更造成；自身问题留在同一任务和 PR 修复，外部问题向 main Agent 提交诊断证据、影响和候选调整。基线变化由 Task Agent 负责 rebase、重新验证和刷新任务 baseline 后再重试。

## Follow-up 与 cut

原交付单元 PR 已合并而后续 mainline follow-up PR 携带剩余变更时，使用 `merge-claim` 的 `mode: "parent-followup"`，记录原 PR、merge SHA 和 follow-up provider receipt，不改写原始回执。

动态 cut 必须先用 `cut-claim` 阻止新合入并等待已有占用，再用 `cut-apply` 原子记录已核验父 SHA 和归属变更。已完成工作留在原单元；未完成开发子任务及已有对话移动到下一个默认单元。原单元 release、deployment 和 verification 任务仍留在原单元，并在 parent merge 后运行。

下一个 parent branch 必须包含上一 parent PR 实际合入主干的结果。外部 provider 的 `update-branch` 只能通过带前后 SHA、branch、parent PR、provider 和明确 update-branch evidence 的 `group-base-reconcile` 记录，不能当作 merge 或 follow-up PR。

交付单元只有在 parent merge、合并 SHA 上的 CI、计划中的 post-merge 任务和已知 follow-up PR 全部完成后才收口；所有单元关闭且没有未解决 operation 或 follow-up PR 后，main Agent 才能记录 `run-complete`。
