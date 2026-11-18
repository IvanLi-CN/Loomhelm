# 计划、拓扑与修订

初始化或修订计划前读取本文件；命令字段以 [CLI 合同](cli-contract.md) 和精确版本 `flow schema --format json` 为准。

## 交付单元归纳

主 Agent 必须先为每个 contribution Task 说明它服务的交付目标，再把适合一起交付、一起验收的任务归入同一个 `delivery_unit_id`。只有任务分别产生可独立交付、独立验收的结果时，才拆成不同的 `delivery_unit_id`。此规则同样适用于 bootstrap 与 regular 的边界；SPEC/ADR 编写、父分支或 parent PR 初始化、准备与实现的先后顺序、主会话与交付会话的角色差异，都不能单独作为新增交付单元的理由。不能因为“一个任务看起来像一个能力”或“一个任务需要一个 PR”就创建一个新的交付单元。

例如，“修复登录后跳转错误”可以包含诊断、补测试、前后端修改和文档更新；这些任务共同交付并验收一个修复结果，可全部归入一个 bootstrap 单元，由主 Agent 协调贡献任务直至收口，无需另建 regular 单元。多个任务或多个 child PR 不改变这一交付边界。

归纳结果只落在已批准计划的原子 scope 中：每个 contribution 或 documentation work 原子使用唯一的 `TaskScope { kind: "task", task_id, delivery_unit_id }`；`DeliveryUnitDefinition` 不复制 `task_ids`，成员由原子 scope 派生。主 Agent 的中间推理不作为新的 Proposal 类型或独立账本对象持久化。

归纳完成后才选择执行拓扑：同一 `delivery_unit_id` 恰好有一个 contribution Task 时，使用共享交付拓扑；有多个 contribution Task 时，使用多任务集成拓扑。共享拓扑复用交付单元对话、工作区、分支和 PR；多任务集成为每个任务创建独立对话、工作区、分支和 child PR。verification、release 和 deployment Task 不增加 contribution Task 数量。

计划校验必须保证每个 contribution Task 有且只有一个交付单元归属，并保证执行策略与归纳结果一致。缺少归属、出现多个归属或任务策略与拓扑冲突时，计划必须被拒绝；不能退回“一项任务一个交付单元”的隐式默认。计划批准后不得静默重新归纳，必须通过计划修订处理。

先建模不可再拆的原子任务及其前驱，再组成任务并同时校验两张图与显式交接事实。新类型仅限 `contribution`、`release`、`deployment`、`verification`；`development`、`other`、`coordination` 只读历史，不由 init 或修订引入。等待、阻塞、集成、单元管理用协调状态与里程碑表示。计划包含单元 PR、仅多贡献拓扑需要的 child PR、post-merge 任务和带来源／置信度的预计时间。默认并行上限三个，等待／阻塞释放名额；parent PR 默认串行，regular 仅按显式依赖并行，不由分组顺序或文件重叠推断依赖。

bootstrap 是首个单元的主会话所有权与启动机制，覆盖完整交付，而非额外的文档阶段。使用 `owner_kind: "main"`，不绑定单元对话，必须位于首位；首个 regular 须在提案记录例外原因和证据。regular 激活前绑定独立交付对话。类型、owner 与对话绑定不得通过普通更新或计划修订改写，本版本无原地所有权转移；已有运行保留当前所有权。

## 原子图

主 Agent 在调用 `init` 前 必须形成完整 canonical plan：每个 contribution Task 都必须有自己的原子任务；原子图 MUST 明确声明开始节点、结束节点、里程碑节点和全部 `atomic_edges`。系统预设的交付单元生命周期原子只提供节点定义，不提供依赖关系；生命周期关系必须由 Agent 在 plan 中显式声明。运行时不得从任务图、交付单元数组顺序、原子数组顺序或名称推导任何原子依赖。

Delivery Unit 的四个预设生命周期原子必须按 `prepare-parent → create-pr → merge-pr → closeout` 保持可达顺序；Contribution Task 的四个预设生命周期原子必须按 `prepare-branch → create-pr → merge-pr → closeout` 保持可达顺序。两层原子不得混用；不再预设 `verify-integration` 或 `verify-task-pr`。两节点之间允许插入 Agent 创建的 work、milestone 和并行分支，但只能使用 Agent 声明的边形成路径；缺失、逆序、无关或自动补出的关系都必须使计划拒绝。

生命周期节点保存显式 `lifecycle_role`；历史读取仅按 owner scope 和完整后缀规则适配旧 ID，不从标题或任意 ID 猜角色或依赖。边引用存在的节点，图无环，里程碑至少有入边或验收条件；历史原子／边只允许机械 canonicalization，不推断业务语义。视图投影的 boundary、颜色、选中状态与详情文案不构成运行事实或 provider evidence。

## 分阶段修订

运行时 schema 及 contract 投影是修订语义的权威。第一次真实 `task_started` 前为 `planning`，之后单向进入 `implementation`；dispatch claim、创建对话、`starting` 和计划选择不跨越此边界。

提案后计划内容不可变。`active_plan_id` 标识选中的候选，`execution_plan_id` 标识当前约束调度的已批准版本。使用 `plan-propose` 提交 canonical candidate；运行时推导 `planning_revision`、`implementation_low_impact` 或 `implementation_high_impact`。不得提交自声明的变更类型。计划修订必须有非空 diff 和重新批准。低影响实现修订需要结构化原因并自动批准；高影响实现修订需要原因和证据，保留旧 execution pointer，仅 hold 受影响任务及其后继，并在新图调度前使用 `plan-approve`。使用 `plan-abandon` 恢复旧 execution plan。

不能在计划 payload 中改写已启动任务的边界或运行时身份。使用带有新 planned task ID、结构化原因和证据的 `task-migrate`；旧任务及其事实和事件保留为 `superseded`。仪表板和 `view` 投影分别保留 phase、生命周期、candidate/execution plan、revision diff 和 hold 原因。不能从 candidate ID、`starting`、dispatch claim 或 terminal plan label 推断完成。

`examples/ledger-initialization/initial.json` 是合成的、未经批准的起始示例，不是可执行的真实计划。实际初始化前替换所有示例身份、日期和任务细节。 `examples/orchestration-viewer/ledger.ts` 提供另一个更丰富的合成仪表板示例；可复现的静态预览和 live demo 见 `examples/README.md`。
