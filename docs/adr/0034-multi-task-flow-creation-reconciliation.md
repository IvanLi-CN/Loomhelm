# ADR 0034：Multi-task Flow 创建对账与普通 Codex reconcile 分离

## Status

Accepted for the Multi-task Flow runtime; implementation and release remain separate work.

## Context

Contract 3 的 `conversation-create` 可能在 Codex 已创建 thread 或 worktree 后因超时、进程终止或连接中断而只能记录 `unknown`。当前 `codex reconcile` 读取独立的 `codex-dispatch` journal，无法查询或更新 Flow Ledger 中的 dispatch operation；直接重试会有重复创建 thread 的风险，手工写入成功结果又会绕过原生证据和 revision fencing。

## Decision

新增 Flow 专属的 `flow creation-reconcile` 入口，按 `run_id`、`operation_id`、绑定的 native request identity 和当前 ledger revision 对一个未知派发操作执行显式对账。对账查询 Codex app-server 的已知 thread，核验 thread 身份、model/thinking、初始化 handshake、独立 worktree owner、HEAD 和清洁状态，并将 reconciliation evidence 作为同一 dispatch operation 的原子 mutation 写回；成功时绑定目标 thread 并生成一次性 handoff notification，证据不足时继续保持 `unknown`。

`codex reconcile` 继续只服务独立的 Codex dispatch journal，不跨账本查找或修复 Flow operation。没有已知 thread identity 时不得根据标题、cwd、时间或相似度猜测；仅有“查询不到 thread”也不能证明失败。只有明确证明进程未启动、没有资源创建且没有观察到 thread 的证据才允许进入 `failed` 并释放 claim。

对账使用已有的 operation identity、request id、expected revision、creation observations、dispatch resolution 和通知幂等合同；不手工编辑 ledger，不生成新的 native request，不静默重复执行 `codex exec`。新增命令和证据来源属于下一次 exact SemVer runtime release，不能复用或覆盖已发布版本。

## Considered Options

- 扩展 `codex reconcile` 直接扫描 Flow Ledger：拒绝，因为两个 journal 的 owner、身份和 revision 合同不同，跨边界会让普通 Codex dispatch 误写正式运行账本。
- 在 CLI 不确定时自动再次执行 `conversation-create`：拒绝，因为未知结果可能已经创建了 thread 或 worktree，自动重试会产生重复资源。
- 允许 Agent 手工提交 `dispatch-resolve` 成功证据：拒绝，因为调用者输入不能替代 Codex thread、初始化和 worktree 的外部事实。

## Consequences

Flow 运行在创建结果不确定时拥有可审计的恢复路径，同时继续保持 fail-closed 和单一账本事实来源。运行时需要新增 app-server 查询、worktree 证据校验、对账 mutation、CLI 文档和回归测试；旧版本只能读取既有 unknown 状态，不能安全恢复它们。

## Verification

验证必须覆盖已知 thread 的成功对账、初始化未完成、配置或 worktree 冲突、无 thread 的未知结果、明确 pre-creation failure、重复 request、revision 冲突、通知幂等和对账后不重复执行 `codex exec`。
