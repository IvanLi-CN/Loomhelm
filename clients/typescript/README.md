# Loomhelm TypeScript 客户端

与现有 Go 客户端并存的独立 TypeScript 包，不替换 Go 客户端。生产入口仅支持 Bun 1.4.4，直接执行 TS 源码。独立运行开发辅助能力无需服务端或 Web App；Codex 会话、浏览器与专项操作仍要求对应宿主能力和授权。生产依赖包括 sharp 与 zod，文件安全通过 Bun 内置 FFI 调用系统库，不要求 C 编译器或 Node 头文件。

```sh
bun install --frozen-lockfile
bun install --cwd skills/multi-task-flow --frozen-lockfile
bun run skills:build
cd clients/typescript
bun install --frozen-lockfile
bun run check
bun test test/*.test.mjs
bun src/cli.ts --config config.example.json status
```

配置路径显式传入；相对 `stateDir` 相对于配置文件所在目录解析。未传配置时使用 `~/.loomhelm`。配置拒绝未知字段、未知版本及尚未实现的 Connected mode。源码从 `client/` 移入本目录后，示例配置使用 `../../client/.loomhelm`，继续读取仓库中原来的 `client/.loomhelm/`，该目录仍被根 Git 忽略规则排除。此兼容目录只保存状态，不放置客户端源码。

目录迁移不改变状态格式，不自动复制、合并或删除状态；任务、回执、Dispatch 身份和锁保持原路径。升级前停止正在使用该状态目录的客户端并备份该目录，再使用本目录的示例配置核对已有任务和回执；重复启动仍使用同一路径，旧版程序也能读取原状态。自定义配置保持原文件位置和 `stateDir`；若手动搬动配置，应把 `stateDir` 改为原状态目录的绝对路径。不要通过创建空状态目录代替恢复历史身份；需要回退时使用备份单独恢复，不自动逆转状态。

## 本地任务闭环

```sh
bun src/cli.ts --config config.example.json apply create-example '{"type":"task.create","task":{"id":"example","goal":"验证客户端","scope":"本地客户端","acceptance":"验证命令退出成功","dependencies":[]}}'
bun src/cli.ts --config config.example.json run verify-example example '["bun","--version"]'
bun src/cli.ts --config config.example.json tasks
bun src/cli.ts --config config.example.json receipts
```

命令输出 JSON；参数、I/O 或执行失败返回非零退出码。`run` 使用参数数组启动真实进程，将退出码、信号、有界 stdout/stderr 写入收据。Task 的可选 `repository` 指定命令工作目录，缺省继承 CLI 工作目录。相同 operation identity 和命令返回既有收据，不重复执行；改变请求内容会被拒绝。失败任务使用新的 operation identity 显式重试。`apply` 暴露底层事实接口，嵌入式使用者通过 `LocalClient`/`Ledger` 在同一个生命周期内完成 start/finish。

依赖必须先存在，从构造上禁止环。依赖仅在 succeeded 后解除门禁；失败、阻塞、中断可重试，成功、取消、跳过保持终态。取消/跳过只用于没有活跃 Run 的 Task。所有尝试、失败与恢复记录均保留。

## 生命周期与恢复

`LocalClient.open()` 获取独占写锁并重放账本；`close()` 等待已排队写入后释放锁。每个 CLI 进程拥有一个短生命周期，后续打开会把遗留 running Run 记为 interrupted，因此不要跨 CLI 调用手工拼接 start/finish；执行命令使用 `run`。SIGINT/SIGTERM 中断 CLI 子进程、保存中断收据并释放锁。运行时只拥有直接子进程，不管理其创建的后台服务或整个进程树。

进程异常退出可能留下 `writer.lock`。客户端不会自动偷锁；先读取准确状态目录中的该文件，核对 PID、hostname、token 与实际执行结果，再调用 `recover-lock TOKEN`。此命令只恢复同机、token 一致且 PID 已不存在的锁；活跃进程、PID 复用、不同主机或不确定身份均拒绝恢复。恢复操作本身异常退出留下的 `writer.recovery.lock` 必须由操作者核对后处理，不会自动删除。锁恢复不终止可能遗留的执行程序；重试前需对账外部副作用。

账本使用 schemaVersion 1，按顺序保存包含 operation identity、时间、前序摘要和 SHA-256 摘要的 Receipt。写入通过同目录临时文件、文件 fsync 与 rename 原子替换，失败时不更新内存状态。摘要用于发现损坏，不提供防恶意篡改的签名认证，也不承诺文件系统断电恢复。整个文件重写适用于第一阶段本地小型账本，未实现压缩或数据库迁移。

## Git/worktree

```sh
bun src/cli.ts git-status /absolute/repository
bun src/cli.ts worktree /absolute/repository /absolute/new-worktree feat/local-task HEAD
```

适配器检查干净源目录、有效分支、新目标和已解析的提交 SHA，使用 `git worktree add -b` 创建新分支与 worktree。它不清理已有路径、不强制覆盖、不更改 remote/upstream、不提交、不推送。失败时保留 Git 返回的信息与可能产生的资源，交由调用者核对；不自动执行破坏性回滚。创建资源后源目录的并发外部变化属于调用者协调边界。

## Codex 派发

顶层 CLI 通过自有的 Codex app-server 子进程接入 `ThreadDispatcher`；dispatch 日志和请求配置保存在 `stateDir` 下的独立目录。线程参数使用 `thread/start.model`、`thread/start.config.model_reasoning_effort`；turn 参数使用 `turn/start.input` 和 `turn/start.effort`。CLI 会等待匹配线程与 turn 的 `turn/completed` 事件，不会把 `turn/start` 响应当作任务成功。

```sh
bun src/cli.ts --config config.example.json codex dispatch REQUEST_ID '{"title":"Local worker","prompt":"Inspect the task","cwd":"/absolute/repo","model":"gpt-6.1-sol","effort":"high"}'
bun src/cli.ts --config config.example.json codex list
bun src/cli.ts --config config.example.json codex reconcile DISPATCH_ID
bun src/cli.ts --config config.example.json codex approve DISPATCH_ID
bun src/cli.ts --config config.example.json codex retry DISPATCH_ID accept
```

未显式提供决定时，CLI 会向 Codex 明确拒绝审批请求。可在派发 JSON 中传入 `approvalDecision`：`accept`、`decline` 或 `cancel`。重试失败或结果未知的派发前，必须先单独调用 `approve`；重试命令中的审批决定只用于处理该次重试期间出现的审批请求。RPC 明确拒绝会记为失败；响应丢失和完成等待超时会记为未知。重复使用 request ID 会读取既有日志，不会创建第二个线程。若进程在预留任务后、保存 thread ID 前退出，日志会留下未决的 `created` 记录，并对外报告为未知；由于无法证明 Codex 是否已创建线程，CLI 会禁止在缺少 thread ID 时批准或重试。

## Skills 与正式任务流

完整源包位于根 `skills/`，共享支持位于根 `skills/bin/`。`skills/source-manifest.json` 记录固定源提交、源摘要、安装摘要和迁移差异；`skills/catalog.json` 记录入口、脚本及依赖强度。上游合同归档在 `skills/docs/vendor/dot-codex/`，不替代本项目规范。资源打包将 TS 源码、完整资源及浏览器资产复制到 `toolkit/`，不转译、不搜索全局 dot-codex 执行代码。Skill 文档中的 `LOOMHELM_TOOLKIT_ROOT` 指向该资源根；`skills run` 原样执行 `.ts` 脚本。包的 bin、exports 和类型入口均指向 `src/`。

所有随包执行代码、合同资源和构建支持都位于 `skills/`：共享脚本在 `skills/bin/`，上游合同在 `skills/docs/vendor/dot-codex/`，维护与构建入口在 `skills/scripts/`。vendor 仅检出 `skills/` 即可保留完整源资源，不需要修改用户的 sparse checkout 或安装配置。安装目录内执行 `bun install --cwd skills --frozen-lockfile --ignore-scripts --backend=copy` 与 `bun install --cwd skills/multi-task-flow --frozen-lockfile` 准备声明的依赖，再执行 `bun run --cwd skills build` 仅构建浏览器 JS/CSS；本机 TS 无需编译。外部 Git、Codex 宿主工具及条件性 Skills 仍按既有合同检测，不复制到源包中。

`bun skills/scripts/check-skills-installation.mjs --root <installation-root> --probe` 分别报告源码完整性、Bun 运行时及实际入口探测；宿主能力单独验收。该检查不会修改任何用户级安装或运行账本。

```sh
bun src/cli.ts skills list
bun src/cli.ts skills check project-engineering-workflow
bun src/cli.ts skills run skills/bin/plan_contract_check.ts --plan - < plan.md
bun src/cli.ts flow view --input - < view-request.json
```

`flow COMMAND --input -` 原样承接 Multi-task Flow 请求、JSON 输出和退出码，账本仍为 schema_version=2 / contract_version=2。生产 socket 优先级为 `--socket` / 配置 `codexAppServerSocket`、`LOOMHELM_CODEX_APP_SERVER_SOCKET`、`CODEX_APP_SERVER_SOCKET`、原 Codex 默认路径。普通 fresh dispatch 与活跃运行的 conversation-create 具有不同授权和回执合同，不能互相冒充。

`skills check` 的 `readinessScope=all-declared-scenarios` 表示保守检查该 Skill 声明的全部条件性场景，不代表每项依赖对每次操作都适用；每项报告保留适用条件。报告覆盖外部 Skill、PATH 中的专项命令、原生宿主能力和已验证的平台组合。命令存在不证明登录、授权或操作成功；原生能力只能由调用方的真实宿主工具清单通过 SDK 的第三参数声明，CLI 不猜测，缺少声明返回 `HOST_CAPABILITY_UNVERIFIED` 和退出码 3。实际专项操作仍须执行源合同的场景门禁与授权检查；该报告不安装工具、不探测外部业务或执行副作用。

旧 `flow schedule/start/finish/recover` 以及数组式 init 返回 `FLOW_LEGACY_ARGUMENTS_UNSUPPORTED`。旧 `orchestration.json`、`tasks.json`、`dispatch.json` 保留原处，不自动转换或删除。旧 `TaskGraph` / `TaskOrchestrator` 已移除。核心本地任务执行、幂等收据和显式 Codex 子进程派发继续作为独立底层能力存在。

`workflow local-verify MANIFEST_JSON_PATH` 和 `LocalValidation` 仅承载可复用的局部验证，输出 `locally-validated`；不证明完整工程工作流、PR 就绪或发布完成。旧 `workflow verify` 明确报兼容错误。正式交付必须按迁入的工程 Skills 执行授权、审查、CI 和停靠合同。

本地编排网页保留鉴权、loopback、PID/generation、端口租约和 macOS 按需 launchd 管理。升级代码不授权替换现有 viewer、抢占端口或写入真实旧运行；使用独立测试 scope 验证。更旧账本仍遵守原只读/维护边界，不能一概声明兼容可写。

viewer 新包采用 v2 清单，覆盖启动 shell、TS、依赖及网页的逐文件摘要；固定 Bun 直接运行 TS。旧 v1 包仅可诊断，不能静默用于启动或升级。本次不安装、启动或替换现有用户服务。

## 平台与构建

生产仅支持 Bun 1.4.4；Node 和旧 `dist/` CLI 不再受支持。使用 Bun 内置 `bun:ffi`，保留目录描述符相对操作、flock 和原子不覆盖重命名，不需要项目原生编译或 Python 辅助进程。验证平台为 macOS arm64 与 Linux x64 glibc，Windows 不受支持。专项 Skill 仍要求各自的外部工具与授权，发现源包不代表已具备其宿主能力。

来源提交未包含独立 LICENSE 文件，不能据此推断公共再分发许可；保留源文件原有版权和许可内容及来源清单。

## 集成边界

公共类型从 `src/index.ts` 导出；源码包直接提供 TS 导出与类型，类型检查使用 noEmit。`runtime` 集中进程、文件和锁适配；`tasks` 负责纯状态规则、事实持久化和收据；`git` 独立于服务端调用本机 Git。生产资源不包含 Node 加载器或编译 JS 回退。

本包提供 [客户端设计](../../docs/design/client.md) 所定义的独立核心、Codex app-server 接线、Skills/工程工作流入口、dispatch 和持久任务编排。Connected mode 仍未实现；不能将本包测试通过解释为整个产品范围均已验收。
