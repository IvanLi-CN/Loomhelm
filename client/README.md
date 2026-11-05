# Loomhelm 本地客户端核心

独立 TypeScript 包，正式基线为 Node.js 22 或更新版本，Bun 1.4 可用于开发与兼容性验证。没有生产依赖，不要求服务端、Web App、Codex 凭据或网络连接。

```sh
cd client
npm ci
npm test
npm run test:bun
node dist/cli.js --config config.example.json status
```

配置路径显式传入；相对 `stateDir` 相对于配置文件所在目录解析。未传配置时使用 `~/.loomhelm`。配置拒绝未知字段、未知版本及尚未实现的 Connected mode。示例配置将本地证据保存在忽略提交的 `client/.loomhelm/`。

## 本地任务闭环

```sh
node dist/cli.js --config config.example.json apply create-example '{"type":"task.create","task":{"id":"example","goal":"验证客户端","scope":"本地客户端","acceptance":"验证命令退出成功","dependencies":[]}}'
node dist/cli.js --config config.example.json run verify-example example '["node","--version"]'
node dist/cli.js --config config.example.json tasks
node dist/cli.js --config config.example.json receipts
```

命令输出 JSON；参数、I/O 或执行失败返回非零退出码。`run` 使用参数数组启动真实进程，将退出码、信号、有界 stdout/stderr 写入收据。Task 的可选 `repository` 指定命令工作目录，缺省继承 CLI 工作目录。相同 operation identity 和命令返回既有收据，不重复执行；改变请求内容会被拒绝。失败任务使用新的 operation identity 显式重试。`apply` 暴露底层事实接口，嵌入式使用者通过 `LocalClient`/`Ledger` 在同一个生命周期内完成 start/finish。

依赖必须先存在，从构造上禁止环。依赖仅在 succeeded 后解除门禁；失败、阻塞、中断可重试，成功、取消、跳过保持终态。取消/跳过只用于没有活跃 Run 的 Task。所有尝试、失败与恢复记录均保留。

## 生命周期与恢复

`LocalClient.open()` 获取独占写锁并重放账本；`close()` 等待已排队写入后释放锁。每个 CLI 进程拥有一个短生命周期，后续打开会把遗留 running Run 记为 interrupted，因此不要跨 CLI 调用手工拼接 start/finish；执行命令使用 `run`。SIGINT/SIGTERM 中断 CLI 子进程、保存中断收据并释放锁。运行时只拥有直接子进程，不管理其创建的后台服务或整个进程树。

进程异常退出可能留下 `writer.lock`。客户端不会自动偷锁；先读取准确状态目录中的该文件，核对 PID、hostname、token 与实际执行结果，再调用 `recover-lock TOKEN`。此命令只恢复同机、token 一致且 PID 已不存在的锁；活跃进程、PID 复用、不同主机或不确定身份均拒绝恢复。恢复操作本身异常退出留下的 `writer.recovery.lock` 必须由操作者核对后处理，不会自动删除。锁恢复不终止可能遗留的执行程序；重试前需对账外部副作用。

账本使用 schemaVersion 1，按顺序保存包含 operation identity、时间、前序摘要和 SHA-256 摘要的 Receipt。写入通过同目录临时文件、文件 fsync 与 rename 原子替换，失败时不更新内存状态。摘要用于发现损坏，不提供防恶意篡改的签名认证，也不承诺文件系统断电恢复。整个文件重写适用于第一阶段本地小型账本，未实现压缩或数据库迁移。

## Git/worktree

```sh
node dist/cli.js git-status /absolute/repository
node dist/cli.js worktree /absolute/repository /absolute/new-worktree feat/local-task HEAD
```

适配器检查干净源目录、有效分支、新目标和已解析的提交 SHA，使用 `git worktree add -b` 创建新分支与 worktree。它不清理已有路径、不强制覆盖、不更改 remote/upstream、不提交、不推送。失败时保留 Git 返回的信息与可能产生的资源，交由调用者核对；不自动执行破坏性回滚。创建资源后源目录的并发外部变化属于调用者协调边界。

## 集成边界

公共类型从 `src/index.ts` 导出；构建产物提供 ESM 与类型声明。`runtime` 集中进程、文件和锁适配；`tasks` 负责纯状态规则、事实持久化和收据；`git` 独立于服务端调用本机 Git。Core 不引入 Bun 专属 API。

本包只交付 [客户端设计](../docs/design/client.md) 的独立核心基础。Codex app-server 协议、Skills/工程工作流迁移、Fresh Thread Dispatch、Multi-task Flow 调度和 Connected mode 仍由后续模块实现，不能将本包测试通过解释为整个第一阶段验收通过。
