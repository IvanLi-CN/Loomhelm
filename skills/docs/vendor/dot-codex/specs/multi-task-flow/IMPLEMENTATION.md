# Multi-task Flow Implementation

## Current Status

- Implementation: Shared viewer candidate implemented; current-head acceptance remains CI-bound.
- Lifecycle: PR readiness requires current-candidate validation, formal review and applicable CI evidence.

## 卡片预览边界

普通卡片悬浮预览移除助手正文与输出空状态，宽度上限280px，字段标签保持完整、长值可换行。对话全文保留在对话图标浮层；消息头显示气泡图标和真实消息开始时间。普通卡片区域恢复宽屏悬浮，三个专用触发区抑制普通预览。时间显示日期和秒，隐藏时区名称。组件覆盖卡片专用触发区互斥、生成更新保留阅读位置、复制范围、键盘关闭、跨间隙移入与关闭后的动画帧取消。PR 图标拒绝旧观察结果，并阻止较早的卡片请求覆盖浮层更新。交付单元卡片、详情及普通预览都只使用自身执行时间，缺失时显示未知；历史贡献任务仍单独列出。合成 `ui_demo` 提供桌面与移动端浏览器证据，真实触屏事件验证500ms长按打开及外部关闭；真实 `gh` 和 Codex 元数据／消息流仅作宿主只读实证。候选交付仍要求当前头的 CI 与正式审查结果。

## Shared Viewer Coverage

- User-root paths, explicit build/API/frontend/ledger compatibility and isolated profiles.
- On-demand launchd singleton, per-thread/run and browser leases, idle exit and PID/generation fencing.
- Multi-run routes, persistent local authentication, single-use tickets and lazy run subscriptions.
- Immutable executable releases, compatibility preflight, health rollback and separate exact-source import with journal recovery.
- CI owns full checks, synthetic browser evidence and isolated macOS empirical acceptance. Existing temporary preview helpers retain their native-session contract.
- Historical implementation notes below describe the ledger and temporary preview layer; the shared production entry is specified by REQ-ORCH-012 and `references/shared-viewer.md`.

## 执行配置与 CLI 创建

- 运行默认值与对象完整覆盖独立解析；未迁移旧账本保持只读。推荐规则、手动来源、claim 替换和冻结原因均进入账本及投影。
- 认证 dashboard API 与 CLI 复用 mutation contract，能力目录由 app-server 提供。网页支持完整组合、默认值、重新推荐和可见错误，保留既有 URL/筛选状态。
- 创建命令绑定 native attempt identity、完整参数和结果，核对实际返回的模型与思考强度，并等待初始化 turn；超时、模型不匹配或不完整响应保持 unknown，须显式对账。请求回放不会再次创建对话。
- 本次源码交付不安装或升级正在运行的用户级 viewer，也不主动调整已创建对话的模型。

## Implementation Coverage

- REQ-ORCH-015：bootstrap 的 owner 通过 run 主线程解析；schema 完整账本校验、运行时生命周期/合并/收口、计划身份保护及 dashboard readiness 使用相同边界。legacy 字段默认 regular/group，不自动转换历史运行；当前未提供 group 原地迁移命令。

- 合成界面证据通过 `bun skills/multi-task-flow/scripts/demo-static.ts --bootstrap` 生成，仅修改展示 fixture，不转换真实账本。[交付单元类型展示](./assets/bootstrap-ownership.png) 对照首个 bootstrap 与后续 regular 卡片。

- 交付单元卡片的耗时只显示数值，移除“交付单元用时”和“进行中”前缀；定时刷新沿用同一显示规则。

- bootstrap 仅允许在 run 初始化时创建；计划修订和动态切割只能新增 regular/group 单元，拒绝操作不改变账本、revision、requests 或事件。交付单元卡片头部采用内容高度行，剩余高度由摘要行承担，避免摘要换行导致标题错位。

- bootstrap 所有权回归覆盖主对话验收子 PR、父 PR merge claim、交付单元收口，以及计划修订拒绝覆盖既有身份并保留事件；完整 Skill `verify` 和固定候选检查均已通过。界面证据在 fetch 并对齐远端主干后重新构建截取，静态生成器使用明确的投影类型，不放宽真实账本校验。

- 交付单元原子任务配置与执行状态独立校验，动态切割只接受未执行的新单元；计划修订审计原子定义变化，审批前阻止受影响步骤执行，放弃修订时恢复原定义。迁移后的契约2继续要求生命周期证据，无版本与旧契约账本只能读取；原子与生命周期投影由 `view-atoms.ts` 关联真实事件。

- 仪表盘通过 `status-row.ts`、`timestamp.ts`、`tooltip.ts` 复用状态行、本地时间和依赖交互。完成时间由 view 按归属与原子稳定 ID 匹配完成事件；缺失记录不使用任务结束时间代填。定向覆盖12小时和7天边界、无时间项、完整时间聚焦提示和事件归属隔离；完整候选实证仍须绑定最终 Candidate。

- The candidate contains the independent Skill, Bun ledger and coordination commands, and a read-only dashboard with a schema-validated demo fixture.
- Root multi-task test entrypoints install the child package from its frozen lockfile before running runtime tests, while fixed candidate validation keeps its offline contract set separate from socket- and DOM-dependent dashboard tests.
- `$multi-task-flow` is independently invokable with its own runtime input contract; `$dev-plan` does not route to or bind it.
- Task-local direct PR work reuses `$fast-flow` only after the parent route has been selected; this does not replace the parent ledger or closeout contract.
- Initialization rejects dev-plan handoff fields and does not consume a raw-plan digest or external planning envelope.
- Initialization validates unbound `planned` groups, tasks and atoms before writing the ledger; invalid input returns `INVALID_INITIAL_STATE` without creating run files, while task conversations remain dispatch-owned.
- Initialization validates only unbound `planned` groups, tasks and atoms before ledger creation. It also rejects pre-seeded runtime identities and assignment history. Later ledger validation accepts only cut-proven reassignment backed by one succeeded cut operation, its boundary SHA, a clean next-group creation snapshot, the cut event, and assignment history.
- Dynamic-cut replay reconstructs `planned`, `starting`, and active task boundaries from recorded state events, including successful `thread_bound` evidence, while allowing the original group to continue through later merge/closeout lifecycle states.
- Plan revisions replay the existing cut assignment evidence and dynamic-group identities before accepting task mappings that still refer to their pre-cut plan nodes.
- Ledger publication verifies the published directory identity, binds parent-directory fsync to the directory opened for rename, retains a published run when parent-directory durability is uncertain, cleans only the verified staging or published inode, and uses an existing ledger lock without recreating a missing lock file. Ledger reads and writes also bind the run, lock directory, and lock-file identities across the operation.
- Local tests cover graph scheduling, concurrent persistence, interruption recovery, operation coordination and dashboard endpoints. The legacy flow remains separate.
- The committed example models two groups, a dynamic cut and group-owned post-merge tasks. Group and task details expose their requirements documents and real Codex conversation links; project and PR records are display-only fixture data.
- The dashboard can serve a live ledger through its token-protected loopback service. `scripts/serve.ts` atomically claims the inspected empty-PID lease under the registry lock, rejects an existing owner or already-listening duplicate, binds the listener while that claim is held, records its own PID and optional host-provided session ID only after the listener is confirmed, retains the cleanup handle from the bind callback, immediately and periodically heartbeats the service lease with the recorded port and expected PID, and releases only that service lease on shutdown or failed startup persistence. The registry keeps `pid` as the value to record and `expected-pid` as the ownership guard, so an empty PID can be bound during first claim while a replaced lease remains protected. The static example is a disconnected snapshot; native conversation navigation evidence is recorded separately in `skills/multi-task-flow/examples/orchestration-viewer/link-verification.json`.
- The Agent/host remains responsible for creating and retaining a real Codex native background session. The Skill does not infer one from a PID, visible terminal or foreground exec; without a supported host route, the service is valid only for same-turn live verification.
- 账本合同新增 `contract_version`、`execution_plan_id`、计划生命周期/修订元数据、任务处置和迁移身份，同时保持存储 `schema_version` 不变。当前写入器使用 `schema_version=2`/`contract_version=2`；schema 1 或 contract 1 只读快照必须通过显式 `migrate` 才能写入，旧快照只在缺少新字段时于读取阶段做确定性归一化。
- `Group.atoms`、`Group.coordination_execution` 与 `group-atom-update`/`group-execution-update` 独立于 `Task.atoms` 实现；计划投影按选定计划的稳定 ID 和归属关联执行事实。卡片、详情和预览只投影交付单元自己的原子进度，等待贡献任务使用非旋转沙漏动画，依赖详情复用可访问 tooltip。
- `cut-apply` 为新交付单元生成独立的五步默认原子清单，`group-close` 与收口原子在同一事务完成，生命周期绑定步骤必须有对应通过证据。
- runtime 根据 `task_started` 推导 `planning` 或 `implementation`，计算 canonical plan diff，并拒绝调用方自报风险级别。设计阶段修订需要 diff 和重新批准；实现阶段低影响修订需要结构化理由并自动批准；高影响修订保留旧执行指针，记录理由/证据，暂停受影响后继，批准后才切换指针。
- `plan-propose` 对新加入的交付单元复用初始化校验，拒绝预绑定对话、分支、生命周期及原子任务或协调执行状态，拒绝时不改变账本。
- `plan-abandon` 恢复旧执行计划。`task-migrate` 将已开始任务及其事实保留为 `superseded`，不隐式创建替代身份，并在 `task_migration_recorded` 中记录新基线、理由、证据和产出继承。
- `contract.ts` 从与校验相同的 Zod 边界生成 JSON Schema 元数据和按操作裁剪的 LLM 语义上下文。dashboard view 将阶段、候选/执行计划指针、生命周期、修订类别和 pending hold 原因分开输出。
- 确定性回放覆盖 Loomhelm v2 到 v3 依赖删除在两个阶段的分类、空/格式错误修订拒绝、双指针批准与放弃、后继定向 hold、任务迁移和自解释投影。

## Remaining Gaps

- 桌面实时接管必须由当前候选真实 CLI 创建、退出、原生消息回执和主人确认共同证明，不能用源码测试或历史冒烟替代。

- The dashboard emits the canonical native `codex://threads/<thread_id>` links without forcing a new browser window, matching the working local dashboard pattern. The current candidate records one native-navigation observation for each fixture ID; the evidence is reused for this candidate and is not re-run by ordinary checks. This does not claim to prove host-specific browser click bridging, which is outside the Skill gate.
- Responsive width acceptance is exercised through the real-browser runner in `skills/multi-task-flow/tests/browser/card-width-regression.mjs`, covering board/grid layouts, detail toggles, cross-layout outer widths, fixed inspector limits and maximal task-column allocation at five medium viewport widths. Local DOM/source tests cover detail interaction and URL serialization; the owner-confirmed mock-demo evidence is recorded in the Spec.

## References

- `./SPEC.md`
- `./HISTORY.md`

## 绑定对话输出

- `conversation-history.ts` 从已绑定对话倒序分页选择最新非空公开 assistant 消息，保留 commentary、partial_answer、final_answer 和未知 phase，排除工具、用户与推理内容；仅在明确方法不支持时退回完整 turns。
- `ConversationOutputs` 维护按 thread 去重的内存投影，按 turn/item identity 合并可用通知，完整完成事件覆盖同项增量；历史条目仅以有效数值完成时间判定完成，缺失或空值仍可接收后续同项增量，历史读取和旧绑定不能覆盖新事件。完成、异常立即推送，增量最多每 100ms 推送一次；历史补读默认每 2 秒执行，失败有界退避。
- API 和 SSE 使用服务实例 `output_epoch` 及独立 `output_revision`，不写账本；最后一个观察者离开时关闭连接。前端 GET 记录请求开始时的输出代际；等待期间已发生代际切换时，拒绝其他代际的迟到 GET，同时允许同代际补读和新 GET 首先发现重启。前端只更新输出区域，保留卡片、焦点、选择、URL 和图表。
- 卡片、悬浮卡片和详情共享 `latest_agent_output`，三种空状态各有明确文案；不可用时最近文本与警告同时显示。详情保留原文换行，所有耗时使用统一纯时间格式，任务卡片省略“当前用时”标签。
- 原生路径已区分独立 daemon 与桌面宿主：`LoadedThreadSubscriptions` 仅加入已加载对话；`CodexDesktopFollower` 使用现有 owner 的版本化跟随通道，`DesktopOutputState` 只保留公开 assistant 内容并按平台顺序投影。已在当前工作对话的隔离验收绑定中被动观察到真实 commentary 文本增量及完成事件，未发送消息，原 run 账本字节不变；最终回答历史读取另由真实 run 的四个绑定对话核实。浏览器、当前候选 CI 和正式 review 证据分别收敛，不以这些原生观察代替。
- 合成输出演示由 `bun run --cwd skills/multi-task-flow demo:static --agent-output` 生成，提供固定 iframe 视口；它只验证展示与客户端更新，不证明宿主流式能力。完整候选检查交给现有 GitHub Actions；不升级已安装 viewer。

- 源码 example 预览复用正式 shared viewer 的 HTTP、鉴权、实例锁和端口租约生命周期，以临时 development profile 隔离示例数据与已安装服务；前端构建成功后更新资源并刷新页面，构建失败保持旧资源。后端源码变化后重启预览命令，不安装 viewer 或导入真实 run。

- 开发预览使用命名编排 `orchestration-viewer`（编排展示与交互验收）和 `viewer-validation-plan`；URL、登录目标、浏览器标题及示例中的引用保持一致。

- 示例按独立目录组织：`examples/orchestration-viewer/` 包含展示数据、具名入口及需求文档；`examples/ledger-initialization/` 保存初始化模板。源码预览复制需求内容到隔离运行目录。shared viewer 返回入口复用页头图标，租约会话状态交给既有连接提示区。

## 兼容升级与维护迁移

服务预检比较当前与目标构建的读写能力，全部历史运行保留读取兼容，已有只读不要求迁移，新增写入降级绑定完整报告确认。独立维护 check/apply 覆盖合同与完整 profile，保留 owner；复用普通迁移转换、备份与 request 幂等，不改变 bound-main 权限。聚焦回归覆盖身份冲突、中断、并发、权限和只读预检；原生隔离 CI 覆盖跨合同升级、真实健康失败恢复和迁移后回滚拒绝。正式服务与运行数据不作为 fixture 或本 PR 部署目标。

自定义 view manifest 通过目录项存在性检测；悬空符号链接进入 no-follow 拒绝路径。回归直接验证不兼容声明及悬空声明在状态探测或停服前拒绝，同时覆盖实际 Agent 使用租约与完成事件组合。

## 原生工作区创建与交接

- `codex-cli-create.ts` 使用独立参数数组、关闭 stdin、JSONL 身份持久化、工具调用拒绝、共享进程树监督与中止清理、回合完成和进程退出双门禁；只读控制面核验实际配置并命名，Git 核验 Codex 所有权与独立 checkout。
- `desktop-handoff.ts` 生成带仓库、归属、范围、基线与验收的正式指令；`orchestrate.ts` 返回它，外部 CLI 不执行正式任务。
- `prepareNativeNotification` 返回原生工具参数，持久 unknown attempt 排除并发和重放。native 回执必须双向匹配 attempt/provider，不能转换历史 provider attempt；ack 保留收件人权限。
- `lifecycle-record` 对新 CLI dispatch 保存开发基线；任务与组 running 受 readiness 门禁，明确失败后重派只读取成功 attempt 的基线。创建参数首次绑定后不可覆盖；`creation_observations` 累积已知身份、资源与执行事实，failed 门禁独立于 transport。历史创建证据和历史在途锁继续适用。
- 兼容边界和停止后恢复见 `native-handoff-compatibility.json`；不运行真实账本迁移，不部署安装副本。

## 卡片资源信息

卡片通过 `resource-popover.ts` 提供独立的对话、PR 和用时浮层，并移除正文为时间预留的底部 padding。浮层支持指针跨区、键盘、长按、上下身份区换序及回答滚动保留；既有卡片预览在资源浮层打开时让出展示位置。

`ConversationOutputs` 接入任务及交付单元绑定，以命名空间隔离身份，兼容保留任务旧键。同线程共用观察，读取真实 thread 名称及最新助手消息；临时输出沿用 epoch/revision，不增加持久化 schema。交付单元时间只从自身运行与收口事件投影。

`pr-details.ts` 由认证 run dashboard 路由调用，校验绑定 PR 的 HTTPS、host、仓库和编号，再以 argv 查询 gh。缓存、并发合并、2秒限流、10秒超时、CI 分类及失败保留均有定向测试。静态 demo 增加模拟标题、交付单元消息与 PR 状态；mock 不替代宿主只读集成实证。

卡片资源浮层与 React Flow／ELK 依赖图共用现有任务投影，互不接管布局。单交付单元合成示例的对话入口保留可聚焦的只读详情，但不产生原生对话链接；组件回归同时覆盖网格和看板。

看板交付单元列头复用同一资源控制器提供用时入口，时间绝对定位于现有列头间隙，不增加列头高度。网格与看板均覆盖交付单元自身时间及缺失事实的组件回归；缺失执行事实时浮层显示“时间未知”。
