# Plan and graph contract

本文件承载计划归纳、Contract 3 原子图和计划修订的详细规则；日常调度只需遵守 `SKILL.md` 的主流程与 fail-closed 门禁。

## 计划归纳

主 Agent 必须先说明每个 contribution Task 服务的需求结果，再把共同完成同一个可验收结果的任务归入同一个 `delivery_unit_id`。任务分别产生独立结果、可以分别交付并分别验收时，才拆成不同交付单元；不能因为一个任务看起来像一个能力或需要一个 PR 就拆分。

每个 contribution 或 documentation work 原子使用唯一的 `TaskScope { kind: "task", task_id, delivery_unit_id }`。`DeliveryUnitDefinition` 不复制 `task_ids`，成员由原子 scope 派生；主 Agent 的中间推理不作为新的 Proposal 类型或独立账本对象持久化。

同一交付单元恰好一个 contribution Task 时使用共享交付拓扑；多个 contribution Task 时使用多任务集成拓扑。共享拓扑复用交付单元对话、工作区、分支和 PR；多任务拓扑为每个任务创建独立对话、工作区、分支和 child PR。verification、release 和 deployment Task 不计入 contribution Task 数量。

计划校验必须保证每个 contribution Task 有且只有一个交付单元归属，并保证执行策略与拓扑一致。缺少归属、多个归属或策略冲突时拒绝计划，不能退回“一项任务一个交付单元”的隐式默认。

默认第一个交付单元是 bootstrap，且只有一个；它由 main conversation 持有、使用 `owner_kind: "main"`、不绑定交付单元对话，并负责初始 SPEC/ADR/计划文档和第一个 parent PR。第一个单元为 regular 时，提案必须记录明确例外原因和证据。regular 单元在激活前必须具备交付单元对话；类型、所有权和对话绑定不能通过普通更新改写。

## 原子图

先建模原子任务及其前驱，每个原子任务是不可再拆的调度单位。新任务类型只能是 `contribution`、`release`、`deployment` 或 `verification`；`development`、`other` 和 `coordination` 仅允许作为历史账本值。

Contract 3 canonical graph 必须显式保存 task-scoped work atoms、delivery-unit lifecycle atoms 和 dependency edges。边必须引用存在的节点，图必须无环，里程碑必须至少有一个入边或验收条件；旧 `atoms`、`group_atoms` 和 legacy plan edges 只能通过机械 canonicalization 转换，不能推断业务语义。

图视图可以添加 `boundary` 类型的“开始”和“结束”节点，帮助识别无前驱和无后继；边界节点是视图投影，不得伪造运行事实。UI 的节点颜色、选中状态和详情文案不能代替账本状态或 provider evidence。

## 计划修订

第一次真实 `task_started` 事件之前，运行处于 `planning`；之后单向进入 `implementation`。dispatch claim、对话创建、`starting` 状态和计划选择不会跨过这条边界，不能把候选计划或已绑定身份当作已经开工。

`active_plan_id` 标识候选计划，`execution_plan_id` 标识当前调度约束的已批准版本。使用 `plan-propose` 提交 canonical candidate；计划修订必须有非空 diff 和结构化原因。高影响修订保留旧 execution pointer，只 hold 受影响任务及其后继，并在新图调度前执行 `plan-approve`；使用 `plan-abandon` 恢复旧 execution plan。

已启动任务的边界和运行时身份不能通过计划 payload 改写；使用带新 planned task ID、原因和证据的 `task-migrate`，旧任务及事实保留为 `superseded`。不能从 candidate ID、`starting`、dispatch claim 或 terminal plan label 推断完成。

`examples/ledger-initialization/initial.json` 是合成且未经批准的候选输入，不是可执行计划；实际初始化前必须替换示例身份、日期和任务细节。
