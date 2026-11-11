# Multi-task Flow 数据结构约束

## 1. 规范范围

本文档定义 `Ledger` 及其嵌套对象必须满足的结构、引用、状态和写入约束。`SCHEMA.md` 定义字段形状；本文档定义字段之间必须成立的关系。所有约束均为规范性要求。

## 2. 根账本约束

- 一个运行只能有一个 `Ledger` 根对象。
- `schema_version` 必须为当前写入器支持的结构版本。
- `contract_version` 必须与该账本使用的领域语义合同一致，不得用 `schema_version` 代替。
- `orchestration_id` 在账本生命周期内不可改变。
- `revision` 必须是非负整数，并在每次成功提交后严格递增。
- `active_plan_id` 和 `execution_plan_id` 必须引用 `plans[]` 中存在的计划 ID。
- `execution_plan_id` 必须指向已批准且未被替代或放弃的计划。
- 所有集合中的稳定 ID 必须唯一；重复 ID 必须拒绝写入。
- 未知字段必须拒绝写入，避免调用方静默扩展合同。

## 3. 计划约束

- `Plan` 必须是完整快照；计划修订不得只提交局部字段补丁。
- `Plan.id` 创建后不可改变；新版本必须使用新 ID，并通过 `supersedes_id` 建立替代关系。
- `proposed` 计划不得支配任务调度；只有 `approved` 计划可以成为 `execution_plan_id`。
- `superseded` 和 `abandoned` 计划不得再次批准或执行。
- `nodes[].id`、`edges[].id`、`atoms[].id`、`group_atoms[].id` 和 `actions[].id` 在各自集合内必须唯一。
- 所有 `node.ref_id`、`node.group_id`、`atom.task_id`、`group_atom.group_id`、edge 端点和 action 所引用的任务/交付单元必须存在。
- 计划图必须无环；不可达节点和悬空边必须拒绝。
- `atomic_edges` 只能引用已存在的原子项，不能引用普通图节点。
- `plan_handoff.task_ids`、`task_surfaces` 和 `acceptance_scopes` 的 ID 集合必须与计划任务一致，不得遗漏或重复。

## 4. 任务与交付单元约束

- 每个 `Task.group_id` 必须引用现有 `Group.id`。
- 一个任务只能归属于一个交付单元；归属变更必须产生新的 assignment history 记录。
- `Task.disposition=superseded` 时必须有 `superseded_by_task_id`，且该 ID 必须引用另一任务。
- `Task.state` 表示执行状态；`Task.disposition` 表示责任身份处置；两者不得互相替代。
- `Group.state` 表示交付单元状态；不能用任务数量推导或覆盖 `coordination_execution`。
- 同一交付单元内的任务 `owned_surfaces` 不得重叠；跨交付单元的 surfaces 也必须由计划校验规则明确允许。
- `bootstrap` 交付单元最多一个；其 owner 必须是 `main`。
- `regular` 交付单元必须有独立 owner 绑定后才能进入运行状态。
- 任务和交付单元的默认原子项只能记录为 `planned`，原子项完成必须通过对应生命周期事实。

## 5. 外部身份与发布约束

- `ExternalRef` 必须同时包含 provider、repository、id 和 URL（URL 可以为 `null`）。
- 分支、PR、会话、工作区和 SHA 只有在对应外部操作获得真实回执后才能写入事实字段。
- 新计划的 `PlannedAction` 必须使用 `{ type, id }` 结构化目标；`target_identity` 只允许旧账本兼容读取，不得用于新写入。
- `PlannedAction` 不得保存 provider 返回的 PR 编号、分支 SHA 或其他事实回执。
- `publish_branch`、`publish_pr`、`merge`、`release` 和 `deploy` 必须先存在于准确的批准计划中。
- provider 回执中的 repository、资源类型、资源 ID、base SHA、head SHA 和目标分支必须与操作请求一致。
- provider 回执不匹配时，操作必须失败或进入 `unknown` 对账状态；不得写入成功事实。

## 6. Operation、Fact 与 Event 约束

- 每个外部副作用必须先创建唯一 `Operation`，再执行外部调用。
- 同一操作 ID 不得创建第二个不同请求；相同请求重放必须幂等。
- `Operation.status=unknown` 表示结果未确认，必须保留操作占用，不得自动转换为 `failed` 或 `succeeded`。
- `receipt_fact_id` 非空时必须引用现有 `Fact.id`，且该事实必须与操作目标和 provider 回执一致。
- `Fact` 是不可变观察结果；修正观察结果必须追加新事实，不得覆盖旧事实。
- `Event` 是不可变审计记录；事件只能追加，不能删除、重排或覆盖。
- `Fact.status=passed` 必须有来源和证据；外部发布事实还必须有匹配的 provider receipt。

## 7. 生命周期约束

- `execution_phase` 只能从 `planning` 转为 `implementation`，不得回退。
- `planning` 转为 `implementation` 的唯一条件是存在真实 `task_started` 事实。
- dispatch claim、会话创建、`starting` 状态、计划选择和 PR 计划动作都不能单独触发阶段转换。
- 计划批准、任务启动、任务集成、任务完成、任务关闭和交付单元收口必须通过对应事件记录。
- 有未解决的 `Operation`、未合并的 follow PR 或未完成的任务时，不得写入 `run_completed`。

## 8. 原子提交约束

- 每次写入必须在账本锁内完成，并以单次原子提交更新账本和 `revision`。
- 任何结构、引用、状态或权限校验失败都不得改变账本内容和 revision。
- 外部调用结果未知时，不得重复执行可能产生副作用的请求；必须先通过 provider 查询完成对账。
- 账本写入不得依赖 dashboard、临时输出、命令退出码或用户界面状态作为事实来源。

## 9. 约束检查顺序

1. 解析字段类型、枚举、ID 和未知字段。
2. 检查集合内 ID 唯一性。
3. 检查所有引用存在且归属正确。
4. 检查计划图和原子图无环。
5. 检查生命周期和状态转换。
6. 检查 owner、批准计划和操作权限。
7. 检查 provider 回执与事实匹配。
8. 在全部检查通过后原子提交账本。
