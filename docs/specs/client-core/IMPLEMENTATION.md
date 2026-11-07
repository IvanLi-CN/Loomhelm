# 实现覆盖

实现位于 `clients/typescript/`；源码公共入口为 `src/index.ts`，Bun 直接执行的 CLI 为 `src/cli.ts`。配置、运行时、生命周期、任务状态、依赖、原子账本、幂等收据、恢复和 Git/worktree 适配覆盖 REQ-CORE-001 至 REQ-CORE-004。

验证入口为 `cd clients/typescript && bun install --frozen-lockfile && bun run check && bun run test`，或根目录的 `scripts/checks client`。测试使用临时目录、真实子进程和临时 Git 仓库，无服务端依赖；覆盖非法配置、依赖与重试、重复请求冲突、独占锁与精确恢复、摘要损坏、写入失败、进程超时/中断/输出限制及本地 CLI 闭环。

客户端设计中的 Codex 协议、Skills/工作流迁移、Dispatch、Multi-task Flow 与 Connected mode 不属于本次核心交付。未增加 Web App 或服务端实现。

CLI 与 Codex 模拟回归使用实际 Bun 子进程，直接引用 src/cli.ts。EOF 模拟通过唯一 stdout 描述符关闭验证断连，不依赖 Node 或旧 dist 产物。

viewer 启动器先验证临时目录及祖先，再使用私有受控 Bun 配置；在任何包内 TS 或配置执行前，以启动器绑定的资源身份验证完整清单。FFI 路径拒绝嵌入 NUL，保持目录描述符边界。
