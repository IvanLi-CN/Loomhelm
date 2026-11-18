# 基线、PR、cut 与收口

准备工作区、基线同步、PR 操作、动态 cut 或收口恢复前读取本文件。

## 开工前基线

创建时只记录 `native_evidence.initial_head`；它不是开发基线。正式派发包含 run/target、仓库、归属、范围、基线与验收要求。交付 Agent（Delivery Agent）必须 fetch 已核验远端的主干并记录真实 SHA 和 fetched_at；任务 Agent（Task Agent）继承所属交付单元当前父分支已核验 SHA。仅允许在本次新建、干净且 Codex 归属一致的工作区对齐并建立工作分支。fetch 失败、脏工作区或归属不明必须阻塞，不覆盖文件，不使用缓存替代 fetch。

Agent 提供资源证据，由主对话通过 `resource-update` 注册 active worktree/branch；目标 owner 调用 `lifecycle-record` 的 `workspace_ready`，新 CLI dispatch 还需 `baseline: { sha, head, clean: true, source, fetched_at? }`，SHA 必须与 HEAD 相同，交付单元 fetched_at 不早于 dispatch，任务 SHA 必须匹配交付单元 current_sha。开发基线存于 dispatch 的 `development_baseline`，并独立保留创建初始 HEAD。任务和交付单元协调进入 running 均受此门禁保护；历史已绑定对话不追加此要求。

Contract-3 的开发基线由 `development-baseline-sync` 明确提交。首次同步使用 `mode: "initial"`，在 dispatch、native evidence、workspace、branch、owner、resource 和 lineage 均已核验后建立空 baseline；之后每次父分支 lineage 通过 `group-base-reconcile`、合并或 cut 推进，都先使用 `mode: "refresh"` 携带 previous receipt 和匹配的 lineage event，再重新调用 `lifecycle-record`。`initial_head` 只表示 native creation 时的初始 HEAD，development baseline receipt 表示本次 workspace evidence 已对应的可工作 SHA，二者不能互换。同步只记录 Agent 已完成的证据，不 fetch、reset、rebase、更新 provider、创建 PR、改变 owner、替代 task-base 或收口 cut。

regular 贡献任务必须有 workspace ready 和 provider 已核验 open 的 parent PR；仅 main-owned bootstrap 在 workspace ready 且 provider 明确证明 parent PR `absent` 时例外，pending、unknown、closed 或缺少证据均不满足。历史已绑定对话不追加新 CLI dispatch 的基线要求。

## PR、cut 与收口恢复

任务或交付单元 Agent 每次执行 PR 合并前都必须使用 `merge-claim`，并通过绑定的 Git provider 核对真实 PR identity、目标、当前 head/base、适用检查和任务质量证明。在共享交付拓扑中，唯一的交付单元 PR 同时是 contribution Task PR，并只有一份 merge receipt。在多贡献拓扑中，child PR 合并由实现批准覆盖，交付单元 PR 仍要求针对该交付单元的事先 `protected-approve`。脚本输入只是 Agent 报告，不是独立的 provider 证据。外部调用后查询 provider，并使用 `merge-resolve` 记录匹配回执；结果不确定时记录 `unknown`、保留占用并在重试前完成对账。不能根据未经核实的错误声称操作失败。负责的对话记录其作用域的质量证明；共享 contribution Task 不得创建 child PR。原交付单元 PR 已合并，而后续 mainline follow-up PR 携带剩余交付单元变更时，协调者使用 `merge-claim` 的 `mode: "parent-followup"`，记录原 PR 和 merge SHA，并针对集成分支解析 follow-up PR；这会推进交付单元 merge SHA，但不会改写原始回执。

收口后的外部事实发生冲突时，调用方使用 `group-closeout-reconcile` 提交原收口事件、计划身份、PR observation、结果和证据引用；`valid` 保持 `closed`，`invalid` 转为 `blocked`，`unknown` 保留业务状态但冻结受影响的下游门禁。不得新增 `reconciling` 等业务状态或覆盖原始事实。只有主 Agent 通过 `protected-approve` 批准 `kind: "delivery_unit_recovery"` 后，交付单元负责人才能使用 `group-reopen` 将同一 DeliveryUnit 从 `blocked` 恢复为 `active`；该命令不会创建 PR、workspace 或 successor。`group-update` 不得绕过这个恢复边界，也不得执行 `closed -> active`。

child PR 出现冲突或检查失败时，任务 Agent 首先判断问题是否由自身变更造成。自身问题留在同一任务和 PR 中修复。确认是外部问题后，向主 Agent 提交诊断证据、影响和候选编排调整；主 Agent 在创建独立修复贡献任务或改变依赖前询问主人。基线变化始终由任务 Agent 负责：rebase、重新验证并刷新任务基线证据后才能重试。普通执行不会在 Agent 之间转移任务工作区或 PR。

经批准的动态 cut 使用 `cut-claim` 阻止新合入并等待已有占用，然后使用 `cut-apply` 原子记录当前已核验的父 SHA 和归属变更。已完成的开发工作留在原交付单元；未完成的开发子任务及其已有对话移动到下一个默认交付单元。原交付单元的 release、deployment 和 verification 任务仍留在原单元，并在其 PR 合并后运行。下一个 parent branch 必须包含上一 parent PR 实际合入主干的结果，之后其开发 PR 才能合入。follow PR 继续归属于原交付单元；分支推进时刷新当前 SHA 和检查/审查证据，不改变 cut 归属。外部 provider 的 `update-branch` 只能通过带有匹配前后 SHA、branch、parent PR、provider 和明确 update-branch 证据的 `group-base-reconcile` 记录，不能当作 merge 或 follow PR。拥有 follow PR 的任务 Agent 通知主 Agent，主 Agent 协调受影响未完成任务 Agent 的 rebase。

交付单元只有在 parent merge、合并 SHA 上的 CI、计划中的 post-merge 任务和已知 follow PR 全部完成后才收口。所有交付单元关闭且没有未解决 operation 或已知 follow PR 后，主 Agent（main Agent）才可以记录 `run-complete`。`resource-update` 分别跟踪每个资源。保留运行数据和必要服务，直到主人确认清理；清理时只处理本次运行的准确资源。
