# Dispatch

`ThreadDispatcher` 是任务会话创建的集成边界。它只依赖注入的 `startThread`、`setThreadName`、`startTurn` 和 `readThread`；顶层客户端 CLI 通过 Codex app-server 子进程提供这些适配器，并保留其持久状态与审批边界。

传入 `stateDir` 后，request identity、thread/turn 身份和每个阶段都会写入 `dispatch.json`，使用核心 `StateLock` 与 `atomicWrite` 保证并发安全和原子替换。重建 Dispatcher 会先读取已有事实；重复 request 不会再次创建 thread。初始化失败保持 `failed`，不确定结果保持 `unknown`，必须先 `reconcile()` 对账，再显式 `approve()` 后 `retry()`。已有 thread 会继续启动原 thread 的 turn，不创建第二个 thread。`FakeDispatchAdapter` 可在没有凭据和真实服务的情况下覆盖成功、失败、未知、重建和争用路径。
