# Multi-task Flow CLI Contract

本文件是 Multi-task Flow CLI 的人类可读命令契约；运行时 schema 由 `packages/multi-task-flow-runtime/lib/schema.ts` 与 `lib/engine.ts` 实现，Skill 只引用本文件并描述编排流程。

## Invocation

正式调用使用 `bunx --bun @loomhelm/multi-task-flow@<exact-version> flow <command> --output json --input -`，stdin 必须是一个 JSON 对象；禁止使用 `latest`、裸缓存二进制或仓库源码路径替代精确版本。

## 人类与机器输出

全局参数 `--output auto|human|json` 优先于 `MULTI_TASK_FLOW_OUTPUT`，缺省为 `auto`；显式 auto 覆盖环境变量的固定风格。stdout 非 TTY、非空 `CODEX_THREAD_ID`、`MULTI_TASK_FLOW_AGENT=1` 或真值 `CI` / `CONTINUOUS_INTEGRATION` 时自动选择 JSON，其他情况选择 human。CI 真值是去除空白后非空且忽略大小写不等于 `0` 或 `false`。stdin 是否重定向不参与判断；检测不代表身份认证，正式 Agent 调用必须显式指定 JSON。

全局参数可放在子命令前后，支持 `--name=value`，重复、缺值或非法值在副作用前拒绝。`--` 后是透传参数；`skills run SCRIPT` 后的旧式脚本参数也归脚本所有。`--verbose` 增加人类细节；`--color auto|always|never` 独立选择颜色，显式 always/never 优先于 `NO_COLOR`，auto 在 `NO_COLOR` 存在、`TERM=dumb` 或目标流非 TTY 时关闭；JSON 永远无色。

所有公开命令层级提供 `-h`、`--help`、`help` 和命令组帮助；JSON 帮助包含 `schema_version=1`、`command`、`summary`、`usage`、`options`、`examples`、`subcommands`。`schema --format json` 始终输出原机器 Schema。人类帮助按用途显示参数和示例，不直接倾倒 request/response Schema。

human 默认展示关键身份、状态、revision、计数、阻塞及安全的下一步；列表最多显示 20 项，单字段最多 160 字符，省略明确提示；verbose 逐项显示展开路径，单字符串最多 4096 字符，完整结果使用 JSON。人类展示必须区分业务结果、输出交付和调用静止，unknown 不等于失败。JSON 业务字段、错误通道和退出码保留原合同；人类错误写 stderr。响应尚未给出结果标记时使用有界判定缓冲，超限的接收中信息写 stderr，完整成功结果再按 stdout 展示；错误摘要不依赖 JSON 字段顺序。没有顶层 code 的 unknown 状态仍提示先对账。新增全局参数错误沿用顶层 stderr `{code: "CLI_ERROR", error: "..."}` 和退出码 1。

human 和 verbose 的投影路径最多 64 层，超深内容明确提示省略，仍校验全部 JSON；每个有界输入批次让出事件循环，使停止信号可及时处理。含凭据标识的诊断文本保守隐藏，错误码和恢复建议独立保留。

Flow JSON 使用原有背压直通；human 使用增量 UTF-8/JSON 解析及有界展示缓冲，消费并验证全部语法，不缓存完整响应。接收中不宣布最终成功，输出或解析失败沿用停止路径，不重做业务、不追加第二份 JSON。`service daemon`、内部 worker 和 `skills run` 的 raw 输出不改变。

### 常用只读参数

`service status` / `service doctor` 可省略 JSON 输入，内部请求为 `{}`。`flow show/view` 支持 `--run-id`、`--actor-role main|group|task`、`--thread-id`，三项全部必填并经过原 runtime 身份与版本校验。show 另支持 `--section`、`--task-id`，普通参数形式默认 summary；view 支持 `--plan-id`。普通参数与 `--input -` 互斥；旧 JSON 请求的默认 section 仍为 full。

```sh
bunx --bun @loomhelm/multi-task-flow@<exact-version> --output human service status
bunx --bun @loomhelm/multi-task-flow@<exact-version> --output human flow show --run-id RUN_ID --actor-role main --thread-id THREAD_ID --section summary
bunx --bun @loomhelm/multi-task-flow@<exact-version> --output json flow show --input - < request.json
```

TTY 默认由 JSON 改为 human 是可观察兼容性变化；机器消费者应显式选择 JSON。业务 JSON 和持久状态合同不变；发布时须按仓库兼容线政策评估该默认行为变化，不能仅凭原 JSON 字段未变宣称终端默认完全兼容。本变更不选择发布版本或更新全局安装。

## Common mutation envelope

写操作通常使用 `{ "run_id": "...", "actor": { "role": "main|group|task", "thread_id": "..." }, "request_id": "...", "expected_revision": 0, "payload": {} }`；`request_id` 必须唯一，重放只允许使用相同 canonical input，revision 冲突必须先读取账本再决定下一步。

`merge-claim` 的 `parent-followup` 模式仅适用于 contract 3 或更高版本中已经 merged 且有 approved plan revision 新增 active contribution 的 DeliveryUnit；普通 `parent` 模式只适用于 active DeliveryUnit。续作 payload 必须包含 `original_parent_pr`、40 或 64 位 `original_parent_merge_sha`、独立 follow-up `pr`、`target_branch`、预期 head/base 和 `owner_approval_id`；protected approval 的 `target_digest` 是目标摘要的 64 位小写 SHA-256，成功 claim 后不得重复使用同一审批。

## Commands

| Command | Access | Payload or query | Safe recovery |
| - | - | - | - |
| `init` | write | `repository`, `config`, `initial_plan`, `groups`, `tasks` | 只在未绑定运行上执行；失败后检查账本，不重复初始化 |
| `show` | read | `section`: `summary`, `plan`, `tasks`, `operations`, `notifications`, `task-context`, `full`; `task-context` 需要 `task_id` | 重新读取一致快照 |
| `view` | read | 可选 `plan_id` | 重新读取一致视图 |
| `invocation-inspect` | read | `run_id`, bound main `actor` | 返回 source/executor 身份、调用状态、marker_digest 与 evidence_refs；不修改文件 |
| `invocation-reconcile` | write/reconcile | 标准 mutation envelope；payload 为 `invocation_id`, `marker_digest`, `evidence_refs` | 仅验证同一调用的不可变资源终态凭据并补写停止事实；相同输入幂等，不重复业务操作 |
| `migrate` | write | 空 payload，要求绑定 actor、request、expected revision | 仅相同 canonical input 幂等重放 |
| `conversation-create` | external write | `operation_id`, `title`, `prompt` | 超时、断线或证据不完整先进入 `creation-reconcile`；确认 interrupted handshake 后可显式 `initialization-recover` |
| `initialization-recover` | external write | `operation_id` | 仅恢复一次固定握手；持久化 attempt 后只能对账，不能自动重发 |
| `creation-reconcile` | write/reconcile | `operation_id` | 没有完整 thread、初始化 turn、worktree 和执行配置证据时保持 `unknown` |
| `notification-prepare` / `notification-send` | external write | `notification_id` | 先领取唯一 attempt；pending/unknown 必须 reconcile |
| `notification-reconcile` | read or write | status 查询，或标准 mutation envelope | 以 provider evidence 为准，不凭错误消息推断成功 |
| `execution-profile-migrate`, `execution-profile-default-update`, `execution-profile-recommend` | write | 字段说明见 `flow <command> --help`；完整 schema 见 `flow schema --format json` | 发现 profile conflict 时重新读取目标配置 |
| 其余 runtime mutation commands | write | 每个命令在 JSON Schema registry 中有独立 request/response 定义；`dispatch-bind-request`、`dispatch-resolve`、`initialization-recovery-claim` 和 `initialization-recovery-observe` 标记为 `internal`/`cli-only`，只能由 `conversation-create`、`creation-reconcile` 或 `initialization-recover` 的相应创建、对账与恢复编排内部调用 | 先检查返回 code、revision 和 operation 状态 |

## Machine-readable surfaces

registry 当前包含 66 个精确命令；`multi-task-flow flow --help` 输出调用形式和安全边界；`multi-task-flow flow <command> --help` 输出该命令的用途、参数和示例，完整 request/response schema 由专用 schema 命令提供；`multi-task-flow flow schema --format json` 输出符合 JSON Schema Draft 2020-12 的完整 command registry。`dispatch-bind-request` 与 `dispatch-resolve` 是 Contract 3 的内部 CLI-only 命令，直接调用会返回 `CLI_ONLY_DISPATCH`。

每个 registry command 都包含 `request`、`response.success` 和 `response.error`；request 明确定义 envelope 与 payload 字段，success 明确定义 `{ ok, code, revision, result }`，error 明确定义 `{ ok, code, revision, message, details }`。registry 的 `$defs` 来自 `flow-domain-schemas.json`，其中 `plan`、`group`、`task`、`ledger`、`execution_profile`、`baseline_receipt`、`notification`、`fact`、`resource`、`atomic_node` 和 `atomic_edge` 由 runtime 的 Zod schema 生成 JSON Schema；provider receipt 按 runtime 的严格字段定义，其他外部事实保留 runtime 明确允许的开放对象边界。

## Error handling

CLI 错误必须返回 `{ "ok": false, "code": "...", "revision": null|number, "message": "...", "details": {} }`；`INVALID_INPUT`、`ACTOR_MISMATCH`、`DEPENDENCIES_PENDING`、`REVISION_CONFLICT`、`CREATION_PENDING`、`UNKNOWN` 和 `CLI_ONLY_DISPATCH` 表示不同的后续动作，不能统一当作可重试失败。

## Ownership

本文件由 CLI/runtime 维护者在仓库中维护；发布包可以携带其副本，Skill 通过 `references/cli-contract.md` 引用它，运行时不会生成或修改 Markdown 文档。JSON Schema registry 是 CLI 的机器契约，Markdown 只负责解释调用语义和恢复规则。

## Interrupted initialization recovery

`initialization-recover` 使用标准 mutation envelope，只允许 bound main；payload 严格为 `{ "operation_id": "..." }`，不接收任意 prompt、模型或 thread。首次调用先检查原始 interrupted 握手和独立 worktree，再追加不可重发的 attempt；任务独占 私有 writer 在取得原生写锁后再次检查历史。当前仅支持已验证的 codex-cli 0.169.0，其他版本 fail closed。成功后返回同一 dispatch 的 succeeded 结果与 handoff notification；失败可能已提交 attempt，因此必须重新读取 revision 和 operation 后通过 `creation-reconcile` 对账，不能根据非零退出码重建会话。

`creation-reconcile` 遇到注册的 recovery attempt 时复读 original/recovery 两个 turn 并核验固定提示和 READY；不会发送新消息。只有 intent、没有可证明的 recovery turn 时保持 unknown，需独立审计。旧的 interrupted turn 不会被覆盖。创建与恢复默认预留初始化预算加 200 秒（覆盖两次有界历史读取、Git 身份核验和关闭），显式 processTimeoutMs 不足时在副作用前报告 FLOW_PROCESS_BUDGET_TOO_SHORT。

## 编排版本生命周期

正常结果的输出合同、只读命令 show、view（含 task-context 查询视图）以及专用 invocation inspect/reconcile 边界见 [OUTPUT_AND_INVOCATION.md](OUTPUT_AND_INVOCATION.md)，对应 REQ-INVOCATION-001 至 REQ-INVOCATION-006。实现与验收覆盖见 [IMPLEMENTATION.md](IMPLEMENTATION.md#编排输出与调用停止对账)。纯查询可读不代表编排已静止，也不放宽下述版本及升级门禁。

`multi-task-flow orchestration schema --format json` 暴露 schema_version=1 的升级检查报告 schema，不访问 run 或原生资源。

`multi-task-flow orchestration compatibility-check --run-id <run-id>` 只报告兼容性；`multi-task-flow orchestration upgrade-check --run-id <run-id>` 只读评估机械迁移，输出 schema_version=1、源/调用者/目标身份、revision/digest、目录身份、业务与结果不确定的调用摘要、snapshot（entries、bytes、max_bytes、within_byte_budget）、migration_supported、migration_ready、完整 blockers 和 next_action。snapshot 是整个 run 目录的只读预算统计，历史条目数不构成阻断，超过 max_bytes 时返回 snapshot_too_large。编排命令遵守全局 `--config` 的 processTimeoutMs，默认仍为 30 秒；大快照需要调用方显式提高进程预算。迁移可行不代表原生静止；native_quiescence 始终为 not_asserted，既有调用可能继续完成，晚回执可能无法写回。只有 `orchestration upgrade --run-id <run-id> [--dry-run] <version|tag>` 执行目标解析或升级，目标必须匹配调用 artifact；不接受编排 rollback。

普通 flow（包括 show/view）继续匹配完整 package/version/build/source 与合同集合，新初始化原子发布 contract 6 和 schema-4 绑定。显式机械迁移支持 schema-2/contract-3/4/5 到 contract 6，业务图、owner、thread/worktree、unknown/attempt/claim 和容量原样保留；生命周期预设以显式 `lifecycle_role` 为准，旧 ID 仅按 owner scope 和完整后缀规则兼容读取，不从标题或任意 ID 猜测角色或依赖边。更早格式维持只读诊断，缺少支持的迁移返回 RUN_MIGRATION_UNSAFE，details 含全部 blocker。普通命令版本不符仍返回 RUN_VERSION_MISMATCH，不从 Gateway 或全局安装猜测来源。

upgrade-check、compatibility-check 和 dry-run 不创建 ledger/lifecycle 锁或修改任何 run 文件，不开启原生 writer 或发送调用。读取检查 no-follow、所有权、硬链接、目录身份及前后内容；observation_stale 不返回 ready。dry-run 与正式 upgrade 共用评估器，不能提前把兼容当成升级成功。

prepared 在既有 lifecycle、维护、账本和绑定排斥下原子交换 run 目录，一同发布 contract-6 账本、schema-4 绑定与 migration_audit；源目录保留为 runs/.upgrade-<uuid>/。审计包含源 revision/digest、绑定与旧 invocation receipt 摘要、业务及结果不确定的对象摘要、转换规则和 writer 屏障判定，不保存原始提示或会话。后续依次推进 migrated、binding_switched、completed，期间普通命令 UPGRADE_INCOMPLETE，只能向冻结目标续跑；源备份与审计不符拒绝。升级没有新建、恢复、通知、归档或结果对账副作用。

旧 flow 在 contract-6 屏障后拒绝，旧绑定维护入口因 schema-4 拒绝，旧目录等待者不能穿透。已登记但结果不确定的调用不因迁移被重发、清空或标成停止；旧 provider 晚回调不允许写回目标。源 snapshot 保存被携带的 invocation receipt，完成的迁移只在摘要精确匹配时允许新身份建立新 receipt，不把旧 receipt 改成 stopped；当前身份的新 running receipt 仍阻断重入。初始化 recovery 缺失 turn/权限快照的拒绝边界保持；归档负向查询保留原 operation_id 与 attempt 时间，缺失身份拒绝，不再归档或反归档。自定义静态视图不得改变编排绑定的可执行 Worker 身份。

副作用调用的 stopped 投影必须有匹配不可变停止事实；机械迁移携带旧 receipt 不等价于停止。

原子目录发布前的候选副本不构成已接受升级，原 run 保持原格式；发布后 prepared 记录是唯一续跑依据。平台或文件系统没有原子目录交换能力时返回 `UNSUPPORTED_PLATFORM` 或 `UPGRADE_PUBLICATION_FAILED` 并保留源与候选，不用连续 rename 降级模拟。源快照、符号链接或目录身份异常均阻断，不自动清理历史恢复材料。新版等待者在执行动作前重新核验目录身份，旧账本锁等待者不能穿透已替换的目录边界。

## Invocation inspection and reconciliation

`invocation-inspect` 与 `invocation-reconcile` 只允许绑定的 main；前者为零写入查询，后者不执行原生调用、不修改业务状态或权限。专用入口核验历史 source 与修复 executor 的独立身份，允许受支持的 schema-2/contract-3、contract-4 源以及 initialize 恢复规则列明的精确审计 contract-5 来源在正式升级前对账；普通命令仍要求精确绑定当前版本。`evidence_refs` 必须精确采用 inspect 返回的 canonical SHA-256 摘要；普通路径覆盖各资源终态，initialize 能力恢复覆盖原始证明文件，规则见 [INITIALIZE_RECOVERY.md](INITIALIZE_RECOVERY.md)。调用方不得自行改变 refs，不能提交“进程已死”或自行声明 stopped。缺少完整执行来源、执行完成或资源终态凭据的历史调用返回 `INVOCATION_EVIDENCE_REQUIRED`，保持阻断。

Flow 默认流式传输，不限制累计输出字节；stdout/stderr 每次最多转发 64 KiB 并等待写完成，慢消费者会暂停上游读取。只有用户明确配置 `maxOutputBytes` 时才按 stdout 与 stderr 合计预算限制（1 字节至 64 MiB）；通用捕获型执行器仍默认限制 1 MiB。输出失败走相同停止路径，已输出 stdout 后只在 stderr 报告失败并非零退出，不追加第二份 JSON 或重做业务。独立 IPC 仅接受匹配 invocation_id 的 stop/stopped，协作停止最多等待 200 秒；后续终止自有进程树不产生安全停止证明。
