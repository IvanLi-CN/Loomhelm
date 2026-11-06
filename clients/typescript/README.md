# Loomhelm TypeScript 客户端

与现有 Go 客户端并存的独立 TypeScript 包，不替换 Go 客户端。正式基线为 Node.js 22 或更新版本，Bun 1.4 可用于开发与兼容性验证。没有生产依赖，不要求服务端、Web App、Codex 凭据或网络连接。

```sh
cd clients/typescript
npm ci
npm test
npm run test:bun
node dist/cli.js --config config.example.json status
```

配置路径显式传入；相对 `stateDir` 相对于配置文件所在目录解析。未传配置时使用 `~/.loomhelm`。配置拒绝未知字段、未知版本及尚未实现的 Connected mode。源码从 `client/` 移入本目录后，示例配置使用 `../../client/.loomhelm`，继续读取仓库中原来的 `client/.loomhelm/`，该目录仍被根 Git 忽略规则排除。此兼容目录只保存状态，不放置客户端源码。

目录迁移不改变状态格式，不自动复制、合并或删除状态；任务、回执、Dispatch 身份和锁保持原路径。升级前停止正在使用该状态目录的客户端并备份该目录，再使用本目录的示例配置核对已有任务和回执；重复启动仍使用同一路径，旧版程序也能读取原状态。自定义配置保持原文件位置和 `stateDir`；若手动搬动配置，应把 `stateDir` 改为原状态目录的绝对路径。不要通过创建空状态目录代替恢复历史身份；需要回退时使用备份单独恢复，不自动逆转状态。

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

## Codex 派发

顶层 CLI 通过自有的 Codex app-server 子进程接入 `ThreadDispatcher`；dispatch 日志和请求配置保存在 `stateDir` 下的独立目录。线程参数使用 `thread/start.model`、`thread/start.config.model_reasoning_effort`；turn 参数使用 `turn/start.input` 和 `turn/start.effort`。CLI 会等待匹配线程与 turn 的 `turn/completed` 事件，不会把 `turn/start` 响应当作任务成功。

```sh
node dist/cli.js --config config.example.json codex dispatch REQUEST_ID '{"title":"Local worker","prompt":"Inspect the task","cwd":"/absolute/repo","model":"gpt-6.1-sol","effort":"high"}'
node dist/cli.js --config config.example.json codex list
node dist/cli.js --config config.example.json codex reconcile DISPATCH_ID
node dist/cli.js --config config.example.json codex approve DISPATCH_ID
node dist/cli.js --config config.example.json codex retry DISPATCH_ID accept
```

未显式提供决定时，CLI 会向 Codex 明确拒绝审批请求。可在派发 JSON 中传入 `approvalDecision`：`accept`、`decline` 或 `cancel`。重试失败或结果未知的派发前，必须先单独调用 `approve`；重试命令中的审批决定只用于处理该次重试期间出现的审批请求。RPC 明确拒绝会记为失败；响应丢失和完成等待超时会记为未知。重复使用 request ID 会读取既有日志，不会创建第二个线程。若进程在预留任务后、保存 thread ID 前退出，日志会留下未决的 `created` 记录，并对外报告为未知；由于无法证明 Codex 是否已创建线程，CLI 会禁止在缺少 thread ID 时批准或重试。

## 持久任务流

`flow` 命令将任务图和执行日志保存在 `stateDir/task-flow/`。每次 CLI 调用都是独立进程；`recover` 会明确地把中断时仍在运行的任务恢复到待处理队列。`schedule` 和 `status` 会根据已持久化的失败任务重新推导被依赖阻塞的任务；它们只更新本进程的状态视图，不会启动外部工作。无关的可执行任务仍会列出。

```sh
node dist/cli.js --config config.example.json flow init '[{"id":"build","kind":"contribution","goal":"Build the client"},{"id":"verify","kind":"verification","goal":"Verify the build","dependencies":["build"]}]'
node dist/cli.js --config config.example.json flow status
node dist/cli.js --config config.example.json flow schedule
node dist/cli.js --config config.example.json flow start build
node dist/cli.js --config config.example.json flow finish build merged
node dist/cli.js --config config.example.json flow recover
```

使用 `node dist/cli.js workflow skills PROJECT_SKILLS_DIR [USER_SKILLS_DIR]` 检查 Skills，或用 `node dist/cli.js workflow verify MANIFEST_JSON_PATH` 执行独立的本地工程工作流。清单格式、验证命令和阶段规则见 [workflow/README.md](src/workflow/README.md)。也可直接调用 `node dist/workflow/cli.js`。

命令成功时会向 stdout 输出一份 JSON 结果。参数或配置错误会向 stderr 输出 `{"code":"CLI_ERROR","error":"..."}` 并以非零状态退出。派发结果为 `failed` 时退出码是 1；未解决的 `unknown` 状态退出码是 2。CLI 不会根据错误或缺失输入推断审批决定。

## 集成边界

公共类型从 `src/index.ts` 导出；构建产物提供 ESM 与类型声明。`runtime` 集中进程、文件和锁适配；`tasks` 负责纯状态规则、事实持久化和收据；`git` 独立于服务端调用本机 Git。Core 不引入 Bun 专属 API。

本包提供 [客户端设计](../../docs/design/client.md) 所定义的独立核心、Codex app-server 接线、Skills/工程工作流入口、dispatch 和持久任务编排。Connected mode 仍未实现；不能将本包测试通过解释为整个产品范围均已验收。
