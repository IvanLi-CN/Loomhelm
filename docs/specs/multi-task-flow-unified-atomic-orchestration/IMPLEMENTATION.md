# Unified atomic orchestration implementation

本文是主题 SPEC 的实现映射。设计边界以同目录的 [SPEC.md](./SPEC.md) 为长期合同，数据结构以 [DATA_MODEL.md](./DATA_MODEL.md) 为准，状态机和恢复规则以 [STATE_MACHINES.md](./STATE_MACHINES.md) 为准；这里记录代码入口、迁移边界和验证入口，不能重新定义领域语义。

## Documentation map

[SPEC.md](./SPEC.md) 记录长期需求、验收和兼容合同；[AGENT_INTERACTIONS.md](./AGENT_INTERACTIONS.md) 记录角色职责、交互顺序和时序图；[DATA_MODEL.md](./DATA_MODEL.md) 记录 canonical schema、投影和外部事实；[STATE_MACHINES.md](./STATE_MACHINES.md) 记录各对象的正常状态机、异常恢复状态机和范围修订；[CLI_CONTRACT.md](./CLI_CONTRACT.md) 记录命令接口；本文件记录实现入口、验证映射与已知偏差。

## Canonical persistence

`packages/multi-task-flow-runtime/lib/atomic-orchestration.ts` 定义 AtomicNode、AtomicEdge、TaskPrBinding、DeliveryUnitExternalFacts、里程碑条件和执行策略的判别联合；`packages/multi-task-flow-runtime/lib/schema.ts` 将它们接入 ledger/plan 校验。`atomic_nodes` 与 `atomic_edges` 是 contract 3 的持久化编排事实。Task 与 DeliveryUnit 只保留兼容外壳、身份、执行策略和外部事实，不保存可独立编辑的 `atom_ids`、`task_ids`、`milestone_ids` 或业务状态。

CLI 命令的人类可读契约位于 [CLI_CONTRACT.md](./CLI_CONTRACT.md)，机器可读命令元数据由 `clients/typescript/src/cli/flow-contract.ts` 暴露为 `flow schema --format json`；`packages/multi-task-flow-runtime/scripts/generate-flow-domain-schemas.ts` 从 runtime Zod schema 生成 `$defs`；Skill 发布副本必须与该契约保持一致。

主 Agent 在计划上下文中根据需求结果归纳交付单元，批准后只把归属结果写入原子 scope 的 `delivery_unit_id`；不存在独立的 `DeliveryUnitProposal` 持久化对象。`validateDeliveryTopologies` 根据同一交付单元内 contribution Task 的数量校验共享拓扑或多任务集成拓扑，避免把“一项任务一个交付单元”当作运行时默认。

## Evaluation and projection

`evaluateMilestone` 对所有入边条件和所有显式验收条件执行全量 AND：空条件在 planned 阶段拒绝；存在明确失败时为 `blocked`；全部满足时为 `satisfied`；其余为 `pending`。评估结果是带事实版本的运行时投影或事件事实，不能替代 milestone 定义。Task/DeliveryUnit 的业务状态必须从同一原子图、里程碑评估和外部事实读取，Agent idle/waiting/disconnected 只进入独立 runtime observation。

## Theoretical scheduling gate

`plannedIntervals` 的结果必须先经过完整性校验再进入 plan approval 和 scheduled readiness。任何节点的开始或结束无法确定、依赖悬空或成环、计划仍未批准时，校验器返回结构化 blocker，engine 拒绝批准或 scheduled 转换，viewer 隐藏理论时间轴并展示全部 blocker。

理论排期的公共表示是相对小时偏移，原点固定为 `0h`。内部可以继续使用分钟或数值毫秒计算，但不得把 `RELATIVE_EPOCH` 生成的日期对象泄露到公共 view、URL、timeline labels 或详情；所有可见时间统一格式化为小时。

## Object state ownership and recovery boundary

Run phase、AtomicNode lifecycle、Task projection、DeliveryUnit projection、provider PR facts、副作用 operation 和 runtime resource observation 必须保持独立的状态边界。`reconciling`、`recovery_pending` 和 `quarantined` 不属于新的业务状态；它们只能由命令结果、审计事件、阻塞原因和网页操作提示表达。

DeliveryUnit merge capability 需要由统一的 engine/domain/view predicate 计算：`merged` 或 `closed` 的 DeliveryUnit 只有在有效 merge receipt、merge SHA、PR identity 和未失效的最新事实全部匹配时，才能满足下游 `requires: merged`。DeliveryUnit 自身为 `closed` 时仍然禁止普通 dispatch、atom update 和新的 post-merge execution。

`closeout-reconcile` 应核验原 closeout event、账本 revision、plan identity、PR/merge facts、Task/atom completion、CI、follow PR 和下游依赖影响，并以追加 audit event 记录结果。有效 closeout 保持 `closed`；无效 closeout 进入 `blocked`；收口后新增范围通过 plan revision 与 successor DeliveryUnit 处理；同一 DeliveryUnit 恢复到 `active` 需要 protected recovery 和重新验证。

恢复不能删除或覆盖原始 closeout、provider fact、operation receipt 或下游副作用。上游 merge capability 失效时，新的下游 dispatch 必须阻塞，既有 operation 保留 `succeeded`、`failed` 或 `unknown` 事实并通过各自 reconcile contract 处理。

## PR and starting gates

贡献 Task 使用 `TaskPrBinding` 表达 unbound/shared_delivery_unit/open/merged/closed。共享交付拓扑下，只有一个 contribution Task 的 DeliveryUnit 使用 `shared_delivery_unit`，Task 与 DeliveryUnit 共用 conversation、worktree、branch 和唯一 PR；多任务集成拓扑下才使用独立 child PR。普通贡献 work 原子或贡献 Task 进入 `starting` 前，所属 DeliveryUnit 必须有已核验的 `pr` 和 `parent_branch`；活跃且 workspace readiness 已完成的 main-owned bootstrap unit 可以让其 main-owned contribution task 在父 PR 创建前启动，但该例外只适用于 canonical facts 明确证明父 PR definitively absent 且交付单元 PR 为 `unpublished` 的路径，父 PR 发布进行中、结果未知、已有父 PR 事实或 provider/repository/id/state identity 不匹配时仍必须阻塞。engine、atomic validator 和 viewer 必须共享这组外部 PR identity/state 判定；engine 也必须拒绝缺少明确 absent receipt 的 bootstrap 启动，viewer 还必须在计划级 readiness 聚合 DeliveryUnit 门禁，不能因 bootstrap 类型而跳过 active、workspace 或父 PR 证据。启动输入不要求提交 hash。DeliveryUnit 集成 PR 的 canonical 字段是 `pr`，旧 `parent_pr` 仅作为只读兼容输入。

## Migration

`packages/multi-task-flow-runtime/lib/store-migration.ts` 负责 contract 2 到 contract 3 的备份、revision fencing 和幂等迁移。Task.atoms 只有在 Task 与 DeliveryUnit 身份明确时才能机械转换为 contribution work；Group.atoms、coordination task/session 和无法确定语义的旧节点必须进入显式计划修订，不能猜测成 coordination 原子。

## Native creation reconciliation

`packages/multi-task-flow-runtime/scripts/orchestrate.ts` 需要提供 `creation-reconcile` 命令；它读取同一 `run_id` 下的 dispatch operation，要求绑定 main actor、operation identity、native request identity 和 expected revision，并调用共享的 Codex app-server query adapter。查询至少覆盖 `thread/read`、初始化 turn 状态、model/thinking、thread cwd 和独立 worktree owner/HEAD/cleanliness；查询不到 thread 或证据不完整时只能记录新的 observation 并保持 `unknown`。

对账成功使用与 `conversation-create` 相同的 dispatch resolution、event、resource 和 notification 路径，但 native evidence 必须声明独立的 reconciliation provenance，并匹配 operation、native request、thread、execution profile 和 worktree 事实。对账失败不得回退到 `codex exec` 或普通 `codex reconcile`；只有明确 pre-creation failure receipt 才能释放 claim。

实现应抽取创建和对账共同使用的 thread metadata、initialization turn 与 worktree evidence 校验函数，避免成功创建和恢复创建采用不同的安全标准。`codex reconcile` 保持在 `clients/typescript/src/cli/codex.ts` 的独立 `codex-dispatch` stateDir，不得跨账本写入 Flow operation。

## Viewer

Viewer 的架构名称是 **Stable Gateway + Per-Run Versioned Workers**：daemon 本身就是 Gateway and Worker Supervisor，独占网页端口并提供 index、认证、公共资源、通用错误和诊断，同时运行和监督独立的 Worker 进程；每个 run 根据自身的 package version、build ID、source SHA 和兼容合同路由到对应 worker。不同 run 可以同时使用不同 viewer 版本，worker 不提供公共页面。

Gateway 更新就是 daemon/Gateway package 更新：候选 staging、停止并排空当前 daemon、固定端口重启和公共 API/资源健康检查；Worker 更新采用 release 并存和 run-scoped version mapping，只有显式 run 版本切换通过兼容性预检后才路由新请求，旧 worker 排空后才能回收。Gateway rollback 与单 run Worker rollback 独立执行，候选失败不得改变固定端口或既有 run 版本映射。

维护动作必须只暴露两个精确 CLI 命令：`multi-task-flow gateway upgrade <version|tag>` 与 `multi-task-flow orchestration upgrade --run-id <run-id> <version|tag>`。两者都支持 `--dry-run <version|tag>` 执行版本发现、完整性和兼容性检查；只有 Gateway 保留 `--rollback`。编排升级遵循 ADR 0039 的前向事务。Gateway 命令只改变公共入口；编排命令由 CLI 在目标 run sidecar 锁下直接更新版本绑定，revision、digest 和 request identity 由 CLI 内部生成与校验，daemon 不参与事务，成功后只可被动或主动刷新映射并按映射管理 worker。

版本更新发现由 `multi-task-flow` CLI 提供，与 daemon 或 Gateway 的运行形式无关。CLI 读取节流本地缓存，缓存过期时安排异步 registry 检查并立即返回上次提示；index 或编排页只能展示 CLI 返回的对应提示，不直接访问 registry，也不能从 daemon 状态推断版本。提示提供对应的 `gateway upgrade` 或 `orchestration upgrade` 命令，`--dry-run` 仍是升级前检查。

版本提示合同统一为 `{ surface, current, target?, compatible, reason, command }`；`current` 必须包含 `package_version`、`build_id`、`source_sha`、`compatibility_line` 和 `viewer_contract`。Gateway bootstrap/index 返回 `surface: "gateway"`，认证后的 run bootstrap 返回 `surface: "orchestration"` 和该 run 的持久版本绑定；检查未知时必须显示原因，不能显示“已是最新”。

自动发现由 CLI 内部异步检查器负责：按 package name 与 compatibility line 节流，持久化 `checked_at`、`next_check_at`、状态、兼容目标、latest 目标和安全失败原因；registry 请求受锁、超时和失败退避保护，并发 CLI 调用复用同一检查。检查器不是公开命令，也不属于 daemon；浏览器页面不直接访问 registry。

聚合依赖图保持默认入口；原子依赖图由同一 `atomic_nodes`/`atomic_edges` 生成。`packages/multi-task-flow-runtime/web/atomic-graph-view.tsx` 使用 React Flow 与 ELK，展示节点范围、状态、条件边并支持缩放、平移、方向切换、节点选择、任务详情联动和可访问节点列表。任务图与交付单元图是读取投影，不是第二份依赖真相。

Viewer worker 诊断遵循 [ADR 0033](../../adr/0033-viewer-worker-diagnostics-and-reconnect.md)：worker 生命周期失败写入独立 runtime 诊断状态，不写 Ledger，不推进业务 revision；gateway、HTTP 响应、daemon 日志和浏览器诊断卡片共享 `diagnostic_id`、run、worker generation、阶段、稳定错误码和恢复状态。`observed`、`retrying`、`degraded`、`recovered` 状态沿用 worker pool 的三次/六十秒重启窗口；浏览器在 `RUN_WORKER_UNAVAILABLE` 后停止无限刷新，保留 run/tab 定位并通过新登录会话受控重连。

Worker 页面尚未加载时由 `packages/multi-task-flow-runtime/lib/gateway-recovery-page.ts` 独立提供 HTML 故障页；`service-http.ts` 区分浏览器编排入口与 JSON 请求，`viewer-runtime.ts` 从已有失败窗口计算剩余等待时间。页面仅刷新当前完整 URL，保留计划、标签页与 fragment，不依赖 Worker 资产、不修改 Ledger 或诊断持久化格式。HTTP 故障注入、限流和页面交互覆盖位于 `tests/gateway-recovery.test.ts`、`tests/viewer-runtime.test.ts` 与 `tests/ui/gateway-recovery.test.ts`；隔离视觉入口为 `dev:demo`（兼容 `preview:gateway-recovery`），`build:demo` 生成独立静态产物；浏览器控制区和 `demo` / `d_*` URL 参数可指定场景、主题、编排 ID 与等待时间，模拟状态仅在浏览器内运行。

故障页复用 Viewer 的 Tailwind/DaisyUI 按钮、文本框与 Lucide 图标；`web/viewer-theme.css` 为正常 Viewer 与 Gateway 共享主题变量，`web/gateway-ui.css` 只包含故障页所需组件和布局。`scripts/build-gateway-ui.ts` 编译为受资源清单保护的 `lib/gateway-ui.generated.ts`，由 Gateway 内嵌到 HTML；运行时不需要 Worker 资源、CDN 或开发依赖。`check:gateway-ui` 验证生成产物与源码一致。编排 ID 提供独立复制入口与权限受限时的选中文本兜底；重试数字使用等宽字体和固定数字槽，折叠诊断区保持紧凑。编排 ID 与复制按钮保留独立的原生键盘导航，键盘操作时统一在组合容器显示焦点，指针操作时不显示焦点框，文字选区仍保留。

## Verification

Schema、迁移、评估、图投影和网页交互分别由 `packages/multi-task-flow-runtime/tests/` 下对应测试覆盖。任何新增字段或状态必须同时更新主题 SPEC、schema/domain 测试、viewer projection 测试和兼容迁移测试；不得只修改临时设计文件或网页文案。

创建对账还必须覆盖：已知 thread 的成功恢复；初始化仍在运行；thread、profile、owner 或 worktree 冲突；无 thread 的 unknown 保留；明确 pre-creation failure；相同 request 重放；expected revision 冲突；成功后的 handoff notification 幂等；以及对账完成后不重复执行 `codex exec`。

Worker 诊断与重连还必须覆盖 socket 启动/连接、请求/流响应、重启耗尽、daemon 重启后的旧浏览器会话、worker 成功替换和多 run 隔离，并验证资源、view、SSE 使用同一错误合同。

排期门禁至少覆盖缺失 duration、悬空依赖、循环、未批准计划、合法零起点排期、并行排期和小数小时格式化；验证必须证明非法计划在批准前失败且不产生理论时间轴。

Viewer 需要分别投影 Run phase、TaskStatus、DeliveryUnitStatus、provider PR state、operation status 和 runtime observation。closed DeliveryUnit 应显示“已收口”和“可满足下游 merged 依赖”两个不同事实，同时保持自身 dispatch readiness blocked。closeout reconcile 的原始事件、证据、失效原因、受影响依赖和 protected recovery 记录必须可回溯。

## Verification

恢复命令的实现入口是 `group-closeout-reconcile` 和 `group-reopen`。前者只接受调用方核验的 Provider observation 并追加 `group_updated` 审计事件；后者要求 `delivery_unit_recovery` protected approval、approved plan、所属关系、无活动副作用操作和已解决的 closeout gate。`deliveryUnitPrMerged` 与 Viewer projection 使用相同的 merge capability 事实边界。

Schema、迁移、评估、图投影和网页交互分别由 `packages/multi-task-flow-runtime/tests/` 下对应测试覆盖。恢复设计需要新增或补齐以下验证：closed bootstrap 作为上游允许 regular dispatch；provider closed 但无 merge receipt 时拒绝；closed DeliveryUnit 自身仍拒绝 dispatch 和 atom update；closeout reconcile 的有效、无效、未知、权限、幂等和 revision conflict 路径；protected recovery 的 plan/workspace/base/owner 门禁；上游 capability 失效后的新下游阻塞和既有 operation 保留；多对象状态在 viewer 中不互相污染；旧 ledger、旧 viewer 和新 audit event 的兼容读取。任何新增字段、命令、事件或状态语义必须同时更新主题 SPEC、schema/domain 测试、viewer projection 测试和兼容迁移测试；不得只修改临时设计文件或网页文案。

## Interrupted initialization recovery

`initialization-recovery.ts` 实现只限绑定 main 的单次恢复与注册链对账；`engine-initialization-recovery.ts` 追加冻结 intent 和原生 turn 观察；`codex-recovery-writer.ts` 用受监管的独占私有 server 封住历史检查与发送间的竞态。初始化验证器精确识别历史文本并允许 prompt-only interruption。回归覆盖重入不重发、异常历史、revision fencing、证据绑定和 handoff 幂等；原生验收仅使用隔离测试资源。兼容和停止发布修复路径见 `initialization-recovery-migration.json`。

## Agent 角色交互的实现与验证

测试使用隔离的临时账本和独立 CLI 子进程，仅 mock Codex 平台的创建、初始化观察、工作区核验及对账结果；不创建真实 Codex 对话、PR、release 或 deployment。公开 CLI、账本存储、权限、revision fencing、通知 attempt/receipt/recipient acknowledgement 与生命周期均执行真实实现。

验证入口为 `agent-role-completion-flow.test.ts`、`agent-role-cli.test.ts`、`dispatch-readiness-ack.test.ts` 和 `engine-core.test.ts`。在 `packages/multi-task-flow-runtime/` 执行 `bun run test`、`bun run test:ui` 和 `bun run build`。结果必须绑定实际候选，不能用历史结果证明后续候选。

### 时序图与 mock 测试的对应范围

| 图 | mock 已覆盖的部分 | 尚不能据此宣称的覆盖 |
| - | - | - |
| S1、S12 | revision/request/actor 拒绝 | proposal、init 与所有 plan revision 路径的完整完成流 |
| S2、S6 | 公开 conversation-create/creation-reconcile、初始化角色证据、unknown 身份保留与禁止重建 | 真实 Codex 外部平台可用性 |
| S3、S4 | bootstrap ownership、shared-delivery 拓扑及权限边界 | bootstrap/shared-delivery 全部外部副作用的完成流 |
| S5、S8、S10 | 三个 Task 分别经 CLI 完成基线、原子、发布、quality、merge receipt、Task closeout，再合并父 PR 并关闭 DeliveryUnit | 所有 TaskKind、所有拓扑与 canonical 原子根图同步的端到端证明 |
| S7、S13 | 通知 intent/attempt/receipt/recipient ack、ready 代次门禁、重放、foreign actor、旧 revision | 真实消息平台投递 |
| S9、S11 | receipt 驱动 merge、CI 门禁、unknown closeout 下游冻结与 valid 恢复、PR identity 拒绝 | release/deployment/verification 外部流程 |

### 审计问题与修复证据

以下记录对照 [SPEC](./SPEC.md)、[交互设计](./AGENT_INTERACTIONS.md)、[状态机](./STATE_MACHINES.md) 与 [CLI 契约](./CLI_CONTRACT.md)，保留问题身份与修复后的验证入口。五项审计问题已补充针对性修复或测试；实际候选的 CI/review 仍需独立收敛，不能仅据此宣称 `merge-ready / Step 5C Ready`。

| 证据 ID | 原问题 | 修复与回归证据 |
| - | - | - |
| MTF-AUDIT-001 | unknown closeout 后仍满足下游 merge gate | `engine-core.test.ts` 验证业务状态保留 closed，最新 unknown 冻结下游 dispatch，仅匹配 provider merged 状态和原 merge SHA 的 valid 对账恢复 capability；矛盾证据拒绝且账本不变。 |
| MTF-AUDIT-002 | 完成流绕过公开 conversation-create CLI | `agent-role-cli.test.ts` 与完成流通过隔离进程执行公开 CLI；验证正常创建、unknown/reconcile、重复 request、foreign actor、旧 revision 和 CLI_ONLY_DISPATCH。 |
| MTF-AUDIT-003 | 直接构造 Task/DeliveryUnit merge facts 和完成状态 | 每个 child PR 都经 publish、quality、merge claim/resolve 与 Task closeout，再合并父 PR 并关闭 DeliveryUnit；无 receipt、closed receipt 均拒绝且账本不变，unknown merge 阻止提前 closeout。 |
| MTF-AUDIT-004 | 未确认的 task-ready 通知允许 claim | `dispatch-readiness-ack.test.ts` 验证 pending/failed/sent/unknown 未确认时拒绝；只接受最新 ready 代次和当前 owner 的确认。初始 ready 直接发现路径不要求补建通知；一旦产生 ready 事件，其通知必须确认。同一命令的普通通知和 ready 通知分别持久化 intent。 |
| MTF-AUDIT-005 | canonical PR 与自身比较 | `engine-core.test.ts` 验证缺失 receipt、resource ID、PR identity 或仓库不匹配时 merge capability 与下游 dispatch 均拒绝；viewer 的 `pr_merged_availability` 和 `merge_capability.status` 复用同一账本判定；`view.test.ts` 同时验证两个投影在缺失/不匹配 receipt、unknown closeout 和 valid 恢复时保持一致。 |

修复保持账本 schema、角色、TaskKind 和状态集合不变；更严格的派发/证据门禁落实已有设计。全局安装资源未在源码修复中更新。

### 通知投递职责的来源差异

[ADR 0035](../../adr/0035-task-agent-ledger-driven-progression-and-dispatch-notifications.md) 描述事件产生的 Task Agent 使用返回的 `tool_request` 通知 main；现有 Agent 执行指引描述由主对话协调原生消息发送。交互图 S7 分开表示事件产生者、投递协调者和收件者，共同边界为 intent、唯一 attempt、provider receipt 与 recipient ack。此处保留来源差异供后续同步，不以执行指引代替项目设计依据，也不通过文档迁移改变 CLI 权限。

权限恢复使用版本化 `permissions.original`、不可变追加命令和原生 settings 通知核验；异常后保留 unknown 与快照，重入不再限制权限或发送新 turn。缺少快照的历史 attempt 与命名 profile 拒绝自动恢复。回归包含真实私有 writer、持久化 LedgerStore、dispatch-resolution、handoff 请求、两次正式 sender adapter turn 与实际 `show task-context` CLI；native 持久化在该回归中由状态化 fixture 模拟，不等同于 Desktop 工具或真实 OS sandbox 验收。当前 contract-4 与完整运行身份的回归在恢复前用完整、可由账本构造的证据调用真实 `dispatch-resolve` CLI，验证拒绝且账本和原生只读策略不变；只有 writer 核验恢复后才能提交成功。兼容路径另见 `recovery-permissions-migration.json`。

原生配置验收入口为 `python3 packages/multi-task-flow-runtime/tests/fixtures/native-permissions.py`：使用空 CODEX_HOME、禁用 daemon auto-start，验证原生 writer 排斥、权限限制及 effective-settings 恢复、与只读全局默认不同的冷 resume 结果。该探测没有凭据，使用本地确定性模型 fixture 完成原生 turn，并核对两个正式 turn 的原权限上下文；不验证外部模型、工具执行或 Desktop 控制。CLI 上下文及成功绑定链由隔离状态化回归覆盖。权限事务的后继决策为 ADR 0040。

## 编排版本绑定与前向升级

ADR 0039 与 REQ-UPGRADE-001 至 REQ-UPGRADE-006 的候选实现位于 `orchestration-identity.ts`、`orchestration-upgrade.ts` 和 `orchestration-lifecycle.ts`：contract 4 保存完整运行身份与升级阶段，既有维护事务同步迁移账本并切换绑定；CLI 与 Worker 核验身份并围绕原生调用保留生命周期回执。直接迁移支持 contract 3/4；更早格式保留诊断，缺少已验证机械链时拒绝自动迁移。`orchestration-upgrade.test.ts` 覆盖基础阶段、重入、冻结目标和备份拒绝；独立 TypeScript CLI 的生命周期测试覆盖实际打包资源的身份传播、普通读取拒绝、只读诊断、dry-run、显式升级、重放和降级拒绝。正式 PR 质量证据仍待收敛，不能视作 merge-ready。

中断初始化恢复复用已合并的 PR #310；本主题不重复实现恢复，也不要求其可选审计字段必然改变 ledger contract。本地未合并的 deadline 与超时诊断增强不属于本次升级实现范围。正式账本、服务与安装版本未变更。

隔离验证确认 0.2.53 的 orchestration-upgrade 不读取 ledger contract，可以改写 schema-1 绑定；主人已批准原子目录发布方案。`store-upgrade-publication.ts` 在既有维护锁下原子交换 run 目录，同时发布 prepared 账本与 schema-2 绑定，并保留源目录快照。实际 0.2.53 的 reader、普通 writer 和仅修改绑定的维护 writer 均拒绝发布后的屏障；测试覆盖交换前中断、交换后 SIGKILL、各后续阶段、并发升级、原生调用等待和旧目录锁等待者。正式 PR/CI/review 仍待收敛。

Gateway 不再为缺失历史绑定的账本使用当前安装或 fallback 身份补建来源；隔离源码预览只为本次新建的临时副本显式登记预览身份，不能作为历史编排来源证据。

回归覆盖自定义视图下 Worker 的真实执行身份、CLI 外桌面通知的静止证据、原子交换期间原生锁获取拒绝后的安全重试，以及空 init 输入的既有错误码。历史 schema-1/contract-1 与 contract-2 的公开只读诊断保持源文件字节不变，并拒绝缺少已验证迁移链的升级。

## 历史副作用静止审计

对应 [ADR 0041](../../adr/0041-historical-side-effect-quiescence-audit.md) 与 [SPEC 第 16 节](./SPEC.md#16-历史副作用静止审计)。尚无新增审计入口、共享静止验证器或历史静止摘要实现；既有升级及通知/创建/归档对账不能视作已覆盖新增需求。静止证据可行性是实现前置门；未通过时保持现有升级拒绝路径，不能以实现批准替代正式 run 写入授权。

### 诊断与验证基线

已核验基线是 npm `@loomhelm/multi-task-flow@0.3.0`，source SHA `9bb7a5dd753fe4be42c21aa7e075250806a0f346`。`lims-poc02-04-r10` 观测 revision 2686，绑定 0.2.55、ledger contract 3；包含 6 个桌面 notification unknown、1 个 dispatch unknown、1 个 conversation archive_unknown，缺少 runtime/call.json。0.3.0 升级先在通知关阻断；隔离 fixture 移除通知阻塞后仍在历史无 stop receipt 关阻断。0.3.0 dry-run 在该检查前返回，不能证明升级就绪。实际执行前必须重新盘点，不硬编码这些数量。

已运行的源码回归为 orchestration-upgrade 19 项、notification-delivery 24 项、initialization-recovery 12 项、notification-reconcile 1 项通过；发布包 source SHA 与源码基线一致。这些结果只证明诊断基线，不能证明候选新增能力或正式升级完成。

### 证据可行性缺口

必须先只读核实当前 run 的每项可信证据和实际排斥机制，才能锁定可实施边界。账本 intent 或历史诊断报告存在，不等于 provider 原始结果可取回；尚未证明以下清单全部可满足。

| 对象 | 需要核实的证据 | 当前不得作出的推断 |
| - | - | - |
| 6 个 notification unknown | 每个 last_attempt_id 对应的真实平台调用及结果或可信终止证据，排除延迟发送 | 没有消息即失败；意图就是投递回执 |
| op-dispatch-c4-r10-20261117-01 | 原创建和持久 recovery attempt 的精确关联及终止证明；覆盖缺失 recovery_turn_id 的未决提交 | 按时间把空 interrupted 回合绑定为 recovery；非零退出即无副作用 |
| conversation archive_unknown | 精确方向的正向 provider 结果或调用终止证据 | 负向查询即失败；重新归档即可修复 |
| 旧 CLI、Worker、桌面调用方、后台归档 | 实际 writer 排斥范围与在途请求证明 | 新版 lifecycle 锁或人工声明覆盖所有旧 producer |

受限 Host 原始记录核查已能配对当前六个 unknown 通知的 prepare 调用与返回，但尚无与这些 attempt 精确匹配的真实桌面发送终止记录。来源中可找到其他通知的结构化发送完成记录，不能用它们覆盖未匹配的 attempt；未执行的动态表达式亦不计作已验证覆盖。缺失 recovery turn identity 的提交与后台归档仍无完整终止证明。隔离原生文件锁实验验证了 thread writer 的双向排斥、共享协调锁防止删除重建、无关 thread 可写和释放后恢复；这些结果只证明该锁协议的排斥能力，不证明历史调用已停止或所有 producer 已冻结。

若证据不可取得，必须保留未解决状态和精确缺口，返回证据边界设计；不能用弱化门禁替代。目标持久合同为 ledger contract 5、schema_version 2；该结构转换尚未实现。实施仍须完成命令 JSON Schema、证据源验证方式、旧生产者排斥和迁移兼容验证，不假定有现成 receipt API。

### 受控维护边界的验证结果

原生 `codex-cli 0.169.0` 的隔离实验扩展验证了 thread 文件锁对 `thread/resume`、`thread/archive` 和 `thread/unarchive` 的排斥；持锁期间目标 rollout 的路径和摘要保持不变。这个排斥范围仍不足以作为完整维护回执：同一目标在持锁期间可通过 `thread/queue/add` 接收持久消息，关闭并重启私有 app-server 后，`thread/queue/list` 仍可读取该消息。未启动该消息对应的 turn，未使用正式 thread 或正式 Host 写入。

| 维护假设 | 隔离验证结果 | 对静止证明的影响 |
| - | - | - |
| thread writer 文件锁能排斥 resume、archive 和 unarchive | 三种原生请求均拒绝，rollout 路径及摘要不变 | 可作为这些临界区的排斥机制，仍须独立覆盖接收队列 |
| thread writer 文件锁能禁止新消息入队 | `thread/queue/add` 成功，队列新增一项 | 持锁或一次空队列查询不能证明生产者已禁入 |
| 私有 app-server 退出即可排空队列 | 重启后仍能读取先前入队项 | 进程退出不能替代持久队列终止证明 |
| `ViewerWorkerPool.stop()` 返回即所有 Worker 已结束 | 延迟 Worker 未完成时，stop 在约 500ms 后返回 | 该接口的有界返回不能充当维护排空回执 |
| Dashboard stop 返回即归档调用已结束 | 注入等待中的 provider 后调用 stop，释放 provider 仍触发后续账本提交 | 关闭监听和 observer 不能替代原生调用 join |

Worker 和 Dashboard 实验使用仓库实际生命周期入口与任务自有 fixture；provider 为可控等待桩，结论限定为 stop/join 语义，不冒充真实 provider 终止证据。原生锁与队列实验使用独立 CODEX_HOME、私有 app-server 和 disposable thread；仅在这些自有资源执行创建、归档和入队，未发送业务任务。

正式 run 四个相关 thread 的受限只读 `thread/queue/list` 观察均为空，ledger revision 和摘要保持不变；该观察仅说明查询时没有可见队列项，不能覆盖并发入队或证明全部生产者被排斥。现有公开原生请求面尚未提供经验证的、同时覆盖新请求禁入、既有调用终止及持久队列的维护接口。在这些能力成立前，历史证据路线与维护边界路线均不足以满足 VER-QUIESCENCE-010，不能发布成功审计结论或放行当前 run 升级。

### 机械迁移保留未决调用的研究结果

原始问题是同一 LIMS run 的版本绑定与数据合同无法安全前移。另一条待确认路径是只迁移表示和运行身份，原样保留未决调用，禁止迁移发起外部调用，并验证旧 writer 无法提交到发布后的账本或绑定。这条路径不推断历史调用已停止，也不解决 c4 握手或业务继续执行；它与 REQ-UPGRADE-005、REQ-QUIESCENCE-001 所要求的静止前提不同，尚未获得采用该替代前提的确认。现有准入代码、ADR 和 SPEC 要求保持不变。

研究使用校验 npm integrity 的真实 `@loomhelm/multi-task-flow@0.2.55` 包，以及当前仓库的原子目录发布和升级事务。目标是合成的 contract-4 身份；仅在任务自有临时账本中替换 `withQuiescentRun` 研究接缝，正式入口没有新增绕过开关。此实验不代表 contract 5 已实现、公开升级命令已通过、静止证据已充分或 PR 已就绪。

| 场景 | 已观测结果 | 证明范围 |
| - | - | - |
| 已发布 0.2.55 通知发送器等待返回时发布目标目录 | 完成升级后及 prepared 中断后，旧发送器提交均被 `INCOMPATIBLE_LEDGER` 拒绝；发布后账本摘要不变 | 使用真实旧包与可控 provider 返回，证明晚回调写入屏障，不证明原生调用终止 |
| 新版本重入同一通知发送或以新 request 请求发送 | 原 request 返回待对账，新 request 因 unknown 拒绝；provider 调用总数仍为一次，attempt 身份保留 | 证明这些重入路径没有补发 |
| 已发布 0.2.55 归档发送器在升级后返回 | 晚回调拒绝，迁移保留原 operation 和 unknown；负向查询没有再次调用归档 | provider 为可控返回，不能作为真实归档完成证据 |
| 归档 unknown 的后续负向查询 | 现有实现会生成新 operation_id；临时修复原型保留 operation_id 与 last_attempt_at 后，同一反例通过 | 暴露需要修复的身份保留问题；原型未写入生产源码 |
| 已发布 0.2.55 的 reader、普通 flow writer 和只修改绑定的维护 writer | 从原子发布的 prepared 状态起均拒绝，账本与绑定字节保持不变；一项隔离回归、11 个断言通过 | 证明真实旧包的两种持久写入入口遇到屏障；没有修改全局安装 |
| 当前 LIMS 账本和绑定的私有副本 | 原静止门禁拒绝；研究接缝下迁移完成且可幂等识别，业务数据摘要一致，目标源码 CLI 可读取同一 run | 使用实际历史数据形状，目标仍为合成身份，不能作为正式升级回执 |
| LIMS 副本中的六个 unknown 通知和历史 recovery | 六项准备发送均拒绝；历史 recovery 进入原生 writer 前拒绝，新 recovery claim 亦拒绝，原 attempt 和业务图保留 | 未调用真实通知、创建、恢复或归档；正式账本和绑定的前后摘要一致 |

这组结果支持继续验证“机械迁移可以保留未决调用”的假设，尚未形成完整安全证明。取舍是旧调用可能继续完成其既有副作用，旧 writer 的晚回执会被拒绝，目标只能继续保留 unknown；不保证该回执日后仍能取回，不保证外部资源静止或相关业务恢复。新准入若获确认，必须明确记录这些事实，不能把未证明静止标为 proven、把未决状态转成失败，或自动释放 claim、容量。

待确认方案将范围收敛到既有升级事务、共享迁移评估、旧 writer 屏障与未决身份保留：只接受已验证的机械转换，不改写业务含义；沿用既有维护、账本、绑定和 lifecycle 排斥，不把它们扩称为所有原生调用已停止；在事务中保存源身份、源 revision/digest、业务数据与未决对象集合摘要、转换规则及 writer 屏障判定。目标 contract 5 仍需独立实现并验证；原生静止若未证明必须如实记录，不要求为迁移新增 Host 会话解析器、全局排空协议或新的恢复账本。无法确认副作用前先提交 intent 的来源、转换保真或旧 writer 排斥时，拒绝该转换。

采用这条路径前需要明确修改 ADR 0039 的静止准入决定，并以符合 ADR 格式的新决定表达取舍，需求和验收仍只由 SPEC 持有。验收至少覆盖：迁移调用原生变更接口次数为零；全部业务数据及 unknown/attempt/claim/容量摘要保持；真实旧包及旧目录等待者无法晚写；同一和新 request 均不能重发未决通知、创建、recovery 或归档；全部崩溃阶段仅向冻结目标续跑；实际 contract-5 tarball 的公开 CLI 在历史副本上完成升级并可读取。真实 LIMS run 最后仍须由 main 发布的精确 artifact 经独立授权执行，不能由副本实验替代。

### 实现边界与验证对应

预期边界为 orchestration lifecycle/upgrade、service CLI、现有 Codex 只读证据读取、upgrade 审计 schema 和隔离回归；CLI_CONTRACT 及 Skill 引用合同在实现时同步，不预先声明候选命令已可用。初始化恢复发送语义和 UI 不变。SPEC 的 VER-QUIESCENCE-001 至 VER-QUIESCENCE-009 是运行时回归要求，010 是当前私有状态的证据可行性和演练，011 是独立授权后的正式成功证明；目前均不能以既有测试结果标记通过。

正式验收清单必须记录精确 artifact 身份、源 revision/digest、审计报告、每项证明来源、升级结果及业务事实差异。原始证据保留在受控位置，只提交脱敏 fixture 和验证方法。方案审核、源码实施、发布和正式升级分别办理，当前文档不替代这些授权。
