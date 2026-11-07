# 实现覆盖

实现位于 `clients/typescript/`；源码公共入口为 `src/index.ts`，Bun 直接执行的 CLI 为 `src/cli.ts`。配置、运行时、生命周期、任务状态、依赖、原子账本、幂等收据、恢复和 Git/worktree 适配覆盖 REQ-CORE-001 至 REQ-CORE-004。

验证入口为 `cd clients/typescript && bun install --frozen-lockfile && bun run check && bun run test`，或根目录的 `scripts/checks client`。测试使用临时目录、真实子进程和临时 Git 仓库，无服务端依赖；覆盖非法配置、依赖与重试、重复请求冲突、独占锁与精确恢复、摘要损坏、写入失败、进程超时/中断/输出限制及本地 CLI 闭环。

客户端设计中的 Codex 协议、Skills/工作流迁移、Dispatch、Multi-task Flow 与 Connected mode 不属于本次核心交付。未增加 Web App 或服务端实现。
