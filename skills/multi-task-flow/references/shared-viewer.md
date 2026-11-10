# Shared viewer operations

The formal root is `~/.local/share/multi-task-flow/`: `config/`, `data/runs/`, `releases/`, `state/`, `logs/`. `CODEX_HOME` and the invoking worktree do not select a formal instance. `MULTI_TASK_FLOW_PROFILE=test|development` requires an absolute `MULTI_TASK_FLOW_ROOT`, distinct from the formal root. Isolated profiles derive separate launchd labels, port scopes and registry roots. `TASK_ORCHESTRATION_DATA_ROOT` is an explicit ledger-only fixture override; never use it to create a second formal authority.

All commands use `service.ts <command> --input -`, consuming one JSON object. Normal usage:

- `ensure`, `renew`, `release`: `{"run_id":"example","thread_id":"main-thread","api_version":1}`.
- `status`, `doctor`: `{}`. Inspect configured identity and runtime before remediation.
- `login`: `{}` or `{"run_id":"example"}`. Its returned target URL contains a sensitive one-time query ticket.

## Explicit maintenance

Build from clean committed source after `bun --no-install run build` in the Skill: `bun --no-install scripts/build-service.ts --output /absolute/new-bundle --service-version <semver>`. The v2 bundle includes a shell launcher, TypeScript sources, prepared dependencies, browser assets and a manifest binding source SHA, platform, file digests and compatibility. A Skill update flow may place a newly built candidate under `candidates/<build-id>/`; the next `ensure` verifies and stages it, runs compatibility preflight, and uses the normal live switch and health-check rollback path. The launcher requires the trusted Bun 1.4.4 executable at the absolute path and SHA-256 pinned when building; it validates and snapshots that runtime before use. It runs independently of the caller working directory but does not include Bun. The maintenance CLI runs with Bun or the shell `viewer` launcher. The viewer preserves the caller environment and Bun configuration; it does not strip runtime variables or replace PATH. The launchd definition records the installing or upgrading caller PATH so background PR queries can resolve gh from the same tool environment. After changing tool locations, regenerate the definition through explicit service maintenance. Before loading package TypeScript through its integrity bootstrap, the launcher verifies all listed resources and rejects unlisted files, links and unsafe package permissions. Legacy compiled v1 bundles remain diagnostic-only and are never a startup or rollback fallback.

- `install`: `{"source":"/absolute/bundle"}`; optional `registry_dir` selects the registry once. Installation initializes credentials and fixed high port, writes a private plist, and does not bootstrap/start it. Formal label: `cc.ivanli.loomhelm.multi-task-flow.viewer`. Next `ensure` bootstraps into the current user's GUI domain, or user domain on headless macOS, and kickstarts it.
- `upgrade`: `{"source":"/absolute/bundle"}`. Validate hashes, platform and existing ledger/custom-view compatibility before stopping the old build. Switch the configuration atomically, start and health-check; failed health restores old configuration and existing lease deadlines. Old releases remain.
- `rollback`: `{}`; the previous build must still support current data. This never restores an old data backup over new writes.
- `credential-rotate`, `credential-revoke`: `{}`; replace the credential and revoke sessions, tickets and browser leases. Agent leases keep their deadlines.

`ensure` performs none of these maintenance actions. No `sudo`, login autostart or unconditional KeepAlive is used. A crash is recovered on the next ensure. A lifetime instance lock, serialized startup and generation/PID guards prevent old processes from altering successor runtime/port ownership. Port conflict fails instead of changing the configured number or taking over another process. The registry directory is resolved at install and saved; no synthetic worktree or `agent_session` is recorded. Active lease registration covers actual runtime only. Logs contain fixed event identities, rotate at 5 MiB and retain three files.

## Contracts

Build ID, source SHA, API major, frontend contract, ledger schema/contract, ledger revision, run ID and plan ID are independent. This release publishes API v1 and frontend contract 1. Readable ledgers include schema 1 with absent legacy contract or contract 1, and schema 2 with contract 1 or 2. Only schema 2 with contract 2 is writable; legacy contracts remain read-only until explicit migration. No unpublished previous API is advertised. Future releases must explicitly publish every supported current/previous major and ledger combination. The newest reader must dual-read every supported historical shape; an older viewer is an isolated read-only fallback only when the newest reader cannot safely interpret that shape. Unsupported runs are marked individually; a CLI fails incompatible handshakes rather than installing or rewriting data.

## Exact-source import and recovery

`import` (alias `migrate`) accepts `{"source_root":"/absolute/legacy-data","run_id":"example"}`. It verifies one exact run under the ledger lock, stages and verifies a copy, journals the operation, renames the source to an adjacent hidden backup, and leaves a tombstone before publishing the destination. Bound legacy writers fail identity checks; the old path cannot be initialized over the tombstone. There is no automatic discovery, deletion, old-port listener or redirect. The result maps preserved run/plan identities to the new stable URL.

Re-running the exact command is idempotent. A prepared journal after source sealing is resumed only after checking its exact operation paths and backup/ staging digests. A recreated source or changed destination blocks recovery; inspect the journal and retain both copies. No automatic rollback overwrites new data. Imports before source sealing can safely retry normal preparation. Code upgrades and this data operation remain separate explicit actions.

## Compatibility preflight and ledger maintenance

代码升级与持久迁移独立授权。`compatibility-check` 接受 `{ "source": "/absolute/bundle" }` 或 `{ "rollback": true }`，只读返回当前/目标构建、全部 run 的合同、revision、原始 SHA256、读写能力、fallback build、错误、写入降级项和 `report_digest`；预检会调用当前与候选 release 自身的 `reader-check`，不能只相信 manifest 的 `readable` 声明。若候选 reader 失败但当前 reader 仍能证明该 run 可读，报告会标记 `fallback_readable` 并允许切换，网页通过旧 viewer 只读投影继续访问；只有两者都无法证明读取安全时才阻塞升级。完成、会话归档、无使用租约都不免除读取兼容，也不证明需要继续写入。已有只读 run 不要求迁移。损坏、不可读或自定义 view 不兼容不能确认绕过。

只有当前构建可写而目标不可写的新增降级需要主人逐次确认。展示准确报告后，`upgrade` 或 `rollback` 可附加 `write_downgrade_approval: { report_digest, approval_ref, maintenance_thread_id }`。应用持锁重算报告，run 内容或构建变化即拒绝旧确认；没有降级时不接受多余确认。`install` 无当前构建时只要求读取兼容。错误的 `details` 包含具体 run、能力及预检报告；不要根据通用错误盲目迁移所有 run。

合同迁移使用 `ledger-maintenance-check` 和 `ledger-maintenance-apply`，不是目录导入的历史 `import/migrate` 别名。普通 orchestration `migrate` 与 `execution-profile-migrate` 仍只允许绑定 main；维护入口使用真实维护身份，不恢复原会话、不改 owner、不取得业务控制权。

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
