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
| `conversation-create` | external write | `operation_id`, `title`, `prompt` | 超时、断线或证据不完整只能进入 `creation-reconcile` |
| `creation-reconcile` | write/reconcile | `operation_id` | 没有完整 thread、初始化 turn、worktree 和执行配置证据时保持 `unknown` |
| `notification-prepare` / `notification-send` | external write | `notification_id` | 先领取唯一 attempt；pending/unknown 必须 reconcile |
| `notification-reconcile` | read or write | status 查询，或标准 mutation envelope | 以 provider evidence 为准，不凭错误消息推断成功 |
| `execution-profile-migrate`, `execution-profile-default-update`, `execution-profile-recommend` | write | 每个命令的字段见 `flow <command> --help` | 发现 profile conflict 时重新读取目标配置 |
| 其余 runtime mutation commands | write | 每个命令在 JSON Schema registry 中有独立 request/response 定义 | 先检查返回 code、revision 和 operation 状态 |

## Machine-readable surfaces

registry 当前包含 61 个精确命令；`multi-task-flow flow --help` 输出调用形式和安全边界；`multi-task-flow flow <command> --help` 输出该精确命令的 request/response schema；`multi-task-flow flow schema --format json` 输出符合 JSON Schema Draft 2020-12 的完整 command registry。

每个 registry command 都包含 `request`、`response.success` 和 `response.error`；request 明确定义 envelope 与 payload 字段，success 明确定义 `{ ok, code, revision, result }`，error 明确定义 `{ ok, code, revision, message, details }`。registry 的 `$defs` 来自 `flow-domain-schemas.json`，其中 `plan`、`group`、`task`、`ledger`、`execution_profile`、`notification`、`atomic_node` 和 `atomic_edge` 由 runtime 的 Zod schema 生成 JSON Schema；provider receipt 按 runtime 的严格字段定义，provider fact、evidence 和其他外部事实保留 runtime 明确允许的开放对象边界。

## Error handling

CLI 错误必须返回 `{ "ok": false, "code": "...", "revision": null|number, "message": "...", "details": {} }`；`INVALID_INPUT`、`ACTOR_MISMATCH`、`DEPENDENCIES_PENDING`、`REVISION_CONFLICT`、`CREATION_PENDING`、`UNKNOWN` 和 `CLI_ONLY_DISPATCH` 表示不同的后续动作，不能统一当作可重试失败。

## Ownership

本文件由 CLI/runtime 维护者在仓库中维护；发布包可以携带其副本，Skill 通过 `references/cli-contract.md` 引用它，运行时不会生成或修改 Markdown 文档。JSON Schema registry 是 CLI 的机器契约，Markdown 只负责解释调用语义和恢复规则。
