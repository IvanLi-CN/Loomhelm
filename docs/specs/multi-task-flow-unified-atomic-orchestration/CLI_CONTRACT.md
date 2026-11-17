# Multi-task Flow CLI Contract

本文件是 Multi-task Flow CLI 的人类可读命令契约；运行时 schema 由 `packages/multi-task-flow-runtime/lib/schema.ts` 与 `lib/engine.ts` 实现，Skill 只引用本文件并描述编排流程。

## Invocation

正式调用使用 `bunx --bun @loomhelm/multi-task-flow@<exact-version> flow <command> --input -`，stdin 必须是一个 JSON 对象；禁止使用 `latest`、裸缓存二进制或仓库源码路径替代精确版本。

## Common mutation envelope

写操作通常使用 `{ "run_id": "...", "actor": { "role": "main|group|task", "thread_id": "..." }, "request_id": "...", "expected_revision": 0, "payload": {} }`；`request_id` 必须唯一，重放只允许使用相同 canonical input，revision 冲突必须先读取账本再决定下一步。

## Commands

| Command | Access | Payload or query | Safe recovery |
| - | - | - | - |
| `init` | write | `repository`, `config`, `initial_plan`, `groups`, `tasks` | 只在未绑定运行上执行；失败后检查账本，不重复初始化 |
| `show` | read | `section`: `summary`, `plan`, `tasks`, `operations`, `notifications`, `task-context`, `full`; `task-context` 需要 `task_id` | 重新读取一致快照 |
| `view` | read | 可选 `plan_id` | 重新读取一致视图 |
| `migrate` | write | 空 payload，要求绑定 actor、request、expected revision | 仅相同 canonical input 幂等重放 |
| `conversation-create` | external write | `operation_id`, `title`, `prompt` | 超时、断线或证据不完整先进入 `creation-reconcile`；确认 interrupted handshake 后可显式 `initialization-recover` |
| `initialization-recover` | external write | `operation_id` | 仅恢复一次固定握手；持久化 attempt 后只能对账，不能自动重发 |
| `creation-reconcile` | write/reconcile | `operation_id` | 没有完整 thread、初始化 turn、worktree 和执行配置证据时保持 `unknown` |
| `notification-prepare` / `notification-send` | external write | `notification_id` | 先领取唯一 attempt；pending/unknown 必须 reconcile |
| `notification-reconcile` | read or write | status 查询，或标准 mutation envelope | 以 provider evidence 为准，不凭错误消息推断成功 |
| `execution-profile-migrate`, `execution-profile-default-update`, `execution-profile-recommend` | write | 每个命令的字段见 `flow <command> --help` | 发现 profile conflict 时重新读取目标配置 |
| 其余 runtime mutation commands | write | 每个命令在 JSON Schema registry 中有独立 request/response 定义；`dispatch-bind-request`、`dispatch-resolve`、`initialization-recovery-claim` 和 `initialization-recovery-observe` 标记为 `internal`/`cli-only`，只能由 `conversation-create`、`creation-reconcile` 或 `initialization-recover` 的相应创建、对账与恢复编排内部调用 | 先检查返回 code、revision 和 operation 状态 |

## Machine-readable surfaces

registry 当前包含 61 个精确命令；`multi-task-flow flow --help` 输出调用形式和安全边界；`multi-task-flow flow <command> --help` 输出该精确命令的 request/response schema；`multi-task-flow flow schema --format json` 输出符合 JSON Schema Draft 2020-12 的完整 command registry。`dispatch-bind-request` 与 `dispatch-resolve` 是 Contract 3 的内部 CLI-only 命令，直接调用会返回 `CLI_ONLY_DISPATCH`。

每个 registry command 都包含 `request`、`response.success` 和 `response.error`；request 明确定义 envelope 与 payload 字段，success 明确定义 `{ ok, code, revision, result }`，error 明确定义 `{ ok, code, revision, message, details }`。registry 的 `$defs` 来自 `flow-domain-schemas.json`，其中 `plan`、`group`、`task`、`ledger`、`execution_profile`、`baseline_receipt`、`notification`、`fact`、`resource`、`atomic_node` 和 `atomic_edge` 由 runtime 的 Zod schema 生成 JSON Schema；provider receipt 按 runtime 的严格字段定义，其他外部事实保留 runtime 明确允许的开放对象边界。

## Error handling

CLI 错误必须返回 `{ "ok": false, "code": "...", "revision": null|number, "message": "...", "details": {} }`；`INVALID_INPUT`、`ACTOR_MISMATCH`、`DEPENDENCIES_PENDING`、`REVISION_CONFLICT`、`CREATION_PENDING`、`UNKNOWN` 和 `CLI_ONLY_DISPATCH` 表示不同的后续动作，不能统一当作可重试失败。

## Ownership

本文件由 CLI/runtime 维护者在仓库中维护；发布包可以携带其副本，Skill 通过 `references/cli-contract.md` 引用它，运行时不会生成或修改 Markdown 文档。JSON Schema registry 是 CLI 的机器契约，Markdown 只负责解释调用语义和恢复规则。

## Interrupted initialization recovery

`initialization-recover` 使用标准 mutation envelope，只允许 bound main；payload 严格为 `{ "operation_id": "..." }`，不接收任意 prompt、模型或 thread。首次调用先检查原始 interrupted 握手和独立 worktree，再追加不可重发的 attempt；任务独占 私有 writer 在取得原生写锁后再次检查历史。当前仅支持已验证的 codex-cli 0.169.0，其他版本 fail closed。成功后返回同一 dispatch 的 succeeded 结果与 handoff notification；失败可能已提交 attempt，因此必须重新读取 revision 和 operation 后通过 `creation-reconcile` 对账，不能根据非零退出码重建会话。

`creation-reconcile` 遇到注册的 recovery attempt 时复读 original/recovery 两个 turn 并核验固定提示和 READY；不会发送新消息。只有 intent、没有可证明的 recovery turn 时保持 unknown，需独立审计。旧的 interrupted turn 不会被覆盖。创建与恢复默认预留初始化预算加 200 秒（覆盖两次有界历史读取、Git 身份核验和关闭），显式 processTimeoutMs 不足时在副作用前报告 FLOW_PROCESS_BUDGET_TOO_SHORT。

## 编排版本生命周期

`multi-task-flow orchestration compatibility-check --run-id <run-id>` 是专用只读诊断入口；`multi-task-flow orchestration upgrade --run-id <run-id> [--dry-run] <version|tag>` 是唯一自动升级入口。目标版本 CLI 使用已验证 artifact 的完整身份执行升级；精确指定自身版本使用该 artifact，标签首次解析后必须与调用者一致。编排不接受 `--rollback`，Gateway 的独立升级及回滚合同不变。

普通 `flow`（包括 `show`、`view`）同时核验账本身份和 `runtime/viewer-binding.json`，必须匹配 package/version/build/source、compatibility line 及 ledger/api/frontend/viewer 合同；`flow --help` 和 `flow schema` 不访问编排。新初始化原子发布 contract 4 账本和 schema-2 绑定，不能使用 Gateway 当前安装猜测来源。历史绑定缺失、不同 build 或尚未升级的数据返回 `RUN_VERSION_MISMATCH`；缺少已验证调用者身份返回 `CALLER_IDENTITY_UNAVAILABLE`。使用诊断查明来源，再显式升级，不能手工编辑绑定绕过。

直接支持 schema-2/contract-3 到 contract-4，以及 contract-4 到更新包版本；升级保持完整业务图、owner、operation、claim 和容量，只增加身份与升级审计并推进 revision。历史 schema-1/contract-1/contract-2 继续提供只读诊断和既有存储原语兼容测试；没有已验证的直接迁移链时返回 `MIGRATION_REQUIRED`，不推断业务语义或自动退役历史事实。缺少同编排可信绑定时返回 `SOURCE_IDENTITY_UNAVAILABLE`，不从全局配置补齐。

升级记录在 `ledger.json` 的 `upgrade` 中，包含唯一 operation、冻结 source/target、请求选择器、源 revision/digest、源绑定 revision/digest、源目录快照名和账本备份名。`prepared` 在既有维护、账本与绑定锁内原子交换整个 run 目录，同时发布 contract-4 账本和 schema-2 绑定，源目录保留为 `runs/.upgrade-<uuid>/` 恢复快照；后续依次推进 `migrated`、`binding_switched`、`completed`。`runtime_identity` 在 prepared 保持源身份，migrated 后成为目标身份。未完成时普通命令返回 `UPGRADE_INCOMPLETE`，只能显式 upgrade 续跑登记目标；重试原标签不会重新查询 registry。备份校验失败返回 `UPGRADE_BACKUP_INVALID`，状态或绑定冲突返回 `UPGRADE_STATE_CONFLICT`，均保留现场。备份仅用于独立灾难恢复，没有反向迁移。

CLI 与新版 Worker 用每个 run 的 lifecycle 锁覆盖原生调用的完整等待，并在 `runtime/call.json` 留下开始及安全退出回执。升级同时持有既有维护锁、账本锁和绑定锁，旧 flow 在 contract-4 屏障后拒绝读写，旧维护入口也因 schema-2 绑定而拒绝改写。调用超时、进程消失和 operation 为 unknown 都不等价于原生调用已停止；没有安全退出证据时返回 `RUN_QUIESCENCE_UNPROVEN`，不强杀进程。旧版本没有完整生命周期回执，含 claimed/unknown 操作的历史编排无法仅凭账本证明静止；专用诊断应保留该阻断。新版安全退出后，静止 unknown 及已有 claim 可以原样升级。

原子目录发布前的候选副本不构成已接受升级，原 run 保持原格式；发布后 prepared 记录是唯一续跑依据。平台或文件系统没有原子目录交换能力时返回 `UNSUPPORTED_PLATFORM` 或 `UPGRADE_PUBLICATION_FAILED` 并保留源与候选，不用连续 rename 降级模拟。源快照、符号链接或目录身份异常均阻断，不自动清理历史恢复材料。新版等待者在执行动作前重新核验目录身份，旧账本锁等待者不能穿透已替换的目录边界。
