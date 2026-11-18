# Unified atomic orchestration data model

本文承载统一原子编排的 canonical schema、Task/DeliveryUnit 投影、外部事实、里程碑和执行策略。需求边界与验收合同以同目录的 [SPEC.md](./SPEC.md) 为准；状态机、状态归属和异常恢复以 [STATE_MACHINES.md](./STATE_MACHINES.md) 为准。

## 1. Canonical 数据结构

### 1.1 原子节点和依赖边

canonical 字段使用 `task_id` 和 `delivery_unit_id`；当前实现中的 `group_id` 只作为兼容读取名称。AtomicNode 不允许 `activity_type: null`、`execution_owner: null` 或通过 null 拼出非法组合。

#### 磁盘持久化：AtomicNode 与 AtomicEdge

下面代码块只定义磁盘上的 canonical 原子节点和依赖边；其中的 work 生命周期、完成结果和证据引用属于原子编排的持久化事实。运行时观察、评估结果和网页读取结构在 [STATE_MACHINES.md](./STATE_MACHINES.md) 中单独定义，不与本代码块混用。

```ts
type AtomicNode = WorkAtom | MilestoneNode;

type TaskScope = {
  kind: "task";
  task_id: string;
  delivery_unit_id: string;
};

type DeliveryUnitScope = {
  kind: "delivery_unit";
  delivery_unit_id: string;
};

type WorkDefinition = {
  kind: "work";
  id: string;
  title: string;
  purpose: string;
  output: string;
  acceptance: WorkAcceptanceCriterion[];
};

type WorkLifecycle<S> =
  | {
      state: "design";
      scope?: never;
      runtime?: never;
      blocker?: never;
      result?: never;
    }
  | {
      state: "planned";
      scope: S;
      runtime?: never;
      blocker?: never;
      result?: never;
    }
  | {
      state: "starting";
      scope: S;
      runtime: WorkRuntime;
      blocker?: never;
      result?: never;
    }
  | {
      state: "running";
      scope: S;
      runtime: WorkRuntime;
      blocker?: never;
      result?: never;
    }
  | {
      state: "blocked";
      scope: S;
      runtime: WorkRuntime;
      blocker: Blocker;
      result?: never;
    }
  | {
      state: "completed";
      scope: S;
      runtime: WorkRuntime;
      blocker?: never;
      result: WorkResult;
    };

type WorkAtom =
  | (WorkDefinition &
      { activity_type: "contribution" | "documentation" } &
      WorkLifecycle<TaskScope>)
  | (WorkDefinition &
      { activity_type: "verification" | "release" | "deployment" } &
      WorkLifecycle<TaskScope | DeliveryUnitScope>);

type MilestoneNode =
  | {
      kind: "milestone";
      id: string;
      title: string;
      state: "design";
      scope?: never;
      acceptance: MilestoneCriterion[];
    }
  | {
      kind: "milestone";
      id: string;
      title: string;
      state: "planned";
      scope: TaskScope | DeliveryUnitScope;
      acceptance: MilestoneCriterion[];
    };

type AtomicEdge = {
  id: string;
  from_node_id: string;
  to_node_id: string;
  requires: EdgeRequirement;
};
```

contribution 和 documentation 原子只能使用 TaskScope；verification、release 和 deployment 原子可以使用 TaskScope 或 DeliveryUnitScope。每个 planned work 原子恰好拥有一个 scope；TaskScope 同时携带 task_id 和 delivery_unit_id，DeliveryUnitScope 只携带 delivery_unit_id。scope 不是父子关系，而是责任和验收分类。

原子节点不创建 Agent 或执行会话，也不保存 `execution_owner`。TaskScope 的执行策略来自 TaskDefinition，DeliveryUnitScope 的执行策略来自 DeliveryUnitDefinition；运行时绑定和执行事实通过 work runtime 与 evidence 记录。

这里的 `WorkRuntime` 和 `WorkResult` 指原子执行事件、结果和 evidence 的持久化事实；它们不等同于 [STATE_MACHINES.md](./STATE_MACHINES.md) 中的 `TaskRuntimeObservation` 或 `DeliveryUnitRuntimeObservation`，后两者只描述当前运行观察。

### 1.2 里程碑条件

里程碑条件是显式、结构化、可验证的谓词；条件类型必须与事实来源匹配，不允许用自由文本代替必要的外部事实约束。

#### 磁盘持久化：MilestoneCriterion 与 EdgeRequirement

下面代码块只定义磁盘上的 milestone 条件和依赖边要求；`MilestoneEvaluation` 属于 [STATE_MACHINES.md](./STATE_MACHINES.md) 中的运行时派生结果。

```ts
type MilestoneCriterion =
  | { kind: "node_satisfied"; node_id: string }
  | { kind: "pr_published"; pr_ref: ExternalRef }
  | { kind: "pr_merged"; pr_ref: ExternalRef; merge_sha: string }
  | { kind: "ci_passed"; target_ref: string; head_sha: string; checks: string[] }
  | { kind: "release_published"; release_id: string; artifact_digest: string }
  | { kind: "deployment_succeeded"; environment: string; artifact_digest: string }
  | { kind: "online_verification_passed"; target: string; verification_id: string };

type EdgeRequirement =
  | { kind: "source_terminal_success" }
  | { kind: "source_evidence"; criterion: MilestoneCriterion };
```

planned milestone 必须至少有一个入边条件或至少一个显式验收条件；只有入边、只有显式验收条件以及两者同时存在都合法。两者都为空的 milestone 是无效计划，必须在 schema 校验阶段拒绝，不能被当作自动满足或普通 pending。

## 2. Task 与 DeliveryUnit 数据结构

Task 和 DeliveryUnit 是平级领域对象。canonical 账本只保存它们的身份、执行策略、交付引用和外部资源事实；`atom_ids`、`task_ids` 和 `milestone_ids` 只存在于派生投影或带 revision 的读取缓存中，不能作为可独立修改的持久化字段。

### 2.1 Task 定义与投影

#### 磁盘持久化：TaskDefinition 与 TaskPrBinding

```ts
type TaskDefinition = {
  id: string;
  title: string;
  execution_policy: TaskExecutionPolicy;
  delivery_refs: TaskDeliveryRefs;
  pr: TaskPrBinding;
};

type TaskPrBinding =
  | { state: "unbound" }
  | {
      state: "shared_delivery_unit";
      delivery_unit_id: string;
    }
  | {
      state: "open";
      pr: ExternalRef;
      branch: string;
      base_branch: string;
    }
  | {
      state: "merged";
      pr: ExternalRef;
      branch: string;
      merge_sha: string;
    }
  | {
      state: "closed";
      pr: ExternalRef;
      branch: string;
      closed_at: string;
      closed_reason: "abandoned" | "superseded" | "provider_closed" | "replaced";
    };
```

TaskDefinition 不保存 TaskKind、成员列表、delivery_unit_id 或独立编排状态。贡献任务的 `pr` 可以是独立 child PR，也可以是 `shared_delivery_unit` 绑定；后者只引用所属 DeliveryUnit，不复制 PR、分支或 SHA。

#### 派生读取：TaskProjection

```ts
type TaskProjection = TaskDefinition & {
  derived: {
    scope:
      | { state: "design" }
      | { state: "planned"; delivery_unit_id: string };
    kind: TaskKind;
    atom_ids: string[];
    status: TaskStatus;
    blockers: Blocker[];
    completed_at: string | undefined;
  };
};

type TaskKind =
  | "contribution"
  | "verification"
  | "release"
  | "deployment";

type TaskStatus =
  | "design"
  | "planned"
  | "ready"
  | "starting"
  | "running"
  | "blocked"
  | "completed";
```

TaskProjection 的 scope、kind、atom_ids、status、blockers 和 completed_at 都由原子节点、依赖边和外部事实计算；它是 API/网页读取结构，不是可独立写回磁盘的定义。

#### 运行时观察：TaskRuntimeObservation

```ts
type TaskRuntimeObservation =
  | { state: "unobserved" }
  | {
      state: "starting" | "running" | "idle" | "waiting" | "disconnected";
      observed_at: string;
      source: string;
    };
```

TaskRuntimeObservation 只描述 Agent 或对话运行观察，不覆盖 TaskProjection 的业务状态，也不属于 TaskDefinition 的 canonical 编排字段。

贡献 Task 必须有 `pr` 字段，但该字段使用 `TaskPrBinding` 联合而不是可空的裸引用。design、planned、starting 和 running 阶段允许 `unbound`；共享交付拓扑使用 `shared_delivery_unit`；多任务集成拓扑使用 `open`、`merged` 或 `closed`。共享绑定解析到同一 DeliveryUnit 的 `DeliveryUnitExternalFacts.pr`，不创建第二个 PR、分支或合并操作。旧的 integrated、closed 等业务标签不属于这组 canonical 阶段。

共享交付拓扑只在同一 DeliveryUnit 恰好存在一个 contribution Task 时合法；documentation 原子归入 contribution Task 后也计入该数量。verification、release 和 deployment Task 不增加 contribution Task 数量，可以继续使用 DeliveryUnitScope 或独立的 evidence 交付。共享绑定的 Task 与 DeliveryUnit 必须使用同一个 conversation、worktree、branch 和 PR，Task 的 PR 发布、检查和合并事实从该 DeliveryUnit 的 provider receipt 派生。新增第二个需要独立代码交付的 contribution Task 时，必须通过显式计划修订切换到多任务集成拓扑，不能在运行中静默创建 child PR。

贡献 Task 切换到 starting 时，校验器必须解析其 `delivery_unit_id` 对应的 DeliveryUnitExternalFacts，并要求 active workspace、`parent_branch` 和成功的 branch receipt；只有显式 `delivery_policy: "parent_pr"` 的任务还需要交付单元处于 `published` 并具有有效 `pr`。普通 starting 命令不把提交 hash 当作启动条件；后续 provider receipt 可以补充 head SHA 或 merge SHA，但这些事实不改变 starting 的输入合同。父 PR publication 必须等待交付单元的 `integrate` 原子完成。

每个 Task 只能归纳出一个 TaskKind。允许混合的活动类型必须映射到同一个 TaskKind，例如 contribution 与 documentation 一起归入 contribution；verification、release 和 deployment 不能混合成一个 Task。TaskKind 归纳函数必须是纯函数并纳入 schema 校验。

### 2.2 DeliveryUnit 定义与投影

#### 磁盘持久化：DeliveryUnitDefinition 与 DeliveryUnitExternalFacts

```ts
type DeliveryUnitDefinition = {
  id: string;
  title: string;
  delivery_unit_kind: "bootstrap" | "regular";
  integration_scope: IntegrationScope;
  execution_policy: DeliveryUnitExecutionPolicy;
};

type DeliveryUnitExternalFacts =
  | { state: "unpublished" }
  | {
      state: "published";
      pr: ExternalRef;
      parent_branch: string;
    }
  | {
      state: "merged";
      pr: ExternalRef;
      parent_branch: string;
      merge_sha: string;
    }
  | {
      state: "closed";
      pr: ExternalRef;
      parent_branch: string;
      closed_at: string;
      closed_reason: "abandoned" | "superseded" | "provider_closed" | "replaced";
    };
```

DeliveryUnitDefinition 不把 Task 作为子对象，也不保存 task_ids、atom_ids 或 milestone_ids。`DeliveryUnitExternalFacts.pr` 是该交付单元的集成 PR；新 canonical 模型不使用 `parent_pr` 字段。`closed` 只表示 provider 已关闭该 PR，不能直接推导为 DeliveryUnit 的 `closed` 业务状态；未重新建立有效 PR 时，交付单元应保持 blocked 或进入显式修订流程。

`closed` external fact 不携带合并结果；`pr_merged` capability 由独立且不可覆盖的 `pr_merged` evidence、`merge_sha` 和对应里程碑计算。Provider 后续关闭 PR 时，不能删除或覆盖这些合并事实；没有合并事实的 `closed` PR 不能满足 `requires: merged`。

parent PR 合并后的 continuation `pr_published` fact 必须携带 `continuation: true`，以便当前 reader 保留原始 canonical parent PR，旧 reader 遇到未知字段时 fail closed；DeliveryUnit closeout 只有在对应 `parent-followup` merge operation 成功后才可继续。

#### 派生读取：DeliveryUnitProjection

```ts
type DeliveryUnitProjection = DeliveryUnitDefinition & {
  derived: {
    task_ids: string[];
    atom_ids: string[];
    milestone_ids: string[];
    status: DeliveryUnitStatus;
    blockers: Blocker[];
    completed_at: string | undefined;
  };
};

type DeliveryUnitStatus =
  | "design"
  | "planned"
  | "ready"
  | "active"
  | "blocked"
  | "merged"
  | "closed";
```

DeliveryUnitProjection 的成员和状态由同一 delivery_unit_id 范围内的原子、里程碑和外部事实计算；它是 API/网页读取结构，不是可独立写回磁盘的定义。

#### 运行时观察：DeliveryUnitRuntimeObservation

```ts
type DeliveryUnitRuntimeObservation =
  | { state: "unobserved" }
  | {
      state: "starting" | "running" | "idle" | "waiting" | "disconnected";
      observed_at: string;
      source: string;
    };
```

DeliveryUnitRuntimeObservation 只描述交付协调会话或 Agent 的运行观察，不覆盖 DeliveryUnitProjection 的业务状态，也不属于 DeliveryUnitDefinition 的 canonical 编排字段。`Group` 仅作为当前实现和历史账本的兼容名称，新 canonical 字段和新 API 使用 DeliveryUnit 与 delivery_unit_id。

### 2.3 执行策略

原子不保存 execution_owner；执行策略由原子 scope 对应的包装对象提供，并用 union 约束可用的执行责任、对话和交付方式。

下面代码块属于磁盘上的 TaskDefinition 与 DeliveryUnitDefinition；它定义执行策略的合法组合，不是运行时观察或网页投影。

```ts
type TaskExecutionPolicy =
  | { kind: "delivery_unit_shared"; conversation: "delivery_unit"; delivery: "shared_delivery_unit_pr" }
  | { kind: "main_owned"; conversation: "current"; delivery: "delivery_unit_pr" | "evidence" }
  | { kind: "task_agent"; conversation: "new"; delivery: "child_pr" | "evidence" }
  | { kind: "evidence_only"; conversation: "none"; delivery: "evidence" };

type DeliveryUnitExecutionPolicy =
  | { kind: "delivery_agent"; conversation: "delivery_unit"; delivery: "delivery_unit_pr" | "evidence" }
  | { kind: "main_owned"; conversation: "current"; delivery: "delivery_unit_pr" | "evidence" }
  | { kind: "evidence_only"; conversation: "none"; delivery: "evidence" };
```

TaskScope 的 work 原子必须能解析到 TaskDefinition.execution_policy；DeliveryUnitScope 的 work 原子必须能解析到 DeliveryUnitDefinition.execution_policy。不存在 `execution_owner: null`、`conversation_policy: null` 或其他非法组合。

## 3. 里程碑评估与状态

里程碑的 canonical 数据是节点定义、入边、验收条件和外部事实引用；`pending | satisfied | blocked` 是由统一评估器生成的运行时投影。调度器、API 和网页必须使用同一评估结果，网页不能自行实现第二套规则。

```text
condition_count = incoming_edge_conditions + explicit_acceptance_conditions

condition_count == 0                         -> invalid plan
condition_count > 0 && any condition failed  -> blocked
condition_count > 0 && all conditions true   -> satisfied
condition_count > 0 && otherwise              -> pending
```

只有所有入边条件和所有显式验收条件都满足时，里程碑才是 satisfied；只有入边条件或只有验收条件的里程碑同样合法。里程碑不会因为“没有条件”而自动满足，也不会隐式把同一交付单元的所有原子视为前置条件。

`blocked` 表示条件已明确失败、目标事实不可满足或计划事实冲突；单纯等待前置 work 或外部事实属于 pending。里程碑没有 running，也不接受执行责任认领。评估结果本身也使用判别联合，不能用可选字段拼出非法组合：

下面代码块是统一评估器的运行时派生结果；它可以作为带 revision 的缓存或事件读取结果存在，但不是 milestone 的 canonical 定义，也不是独立状态写入。

```ts
type MilestoneEvaluation =
  | {
      status: "pending";
      unmet: MilestoneCriterion[];
      evidence_refs: string[];
      plan_revision: string;
      fact_revision: string;
    }
  | {
      status: "satisfied";
      evidence_refs: string[];
      satisfied_at: string;
      plan_revision: string;
      fact_revision: string;
    }
  | {
      status: "blocked";
      blockers: Blocker[];
      evidence_refs: string[];
      plan_revision: string;
      fact_revision: string;
    };
```

若需要性能优化，可以保存带 `plan_revision` 和 `fact_revision` 的评估快照；快照过期或丢失时必须能够从 canonical 定义和事实重新计算。

如果需要审计里程碑曾经达成，应记录 `milestone_satisfied` receipt 或事件及其 fact revision；该事件证明某个事实版本下曾满足，不允许反向把 milestone.status 当作独立权威状态。
