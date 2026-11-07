# Release Tracking

## Context and Scope

发布观察依赖明确可启动的角色、真实外部证据和有限恢复窗口。本主题覆盖发布触发后的观察、发布链绑定、生产部署核验与恢复，不授予新的发布、合并、 版本选择或其他运维操作权限。CI 门禁仍由 CI Tracker 独立负责。CI、Release、部署、PR 状态及其恢复均禁止创建、更新或复用 tracking automation；资源租约续期和已明确授权的非 tracking 交接仍由各自合同负责。

## Terms and Interfaces

Release Origin 固定记录起始仓库、分支与提交；Publication Identity 记录实际发布提交与版本；Release Lineage 是两者之间经过外部证据核实的仓库发布链。

执行入口与返回字段由 [shared release contract](../../../skills/project-engineering-workflow/references/release-tracking-short-contract.md) 定义。发布观察属于 `post_merge`/`post_deploy` closeout，不能反向满足 pre-merge readiness。

## Requirements

### REQ-RELEASE-ROLE

MUST 定义、注册并显式启动专用 `release-tracker`，与 `ci-tracker` 分开；角色名不是独立工具名。配置检查与运行时实际启动结果 MUST 分别报告。恢复 MUST 保持原观察模型配置，不得隐式切换模型或以主 Agent 轮询替代。

### REQ-RELEASE-TRIGGER

Tracker 不可用 MUST NOT 阻止已有授权的发布触发；触发后 MUST 保留未完成核验与精确恢复锚点。发布或部署未经核实 MUST NOT 报告流程成功。

完整决策卡 MUST 列明发布目标、版本规则、政策来源、必要准备及碰撞处理。主人明确确认发布卡并要求合并时，卡内发布准备与发布获得授权；卡外独立运维动作不因此获准。合并后 MUST 按实际仓库政策和 merge SHA 重新核验；事实漂移、冲突或授权不明确时停止受影响动作。

平台确认 PR 已合并并返回实际 merge SHA 后 MUST 立即启动该 SHA 的目标 CI 跟踪，同时推进不依赖其终态的已授权发布准备和适用性核验；不能等待 CI 与发布终态才登记的审计收据。实际发布触发 MUST 遵守仓库声明的前置门禁；CI 和发布分别跟踪至各自终态或明确未完成。手动发布尚未触发不是不适用的证据。

### REQ-RELEASE-RECOVERY

观察不可用或中断后 MUST 返回 `unavailable|incomplete` 与恢复锚点；当前聊天只等待仍存活的 tracker 句柄，不得创建、更新或复用 heartbeat、cron、app automation 或其他调度器。主人再次执行 `$flow-continue` 时 MUST 复用原身份、起始提交、发布链、截止时间和重试记录，不得重复观察或重复触发发布。状态无变化时 MUST 保持安静；完成、失败、需要人工处理或预算耗尽时通知。

### REQ-RELEASE-LINEAGE

MUST 分别记录固定起始 SHA 与实际发布 SHA；不同 SHA 只有在仓库提供的外部证据证明完整连续发布链时才能接受。MUST 核实全部声明发布面，包括管线负责的生产部署；绿灯、tag 匹配或部署已派发均不能代替实际终态证据。未知发布面或链路缺口 MUST 保持未完成。

### REQ-RELEASE-PHASE-IDENTITY

`release_expected` MUST be derived only after a real merge from `target_repo + target_branch + merge_sha`; a Step 5C release decision card, Candidate evidence card, or CI intent snapshot is not publication evidence. Any `post_deploy` acceptance or release observation MUST bind the same merge SHA lineage and a structured `deployment_identity` whose source and bound SHA match that merge. Missing or mismatched deployment identity MUST remain an owner-action blocker and MUST NOT be reclassified as `not_required`.

### REQ-RELEASE-RETRY

Tracker MAY 安全重跑同一已有失败运行一次：已有授权以及该运行幂等、 可安全重试的外部证据缺一不可。MUST 保存重试记录，跨 tracker 重建和手动 `$flow-continue` 均不恢复已用额度；不得派发替代发布或改变发布输入。

### REQ-RELEASE-BUDGET

观察 MUST 使用累计墙钟预算：未执行重跑等发布恢复操作时 30 分钟，执行已获授权的恢复操作后最多一小时；均从同一窗口起点计算。初始起点为自动发布的已确认 merge 或手动发布的已确认 dispatch。等待、启动故障、只读检查、手动 `$flow-continue` 和 tracker 重建 MUST NOT 重置或延长预算。到期 MUST 停止观察，保留锚点供主人手动继续；不取消远端发布。手动继续 MUST 保留原发布身份、窗口起点、deadline 与重试记录。

## Verification

### VER-RELEASE-WIRING

- covers: `REQ-RELEASE-ROLE`
- 配置检查核对合同入口、角色注册、profile 文件和身份；缺失或错误关联必须失败。运行时验收需取得专用角色的实际启动结果，不能用静态通过代替。

### VER-RELEASE-RECOVERY

- covers: `REQ-RELEASE-TRIGGER`, `REQ-RELEASE-RECOVERY`, `REQ-RELEASE-BUDGET`
- 合同检查覆盖不阻断触发、句柄等待、手动 `$flow-continue`、活动 tracker 复用、安静通知与共同截止时间；运行时演练覆盖观察故障、接管、截止停止和手动续推，且无重复发布。运行时调度器不属于当前恢复入口。
- 当前候选的确定性回放还必须拒绝 tracking automation_update 的 heartbeat/cron 创建或更新，验证完整手动恢复锚点、身份连续性与有限窗口，并保留明确标注的非 tracking automation 兼容性。
- 回放确认卡授权、手动准备、CI 并行及项目门禁，验证缺失授权、事实冲突和未触发发布不会被错误关闭。

### VER-RELEASE-IDENTITY

- covers: `REQ-RELEASE-LINEAGE`, `REQ-RELEASE-PHASE-IDENTITY`
- 语义回放接受有完整证据的不同发布 SHA 与终态部署；拒绝错误起始 SHA、 断链、仅自述链路、缺失部署、未知发布面或不匹配产物。

### VER-RELEASE-RETRY

- covers: `REQ-RELEASE-RETRY`
- 回放验证仅可对精确失败运行安全重跑一次，无安全证据或超额重跑必须失败；运行时验收核对重建/续推后的已用额度和实际运行 receipt。

## Related ADRs

- [Distinct CI and Release Tracker Ownership](../../adr/0027-release-tracker-ownership.md)

## References

- [Implementation](IMPLEMENTATION.md)
- [History](HISTORY.md)
