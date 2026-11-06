# Orchestration

`TaskGraph` 校验依赖图，并把历史 superseded 任务排除在活动调度之外。`TaskOrchestrator` 限制并发运行容量，只阻塞失败任务的后继节点，同时保持无关任务继续运行。贡献任务以 `merged` 进入成功终态，验收和验证任务以 `passed` 进入成功终态，协调任务以 `completed` 进入成功终态。

传入 `stateDir` 并通过 `TaskOrchestrator.open()` 打开时，任务状态、尝试次数和终态会写入 `orchestration.json`，新实例会恢复已完成与运行中的事实；核心 `StateLock` 和 `atomicWrite` 防止并发启动重复占用容量。传入已有核心 `Ledger` 后，匹配的核心任务还会记录 `run.start` 与 `run.finish` 收据。`recoverPersisted()` 会把重启时遗留的运行任务恢复为 `pending`，由调用方决定有界重试。

持久化锁争用最多重试 1000 次，每次等待 5 毫秒；正常 fsync 较慢时仍保留有限等待。等待不删除、抢占或自动恢复活跃锁，其他错误仍直接返回；超过重试预算后保留错误供调用方处理。
