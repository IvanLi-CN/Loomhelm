# Unified atomic orchestration implementation

本文是主题 SPEC 的实现映射。设计边界以同目录的 [SPEC.md](./SPEC.md) 为长期合同，数据结构以 [DATA-MODEL.md](./DATA-MODEL.md) 为准，状态机和恢复规则以 [STATE-MACHINES.md](./STATE-MACHINES.md) 为准；这里记录代码入口、迁移边界和验证入口，不能重新定义领域语义。

## Documentation map

`SPEC.md` 记录需求、验收和兼容合同；`DATA-MODEL.md` 记录 canonical schema、投影和外部事实；`STATE-MACHINES.md` 记录各对象的正常状态机、异常恢复状态机和范围修订；本文件记录实现入口与验证映射。

## Canonical persistence

`packages/multi-task-flow-runtime/lib/atomic-orchestration.ts` 定义 AtomicNode、AtomicEdge、TaskPrBinding、DeliveryUnitExternalFacts、里程碑条件和执行策略的判别联合；`packages/multi-task-flow-runtime/lib/schema.ts` 将它们接入 ledger/plan 校验。`atomic_nodes` 与 `atomic_edges` 是 contract 3 的持久化编排事实。Task 与 DeliveryUnit 只保留兼容外壳、身份、执行策略和外部事实，不保存可独立编辑的 `atom_ids`、`task_ids`、`milestone_ids` 或业务状态。

CLI 命令的人类可读契约位于 [CLI-CONTRACT.md](./CLI-CONTRACT.md)，机器可读命令元数据由 `clients/typescript/src/cli/flow-contract.ts` 暴露为 `flow schema --format json`；`packages/multi-task-flow-runtime/scripts/generate-flow-domain-schemas.ts` 从 runtime Zod schema 生成 `$defs`；Skill 发布副本必须与该契约保持一致。

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

维护动作必须只暴露两个精确 CLI 命令：`multi-task-flow gateway upgrade <version|tag>` 与 `multi-task-flow orchestration upgrade --run-id <run-id> <version|tag>`。两者都支持 `--dry-run [version|tag]` 执行版本发现、完整性和兼容性检查，支持 `--rollback [version|tag]` 回退到已验证版本；两个 flag 互斥。Gateway 命令只改变公共入口；编排命令由 CLI 在目标 run sidecar 锁下直接更新版本绑定，revision、digest 和 request identity 由 CLI 内部生成与校验，daemon 不参与事务，成功后只可被动或主动刷新映射并按映射管理 worker。

版本更新发现由 `multi-task-flow` CLI 提供，与 daemon 或 Gateway 的运行形式无关。CLI 读取节流本地缓存，缓存过期时安排异步 registry 检查并立即返回上次提示；index 或编排页只能展示 CLI 返回的对应提示，不直接访问 registry，也不能从 daemon 状态推断版本。提示提供对应的 `gateway upgrade` 或 `orchestration upgrade` 命令，`--dry-run` 仍是升级前检查。

版本提示合同统一为 `{ surface, current, target?, compatible, reason, command }`；`current` 必须包含 `package_version`、`build_id`、`source_sha`、`compatibility_line` 和 `viewer_contract`。Gateway bootstrap/index 返回 `surface: "gateway"`，认证后的 run bootstrap 返回 `surface: "orchestration"` 和该 run 的持久版本绑定；检查未知时必须显示原因，不能显示“已是最新”。

自动发现由 CLI 内部异步检查器负责：按 package name 与 compatibility line 节流，持久化 `checked_at`、`next_check_at`、状态、兼容目标、latest 目标和安全失败原因；registry 请求受锁、超时和失败退避保护，并发 CLI 调用复用同一检查。检查器不是公开命令，也不属于 daemon；浏览器页面不直接访问 registry。

聚合依赖图保持默认入口；原子依赖图由同一 `atomic_nodes`/`atomic_edges` 生成。`packages/multi-task-flow-runtime/web/atomic-graph-view.tsx` 使用 React Flow 与 ELK，展示节点范围、状态、条件边并支持缩放、平移、方向切换、节点选择、任务详情联动和可访问节点列表。任务图与交付单元图是读取投影，不是第二份依赖真相。

Viewer worker 诊断遵循 [ADR 0033](../../adr/0033-viewer-worker-diagnostics-and-reconnect.md)：worker 生命周期失败写入独立 runtime 诊断状态，不写 Ledger，不推进业务 revision；gateway、HTTP 响应、daemon 日志和浏览器诊断卡片共享 `diagnostic_id`、run、worker generation、阶段、稳定错误码和恢复状态。`observed`、`retrying`、`degraded`、`recovered` 状态沿用 worker pool 的三次/六十秒重启窗口；浏览器在 `RUN_WORKER_UNAVAILABLE` 后停止无限刷新，保留 run/tab 定位并通过新登录会话受控重连。

## Verification

Schema、迁移、评估、图投影和网页交互分别由 `packages/multi-task-flow-runtime/tests/` 下对应测试覆盖。任何新增字段或状态必须同时更新主题 SPEC、schema/domain 测试、viewer projection 测试和兼容迁移测试；不得只修改临时设计文件或网页文案。

创建对账还必须覆盖：已知 thread 的成功恢复；初始化仍在运行；thread、profile、owner 或 worktree 冲突；无 thread 的 unknown 保留；明确 pre-creation failure；相同 request 重放；expected revision 冲突；成功后的 handoff notification 幂等；以及对账完成后不重复执行 `codex exec`。

Worker 诊断与重连还必须覆盖 socket 启动/连接、请求/流响应、重启耗尽、daemon 重启后的旧浏览器会话、worker 成功替换和多 run 隔离，并验证资源、view、SSE 使用同一错误合同。

排期门禁至少覆盖缺失 duration、悬空依赖、循环、未批准计划、合法零起点排期、并行排期和小数小时格式化；验证必须证明非法计划在批准前失败且不产生理论时间轴。

Viewer 需要分别投影 Run phase、TaskStatus、DeliveryUnitStatus、provider PR state、operation status 和 runtime observation。closed DeliveryUnit 应显示“已收口”和“可满足下游 merged 依赖”两个不同事实，同时保持自身 dispatch readiness blocked。closeout reconcile 的原始事件、证据、失效原因、受影响依赖和 protected recovery 记录必须可回溯。

## Verification

恢复命令的实现入口是 `group-closeout-reconcile` 和 `group-reopen`。前者只接受调用方核验的 Provider observation 并追加 `group_updated` 审计事件；后者要求 `delivery_unit_recovery` protected approval、approved plan、所属关系、无活动副作用操作和已解决的 closeout gate。`deliveryUnitPrMerged` 与 Viewer projection 使用相同的 merge capability 事实边界。

Schema、迁移、评估、图投影和网页交互分别由 `packages/multi-task-flow-runtime/tests/` 下对应测试覆盖。恢复设计需要新增或补齐以下验证：closed bootstrap 作为上游允许 regular dispatch；provider closed 但无 merge receipt 时拒绝；closed DeliveryUnit 自身仍拒绝 dispatch 和 atom update；closeout reconcile 的有效、无效、未知、权限、幂等和 revision conflict 路径；protected recovery 的 plan/workspace/base/owner 门禁；上游 capability 失效后的新下游阻塞和既有 operation 保留；多对象状态在 viewer 中不互相污染；旧 ledger、旧 viewer 和新 audit event 的兼容读取。任何新增字段、命令、事件或状态语义必须同时更新主题 SPEC、schema/domain 测试、viewer projection 测试和兼容迁移测试；不得只修改临时设计文件或网页文案。
