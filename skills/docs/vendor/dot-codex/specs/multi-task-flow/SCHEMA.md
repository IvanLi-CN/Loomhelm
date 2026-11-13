# Multi-task Flow 账本数据结构

## 1. 根对象

账本根对象类型为 `Ledger`，对应 `skills/multi-task-flow-runtime/lib/schema.ts` 中的 `ledgerSchema`。一个运行只有一个根对象；所有计划、任务、操作、事实和事件都从该对象的数组字段进入账本。

```text
Ledger
├── repository
├── control
├── config
├── plans[]
├── groups[]
├── tasks[]
├── follow_prs[]
├── facts[]
├── operations[]
├── events[]
├── milestones[]
├── requests[]
├── notifications[]
└── resources[]
```

## 2. `Ledger` 字段

| 路径 | 类型 | 必填 | 说明 |
| - | - | - | - |
| `schema_version` | `2` | 是 | 持久化结构版本。 |
| `source_schema_version` | `1 \| null` | 否 | 兼容迁移时记录来源版本。 |
| `contract_version` | `1 \| 2` | 是 | 领域合同版本。 |
| `version` | `Version \| null` | 否 | 技能和读取合同版本。 |
| `orchestration_id` | `Id` | 是 | 运行唯一 ID。 |
| `revision` | `number` | 是 | 非负、单调递增的账本版本。 |
| `repository` | `Repository` | 是 | 代码托管仓库信息。 |
| `control` | `Control` | 是 | owner、所有权和批准信息。 |
| `config` | `Config` | 是 | 并发、时区、链接验证和默认执行配置。 |
| `plans` | `Plan[]` | 是 | 至少一个计划版本。 |
| `active_plan_id` | `Id` | 是 | 当前选择的计划。 |
| `execution_plan_id` | `Id` | 是 | 当前执行计划。 |
| `groups` | `Group[]` | 是 | 交付单元。 |
| `tasks` | `Task[]` | 是 | 任务。 |
| `follow_prs` | `FollowPr[]` | 是 | 后续 PR。 |
| `facts` | `Fact[]` | 是 | 已记录事实。 |
| `operations` | `Operation[]` | 是 | 外部操作记录。 |
| `events` | `Event[]` | 是 | 不可变事件记录。 |
| `milestones` | `Milestone[]` | 是 | 里程碑记录，默认空数组。 |
| `requests` | `Request[]` | 是 | 幂等请求记录。 |
| `notifications` | `Notification[]` | 是 | 通知记录。 |
| `resources` | `Resource[]` | 是 | 对话、工作区、分支、端口和服务资源。 |
| `updated_at` | `Timestamp` | 是 | 最近更新时间。 |

## 3. 公共类型

| 类型 | 定义 |
| - | - |
| `Id` | `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/`。 |
| `Text` | 去除首尾空格后长度大于 0 的字符串。 |
| `Timestamp` | 不带 UTC offset 的 ISO datetime。 |
| `Sha` | 40 或 64 位小写十六进制字符串。 |
| `Sha256` | 64 位小写十六进制字符串。 |
| `NullableText` | `Text \| null`。 |
| `ExternalRef` | `{ provider, repository, id, url: URL \| null }`。 |
| `ExecutionProfile` | `{ model: Text, thinking: Text }`。 |

## 4. 计划结构

### `Plan`

| 字段 | 类型 | 说明 |
| - | - | - |
| `id` | `Id` | 计划 ID。 |
| `supersedes_id` | `Id \| null` | 被当前计划替代的旧计划。 |
| `approval_id` | `Text \| null` | 批准记录 ID。 |
| `lifecycle` | `proposed \| approved \| superseded \| abandoned` | 计划生命周期。 |
| `revision` | `PlanRevision \| null` | 计划修订信息。 |
| `created_at` | `Timestamp` | 创建时间。 |
| `start_at` | `Timestamp \| null` | 计划起始时间。 |
| `atoms` | `AtomPlan[]` | 任务原子项。 |
| `group_atoms` | `GroupAtomPlan[]` | 交付单元原子项，默认空数组。 |
| `atomic_edges` | `AtomEdge[]` | 原子项依赖。 |
| `nodes` | `Node[]` | 计划图节点。 |
| `edges` | `Edge[]` | 计划图边。 |
| `cut_rules` | `CutRule[]` | 动态切割规则。 |
| `actions` | `PlannedAction[]` | 计划动作。 |
| `plan_handoff` | `PlanHandoff \| undefined` | 计划交接信息。 |

### 原子项

| 类型 | 字段 | 取值 |
| - | - | - |
| `AtomPlan` | `id`, `title`, `task_id`, `purpose`, `output` | 全部为必填文本或 ID。 |
| `GroupAtomPlan` | `id`, `title`, `group_id`, `purpose`, `output`, `lifecycle_stage` | `lifecycle_stage` 为 `workspace_ready`、`pr_created`、`pr_merged`、`closed` 或 `null`。 |
| `AtomEdge` | `id`, `from_atom_id`, `to_atom_id` | 三个字段均为 ID。 |

### 计划图

`Node` 字段如下：

| 字段 | 类型 |
| - | - |
| `id` | `Id` |
| `kind` | `main_start`、`main_end`、`group_start`、`group_end`、`task`、`milestone` |
| `ref_id` | `Id \| null` |
| `group_id` | `Id \| null` |
| `label` | `Text` |
| `estimate_minutes` | 非负整数或 `null` |
| `estimate_basis` | `Text \| null` |
| `estimate_confidence` | `low`、`medium`、`high` 或 `null` |

`Edge` 字段为 `id`、`from_node_id`、`to_node_id` 和 `requires`。`requires` 为 `integrated`、`completed`、`merged`、`ci_passed`、`published`、`deployed` 或 `verified`。

### `PlannedAction`

| 字段 | 类型 |
| - | - |
| `id` | `Id` |
| `kind` | `publish_branch`、`publish_pr`、`release`、`deploy` |
| `task_id` | `Id \| null`，默认 `null` |
| `group_id` | `Id \| null`，默认 `null` |
| `target` | `{ type: task \| group, id: Id }`；新计划必填 |
| `target_identity` | `Text \| undefined`；仅旧账本兼容读取，新计划不得填写 |

### `PlanRevision`

`PlanRevision` 包含 `execution_phase`、`change_class`、`affected_task_ids`、`affected_node_ids`、`affected_edge_ids`、`change_set`、`reason`、`approval_required` 和 `paused_task_ids`。`execution_phase` 为 `planning | implementation`；`change_class` 为 `planning_revision | implementation_low_impact | implementation_high_impact`。

## 5. 交付单元与任务

### `Group`

| 字段 | 类型 |
| - | - |
| `id`, `title` | `Id`, `Text` |
| `delivery_unit_kind` | `bootstrap` 或 `regular`，默认 `regular` |
| `owner_kind` | `main` 或 `group`，默认 `group` |
| `agent_thread_id` | `Text \| null` |
| `state` | `planned`、`active`、`merged`、`closed`、`blocked` |
| `parent_branch` | `Text \| null` |
| `parent_pr` | `ExternalRef \| null` |
| `cut_sha`, `current_sha`, `merge_sha` | `Sha \| null` |
| `requirements_path` | `Text \| null` |
| `atoms` | 交付单元原子项数组，默认 `[]` |
| `coordination_execution` | `{ state, reason, waiting_for_task_ids }` |
| `execution_profile` | `ExecutionProfile \| null` |
| `execution_profile_source` | `manual`、`recommendation` 或 `null` |
| `execution_profile_rule` | `Text \| null` |
| `lifecycle` | `Lifecycle`，默认四项均为 `unknown` |

`coordination_execution.state` 为 `unknown`、`idle`、`running`、`waiting` 或 `blocked`。

### `Task`

| 字段 | 类型 |
| - | - |
| `id` | `Id` |
| `title` | `Text` |
| `kind` | 见下方枚举 |
| `group_id` | `Id` |
| `thread_id` | `Text \| null` |
| `state` | 见下方枚举 |
| `agent_resume_state` | `starting \| running \| undefined` |
| `disposition` | `active \| superseded \| abandoned`，默认 `active` |
| `superseded_by_task_id` | `Text \| null`，默认 `null` |
| `execution_owner` | 见下方枚举，默认 `null` |
| `conversation_policy` | 见下方枚举，默认 `null` |
| `delivery_policy` | 见下方枚举，默认 `null` |
| `atoms` | `{ id, title, status }[]` |
| `owned_surfaces` | `Text[]` |
| `branch` | `Text \| null`，默认 `null` |
| `base_sha` | `Sha \| null` |
| `pr` | `ExternalRef \| null` |
| `requirements_path` | `Text \| null` |
| `execution_profile` | `ExecutionProfile \| null` |
| `execution_profile_source` | `manual \| recommendation \| null`，默认 `null` |
| `execution_profile_rule` | `Text \| null`，默认 `null` |
| `started_at` | `Timestamp \| null` |
| `finished_at` | `Timestamp \| null` |
| `blocker` | `Text \| null` |
| `assignment_history` | `{ group_id, effective_at, reason, cut_operation_id }[]` |
| `lifecycle` | `Lifecycle`，默认四项均为 `unknown` |

```text
kind: contribution | release | deployment | verification | coordination | development | other
state: planned | ready | starting | running | agent_idle | waiting | blocked | integrated | completed | closed
execution_owner: main | delivery_agent | task_agent | null
conversation_policy: main_owned | delivery_owned | task_agent | none | null
delivery_policy: parent_pr | child_pr | evidence | none | null
```

任务原子项的 `status` 为 `planned`、`running`、`completed` 或 `blocked`。任务迁移记录为 `{ group_id, effective_at, reason, cut_operation_id }`。

## 6. 操作与事实

### `Operation`

| 字段 | 类型 |
| - | - |
| `id` | `Id` |
| `kind` | `dispatch`、`merge`、`cut`、`publish_branch`、`publish_pr`、`release`、`deploy` |
| `actor_id` | `Text` |
| `target_id` | `Id` |
| `status` | `claimed`、`succeeded`、`failed`、`unknown` |
| `request` | 字符串键到任意 JSON 值的映射 |
| `expected_sha` | `Sha \| null` |
| `receipt_fact_id` | `Id \| null` |
| `created_at`, `updated_at` | `Timestamp` |

### `Fact` 与 `ProviderReceipt`

`Fact` 字段为 `id`、`kind`、`subject_id`、`status`、`source`、`observed_at`、`sha`、`evidence_ref`、`quality` 和 `receipt`。`kind` 为 `child_review`、`task_quality`、`pr_merged`、`branch_published`、`pr_published`、`ci_passed`、`published`、`deployed` 或 `verified`；`status` 为 `passed`、`failed` 或 `unknown`。

`ProviderReceipt` 字段为 `provider`、`repository`、`resource_type`、`resource_id`、`branch`、`target_branch`、`base_sha`、`head_sha`、`pr`、`state` 和 `evidence_ref`。`resource_type` 为 `branch | pr`；`state` 为 `exists | open | merged | absent | unknown`。

### `Event`

`Event` 为 `{ id, type, subject_id, actor_id, occurred_at, recorded_at, data }`。`occurred_at` 可为 `null`；`data` 为字符串键到任意 JSON 值的映射；`type` 使用 `schema.ts` 中声明的事件枚举。

## 7. 其他集合

| 类型 | 字段 |
| - | - |
| `FollowPr` | `id`, `origin_task_id`, `origin_group_id`, `pr`, `target_branch`, `state`, `merge_fact_id`, `affected_task_ids`。 |
| `Milestone` | `id`, `target_type`, `target_id`, `title`, `evidence_ref`, `recorded_at`, `recorded_by`。 |
| `Request` | `request_id`, `command`, `canonical_input`, `result`, `committed_revision`。 |
| `Notification` | `id`, `event_id`, `recipient_thread_id`, `ledger_status`, `status`, `delivery_status`, `ack_status`, `attempts`, `last_attempt_id`, `last_reconciliation_id`, `last_error`, `updated_at`。 |
| `Resource` | `id`, `kind`, `target`, `status`, `evidence_ref`, `error`, `last_attempt_at`, `operation_id`, `archive_policy`。 |

## 8. 对象关系

```text
Ledger
  ├─ plans[].nodes[].ref_id ──> tasks[].id / groups[].id
  ├─ tasks[].group_id ────────> groups[].id
  ├─ operations[].target_id ──> task/group/resource ID
  ├─ operations[].receipt_fact_id -> facts[].id
  ├─ facts[].subject_id ──────> task/group ID
  ├─ tasks[].pr ──────────────> ExternalRef
  └─ groups[].parent_pr ──────> ExternalRef
```

`active_plan_id` 和 `execution_plan_id` 必须引用 `plans[]` 中的 ID；每个任务的 `group_id` 必须引用 `groups[]`；依赖图中的引用必须存在；ID 在各自集合内必须唯一。

## 9. 权威来源

- 运行时 schema：`skills/multi-task-flow-runtime/lib/schema.ts`
- 语义字段元数据：`skills/multi-task-flow-runtime/lib/contract.ts`
- 持久化实现：`skills/multi-task-flow-runtime/lib/store.ts`
- 结构约束：[`SCHEMA-CONSTRAINTS.md`](./SCHEMA-CONSTRAINTS.md)
