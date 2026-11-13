# `@loomhelm/multi-task-flow`

独立的 Multi-task Flow Skill runtime 与本地账本 CLI，与 Go 客户端并存。包的正式入口是 `multi-task-flow`，兼容别名 `loomhelm` 仍保留；生产运行时只支持 Bun 1.4.4，包直接执行 TypeScript 源码并携带完整 Skill、合同和 viewer 资源，production dependencies 由消费者安装。

安装包不依赖父仓库 checkout、`~/.agents` 或全局 Skill 源包。`playwright`、`sharp`、`zod` 由 npm 根 package 声明并在消费者 `bun install` 时解析；React、ELK、vis 等只用于 workspace viewer build，Bun 是包外部前置条件，不由包自动安装或升级。

```sh
bunx --bun --package @loomhelm/multi-task-flow@compat-v1 multi-task-flow skills list
bunx --bun --package @loomhelm/multi-task-flow@compat-v1 multi-task-flow skills check multi-task-flow
bunx --bun --package @loomhelm/multi-task-flow@compat-v1 multi-task-flow flow view --input - < view-request.json
```

`compat-v1` 是显式兼容线，不等于 npm package version。package version、compatibility line、Skill version、source/merge SHA、合同版本、build ID 和 digest 在包内 artifact manifest 中分别记录；不从调用者传入的 dist-tag 或 `latest` 推断身份。破坏 CLI 输入输出、账本语义或 viewer/service 边界的变更必须建立新的兼容线，旧兼容线继续保留为可安装版本。

## 版本化安装与内部版本矩阵

可重复的生产安装必须固定 package version；`@compat-v1` 只用于接收同一兼容线内经过门禁的最新版本，`latest` 不构成身份或兼容性证明。运行前置条件是 `bun --version` 返回 `1.4.4`；Bun 由宿主提供，包不会替换或升级它。

```sh
bunx --bun --package @loomhelm/multi-task-flow@0.2.10 multi-task-flow skills list
bunx --bun --package @loomhelm/multi-task-flow@compat-v1 multi-task-flow skills list
bunx --bun --package @loomhelm/multi-task-flow@0.2.10 multi-task-flow flow view --input - < view-request.json
```

当前源码投影的内部合同矩阵如下；`source_sha`、`merge_sha`、`build_id`、`canonicalDigestAlgorithm=path-byte-v2`、canonical digest 和 raw npm integrity 是每个候选构建的独立身份字段，不能由这张静态表推断。

| 维度 | 当前值 |
| - | - |
| package | `@loomhelm/multi-task-flow@0.2.10` |
| compatibility line | `compat-v1` |
| Skill | `2.7.6` |
| ledger contract | `3` |
| API | `1` |
| frontend | `1` |
| viewer | `5` |
| service | `1` |

破坏 CLI 输入输出、账本写入语义、viewer API、frontend 或 service 边界时，必须提升 `compat-vN`；仅提升 package SemVer 不会扩大旧兼容线的合同。包发布仍需经过仓库 release gate 和精确 merge SHA 验证，当前源码投影不等于已经发布到 npm。

npm 发布需要 npm Trusted Publisher 绑定 `IvanLi-CN/Loomhelm` 与 `skill-release-publish.yml`，以及 owner-approved release workflow；不使用长期 npm 写入 token。缺少 Trusted Publisher 或 workflow receipt 时只执行本地 build、pack 和 tarball 校验，不把本地候选称为已发布包。

发布 workflow 使用同一 candidate tarball 执行 exact registry reconcile；404、processing、已知 409、timeout 和 identity mismatch 都必须记录 receipt，不能重传或重建。exact registry identity 对账成功才是 `published`，compatibility line、`latest` 和显式 `stable` 逐个 read-back 成功才是 `completed`；现有 `0.2.7` schema v2 artifact 只做 raw integrity/legacy identity 对账，禁止重传。

客户端只提供 `release identity` 和 `release validate` 等本地只读检查；`release publish`、`publish:exact` 和 `publish:compat` 不提供直接 npm 写入路径，发布只能由受保护的 Skill Runtime Release workflow 完成。

```sh
bun install --frozen-lockfile
bun install --cwd skills/multi-task-flow-runtime --frozen-lockfile
bun --no-install run skills:build
cd clients/typescript
bun install --frozen-lockfile
bun --no-install run check
bun --no-install run test
bun --no-install src/cli.ts --config config.example.json status
```

发布包构建前需要准备 Skill build inputs 与消费者依赖：`bun install --cwd skills --frozen-lockfile --ignore-scripts --backend=copy`、`bun install --cwd skills/multi-task-flow-runtime --frozen-lockfile` 和 `bun install --cwd clients/typescript --frozen-lockfile --ignore-scripts --backend=copy`。随后在 `clients/typescript/` 执行 `bun --no-install run build`，构建会拒绝摘要不一致、缺失 consumer dependency、符号链接资源和非法 package identity。

配置路径显式传入；相对 `stateDir` 相对于配置文件所在目录解析。未传配置时使用 `~/.loomhelm`。配置拒绝未知字段、未知版本及尚未实现的 Connected mode。源码从 `client/` 移入本目录后，示例配置使用 `../../client/.loomhelm`，继续读取仓库中原来的 `client/.loomhelm/`，该目录仍被根 Git 忽略规则排除。此兼容目录只保存状态，不放置客户端源码。

目录迁移不改变状态格式，不自动复制、合并或删除状态；任务、回执、Dispatch 身份和锁保持原路径。升级前停止正在使用该状态目录的客户端并备份该目录，再使用本目录的示例配置核对已有任务和回执；重复启动仍使用同一路径，旧版程序也能读取原状态。自定义配置保持原文件位置和 `stateDir`；若手动搬动配置，应把 `stateDir` 改为原状态目录的绝对路径。不要通过创建空状态目录代替恢复历史身份；需要回退时使用备份单独恢复，不自动逆转状态。

## 本地任务闭环

```sh
bun --no-install src/cli.ts --config config.example.json apply create-example '{"type":"task.create","task":{"id":"example","goal":"验证客户端","scope":"本地客户端","acceptance":"验证命令退出成功","dependencies":[]}}'
bun --no-install src/cli.ts --config config.example.json run verify-example example '["bun","--version"]'
bun --no-install src/cli.ts --config config.example.json tasks
bun --no-install src/cli.ts --config config.example.json receipts
```

命令输出 JSON；参数、I/O 或执行失败返回非零退出码。`run` 使用参数数组启动真实进程，将退出码、信号、有界 stdout/stderr 写入收据。Task 的可选 `repository` 指定命令工作目录，缺省继承 CLI 工作目录。相同 operation identity 和命令返回既有收据，不重复执行；改变请求内容会被拒绝。失败任务使用新的 operation identity 显式重试。`apply` 暴露底层事实接口，嵌入式使用者通过 `LocalClient`/`Ledger` 在同一个生命周期内完成 start/finish。

依赖必须先存在，从构造上禁止环。依赖仅在 succeeded 后解除门禁；失败、阻塞、中断可重试，成功、取消、跳过保持终态。取消/跳过只用于没有活跃 Run 的 Task。所有尝试、失败与恢复记录均保留。

## 生命周期与恢复

`LocalClient.open()` 获取独占写锁并重放账本；`close()` 等待已排队写入后释放锁。每个 CLI 进程拥有一个短生命周期，后续打开会把遗留 running Run 记为 interrupted，因此不要跨 CLI 调用手工拼接 start/finish；执行命令使用 `run`。SIGINT/SIGTERM 中断 CLI 子进程、保存中断收据并释放锁。运行时只拥有直接子进程，不管理其创建的后台服务或整个进程树。

进程异常退出可能留下 `writer.lock`。客户端不会自动偷锁；先读取准确状态目录中的该文件，核对 PID、hostname、token 与实际执行结果，再调用 `recover-lock TOKEN`。此命令只恢复同机、token 一致且 PID 已不存在的锁；活跃进程、PID 复用、不同主机或不确定身份均拒绝恢复。恢复操作本身异常退出留下的 `writer.recovery.lock` 必须由操作者核对后处理，不会自动删除。锁恢复不终止可能遗留的执行程序；重试前需对账外部副作用。

账本使用 schemaVersion 1，按顺序保存包含 operation identity、时间、前序摘要和 SHA-256 摘要的 Receipt。写入通过同目录临时文件、文件 fsync 与 rename 原子替换，失败时不更新内存状态。摘要用于发现损坏，不提供防恶意篡改的签名认证，也不承诺文件系统断电恢复。整个文件重写适用于第一阶段本地小型账本，未实现压缩或数据库迁移。

## Git/worktree

```sh
bun --no-install src/cli.ts git-status /absolute/repository
bun --no-install src/cli.ts worktree /absolute/repository /absolute/new-worktree feat/local-task HEAD
```

适配器检查干净源目录、有效分支、新目标和已解析的提交 SHA，使用 `git worktree add -b` 创建新分支与 worktree。它不清理已有路径、不强制覆盖、不更改 remote/upstream、不提交、不推送。失败时保留 Git 返回的信息与可能产生的资源，交由调用者核对；不自动执行破坏性回滚。创建资源后源目录的并发外部变化属于调用者协调边界。

## Codex 派发

顶层 CLI 通过自有的 Codex app-server 子进程接入 `ThreadDispatcher`；dispatch 日志和请求配置保存在 `stateDir` 下的独立目录。线程参数使用 `thread/start.model`、`thread/start.config.model_reasoning_effort`；turn 参数使用 `turn/start.input` 和 `turn/start.effort`。CLI 会等待匹配线程与 turn 的 `turn/completed` 事件，不会把 `turn/start` 响应当作任务成功。

```sh
bun --no-install src/cli.ts --config config.example.json codex dispatch REQUEST_ID '{"title":"Local worker","prompt":"Inspect the task","cwd":"/absolute/repo","model":"gpt-6.1-sol","effort":"high"}'
bun --no-install src/cli.ts --config config.example.json codex list
bun --no-install src/cli.ts --config config.example.json codex reconcile DISPATCH_ID
bun --no-install src/cli.ts --config config.example.json codex approve DISPATCH_ID
bun --no-install src/cli.ts --config config.example.json codex retry DISPATCH_ID accept
```

未显式提供决定时，CLI 会向 Codex 明确拒绝审批请求。可在派发 JSON 中传入 `approvalDecision`：`accept`、`decline` 或 `cancel`。重试失败或结果未知的派发前，必须先单独调用 `approve`；重试命令中的审批决定只用于处理该次重试期间出现的审批请求。RPC 明确拒绝会记为失败；响应丢失和完成等待超时会记为未知。重复使用 request ID 会读取既有日志，不会创建第二个线程。若进程在预留任务后、保存 thread ID 前退出，日志会留下未决的 `created` 记录，并对外报告为未知；由于无法证明 Codex 是否已创建线程，CLI 会禁止在缺少 thread ID 时批准或重试。

## Skills 与正式任务流

完整源包位于包内 `toolkit/skills/`，共享支持位于 `toolkit/skills/bin/`，预构建 viewer 资产位于对应的 Multi-task Flow dist 目录。`skills/source-manifest.json` 记录固定源提交、源摘要、安装摘要和迁移差异；`skills/catalog.json` 记录入口、脚本及依赖强度；`artifact-manifest.json` 记录 schema v3 package identity、`path-byte-v2` canonical digest 和逐文件摘要。资源打包将 TS 源码、完整资源和浏览器资产复制到 `toolkit/`，不复制 production `node_modules`，不转译、不搜索全局 dot-codex 执行代码。Skill 文档中的 `LOOMHELM_TOOLKIT_ROOT` 指向该资源根；`skills run` 原样执行 `.ts` 脚本。包的 bin、exports 和类型入口均指向 `src/`。

所有随包执行代码、合同资源和构建支持都位于 `skills/`：共享脚本在 `skills/bin/`，上游合同在 `skills/docs/vendor/dot-codex/`，维护与构建入口在 `skills/multi-task-flow-runtime/scripts/`。vendor 仅检出 `skills/` 即可保留完整源资源，不需要修改用户的 sparse checkout 或安装配置。安装目录内执行 `bun install --cwd skills --frozen-lockfile --ignore-scripts --backend=copy` 与 `bun install --cwd skills/multi-task-flow-runtime --frozen-lockfile` 准备声明的依赖，再执行 `bun --no-install run --cwd skills/multi-task-flow-runtime build` 仅构建浏览器 JS/CSS；本机 TS 无需编译。外部 Git、Codex 宿主工具及条件性 Skills 仍按既有合同检测，不复制到源包中。

`bun --no-install skills/multi-task-flow-runtime/scripts/check-skills-installation.ts --root <installation-root> --probe` 分别报告源码完整性、Bun 运行时及实际入口探测；宿主能力单独验收。该检查不会修改任何用户级安装或运行账本。

```sh
bun --no-install src/cli.ts skills list
bun --no-install src/cli.ts skills check project-engineering-workflow
bun --no-install src/cli.ts skills run skills/bin/plan_contract_check.ts --plan - < plan.md
bun --no-install src/cli.ts flow view --input - < view-request.json
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

## Viewer service 运维

viewer service 由单一 loopback gateway 管理，实际 worker 通过 owner-only Unix socket 受控；直接 ledger CLI 不经过 viewer HTTP，也不能借 viewer 路由绕过 ledger owner、revision 或 command identity。以下命令均通过已发布 npm 包的 `service` 子命令执行，输入必须是一个 JSON 对象并通过 stdin 传入：`multi-task-flow service <command> --input -`。

```sh
multi-task-flow service status --input - < status.json
multi-task-flow service doctor --input - < empty.json
multi-task-flow service ensure --input - < ensure.json
multi-task-flow service compatibility-check --input - < published-bundle.json
multi-task-flow service upgrade --input - < published-bundle.json
multi-task-flow service rollback --input - < rollback.json
```

`published-bundle.json` 必须引用由受保护 Skill Runtime release workflow 生成并校验的、与当前平台匹配的 v2 bundle；用户侧不运行 `build-service.ts`，也不把 npm CLI 或 Skill source 目录作为 viewer。`ensure` 的 actor 至少包含 `{ "run_id": "<run-id>", "thread_id": "<thread-id>", "api_version": 1 }`；它会核对安装 manifest、generation、PID、port 和 health identity，并在旧实例停止后重新建立租约。`status` 或 `doctor` 先确认安装、运行阶段和当前 build；启动失败时保留 runtime 状态并检查配置 user service 的 launchd 记录，不删除 data 或 release 目录。

agent lease 默认 60 分钟，browser lease 默认 5 分钟；浏览器页面应每 60 秒续租。所有租约过期后服务进入 stopping，账本和发布目录保留，下一次 `ensure` 负责恢复；不要通过删除 runtime、抢占端口或手工杀死不属于当前 generation/PID 的进程来“修复”。`credential-rotate` 或 `credential-revoke` 会撤销 browser sessions，之后必须重新获取一次性登录票据；`login` 返回的 URL 只使用一次且 60 秒过期。

升级顺序是 `status`/`doctor`、`compatibility-check`、`upgrade`、health 验证；回退使用 `compatibility-check` 的 `{ "rollback": true }` 报告后再执行 `rollback`。候选不可读、custom view 不兼容、generation/PID 不匹配或旧 reader 也无法安全读取时必须停在 preflight；不得强制切换、自动反向迁移或盲目重试未知发布结果。

历史账本的合同迁移使用 `ledger-maintenance-check` 和 `ledger-maintenance-apply`，不是 `import`/`migrate` 别名。check 先产生 source/target contract、owner、revision、ledger digest、pending operations 和 operation digest；apply 必须携带原 owner thread、expected revision、expected ledger SHA-256、operation digest、maintenance identity、approval reference、reason 和 `writers_paused: true`，并保留完整 backup。迁移只允许机械补齐合同 envelope，不补造 baseline、event、owner 或业务策略。

最新 reader 对受支持历史格式执行双读；旧 reader 仅在最新 reader 无法安全解释时进入隔离只读 fallback。fallback 不得取得 lease、修改 revision、写入 ledger 或伪装成当前 service；损坏或无法证明安全读取的 run 单独标记并 fail closed。恢复时先按 `run_id`、build/source/merge identity、generation、PID、ledger SHA-256 和 provider receipt 对账，再决定重试或回退。
