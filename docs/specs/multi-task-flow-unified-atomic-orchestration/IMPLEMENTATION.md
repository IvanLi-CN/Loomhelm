# Unified atomic orchestration implementation

本文是主题 SPEC 的实现映射。设计边界、持久化与派生结构以同目录的 `SPEC.md` 为唯一长期合同；这里记录代码入口、迁移边界和验证入口，不能重新定义领域语义。

## Canonical persistence

`skills/multi-task-flow/lib/atomic-orchestration.ts` 定义 AtomicNode、AtomicEdge、TaskPrBinding、DeliveryUnitExternalFacts、里程碑条件和执行策略的判别联合；`skills/multi-task-flow/lib/schema.ts` 将它们接入 ledger/plan 校验。`atomic_nodes` 与 `atomic_edges` 是 contract 3 的持久化编排事实。Task 与 DeliveryUnit 只保留兼容外壳、身份、执行策略和外部事实，不保存可独立编辑的 `atom_ids`、`task_ids`、`milestone_ids` 或业务状态。

## Evaluation and projection

`evaluateMilestone` 对所有入边条件和所有显式验收条件执行全量 AND：空条件在 planned 阶段拒绝；存在明确失败时为 `blocked`；全部满足时为 `satisfied`；其余为 `pending`。评估结果是带事实版本的运行时投影或事件事实，不能替代 milestone 定义。Task/DeliveryUnit 的业务状态必须从同一原子图、里程碑评估和外部事实读取，Agent idle/waiting/disconnected 只进入独立 runtime observation。

## PR and starting gates

贡献 Task 使用 `TaskPrBinding` 表达 unbound/shared_delivery_unit/open/merged/closed。共享交付拓扑下，只有一个 contribution Task 的 DeliveryUnit 使用 `shared_delivery_unit`，Task 与 DeliveryUnit 共用 conversation、worktree、branch 和唯一 PR；多任务集成拓扑下才使用独立 child PR。普通贡献 work 原子或贡献 Task 进入 `starting` 前，所属 DeliveryUnit 必须有已核验的 `pr` 和 `parent_branch`；活跃且 workspace readiness 已完成的 main-owned bootstrap unit 可以让其 main-owned contribution task 在父 PR 创建前启动，但该例外只适用于 canonical facts 明确证明父 PR definitively absent 且交付单元 PR 为 `unpublished` 的路径，父 PR 发布进行中、结果未知、已有父 PR 事实或 provider/repository/id/state identity 不匹配时仍必须阻塞。engine、atomic validator 和 viewer 必须共享这组外部 PR identity/state 判定；engine 也必须拒绝缺少明确 absent receipt 的 bootstrap 启动，viewer 还必须在计划级 readiness 聚合 DeliveryUnit 门禁，不能因 bootstrap 类型而跳过 active、workspace 或父 PR 证据。启动输入不要求提交 hash。DeliveryUnit 集成 PR 的 canonical 字段是 `pr`，旧 `parent_pr` 仅作为只读兼容输入。

## Migration

`skills/multi-task-flow/lib/store-migration.ts` 负责 contract 2 到 contract 3 的备份、revision fencing 和幂等迁移。Task.atoms 只有在 Task 与 DeliveryUnit 身份明确时才能机械转换为 contribution work；Group.atoms、coordination task/session 和无法确定语义的旧节点必须进入显式计划修订，不能猜测成 coordination 原子。

## Viewer

聚合依赖图保持默认入口；原子依赖图由同一 `atomic_nodes`/`atomic_edges` 生成。`skills/multi-task-flow/web/atomic-graph-view.tsx` 使用 React Flow 与 ELK，展示节点范围、状态、条件边并支持缩放、平移、方向切换、节点选择、任务详情联动和可访问节点列表。任务图与交付单元图是读取投影，不是第二份依赖真相。

## Verification

Schema、迁移、评估、图投影和网页交互分别由 `skills/multi-task-flow/tests/` 下对应测试覆盖。任何新增字段或状态必须同时更新主题 SPEC、schema/domain 测试、viewer projection 测试和兼容迁移测试；不得只修改临时设计文件或网页文案。
