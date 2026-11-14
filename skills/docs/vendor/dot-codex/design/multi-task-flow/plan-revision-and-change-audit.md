# Multi Task Flow 计划修订与阶段审计设计

本文说明 Multi Task Flow 如何区分设计阶段和实现阶段的计划调整，如何保留计划与任务的历史，以及如何从同一份可执行合同生成 runtime、dashboard 和 LLM 所需语义。本文只描述本地编排边界，不授权启动会话、创建 PR、发布或部署。

## 核心维度

`execution_phase`、`plan_lifecycle`、`active_plan_id` 和 `execution_plan_id` 是互相独立的事实。

```text
execution_phase: planning | implementation
plan_lifecycle: proposed | approved | superseded | abandoned
active_plan_id: 当前选择的候选版本
execution_plan_id: 当前实际支配调度的已批准版本
```

阶段只由真实 `task_started` 事件决定：首个事件前是 `planning`，之后永久是 `implementation`。dispatch claim、会话创建、`starting` 和计划选择都不触发阶段切换。

高影响修订提出后，`active_plan_id` 可以指向 `proposed` 候选，而 `execution_plan_id` 继续指向旧的 `approved` 版本。批准时原子切换两个指针并把旧版本标记为 `superseded`；放弃时把候选标记为 `abandoned` 并恢复旧指针。

## 变更判定

runtime 根据规范化 diff 推导变更级别，调用方不得在请求中自报级别。

| 阶段与变化 | `change_class` | 理由 | 证据 | 重新批准 | 调度 |
| - | - | - | - | - | - |
| 尚无 `task_started` 的计划内容变化 | `planning_revision` | 可选 | 可选 | 必须 | 候选未批准前不调度 |
| 实现阶段仅改标题、说明、标签或估时 | `implementation_low_impact` | 必须 | 可选 | 不需要 | 不暂停 |
| 实现阶段改依赖、归属、owned surfaces、基线、验收、父 PR、发布或部署动作 | `implementation_high_impact` | 必须 | 必须 | 必须 | 只暂停受影响任务及其后继 |
| 仅改 dashboard 展示、筛选、缩放或 URL 状态 | 无账本修订 | 不需要 | 不需要 | 不需要 | 不改变调度事实 |

任何修订都必须有非空 canonical diff。实现阶段的理由是结构化对象，至少包含 `category`、`summary`、`evidence_refs` 和 `impact`；高影响修订的 `evidence_refs` 非空。缺少理由、证据或 diff 时，在账本变更前拒绝请求。

## 不可变快照与任务迁移

计划内容在提出后不可原地修改。计划修订保存新增、删除和修改的路径及旧/新值，并记录受影响的 task、node、edge、暂停对象、理由与批准要求。

已产生 `task_started` 的任务不能通过计划请求改写 runtime 状态或任务边界。需要改变边界时：

1. 新任务使用新 ID、`planned` 状态、`active` 处置和新的 `base_sha`。
2. 旧任务保留状态、开始时间、事件、事实、证据和责任历史，并标记 `disposition=superseded`。
3. `task_migration_recorded` 记录旧/新 ID、理由、证据、继承与未继承产出、新基线、关联计划修订和迁移时间。

任务 `state` 表示执行进度；`disposition` 表示责任身份。两者不能互相替代。

## 自解释合同

`packages/multi-task-flow-runtime/lib/schema.ts` 是唯一执行合同源。相邻的 `contract.ts` 只提供该合同的元数据、JSON Schema 和按操作裁剪的 `localSemanticProjection`，不建立第二套字段解析器。

同一合同提供：

- Zod runtime 校验和跨字段不变量；
- JSON Schema；
- dashboard/API 的稳定字段投影；
- 当前操作所需的 LLM 局部语义，包括阶段、候选/执行计划、生命周期、变更级别、受影响对象、理由/证据要求、批准影响、允许转换、正例和反例。

`schema_version` 表示存储结构；`contract_version` 表示领域语义。旧账本缺少新字段时只做确定性的读取归一化；语义无法安全归一化时必须拒绝，不能静默猜测。

## Dashboard 投影

View 必须独立输出：

- `execution_phase`；
- `active_plan_id` 与 `execution_plan_id`；
- active plan 的 `lifecycle`；
- `change_class`、canonical diff、理由/证据要求和批准状态；
- 任务 `disposition`、`is_held` 与 `hold_reason`。

高影响候选尚未批准时，hold 只对受影响任务及其后继生效；批准后暂停列表作为审计历史保留，但不能继续阻塞 ready。页面不能把 `active_plan_id`、`starting`、dispatch claim 或末节点名称当成实际完成。

## Loomhelm v2 到 v3 回放

回放的 v2/v3 均没有 `task_started`、运行操作或外部事实，因此四条依赖删除必须得到：

```text
execution_phase: planning
change_class: planning_revision
reason_required: false
diff_required: true
approval_required: true
```

canonical diff 必须包含：

```text
session-resume -> query-layer
server-read-path -> query-layer
query-layer -> ui-regression
ui-regression -> docs
```

只要加入任一真实 `task_started` 事实，同一删除就变为 `implementation_high_impact`，缺少理由或证据必须被拒绝；候选提出期间旧 `execution_plan_id` 保持不变，批准后才切换。

## 操作边界与恢复

- 修订操作通过账本原子事务执行，失败不能留下半个计划、事件或指针状态。
- 同一 `request_id` 只能重放同一 canonical input；事件 ID 在一个请求产生多个事件时使用稳定后缀保持唯一。
- 待批准高影响修订期间禁止再次提出候选；无关任务仍按旧 execution plan 运行。
- `plan-abandon` 是恢复旧执行计划的唯一显式路径；不能通过直接改指针绕过事件。
- 所有分类、hold 和迁移结论都由本地确定性回放证明，不以真实外部 PR 或手动 workflow 作为唯一证据。
