# Unified atomic orchestration

状态：已锁定的长期主题合同。

本文是仓库内多任务编排的 canonical 领域、持久化、状态推导、迁移和网页展示合同。实现、测试和后续设计修订必须以本文为基线；`/tmp` 中的设计草稿不属于项目事实源。

## 1. 核心模型

AtomicNode 与 AtomicEdge 是唯一的编排真相。AtomicNode 统一承载可执行 work 原子和只表达条件的 milestone 原子；Task 与 DeliveryUnit 是从同一张原子图派生出的平级投影。

- work 原子表示需要责任边界、执行策略或外部系统推进的工作，活动类型包括 contribution、documentation、verification、release 和 deployment。
- milestone 原子表示一组显式条件的检查点，没有 Agent 执行、执行 owner 或 running 状态。
- Task 由 task scope 的 work 原子归纳得到，DeliveryUnit 由 delivery_unit_id 范围内的原子和外部事实归纳得到。
- Task 和 DeliveryUnit 不互相拥有，不保存对方的成员副本，也不保存独立的权威编排状态。
- Agent idle、对话连接、PR 查询和观察器断开等信息属于运行时观察层，不覆盖原子图推导出的业务状态。

## 2. 对象关系

```text
AtomicNode + AtomicEdge（唯一的原子依赖图）
├── work.scope.kind = "task"
│   └── TaskProjection 读取 task_id 范围内的成员
├── work.scope.kind = "delivery_unit"
│   └── DeliveryUnitProjection 读取 delivery_unit_id 范围内的成员
└── milestone.scope.kind = "task" | "delivery_unit"
    └── TaskProjection 或 DeliveryUnitProjection 读取里程碑

AtomicNode + AtomicEdge
├── 原样展示 / 筛选 ───────────────> 原子依赖图
├── 按 task_id 折叠 ───────────────> 任务依赖图
└── 按 delivery_unit_id 折叠 ──────> 交付单元依赖图

Task 与 DeliveryUnit 是平级对象；delivery_unit_id 只是共同的分类、整合和验收范围标记，不表示父子、会话从属或管理权转移。
```

网页中的任务图和交付单元图都是原子图的投影，不能反向成为新的依赖来源。聚合边必须保留对应的原子路径，以便从任务或交付单元上的阻塞回溯到具体节点、条件和证据。

## 3. 统一的原因

当前实现把任务内部原子和交付单元生命周期原子分成两套数据和两套更新命令，造成相同概念有两个状态来源、依赖图覆盖范围不一致、交付单元生命周期依赖数组顺序、网页无法追溯实际阻塞原子，以及 merge-claim、group-close 和任务状态检查使用不同集合的问题。

统一后，依赖、完成证据、阻塞原因和状态推导都围绕一张原子图进行，Task 和 DeliveryUnit 只保留身份、执行策略、外部资源事实和可重建投影所需的信息。

## 4. 协调模型与交付单元流程

当前项目中的 `Task.kind = "coordination"` 和 `Group.coordination_execution` 是历史实现概念。新模型不再定义 coordination TaskKind，也不定义 `activity_type = "coordination"`；协调是由依赖边、里程碑条件、外部事实和运行时观察共同表达的编排行为。

文档、需求、设计和 ADR 等文档产物使用 documentation 原子类型；属于实现交付一部分的文档使用 contribution 原子。documentation 原子归入 contribution Task，不新增 documentation TaskKind。集成验收使用 verification 原子，发布使用 release 原子，部署使用 deployment 原子，代码实现使用 contribution 原子。

交付单元的标准生命周期按以下顺序编排，具体顺序由 AtomicEdge 表达：

1. 准备工作区、交付单元集成分支和交付单元集成 PR 基线：记录外部操作及其 evidence，不创建 coordination 原子。
2. 创建并发布交付单元集成 PR：使用 delivery_unit scope 的 milestone，显式要求 provider receipt。
3. 并行执行该 delivery_unit_id 下的 contribution Task 原子；每个 contribution Task 可以绑定自己的 child PR。贡献任务进入 starting 前，交付单元必须已经提供 `pr` 和 `parent_branch`，但这次启动输入不要求提交 hash；交付单元等待状态由依赖投影得到，不创建“等待任务”。
4. 集成子 PR 并完成集成验收：使用 delivery_unit scope 的 verification work 原子，要求当前交付单元集成分支 SHA 的集成和检查证据。
5. 合并交付单元集成 PR：使用 delivery_unit scope 的 milestone，显式要求前置原子完成和合并事实。
6. 按计划执行 release、deployment 和线上 verification 原子；根据责任边界使用 Task scope 或 delivery_unit scope。
7. 收口和资源清理：使用 delivery_unit scope 的 milestone，显式要求必要节点、外部资源和通知条件满足。

交付单元集成 PR 准备、创建、合并和收口本身不是独立的 work 原子；如果这些动作需要编排，就使用具体的外部操作证据和 milestone 条件表达。旧账本中的 coordination task 和 coordination session 只读兼容，不自动猜测业务语义；迁移必须通过显式计划修订，将其转换为 contribution、documentation、verification、release、deployment 或适当的 milestone。

## 5. Canonical 数据结构

### 5.1 原子节点和依赖边

canonical 字段使用 `task_id` 和 `delivery_unit_id`；当前实现中的 `group_id` 只作为兼容读取名称。AtomicNode 不允许 `activity_type: null`、`execution_owner: null` 或通过 null 拼出非法组合。

#### 磁盘持久化：AtomicNode 与 AtomicEdge

下面代码块只定义磁盘上的 canonical 原子节点和依赖边；其中的 work 生命周期、完成结果和证据引用属于原子编排的持久化事实。运行时观察、评估结果和网页读取结构在后文单独定义，不与本代码块混用。

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

这里的 `WorkRuntime` 和 `WorkResult` 指原子执行事件、结果和 evidence 的持久化事实；它们不等同于后文的 `TaskRuntimeObservation` 或 `DeliveryUnitRuntimeObservation`，后两者只描述当前运行观察。

### 5.2 里程碑条件

里程碑条件是显式、结构化、可验证的谓词；条件类型必须与事实来源匹配，不允许用自由文本代替必要的外部事实约束。

#### 磁盘持久化：MilestoneCriterion 与 EdgeRequirement

下面代码块只定义磁盘上的 milestone 条件和依赖边要求；`MilestoneEvaluation` 属于后文的运行时派生结果。

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

## 6. Task 与 DeliveryUnit 数据结构

Task 和 DeliveryUnit 是平级领域对象。canonical 账本只保存它们的身份、执行策略、交付引用和外部资源事实；`atom_ids`、`task_ids` 和 `milestone_ids` 只存在于派生投影或带 revision 的读取缓存中，不能作为可独立修改的持久化字段。

### 6.1 Task 定义与投影

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

TaskDefinition 不保存 TaskKind、成员列表、delivery_unit_id 或独立编排状态。`pr` 是贡献任务自己的 child PR 绑定；它与 DeliveryUnit 的集成 PR 是两个不同的外部资源。

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

贡献 Task 必须有 `pr` 字段，但该字段使用 `TaskPrBinding` 联合而不是可空的裸引用。design、planned、starting 和 running 阶段允许 `unbound`；blocked 阶段允许 `unbound` 或 `closed`，因为阻塞可能发生在 PR 创建之前，也可能由 PR 被关闭引起；从 running 之后进入的任何非 blocked canonical 阶段（当前为 completed）都必须是 `open` 或 `merged`，不能把 `closed` PR 当作正常完成。旧的 integrated、closed 等业务标签不属于这组 canonical 阶段。贡献 Task 的 child PR 与 DeliveryUnit 的 `pr` 是两个不同的外部资源：前者是该 Task 的交付，后者是该 DeliveryUnit 的集成 PR。

贡献 Task 切换到 starting 时，校验器必须解析其 `delivery_unit_id` 对应的 DeliveryUnitExternalFacts，并要求它处于 `published`，同时具有 `pr` 和 `parent_branch`；唯一例外是活跃且已完成 workspace readiness 的 main-owned bootstrap unit，其 main-owned contribution task 可以在集成 PR 创建前启动。regular unit 和 Task Agent 路径始终保留集成 PR 门禁。普通 starting 命令只需要这些交付单元集成 PR 和交付单元集成分支信息，不把提交 hash 当作启动条件；后续 provider receipt 可以补充 head SHA 或 merge SHA，但这些事实不改变 starting 的输入合同。

每个 Task 只能归纳出一个 TaskKind。允许混合的活动类型必须映射到同一个 TaskKind，例如 contribution 与 documentation 一起归入 contribution；verification、release 和 deployment 不能混合成一个 Task。TaskKind 归纳函数必须是纯函数并纳入 schema 校验。

### 6.2 DeliveryUnit 定义与投影

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

### 6.3 执行策略

原子不保存 execution_owner；执行策略由原子 scope 对应的包装对象提供，并用 union 约束可用的执行责任、对话和交付方式。

下面代码块属于磁盘上的 TaskDefinition 与 DeliveryUnitDefinition；它定义执行策略的合法组合，不是运行时观察或网页投影。

```ts
type TaskExecutionPolicy =
  | { kind: "main_owned"; conversation: "current"; delivery: "delivery_unit_pr" | "evidence" }
  | { kind: "task_agent"; conversation: "new"; delivery: "child_pr" | "evidence" }
  | { kind: "evidence_only"; conversation: "none"; delivery: "evidence" };

type DeliveryUnitExecutionPolicy =
  | { kind: "delivery_agent"; conversation: "delivery_unit"; delivery: "delivery_unit_pr" | "evidence" }
  | { kind: "main_owned"; conversation: "current"; delivery: "delivery_unit_pr" | "evidence" }
  | { kind: "evidence_only"; conversation: "none"; delivery: "evidence" };
```

TaskScope 的 work 原子必须能解析到 TaskDefinition.execution_policy；DeliveryUnitScope 的 work 原子必须能解析到 DeliveryUnitDefinition.execution_policy。不存在 `execution_owner: null`、`conversation_policy: null` 或其他非法组合。

## 7. 里程碑评估与状态

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

## 8. 状态推导

### 8.1 Work 原子

原子 state 必须包含 design。design 只允许存在于设计阶段，此时 scope 缺省；从 design 转为 planned 时必须一次性确定唯一 scope，之后不得回到 design。

work 原子保留唯一的执行状态：

```text
planned -> starting -> running -> completed
planned -> blocked
starting -> blocked
running -> blocked
blocked -> starting
blocked -> running
```

ready 不作为独立字段持久化；它是依赖满足、执行策略和资源可用性计算出的瞬时可执行条件。原子完成必须带有与活动类型匹配的 result/evidence：contribution 对应实现和质量结果，documentation 对应文档产物，verification 对应线上验证，release 对应发布证据，deployment 对应目标环境证据。

### 8.2 Task

Task 不保存独立的权威 state。TaskStatus 中可以包含 design、planned、ready、starting、running、blocked 和 completed；这些值都由 task scope 的 work 原子、里程碑和外部事实计算，不再额外保存 `ready` 布尔字段。Agent idle、waiting、disconnected 等 runtime observation 只作为独立叠加信息，不参与业务状态判定。

TaskStatus 按 `design → blocked → completed → running → starting → ready → planned` 的顺序取第一个满足条件的结果，以保证状态互斥；其中 `blocked` 优先于 ready/starting/running，`completed` 只有在不存在阻塞且所有必要条件满足时才成立。

- design：范围内仍存在 design 原子或任务尚未完成 scope 绑定。
- planned：没有 design 原子、阻塞节点、starting/running 节点或可执行成员。
- ready：至少一个成员 work 原子满足依赖并可执行，且没有 starting/running 节点。
- starting：至少一个成员 work 原子处于 starting 且没有 running 节点；对于 contribution Task，只有在所属 DeliveryUnit 已有 `pr` 和 `parent_branch` 后才能进入该状态。
- running：至少一个成员 work 原子处于 running。
- blocked：成员节点存在明确阻塞、拓扑错误、证据错误，或贡献任务的 child PR 已进入 `closed` 且尚未建立替代 PR。
- completed：所有成员 work 原子完成，且该 Task 所需里程碑全部 satisfied。

`integrated` 是旧账本中的业务标签，表示贡献 Task 自己的 child PR 已经合并到 DeliveryUnit 的集成分支；它不表示存在 follow-up PR，也不表示 Task 的全部工作已经完成。follow-up PR 是独立的外部资源，可以在 child PR 集成后继续存在，并由自己的发布/合并事实或里程碑决定是否阻塞 DeliveryUnit 的后续步骤。新模型不把 `integrated` 作为 canonical TaskStatus，而是用 `pr_merged` 外部事实或对应 milestone 的 satisfied 结果表达；网页如需保留旧术语，只能显示为派生标签。

这三个词的边界必须固定：`integrated` 表示“child PR 已进入 DeliveryUnit 集成分支”，是过程标签；`completed` 表示“该 Task 的全部 work 原子完成，且所需 milestone 全部 satisfied”，是成功的 canonical TaskStatus；`closed` 在旧 Task 账本中表示记录被关闭或收口，可能发生在 `integrated` 或 `completed` 之后，也可能用于 abandoned、superseded 等不成功的终止，因此不能当作成功状态。新模型不把旧 Task 的 `closed` 写入 TaskStatus；成功收口使用 DeliveryUnit 的 closeout milestone，管理性关闭使用独立的 disposition/closure 事实。Task 的 `closed` 与 `TaskPrBinding.state = "closed"` 也不是一回事，后者只表示 provider 关闭了 PR。

### 8.3 DeliveryUnit

DeliveryUnitStatus 由同一 delivery_unit_id 范围内的全部成员节点、交付单元级里程碑和外部事实推导；Agent runtime observation 不参与业务状态判定。

DeliveryUnitStatus 按 `design → blocked → closed → merged → active → ready → planned` 的顺序取第一个满足条件的结果，以保证状态互斥；`closed` 和 `merged` 只有对应的交付单元里程碑 satisfied 后才成立。

- design：范围内仍存在 design 原子或交付单元尚未完成计划绑定。
- planned：没有可执行、starting 或 running 的 work 原子。
- ready：至少一个成员 work 原子满足依赖并可执行，且没有 starting/running 原子。
- active：至少一个 work 原子处于 starting 或 running。
- blocked：存在明确阻塞节点、未满足且已失败的必要里程碑、拓扑错误，或 DeliveryUnit 的集成 PR 已进入 `closed` 且尚未建立替代 PR。
- merged：交付单元集成 PR 合并里程碑 satisfied。
- closed：收口里程碑 satisfied 且所有必要节点完成。

交付单元集成 PR、CI、发布和部署事实由外部操作和 provider evidence 记录，只作为原子完成或里程碑满足的输入，不再同步成另一份 DeliveryUnit.lifecycle 状态。

### 8.4 Agent 运行观察

Agent 空闲、对话连接、最新输出和观察器断开等信息属于独立 runtime_observation。页面可以同时显示“任务已完成 · Agent 空闲”或“任务执行中 · 对话断开”，但运行观察不能覆盖原子图推导出的 Task 或 DeliveryUnit 状态。

## 9. 编排流程

```text
创建原子 work 与 milestone 定义
  -> 创建 AtomicEdge 并校验无环
  -> 为 planned 原子绑定唯一 scope
  -> 生成或绑定 TaskDefinition 与 DeliveryUnitDefinition
  -> 校验活动类型、scope、TaskKind 和执行策略
  -> 批准 canonical 原子图
  -> 运行时记录 work 事件、外部事实和 evidence
  -> 统一评估 milestone
  -> 派生 Task 与 DeliveryUnit 状态
  -> 网页展示原子图和两个聚合投影
```

计划阶段允许原子处于 design，此时可以先定义目的、输出、验收条件和候选依赖，但不能调度。进入 planned 后，work 和 milestone 都必须具有明确且唯一的 scope；不存在同时属于多个 Task 或多个 DeliveryUnit 的原子。

## 10. 校验合同

所有规则必须进入单一的 Zod/domain schema 和领域校验器，不能依赖网页或调度器各自补充隐式判断。

- 所有节点和边 ID 唯一，边引用存在节点。
- 原子图必须无环；里程碑条件不能形成无法满足的循环。
- planned work 原子恰好拥有一个 scope；contribution/documentation 只能是 TaskScope，verification/release/deployment 才允许 DeliveryUnitScope。
- 每个 Task 至少包含一个 task scope 的 work 原子；所有成员原子属于同一 DeliveryUnit。
- milestone 可以是 TaskScope 或 DeliveryUnitScope；TaskScope 必须同时携带 task_id 和 delivery_unit_id。
- planned milestone 至少有一个入边条件或显式验收条件；两者都为空时拒绝计划。
- milestone 不得有 execution owner、requirements path、conversation binding 或 running 状态。
- TaskKind 必须与成员 work 原子的归纳结果一致；不同 TaskKind 的活动不能混入同一个 Task。
- contribution Task 必须有 `pr: TaskPrBinding` 字段；running 时可以是 `unbound`，blocked 时也可以是 `unbound`，从 running 之后进入的任何非 blocked 阶段必须是 `open` 或 `merged`。
- TaskPrBinding 必须能够表达 `unbound`、`open`、`merged` 和 `closed`；DeliveryUnitExternalFacts 必须能够表达 `unpublished`、`published`、`merged` 和 `closed`。两者的 `closed` 都必须保留关闭时间和关闭原因，并只能作为外部失败/阻塞事实，不能被当作成功完成。
- contribution Task 切换到 starting 时，所属 DeliveryUnit 的外部事实必须是 `published`，并提供 `pr` 与 `parent_branch`；活跃且已完成 workspace readiness 的 main-owned bootstrap unit 是唯一例外，可以在集成 PR 创建前启动其 main-owned contribution task；starting 输入不要求提交 hash，提交 hash 只能作为后续 provider receipt 或合并事实记录。
- contribution work 原子进入 starting 时必须满足同一 DeliveryUnit 的 `published` PR 前置条件，除非它属于上述 main-owned bootstrap 例外；starting 是原子生命周期的一部分，不能只在 TaskProjection 或 Agent runtime observation 中临时伪造。
- 活动类型、完成条件、result/evidence 和外部目标必须兼容。
- TaskScope 和 DeliveryUnitScope 必须分别解析到对应的 execution_policy；不得出现 null 组合。
- 外部事实必须绑定正确目标、SHA、PR、环境和来源身份。
- 发布、部署和线上验证必须是显式原子，不能从普通 contribution 节点隐式推断。
- 普通实现任务内部可以保留单元测试、静态检查和代码自测，不得因此自动生成 verification Task。
- 孤立节点、悬空任务、无归属里程碑和空条件 planned milestone 拒绝执行。
- 计划修订以 AtomicNode 和 AtomicEdge 为 canonical diff；Task、DeliveryUnit 和网页投影由修订后图重新生成。
- 动态切割只能迁移尚未开始的原子节点；已开始节点保留身份、事件和证据。

## 11. 网页展示

网页提供原子依赖图、任务依赖图和交付单元依赖图，三者使用同一份 AtomicNode + AtomicEdge 数据。

原子依赖图展示所有 work 和 milestone 节点，支持按 DeliveryUnit、Task、activity_type 和 kind 筛选，显示入边条件、显式验收条件、完成证据、评估状态和阻塞原因，并能从节点打开对应 Task 或 DeliveryUnit 详情。

任务依赖图和交付单元依赖图是两个平行投影：

```text
AtomicNode + AtomicEdge
├── 按 task_id 汇总和折叠 ─────────> Task 依赖图
└── 按 delivery_unit_id 汇总和折叠 > DeliveryUnit 依赖图
```

聚合边必须保留“聚合边 -> 原子路径 -> 具体节点 -> 条件 -> 证据/阻塞原因”的回溯入口。等待合并必须能明确指向交付单元集成 PR 合并 milestone，并列出前置 work、PR published、CI passed 等显式条件。

## 12. 历史兼容与迁移

第一阶段新增统一 `atomic_nodes` 和 `atomic_edges` canonical 存储，旧字段只读兼容，禁止新写入继续创建 `Task.atoms` 或 `Group.atoms`。

第二阶段把 `Task.atoms` 映射为 work 节点，把 `Group.atoms` 映射为具体的 verification、release、deployment 或 milestone；旧数组顺序只有在语义明确时才转换为依赖边。无法机械判断语义的旧组级原子必须标记为需要计划修订，不能自动创建新的协调原子。

第三阶段统一使用 atomic-node-update，删除 group-atom-update 的独立语义，删除 Task 和 DeliveryUnit 状态的直接写入路径；外部合并、发布、部署和验证操作只写事实、事件和原子完成证据。

第四阶段保留聚合图为兼容默认视图，新增原子依赖图作为审查入口；旧 viewer 只读兼容旧字段，不再生成新的双份原子数据。旧 `Group` 名称和 `group_id` 字段只保留在兼容层，新 canonical 模型使用 DeliveryUnit 和 delivery_unit_id。

旧账本中的 `parent_pr` 只在确认它表示 DeliveryUnit 的集成 PR 时，读取为 canonical `DeliveryUnitExternalFacts.pr`；旧执行策略值 `parent_pr` 只读映射为 `delivery_unit_pr`。新 canonical 字段和策略不再使用 `parent_pr` 这个名称，也不把交付单元表达成 Task 的父对象。

## Related ADRs

- [Multi-task Flow task execution and delivery boundaries](../../adr/0027-multi-task-flow-task-execution-and-delivery-boundaries.md)
- [First delivery unit is bootstrap by default](../../adr/0031-first-delivery-unit-bootstrap-by-default.md)

## 13. 可行性与风险

可行性高，但这不是局部重命名，会影响 schema、计划校验、初始化和动态切割、运行时事件、merge-claim、group-close、view projection、dashboard 图和历史迁移。

最大风险是把 milestone 误当成可执行任务，或为了兼容旧生命周期字段继续保留第二套权威状态。milestone 必须是条件节点；Task 和 DeliveryUnit 必须是派生投影；外部事实和证据必须是状态评估的输入。

不建议一次性重写历史账本。应先实现新 schema、只读迁移和三种视图验证，再对可机械转换的历史数据执行受控迁移；无法机械判断的历史语义必须等待显式计划修订。

本设计锁定以下边界：AtomicNode + AtomicEdge 是唯一编排真相；Task 与 DeliveryUnit 是平级投影；里程碑以所有入边条件和所有显式验收条件的全量 AND 规则达成；空条件 planned milestone 无效；Task 和 DeliveryUnit 的业务状态由原子、里程碑和外部事实推导；Agent 运行观察单独记录；coordination 不再作为新任务类型或原子活动类型。
