# Shared viewer operations

The viewer architecture is **Stable Gateway + Per-Run Versioned Workers**. The daemon is the Gateway and Worker Supervisor: it owns the HTTP port and public pages and starts and supervises only the separate Worker processes. Each run is routed by its package version, build ID, source SHA and compatibility contracts; the daemon's current package version is not a substitute for a run's version identity.

Update discovery belongs to the `multi-task-flow` CLI. The CLI reads a throttled local cache and schedules an asynchronous registry check when stale; it is independent of daemon or Gateway runtime. The index page may display the Gateway hint returned by the CLI, while an orchestration page may display the run-specific hint returned by the orchestration upgrade command. Neither page performs registry discovery.

The shared hint contract is `{ surface, current, target?, compatible, reason, command }`; `current` contains `package_version`, `build_id`, `source_sha`, `compatibility_line` and `viewer_contract`. The index uses `surface: "gateway"`; an authenticated run bootstrap uses `surface: "orchestration"` and its persisted run binding. `compatible: "unknown"` remains visible as an unavailable check with its reason.

The CLI checker persists `checked_at`, `next_check_at`, compatible/latest candidates, status and safe failure reason. It uses a lock and bounded backoff so repeated CLI calls share one asynchronous check. Browser code and daemon runtime never fetch the registry.

Gateway updates replace the daemon/Gateway package through a staged health-checked restart on the same fixed port and preserve all run/version mappings. Worker releases are side-by-side; a run changes worker version only through an explicit run-scoped operation with compatibility evidence, request draining and an auditable version mapping. There is no global worker upgrade that silently changes existing runs.

`multi-task-flow gateway upgrade <version|tag>` 只替换共享入口，Gateway 的 `--dry-run` 检查发行与兼容性，`--rollback` 恢复已验证的目标。单次编排的 `multi-task-flow orchestration upgrade --run-id <run-id> <version|tag>` 按 [CLI 合同](cli-contract.md) 原子发布目标 run，支持 `--dry-run`，不支持编排 rollback。该命令不依赖 daemon 在线，完成后可尽力通知 daemon 刷新。Worker 没有更新命令，也不会自行升级。

The formal root is `~/.local/share/multi-task-flow/`: `config/`, `data/runs/`, `releases/`, `state/`, `logs/`. `CODEX_HOME` and the invoking worktree do not select a formal instance. `MULTI_TASK_FLOW_PROFILE=test|development` requires an absolute `MULTI_TASK_FLOW_ROOT`, distinct from the formal root. Isolated profiles derive separate launchd labels, port scopes and registry roots. `TASK_ORCHESTRATION_DATA_ROOT` is an explicit ledger-only fixture override; never use it to create a second formal authority.

Published-package commands use only `bunx --bun @loomhelm/multi-task-flow@<exact-version> --output json service <command> --input -`, consuming one JSON object. Do not replace this form with `npx`, `latest`, a compatibility-line tag, a bare cached binary, or a repository-local source path. Normal usage:

- `status`, `doctor`: `printf '{}\n' | bunx --bun @loomhelm/multi-task-flow@<exact-version> --output json service status --input -` and the equivalent `doctor` command. Inspect configured identity and runtime before remediation.
- `ensure`, `renew`, `release`: `bunx --bun @loomhelm/multi-task-flow@<exact-version> --output json service <command> --input -` with `{"run_id":"example","thread_id":"main-thread","api_version":1}` on stdin.
- `login`: the same exact-version prefix with `{}` or `{"run_id":"example"}`. Its returned target URL contains a sensitive one-time query ticket.

## Version and runtime diagnosis

Run `bunx --bun @loomhelm/multi-task-flow@<exact-version> --output json --version` and the read-only `service status` command with the same exact package version. The package version identifies the CLI process; it is not the bundle `service_version`.

正式根目录为 `~/.local/share/multi-task-flow/`。先读取 `config/service.json`，按安装形态选择证据；不要从 npm cache 路径或残留 release 目录推断当前身份。

- **npm package-backed**：配置包含 `package_name` 与 `package_version`。用配置中的 exact version 运行 `--version` 与只读 `service status`。配置、CLI artifact identity 和运行时必须匹配 package name/version、build ID、source SHA、compatibility line、Skill version 与 service/ledger/api/frontend/viewer contracts；`current_build` 与 `artifact_build_id` 必须相等。`installed`、`running` 和 runtime `ok` 必须为 true；status 还在运行时核验 generation、PID 和 port。此形态遵循 ADR 0032，不复制服务 bundle，因此缺少 `releases/<current_build>/manifest.json` 是正常布局，不是安装损坏或升级理由。
- **legacy bundle**：配置没有 package identity。仅为诊断读取 `releases/<current_build>/manifest.json`，核对 build/source/platform/service version。缺失或不一致时报告准确证据；即使健康，也不能把残留 bundle 当成 package-backed 安装或自动回退。转为包式安装需要主人明确批准具体维护动作。
- **partial/unknown**：包身份只声明了一部分、必需字段为空或 CLI/config/runtime 不一致时，报告身份阻塞，不猜测安装形态，不合成 manifest，也不以另一版本的 CLI 证明当前身份。

以下是 npm package-backed 的只读核验。`<exact-version>` 必须替换为配置中的版本；不要打印完整配置或包含租约身份的 status。需要 `jq`，任一命令失败即停止，不执行修复：

```sh
set -e
service_root="$HOME/.local/share/multi-task-flow"
cli_json="$(bunx --bun @loomhelm/multi-task-flow@<exact-version> --output json --version)"
status_json="$(printf '{}\n' | bunx --bun @loomhelm/multi-task-flow@<exact-version> --output json service status --input -)"
jq -e --argjson cli "$cli_json" --argjson status "$status_json" '
  . as $cfg | $status.result as $runtime |
  ($status.ok == true and $runtime.installed == true and
   $runtime.running == true and $runtime.ok == true) and
  ([.package_name, .package_version, .current_build, .artifact_build_id,
    .source_sha, .compatibility_line, .skill_version, .service_contract,
    .ledger_contract, .api_contract, .frontend_contract, .viewer_contract] |
    all(. != null and . != "")) and
  (.package_name == "@loomhelm/multi-task-flow") and
  (.current_build == .artifact_build_id) and
  (.package_name == $cli.package_name and .package_name == $runtime.package_name) and
  (.package_version == $cli.version and .package_version == $runtime.package_version) and
  (.current_build == $cli.build_id and .current_build == $runtime.build_id) and
  (.source_sha == $cli.source_sha and .source_sha == $runtime.source_sha) and
  (.compatibility_line == $cli.compatibility_line and .compatibility_line == $runtime.compatibility_line) and
  (.skill_version == $cli.skill_version and .skill_version == $runtime.skill_version) and
  (.service_contract == $cli.contracts.service and .service_contract == $runtime.service_contract) and
  (.ledger_contract == $cli.contracts.ledger and .ledger_contract == $runtime.ledger_contract) and
  (.api_contract == $cli.contracts.api and ($runtime.compatibility.api_versions | index($cfg.api_contract)) != null) and
  (.frontend_contract == $cli.contracts.frontend and ($runtime.compatibility.frontend_contracts | index($cfg.frontend_contract)) != null) and
  (.viewer_contract == $cli.contracts.viewer and .viewer_contract == $runtime.viewer_contract)
' "$service_root/config/service.json"
```

核验失败只报告包版本、配置/CLI/runtime 的 build/source 和缺失或冲突字段；不要调用 `ensure`、安装、升级、回滚、凭据维护或导入作为修复。核验通过允许正常 `ensure`，不构成服务维护授权。

## Explicit maintenance

当前 package-backed 安装遵循 ADR 0032：CLI 与 daemon 来自同一个 exact npm package，服务根目录不复制生产代码。安装请求为 `service install` 的 `{ "version": "<exact-version>" }`；升级优先使用已批准的 `gateway upgrade <exact-version>` 路径，具体命令以该 exact CLI 的 help 为准。维护先展示当前/目标包身份、兼容性与数据影响，再由主人明确批准。不能通过从源码构建 bundle、复制 npm cache 或补写 release manifest 修复身份。Gateway 升级与单 run 的 orchestration 升级是不同操作，不能互相替代。

旧 bundle 的 `source` 输入、`releases/`、`candidates/` 和 `build-service.ts` 仅保留历史维护与受控发布用途；它们不适用于当前 npm package-backed 普通运行。保留旧文件，不自动迁移、清理或作为回退；针对旧 profile 的具体维护应按实际版本合同单独授权。凭据轮换、撤销和数据导入同样不属于普通 ensure。

`ensure` performs none of these maintenance actions. No `sudo`, login autostart or unconditional KeepAlive is used. A crash is recovered on the next ensure. A lifetime instance lock, serialized startup and generation/PID guards prevent old processes from altering successor runtime/port ownership. Port conflict fails instead of changing the configured number or taking over another process. The registry directory is resolved at install and saved; no synthetic worktree or `agent_session` is recorded. Active lease registration covers actual runtime only. Logs contain fixed event identities, rotate at 5 MiB and retain three files.

## Contracts

Build ID, source SHA, API major, frontend contract, ledger schema/contract, ledger revision, run ID and plan ID are independent. This release publishes API v1 and frontend contract 1. Readable ledgers include schema 1 with absent legacy contract or contract 1, and schema 2 with contract 1, 2 or 3. Schema 2 contract 2 remains writable for compatibility, while new development baseline synchronization requires contract 3; legacy contracts remain read-only until explicit migration. No unpublished previous API is advertised. Future releases must explicitly publish every supported current/previous major and ledger combination. The newest reader must dual-read every supported historical shape; an older viewer is an isolated read-only fallback only when the newest reader cannot safely interpret that shape. Unsupported runs are marked individually; a CLI fails incompatible handshakes rather than installing or rewriting data.

## Exact-source import and recovery

`import` (alias `migrate`) accepts `{"source_root":"/absolute/legacy-data","run_id":"example"}`. It verifies one exact run under the ledger lock, stages and verifies a copy, journals the operation, renames the source to an adjacent hidden backup, and leaves a tombstone before publishing the destination. Bound legacy writers fail identity checks; the old path cannot be initialized over the tombstone. There is no automatic discovery, deletion, old-port listener or redirect. The result maps preserved run/plan identities to the new stable URL.

Re-running the exact command is idempotent. A prepared journal after source sealing is resumed only after checking its exact operation paths and backup/ staging digests. A recreated source or changed destination blocks recovery; inspect the journal and retain both copies. No automatic rollback overwrites new data. Imports before source sealing can safely retry normal preparation. Code upgrades and this data operation remain separate explicit actions.

## Compatibility preflight and ledger maintenance

代码升级与持久迁移独立授权。`compatibility-check` 接受 `{ "source": "/absolute/bundle" }` 或 `{ "rollback": true }`，只读返回当前/目标构建、全部 run 的合同、revision、原始 SHA256、读写能力、fallback build、错误、写入降级项和 `report_digest`；预检会调用当前与候选 release 自身的 `reader-check`，不能只相信 manifest 的 `readable` 声明。若候选 reader 失败但当前 reader 仍能证明该 run 可读，报告会标记 `fallback_readable` 并允许切换，网页通过旧 viewer 只读投影继续访问；只有两者都无法证明读取安全时才阻塞升级。完成、会话归档、无使用租约都不免除读取兼容，也不证明需要继续写入。已有只读 run 不要求迁移。损坏、不可读或自定义 view 不兼容不能确认绕过。

只有当前构建可写而目标不可写的新增降级需要主人逐次确认。展示准确报告后，`upgrade` 或 `rollback` 可附加 `write_downgrade_approval: { report_digest, approval_ref, maintenance_thread_id }`。应用持锁重算报告，run 内容或构建变化即拒绝旧确认；没有降级时不接受多余确认。`install` 无当前构建时只要求读取兼容。错误的 `details` 包含具体 run、能力及预检报告；不要根据通用错误盲目迁移所有 run。

合同迁移使用 `ledger-maintenance-check` 和 `ledger-maintenance-apply`，不是目录导入的历史 `import/migrate` 别名。`schema-2/contract-2` 到 `schema-2/contract-3` 的迁移只更新合同判别和版本 envelope，保留 backup、source digest、owner、revision 证据，不补造 `baseline_verified` 或历史同步 event；普通 orchestration `migrate` 与 `execution-profile-migrate` 仍只允许绑定 main。维护入口使用真实维护身份，不恢复原会话、不改 owner、不取得业务控制权。

历史 `schema-2/contract-2` 账本若任一任务缺少 `execution_owner`、`conversation_policy` 或 `delivery_policy`，普通写入会在 `requireLedgerCompatibility(..., "write")` 处先返回 `HISTORICAL_LEDGER_READ_ONLY`，因此不会进入 engine，也不会自动推断策略；完整声明但语义冲突或值非法的历史策略同样保持只读并要求显式恢复；这条只读链与缺失默认 execution profile 是两个独立门禁。

对该历史形态，唯一正式修复是对准确 run 执行 `ledger-maintenance-check` / `ledger-maintenance-apply` 的 `action: "contract"`。candidate 只为完全缺失的策略键补出显式 `null` 声明，并在报告和 request result 的 `task_execution_policy_migration` 中记录任务与字段；部分声明会以 `TASK_EXECUTION_POLICY_INCOMPLETE` 拒绝，不推断 owner、对话归属、交付方式、PR 或生命周期事实。普通 orchestration `migrate` 仍只处理 legacy/contract-1，不能用它绕过该门禁。

先用 `ledger-maintenance-check` 输入 `{ "run_id": "exact-run", "action": "contract" }`。执行配置是另一个独立动作：`{ "run_id": "exact-run", "action": "execution-profile", "execution_profile": { "model": "<owner-selected-model>", "thinking": "<owner-selected-thinking>" } }`。check 返回原 owner、revision、源 SHA256、目标、当前/迁移后读取能力、未决操作和 `operation_digest`，不写入状态。

获得主人对准确动作的批准、暂停旧写入器后，apply 传入同样动作参数，并添加 `expected_owner_thread_id`、`expected_revision`、`expected_ledger_sha256`、`operation_digest`、唯一 `request_id`、实际 `maintenance_thread_id`、`approval_ref`、`reason` 和 `writers_paused: true`。`approval_ref` 和暂停声明是同 OS 用户维护信任边界内的审计记录，不是独立认证或进程隔离证明。不要冒用原 owner。claimed/unknown 创建、合并和切割操作须由原业务流程对账，维护命令不会替它们收口；服务租约本身不阻塞。

安全顺序是先显式升级至同时可读源/目标合同的 viewer，再批准单 run 合同迁移，再按需单独批准完整 profile 迁移。只有机械、无语义推断、幂等、可恢复且经过备份和 digest 验证的迁移可以自动执行；历史内容不自动清理。已提交但缺少源摘要或请求 sidecar 的旧迁移记录无法安全证明备份绑定原始源数据，重放必须进入显式恢复流程，系统不会自动补写 sidecar 或接受该重放。若最新 viewer 无法读取某个 run，已配置 `previous_build` 的 viewer 可通过 `GET /api/v1/runs/<run-id>/legacy-view` 请求明确的旧 viewer 只读投影；该端点不创建 lease、不接受 mutation、不推进 owner 或 revision。服务未安装或不支持目标时 apply 拒绝；不为历史展示补造模型或完成事实。维护锁、run 锁覆盖复核和原子提交，完整旧文件写入 `ledger.maintenance-<request_id>.json`，并以 request identity sidecar 绑定 `request_id`、command 和 `canonical_input`；sidecar 先于新备份持久化，只有精确匹配的旧备份或仅 sidecar 中间状态可以补绑/恢复，损坏、不匹配或 replay 工件校验失败时 fail closed。真实维护身份和批准引用保留于账本 request result。每次变更 revision 增加 1；同请求同内容重放，异内容拒绝。

维护迁移完成后，bootstrap 仍由绑定的 main conversation 持有：已完成文档/工作区 atom 只能对应已有的 workspace 和提交事实，`parent_pr` 仍为 `null`、`pr_created` 仍为 `unknown`，直到真实 `publish-pr` receipt 被记录；不得把其他 delivery unit 的实现 PR（例如 PR `#360`）挂到 bootstrap，也不得用迁移补造父 PR 或合并事实。

备份后中断可用相同请求恢复，提交后响应丢失可安全重放。冲突保留双方证据，不覆盖备份或账本。代码健康失败恢复原构建和租约期限；新数据不被旧备份覆盖。迁移后旧构建不可读时 rollback 拒绝，采用兼容过渡构建或向前修复。合作锁不能防止同用户手工改文件或不遵守协议的旧写入器，主人必须确认这些写入已暂停。

## 停服诊断

`viewer.jsonl` 中 `stopping` 记录关闭入口，`stopped` 记录完成；`stop_started_at` 和 `stop_completed_at` 分别表示两个阶段。原因区分 `SIGTERM`、`SIGINT`、`leases_expired`、`lease_state_error`、`registry_heartbeat_error`、`startup_error` 和 `requested`。旧构建的 `signal` 也可能来自内部异常，不能据此推断 OS 信号或发送者。注册表锁超时以固定错误码 `REGISTRY_LOCK_TIMEOUT` 记录：前两次失败保留监听，第三次关闭；成功心跳产生恢复事件并清零。其他未知错误及所有权变化立即关闭。日志不输出异常消息、路径或凭据，诊断写入失败只输出固定提示。

服务 label 从 `cn.ivan.multi-task-flow.viewer` 改为 `cc.ivanli.loomhelm.multi-task-flow.viewer`；隔离实例保留原有 profile 后缀。已有安装使用新 bundle 的维护 CLI 执行显式 `upgrade`，卸载当前 profile 的新旧 label，再生成新 plist 并启动。普通 `ensure` 遇到旧 plist 时要求升级，不自动迁移。数据根目录、端口 registry scope、凭据和运行账本保持原位。

展示服务使用 launchd 的 `Interactive` 进程分类：它直接响应用户的 HTTP 操作，不使用 XPC 活动驱动的 `Adaptive` 分类。`Background` 的 I/O 限流会拖慢完整资源校验。启动、升级与恢复使用单调时钟限定 60 秒健康等待窗口，单次 HTTP 探测最多另占 1.5 秒；临时维护租约为 90 秒，在原生启动前后分别续租，覆盖整个健康等待窗口，结束或恢复失败后释放。已有 Agent／浏览器租约的期限不延长。超时仍执行既有失败恢复，完整性校验不跳过。

## 运行展示与资源生命周期

拥有后台生命周期，不要求管理员权限，也不会在登录时自动启动。独立的 main-thread/run lease 有效期为 60 分钟；相关成功编排命令会续租。长时间等待期间显式 renew。已连接浏览器页面每 60 秒续租一次，TTL 为五分钟。收口时只释放本次运行的 Agent lease；不能停止共享服务或释放其他运行的 lease。最后一个 lease 过期会触发退出但不会删除数据；下一次 `ensure` 可恢复崩溃。未完成账本不会保持进程存活。

使用可选 `run_id` 调用 `login` 获取一次性的 60 秒浏览器入口。把该 URL 当作凭据，不能写入普通日志、账本或 PR。稳定的 run/plan 链接不包含凭据。登录后，`/` 列出运行，`?plan=<plan-id>` 选择历史计划。服务校验 Host/Origin，并使用 HttpOnly/SameSite 浏览器会话。服务链接不可用时先按身份诊断规则检查，再决定是否可调用 `ensure`。只有当前订阅的运行持有文件监听器。

每运行的自定义 HTML/CSS/JS 仍支持放在 `data/runs/<run-id>/view/`。必须包含 `{ "api_version": 1, "frontend_contract": 1 }` 的 `view.manifest.json`。声明缺失或不兼容时保留文件，并带警告回退到共享模板。相对 API/资源路径必须留在 `/runs/<run-id>/` 内；这属于同一用户信任域。页面需要保留依赖图、计划/实际时间线、group 归属、状态、阻塞原因、PR、需求和真实对话链接。对话链接使用真实 ID 和 canonical `codex://threads/<thread-id>` anchor。

对于示例和外部 fixture，使用通用的只读源目录 viewer。它接受绝对的源运行数据目录，校验账本和文件系统身份，分配随机的 `view-<id>` 展示身份，并通过同一个 singleton 提供服务。它原地读取源目录，不在正式 `data/runs` 下发布，不允许编排写入，并在显式浏览器 view lease 过期时移除映射。不能增加 example 专用服务模式，也不能把源视图当作真实运行。

显式安装的共享用户服务使用系统服务例外管理后台生命周期；不要求 Codex background session。维护仍须对具体动作明确授权，普通运行不从用户侧源码构建或复制 bundle。受控候选测试需要安装依赖或构建本地资源时，在 `<skill>` 目录执行 `bun install --frozen-lockfile` 与 `bun --no-install run build`；这不授权升级用户安装。
