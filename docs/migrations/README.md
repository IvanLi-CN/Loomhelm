# Multi-task-flow 迁移指南

每个影响既有 run、ledger、custom view、队列或其他持久化状态的发布版本，都必须在 `docs/migrations/<service-version>/` 下提供升级指南，并在 release manifest 的 `migration_guides` 中登记路径、SHA-256、适用源合同和维护命令。

升级指南必须说明受影响的源版本、停止写入要求、检查命令、迁移步骤、失败恢复路径和回滚限制。没有数据结构或旧数据读写影响的发布可以不新增版本目录，但仍应保持 manifest 的 `migration_guides` 为空或继承既有索引。
