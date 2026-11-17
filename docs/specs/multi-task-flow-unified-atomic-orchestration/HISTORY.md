# History

## 历史副作用静止审计

2026-11-17：将历史静止审计方案拆分为 proposed [ADR 0041](../../adr/0041-historical-side-effect-quiescence-audit.md) 与 SPEC 第 16 节。ADR 只记录静止证明随升级事务保存、避免独立恢复账本的持久化取舍；长期需求和可追溯验收归入 SPEC，诊断基线、覆盖及证据缺口归入 IMPLEMENTATION。没有程序、发布、全局安装或正式 run 变更。

主人已确认最终目标可采用后续正式版本，并以同一 LIMS run 的安全升级为边界；静止 unknown、claim 和容量允许保留，c4 初始化恢复及业务继续执行独立处理。该边界延续 ADR 0039，不要求先把所有业务 unknown 清成终态；初始化恢复仍遵循 ADR 0038，不重发既有 attempt。审计摘要的目标持久合同尚需兼容评估，不能将提案误认为已发布 contract 4 能力。

## 既有主题记录

- 2026-11-17: 增加 Gateway 独立 HTML 故障恢复合同与源码实现，覆盖 Worker 完全不可用、限流倒计时、保留完整 URL 的手动重试与可指定 URL 场景的纯 Web Demo、独立静态构建；不改变 Ledger、诊断持久化格式或业务派发语义。

- 2026-11-11: Locked the unified atomic orchestration contract and implementation scope.
- 2026-11-12: Promoted the complete design into the topic SPEC and documented the implementation mapping, compatibility boundary and viewer entry points.
- 2026-11-13: Clarified the main-owned bootstrap start exception and fail-closed handling for uncertain or retained parent PR facts.
- 2026-11-13: Revalidated the topic contract after the mainline viewer and documentation synchronization.
- 2026-11-13: Closed bootstrap readiness consistently across engine, atomic validation and viewer projections, including provider identity, parent PR state and active workspace gates.
- 2026-11-13: Required explicit failed PR absence evidence and propagated DeliveryUnit gates into plan-level bootstrap readiness projections.
- 2026-11-13: Aligned engine bootstrap dispatch with the same explicit parent PR absence evidence required by validator and viewer.
- 2026-11-15: Added a fail-closed theoretical scheduling gate: plans with incomplete or indeterminate intervals cannot be approved or scheduled, incomplete viewers hide the timeline and list blockers, and user-visible planned time is relative hours from `0h` without date or timezone semantics.
- 2026-11-15: Required complete atomic graph rendering and stable derived detail ordering: invalid nodes and edges remain visible with diagnostics, DAGs use stable topological ordering, cyclic graphs use strongly connected component fallback, and the viewer does not persist a second display-order fact or automatic current-item emphasis.
- 2026-11-15: Expanded the topic contract to define separate state ownership for Run, AtomicNode, Task, DeliveryUnit, provider PR facts, operations and runtime resources; preserved merged capability after DeliveryUnit closeout; and specified audited closeout reconciliation, blocked recovery, successor DeliveryUnit revision and downstream impact handling.
- 2026-11-15: Split the review surface into SPEC.md, DATA_MODEL.md and STATE_MACHINES.md so the requirements contract, canonical data model and state/recovery diagrams can be reviewed independently.
- 2026-11-15: Locked Flow-native creation reconciliation as a separate recovery path from the standalone Codex dispatch journal, including evidence requirements, fail-closed unknown handling, idempotency and explicit exact-version release.
- 2026-11-16: Established the layered CLI contract boundary: repository documentation is the human-readable source, CLI help/schema are runtime surfaces, and the Skill references the packaged contract copy.
- 2026-11-17: Renamed the project-owned and vendored compound specification documents to underscore-separated names and synchronized their references, resource metadata and validation paths without changing the CLI contract or runtime behavior.

- 2026-11-17: Locked the compact two-column detail inspector, selected-atom relations, Agent controls and diagnostics, combined status/policy projections, explicit empty states and bound-PR detail fallback.

- 2026-11-17: Consolidated Agent roles and interaction design with thirteen sequence diagrams into AGENT_INTERACTIONS.md; moved mock completion-flow coverage and MTF-AUDIT-001 through MTF-AUDIT-005 into IMPLEMENTATION.md. CLI_CONTRACT.md retains its canonical location under ADR 0036; this documentation reorganization does not change runtime semantics. Related change: [PR #306](https://github.com/IvanLi-CN/Loomhelm/pull/306).

- 2026-11-17: 修复 MTF-AUDIT-001/004/005 的 closeout uncertainty、ready notification acknowledgement 和 provider PR identity 门禁；补齐 MTF-AUDIT-002/003 的公开 CLI mock 创建、对账及多 Task 完成流。保持持久化 schema 和状态集合不变。

- 2026-11-17: 统一 `merge_capability` 汇总、`pr_merged_availability` 与实际派发门禁的账本判定；closeout 对账 unknown 时汇总保持 unknown，valid 后恢复。补充缺失或不匹配 provider receipt 与恢复路径的双字段一致性回归。

## Interrupted initialization recovery

采用 ADR 0038：显式单次初始化恢复与纯 creation reconciliation 分离；允许只有用户消息的 interrupted 握手，精确兼容历史角色文本，并对创建/恢复增加跨进程预算。恢复 attempt、原始 items 摘要和原生 recovery turn identity 追加保存，重入不重发，不改写旧 turn 或生产账本。

- 2026-11-17: 修复恢复握手污染后续正式任务权限：原权限先持久化，限制仅用于握手，恢复并核验后再成功绑定。历史缺少快照的 attempt 保留读取但拒绝自动恢复。修复 task-context 的 ready 导入，并补充真实 CLI 和端到端状态化回归；不修改生产账本或全局安装版本。

## 编排前向升级边界

采用 ADR 0039：普通命令严格匹配完整运行身份；目标 CLI 经显式 upgrade 自动迁移，升级中断显式续跑，不提供编排降级。该决定替代 ADR 0034 中的编排 rollback 规则，保留 Gateway 独立回滚边界；具体需求归于 REQ-UPGRADE-001 至 REQ-UPGRADE-006。初始化恢复继续采用已合并的 [PR #310](https://github.com/IvanLi-CN/Loomhelm/pull/310)，与升级生命周期分别维护。

## 编排前向升级的原子发布屏障

候选复现表明旧版维护入口可以绕过单独的 ledger contract 屏障改写 schema-1 绑定；采用主人确认的整个 run 目录原子发布，同时切换账本拒绝合同与绑定格式。保留隐藏源目录快照，旧目录锁等待者按身份拒绝，新生命周期等待者重新取得当前锁；不提供编排回滚或自动清理。初始化恢复和创建预算继续复用 PR #310。

## 机械迁移保留结果不确定的调用

主人确认以机械迁移保留尚未证明静止的结果不确定的调用，取代全部原生调用终止的升级前提；ADR 0041 记录这项决定并替代 ADR 0039 对该前提的决定，ADR 0039 其余前向事务与版本绑定决定保持。此前尚未实现的 REQ/VER-QUIESCENCE-001 至 011 由 SPEC 第 16 节 REQ/VER-MIGRATION-001 至 011 替换，原生静止不再是纯表示迁移的成功声明或验收目标。初始化恢复权限事务及 ADR 0040 保持。

经验验收改为当前 Candidate 的真实旧包屏障与 LIMS 受控私有副本的机械迁移保真，正式同一 run 升级仍是合并发布后独立授权的验收。研究发现归档负向查询轮换 operation_id 的反例；通知晚回调、原子发布及私有副本的原型结果只支持新实现方向，不替代候选验证、正式审查或发布回执。

- 2026-11-17: 为目录升级的旧锁等待者测试增加失败结果诊断，保持既有安全拒绝条件与锁实现不变，并同步资源摘要。
