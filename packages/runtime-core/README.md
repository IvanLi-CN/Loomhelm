# @loomhelm/runtime-core

`@loomhelm/runtime-core` 提供 Loomhelm Skill 包共用的 Bun 运行原语，独立发布，供消费者声明精确版本依赖。

发布通过 `.github/workflows/runtime-core-release.yml` 的 npm Trusted Publishing 完成。发布必须指定精确源码提交和 SemVer；工作流冻结一个 tarball、发布该文件、回读精确 npm 版本，并创建对应的不可变 `runtime-core-vX.Y.Z` 标签。

## 进程执行

从 `@loomhelm/runtime-core/modules/core/process` 导入 `runProcess`。`outputSink(stream, chunk)` 支持同步回调和异步回调；每个流等待当前回调完成后才读取下一块，stdout 与 stderr 独立消费。回调返回值不参与结果计算，异常会使调用失败并终止、回收本次启动的子进程。接收端应保证回调能够结束；进程停止期限不负责取消调用者提供的永不结束的 Promise。

`maxCapturedOutputBytes` 仅限制每个流保存在返回值中的字节数，默认不限制；设为 `0` 可只转发、不保留。它不限制累计传输字节数。流式使用时必须显式选择合理的捕获预算，不能把接收端背压等同于整个进程的内存上限。

可选的 `onControlMessage(message)` 启用 Bun IPC；`onSpawn({ pid, send })` 提供本次子进程的控制句柄。这两个回调是同步回调，抛错会终止并回收子进程。子进程应使用 `process.send` 和 `process.on("message", ...)`，在控制通信结束时断开 IPC；控制消息不会混入 stdout/stderr。

停止请求可通过 `cooperativeStop()` 先通知子进程收尾。该钩子每次执行最多调用一次；完成、失败、子进程退出或截止时间到达后，监督器继续原有的 SIGTERM、宽限期和 SIGKILL 回收。`cooperativeStopTimeoutMs` 默认 `200000`，仅接受 `1..200000` 的整数，非法值在启动前拒绝。超时、AbortSignal 和宿主信号复用同一停止路径；未配置钩子的调用保持原有信号升级方式。

本地进程退出、IPC 关闭和强制回收都只描述本地监督结果。调用者必须独立保存远端请求、资源和停止证据，不能据此声称远端副作用已停止。
