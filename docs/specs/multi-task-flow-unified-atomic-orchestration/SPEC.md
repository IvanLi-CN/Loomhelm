# Unified atomic orchestration

状态：已锁定的长期主题合同。

第 16 节规定保留结果不确定的调用的机械迁移合同，不表示已实现、已发布或已获得正式运行写入授权；当前覆盖状态见 IMPLEMENTATION.md。

本文是仓库内多任务编排的 canonical 领域、持久化、状态推导、迁移和网页展示合同。实现、测试和后续设计修订必须以本文为基线；`/tmp` 中的设计草稿不属于项目事实源。

## Context and Scope

本主题定义 Multi-task Flow 的统一原子编排合同，覆盖 AtomicNode、AtomicEdge、Task、DeliveryUnit、外部事实、状态推导、迁移和网页投影。它约束 `skills/multi-task-flow/` 的持久化、运行时门禁、验证器和 viewer，不替代仓库级工程交付流程或外部 provider 的事实来源。

编排输出、纯查询和调用停止对账属于同一主题的运行时边界；配套设计见 [OUTPUT_AND_INVOCATION.md](OUTPUT_AND_INVOCATION.md)，具体实现覆盖与已知差异见 [IMPLEMENTATION.md](IMPLEMENTATION.md#编排输出与调用停止对账)。

## Requirements

### REQ-ATOMIC-001

AtomicNode 与 AtomicEdge MUST 是唯一的编排依赖事实；Task 与 DeliveryUnit MUST 作为平级派生投影读取同一张原子图，不得保存可独立修改的第二份成员或业务状态。

### REQ-ATOMIC-002

普通 contribution Task 和 Task Agent 路径 MUST 在 starting 前核验交付单元的集成 PR 与分支事实；只有 active、workspace-ready、main-owned 的 bootstrap unit 才能让 main-owned contribution task 在集成 PR 发布前启动，发布进行中、结果未知或已有非空父 PR 事实时 MUST 继续阻塞。

### REQ-ATOMIC-003

planned work、milestone、Task 状态和 DeliveryUnit 状态 MUST 通过统一 schema/domain 校验器及原子、里程碑和外部事实推导；空条件 planned milestone、非法 scope、循环依赖和不匹配的执行边界 MUST 被拒绝。

### REQ-ATOMIC-004

原子图、任务图和交付单元图 MUST 使用同一份 canonical 原子数据，聚合投影 MUST 保留回溯到原子节点、条件、证据和阻塞原因的路径；历史格式只能按兼容合同读取或经可恢复的显式迁移处理。

完整任务依赖图 MUST 只展示一个全局开始和一个全局结束边界，分别来自编排的 `main_start` 与 `main_end`。交付单元的开始与收口边界 MUST NOT 投影为额外的开始或结束节点；穿过这些边界的依赖、条件和来源路径 MUST 保留，单元收口不代表编排结束。

### REQ-VIEWER-ATOMIC-001

原子依赖图 MUST 展示 canonical `AtomicNode` 与 `AtomicEdge` 中所有已持久化的节点和边，即使图存在环、孤儿节点、缺失依赖或顺序冲突；viewer MUST 通过节点、边和详情警告标记异常区域，不得通过过滤异常事实制造一个看似合法的子图。

### REQ-VIEWER-ATOMIC-002

交付单元和任务详情中的原子任务列表 MUST 从同一份原子依赖图推导顺序；无环图使用以稳定节点 ID 作为并列 tie-breaker 的稳定拓扑排序，有环图使用强连通分量的稳定回退顺序，并 MUST 显示无法形成合法线性顺序的诊断。系统 MUST NOT 持久化独立的 `display_order` 作为第二个顺序事实。

### REQ-VIEWER-ATOMIC-003

原子任务状态 MUST 仅由状态图标表达；用户聚焦的节点使用聚焦样式；viewer MUST NOT 因节点是第一项或第一个 `planned` 节点而自动添加“当前待推进项”样式。

### REQ-VIEWER-ATOMIC-004

详情 MUST 使用两栏布局，每栏独立上下堆叠：左栏为任务或交付单元信息及原子任务列表，右栏为当前选中原子任务信息及 Agent 信息和输出。原子任务选择只改变右上原子信息，不得混淆所属任务或交付单元的 Agent 上下文。列表标题 MUST 显示已完成数与总数；原子关系默认折叠，同一行显示摘要与右端展开图标，展开后用紧凑图表展示 canonical 前驱和后继。已完成原子摘要显示后继，其余显示前驱。

### REQ-VIEWER-ATOMIC-005

任务或交付单元标题左侧 MUST 使用单个无边框状态图标概览业务、运行就绪和调度状态，tooltip 保留三个来源状态；原子状态图标显示在原子标题右侧。组合状态只允许按生产者不变量剪枝，未知枚举、缺失字段和不可能组合 MUST 使用未知状态兜底且保留原值。执行归属和对话策略 MUST 合成为一个图标加文本 chip，悬浮或聚焦显示两个原始字段，交付方式使用独立图标加文本 chip；原始状态机、组合边界和异常兜底见 [STATE_MACHINES.md](STATE_MACHINES.md)。

### REQ-VIEWER-ATOMIC-006

Agent 信息 MUST 集中在右栏 Agent 区域：标题显示对话标题或未关联，打开对话与复制对话 ID 使用标题右端图标按钮，执行配置编辑器使用浮层且不得撑开信息行，运行时观察与诊断默认折叠。所有详情字段 MUST 提供明确空状态。PR 绑定事实与详情查询结果 MUST 区分：已有绑定但暂未获取详情时保留 PR identity、链接及刷新能力，不得误显示尚未关联。

### REQ-VIEWER-RECOVERY-001

Gateway MUST 在 Worker 完全不可用时独立提供编排入口的 HTML 故障页，清楚区分页面连接失败与任务失败，提供手动重试、返回列表、复制诊断和可展开技术详情。重试 MUST 尊重实际剩余重启窗口并保留当前完整 URL，不得重新派发任务或重复业务副作用；非页面请求 MUST 保持 JSON 错误合同。

### REQ-SCHEDULE-001

计划在批准前 MUST 通过完整理论排期校验；任一可执行节点缺少可计算的正确定时、存在悬空依赖、循环依赖、未批准计划或其他导致开始/结束偏移不可确定的情况时，批准和 scheduled 状态转换 MUST 被拒绝。

### REQ-SCHEDULE-002

理论排期 MUST 使用纯相对小时坐标，时间原点固定为 `0h`；排期计算、持久化投影、URL 状态、图表轴、节点标签和详情 MUST NOT 展示日期、时间戳或时区语义。分钟可以作为内部计算精度，但用户可见值 MUST 格式化为小时。

### REQ-SCHEDULE-003

理论排期不完整时，viewer MUST 隐藏理论时间轴并显示逐项阻断原因，包括缺少 duration、悬空依赖、循环依赖和未批准状态；不得把未知时间渲染成零点、默认时长或看似有效的时间轴。

### REQ-ATOMIC-005

每个状态 MUST 归属于唯一对象边界：Run phase 归属于 Orchestration，work lifecycle 归属于 AtomicNode，TaskStatus 与 DeliveryUnitStatus 是从原子、里程碑和外部事实派生的读取投影，provider PR state 归属于外部事实，operation status 归属于一次副作用操作，runtime observation 归属于会话或资源；任何对象不得把其他对象的状态复制为第二份权威状态。

### REQ-ATOMIC-006

DeliveryUnit 的 `closed` 业务状态 MUST 保留已经验证的 `pr_merged` 能力，使其可以满足下游 `requires: merged` 依赖；该能力 MUST 由有效的 merge receipt、`merge_sha`、目标 PR identity 和未被后续冲突事实失效的证据共同决定，不能仅由 `group.state` 或 provider PR 的 `closed` 状态决定。

### REQ-ATOMIC-007

恢复 MUST 通过受审计的 reconcile 或 protected recovery 命令记录为追加事件，不得新增 `reconciling` 等临时业务状态或覆盖原始事实；有效 closeout 的 reconcile 保持 `closed`，无效 closeout 转为 `blocked`，范围变化通过显式计划修订和 successor DeliveryUnit 表达，只有受保护恢复才能使同一 DeliveryUnit 从 `blocked` 回到 `active`。

### REQ-ATOMIC-008

当上游 DeliveryUnit 的 merge 能力被新事实否定时，新的下游派发 MUST 被阻塞；已存在的下游 operation MUST 保持其原有 `unknown`、`succeeded` 或 `failed` 事实并单独对账，系统不得自动回滚外部副作用或删除历史证据。

## Verification

### VER-ATOMIC-001

- covers: `REQ-ATOMIC-001`, `REQ-ATOMIC-003`
- Method: AtomicNode/AtomicEdge schema、里程碑评估、scope 校验、状态投影和迁移测试。
- Pass condition: 非法图、空条件 planned milestone、错误 scope 或第二份状态来源被拒绝；合法投影从同一原子事实重建。

### VER-ATOMIC-002

- covers: `REQ-ATOMIC-002`
- Method: engine、atomic-orchestration schema 和 dispatch claim 测试覆盖 bootstrap main-owned、regular、Task Agent、父 PR 发布中、未知和关闭事实。
- Pass condition: 只有明确满足 bootstrap 例外的 main-owned contribution task 可以绕过父 PR；其他路径在缺少已发布且开放的父 PR 时保持阻塞。

### VER-ATOMIC-003

- covers: `REQ-ATOMIC-004`
- Method: viewer projection、原子依赖图、聚合依赖回溯、历史兼容和迁移测试。
- Pass condition: 三种图使用同一 canonical 数据，页面可定位具体原子和证据，历史数据不会被无语义推断地覆盖或清理。

### VER-VIEWER-ATOMIC-001

- covers: `REQ-VIEWER-ATOMIC-001`, `REQ-VIEWER-ATOMIC-002`, `REQ-VIEWER-ATOMIC-003`
- Method: viewer projection、原子图和详情内容测试，覆盖合法 DAG、并列节点、环、孤儿节点、缺失依赖、开始/结束节点、里程碑、选中节点和状态图标。
- Pass condition: 所有 canonical 节点与边始终可见；合法 DAG 的详情顺序与依赖一致；非法图显示完整事实和异常原因；不产生第二顺序字段；列表不再自动高亮第一个 planned 节点。

### VER-VIEWER-ATOMIC-002

- covers: `REQ-VIEWER-ATOMIC-004`, `REQ-VIEWER-ATOMIC-005`, `REQ-VIEWER-ATOMIC-006`
- Method: 详情内容、原子关系、Agent 操作、配置浮层、PR 提示及空状态 UI 测试；组合状态穷举测试与领域校验交叉验证；源码预览人工视觉验收。回归同时覆盖快照刷新后的原子选择保持、Bootstrap 主对话绑定、配置保存及快照替换后的焦点恢复和不支持 Popover API 时的浮层卸载。浏览器服务回归以实际投影的 canonical 原子边为断言依据，并覆盖短中等视口的抽屉打开行为；同时符合桌面宽度与抽屉断点时，抽屉策略优先，鼠标和键盘选择均必须打开可见详情；整合主线（包括 Gateway 升级恢复路径）后重新执行相同断点与交互回归；发布元数据整合不得改变已确认的 viewer 版本预期。
- Pass condition: 两栏上下堆叠，原子选择与 Agent 上下文边界正确；所有 chip 和图标与值匹配并可聚焦查看原始值；异常组合明确兜底；折叠、浮层与空状态不导致布局空白或误报未关联 PR。

### VER-VIEWER-RECOVERY-001

- covers: `REQ-VIEWER-RECOVERY-001`
- Method: Gateway HTTP 故障注入、Worker pool 限流和页面交互测试，以及独立 `ui_demo` 的桌面和移动布局核验。
- Pass condition: Worker 不可用时 HTML 页面无需 Worker 资源即可显示，倒计时结束前不能重试，结束后不自动刷新；手动重试保留 URL，API 保持 JSON，Ledger 内容与业务 revision 不变。

### VER-SCHEDULE-001

- covers: `REQ-SCHEDULE-001`, `REQ-SCHEDULE-003`
- Method: 计划批准、scheduled 转换、排期校验器和 viewer 空状态测试，覆盖缺失 duration、悬空依赖、循环、未批准计划和合法完整计划。
- Pass condition: 所有非法计划在批准前失败并返回逐项原因；viewer 不创建理论时间轴；合法计划才显示完整排期。

### VER-SCHEDULE-002

- covers: `REQ-SCHEDULE-002`
- Method: 排期计算、序列化、URL 状态和 timeline formatter 测试，覆盖零点、并行节点、小数小时和跨内部日期边界的长排期。
- Pass condition: 用户可见坐标始终从 `0h` 开始并以小时显示，输出不包含日期、时区或 ISO 时间戳。

### VER-ATOMIC-004

- covers: `REQ-ATOMIC-005`, `REQ-ATOMIC-006`
- Method: schema/domain 状态归属、DeliveryUnit merge capability、closed bootstrap 上游派发、provider PR closed 与业务 closeout 区分测试。
- Pass condition: 每个状态只有一个权威对象；closed DeliveryUnit 在 merge evidence 有效时可以满足下游 merged 依赖，但自身仍不能继续普通派发；provider closed 且没有 merge evidence 的 PR 不得满足该依赖。

### VER-ATOMIC-005

- covers: `REQ-ATOMIC-007`, `REQ-ATOMIC-008`
- Method: closeout-reconcile、protected recovery、计划修订、下游影响阻塞、unknown operation reconciliation 和历史事件投影测试。
- Pass condition: 恢复只追加审计事件；有效 closeout 保持 closed；无效 closeout 进入 blocked；范围变化创建 successor；上游能力失效不会删除或自动回滚下游副作用。

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

状态机图、对象状态归属和异常恢复规则集中记录在 [STATE_MACHINES.md](./STATE_MACHINES.md)，便于单独审查；数据结构和 schema 定义集中记录在 [DATA_MODEL.md](./DATA_MODEL.md)。角色职责、身份绑定和端到端交互时序集中记录在 [AGENT_INTERACTIONS.md](./AGENT_INTERACTIONS.md)，命令接口集中记录在 [CLI_CONTRACT.md](./CLI_CONTRACT.md)；实现映射、测试覆盖与已知设计偏差见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)。

## 3. 统一的原因

当前实现把任务内部原子和交付单元生命周期原子分成两套数据和两套更新命令，造成相同概念有两个状态来源、依赖图覆盖范围不一致、交付单元生命周期依赖数组顺序、网页无法追溯实际阻塞原子，以及 merge-claim、group-close 和任务状态检查使用不同集合的问题。

统一后，依赖、完成证据、阻塞原因和状态推导都围绕一张原子图进行，Task 和 DeliveryUnit 只保留身份、执行策略、外部资源事实和可重建投影所需的信息。

## 4. 协调模型与交付单元流程

交付单元数量是主 Agent（main Agent）在规划阶段基于需求结果和 contribution Task 归纳出的计划结果，不是主人预先填写的数量，也不是由 PR 数量、Agent 数量或文件边界反推。主 Agent 必须先判断每个 contribution Task 服务的需求结果，再把共同完成同一个可验收需求结果的任务归入同一个 `delivery_unit_id`；能够独立交付和独立验收的需求结果才使用不同的 `delivery_unit_id`。该判断保留在 Agent 上下文和已批准计划中，不新增 `DeliveryUnitProposal` 等中间账本对象。

归纳完成后，每个 contribution 或 documentation work 原子必须使用唯一的 `TaskScope`，其中的 `task_id` 标识任务，`delivery_unit_id` 标识其交付范围。`DeliveryUnitDefinition` 不保存 `task_ids` 副本；DeliveryUnitProjection 从原子 scope、里程碑和外部事实派生成员。计划校验必须拒绝缺少归属、重复归属以及执行策略与归纳结果不一致的计划，不能把“一项任务一个交付单元”作为隐式默认。

同一 `delivery_unit_id` 下 contribution Task 的数量决定执行拓扑：数量为一时，任务复用交付单元对话、工作区、分支和 PR；数量大于一时，每个任务保持独立对话、工作区、分支和 child PR，由交付单元负责集成。verification、release 和 deployment Task 不参与该数量判断。计划批准后若需求边界发生变化，必须通过计划修订重新归纳，不能在运行中静默创建或删除 child PR。

当前项目中的 `Task.kind = "coordination"` 和 `Group.coordination_execution` 是历史实现概念。新模型不再定义 coordination TaskKind，也不定义 `activity_type = "coordination"`；协调是由依赖边、里程碑条件、外部事实和运行时观察共同表达的编排行为。

文档、需求、设计和 ADR 等文档产物使用 documentation 原子类型；属于实现交付一部分的文档使用 contribution 原子。documentation 原子归入 contribution Task，不新增 documentation TaskKind。集成验收使用 verification 原子，发布使用 release 原子，部署使用 deployment 原子，代码实现使用 contribution 原子。

交付单元的标准生命周期按以下顺序编排，具体顺序由 AtomicEdge 表达：

1. 解析交付拓扑并准备工作区、交付单元分支和 PR 基线：记录外部操作及其 evidence，不创建 coordination 原子。只有一个 contribution Task 时选择共享交付拓扑；存在多个 contribution Task 时选择多任务集成拓扑。
2. 创建并发布交付单元 PR：使用 delivery_unit scope 的 milestone，显式要求 provider receipt。共享交付拓扑下，该 PR 同时是唯一 contribution Task 的交付 PR。
3. 执行该 `delivery_unit_id` 下的 contribution Task 原子。共享交付拓扑使用同一个交付单元对话、工作区、分支和 PR；多任务集成拓扑才为各 contribution Task 创建独立 child PR。普通 contribution 任务进入 starting 前，交付单元必须已经提供 `pr` 和 `parent_branch`，但活跃且 workspace readiness 已完成的 main-owned bootstrap unit 可以让其 main-owned contribution task 在集成 PR 创建前启动；regular unit 和 Task Agent 路径仍必须满足父 PR 门禁。启动输入不要求提交 hash；交付单元等待状态由依赖投影得到，不创建“等待任务”。
4. 共享交付拓扑直接完成交付单元级验收；多任务集成拓扑先集成 child PR，再使用 delivery_unit scope 的 verification work 原子核对当前交付单元分支 SHA 和检查证据。
5. 合并交付单元 PR：使用 delivery_unit scope 的 milestone，显式要求前置原子完成和合并事实。
6. 按计划执行 release、deployment 和线上 verification 原子；根据责任边界使用 Task scope 或 delivery_unit scope。
7. 收口和资源清理：使用 delivery_unit scope 的 milestone，显式要求必要节点、外部资源和通知条件满足。

交付单元的准备父分支、创建父 PR、合并父 PR 和收口是交付单元预设 work 原子；它们不得与 Task 原子混用。集成验收不是预设原子；如果计划需要集成检查，应由 Agent 创建实际 work 或 milestone，并声明其 scope 和条件。旧账本中的 coordination task 和 coordination session 只读兼容，不自动猜测业务语义；迁移必须通过显式计划修订，将其转换为 contribution、documentation、verification、release、deployment 或适当的 milestone。

Canonical schema、Task/DeliveryUnit 投影、外部事实和执行策略见 [DATA_MODEL.md](./DATA_MODEL.md)。

状态派生、状态优先级和非正常恢复见 [STATE_MACHINES.md](./STATE_MACHINES.md)。

## 5. 编排流程

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

## 6. 校验合同

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
- contribution Task 切换到 starting 时，所属 DeliveryUnit 的外部事实通常必须是 `published`，并提供 `pr` 与 `parent_branch`；活跃且已完成 workspace readiness 的 main-owned bootstrap unit 是唯一例外，可以在集成 PR 创建前启动其 main-owned contribution task。若父 PR 发布操作仍在进行、结果未知或已有非空的父 PR 事实，则不能使用该例外；engine、atomic validator 和 viewer 必须对父 PR 使用相同的 provider/repository/id/state 证据判定，engine 不得在缺少明确 absent receipt 时放行 bootstrap，且 viewer 的计划级 readiness 必须聚合 DeliveryUnit 的 active、workspace 和父 PR 门禁；starting 输入不要求提交 hash，提交 hash 只能作为后续 provider receipt 或合并事实记录。
- contribution work 原子进入 starting 时必须满足同一 DeliveryUnit 的 `published` PR 前置条件，除非它属于上述 main-owned bootstrap 例外；starting 是原子生命周期的一部分，不能只在 TaskProjection 或 Agent runtime observation 中临时伪造。
- 活动类型、完成条件、result/evidence 和外部目标必须兼容。
- TaskScope 和 DeliveryUnitScope 必须分别解析到对应的 execution_policy；不得出现 null 组合。
- 外部事实必须绑定正确目标、SHA、PR、环境和来源身份。
- 状态必须绑定唯一对象边界；Run、AtomicNode、Task、DeliveryUnit、provider PR、operation 和 runtime resource 的状态不得互相复制为第二份权威状态。
- `requires: merged` 的依赖必须使用统一的 merge capability 判定；DeliveryUnit 为 `merged` 或 `closed` 且具有有效 merge receipt 时满足，provider PR 单独为 `closed` 或 DeliveryUnit 单独为 `closed` 时不满足。
- DeliveryUnit closeout 只能由受审计的 closeout operation 完成；有效 reconcile 保持 `closed`，无效 reconcile 只能进入 `blocked`，同一单元恢复执行必须经过 protected recovery 和完整重新验证。
- 收口后发现的新范围必须通过 plan revision 和 successor DeliveryUnit 表达；不得通过覆盖历史 closeout、复活旧 Task identity 或新增未批准 atom 改写原责任边界。
- 上游 merge capability 失效时，新下游派发必须阻塞，既有下游 operation 必须保留原始结果并单独 reconcile，不得自动回滚外部副作用。
- 发布、部署和线上验证必须是显式原子，不能从普通 contribution 节点隐式推断。
- 普通实现任务内部可以保留单元测试、静态检查和代码自测，不得因此自动生成 verification Task。
- 孤立节点、悬空任务、无归属里程碑和空条件 planned milestone 拒绝执行。
- 计划修订以 AtomicNode 和 AtomicEdge 为 canonical diff；Task、DeliveryUnit 和网页投影由修订后图重新生成。
- 动态切割只能迁移尚未开始的原子节点；已开始节点保留身份、事件和证据。

## 7. 网页展示

网页提供原子依赖图、任务依赖图和交付单元依赖图，三者使用同一份 AtomicNode + AtomicEdge 数据。

原子依赖图展示所有 work 和 milestone 节点，支持按 DeliveryUnit、Task、activity_type 和 kind 筛选，显示入边条件、显式验收条件、完成证据、评估状态和阻塞原因，并能从节点打开对应 Task 或 DeliveryUnit 详情。

任务依赖图和交付单元依赖图是两个平行投影：

```text
AtomicNode + AtomicEdge
├── 按 task_id 汇总和折叠 ─────────> Task 依赖图
└── 按 delivery_unit_id 汇总和折叠 > DeliveryUnit 依赖图
```

聚合边必须保留“聚合边 -> 原子路径 -> 具体节点 -> 条件 -> 证据/阻塞原因”的回溯入口。等待合并必须能明确指向交付单元集成 PR 合并 milestone，并列出前置 work、PR published、CI passed 等显式条件。

页面必须分别展示 Run phase、TaskStatus、DeliveryUnitStatus、provider PR state、operation status 和 runtime observation。页面不得把 operation 的 `unknown`、provider PR 的 `closed` 或 Agent 的 idle/disconnected 显示为 Task 或 DeliveryUnit 的成功完成。

当 DeliveryUnit 为 `closed` 且 merge capability 有效时，页面应同时显示“本单元已收口”和“可满足下游 merged 依赖”；该单元自身的 dispatch readiness 仍应为 blocked。closeout reconcile 的原始事件、核验依据、失效原因、受影响依赖和 protected recovery 记录必须可从 DeliveryUnit 详情回溯。

## 8. 历史兼容与迁移

第一阶段新增统一 `atomic_nodes` 和 `atomic_edges` canonical 存储，旧字段只读兼容，禁止新写入继续创建 `Task.atoms` 或 `Group.atoms`。

第二阶段把 `Task.atoms` 映射为 work 节点，把 `Group.atoms` 映射为具体的 verification、release、deployment 或 milestone；旧数组顺序只有在语义明确时才转换为依赖边。无法机械判断语义的旧组级原子必须标记为需要计划修订，不能自动创建新的协调原子。

第三阶段统一使用 atomic-node-update，删除 group-atom-update 的独立语义，删除 Task 和 DeliveryUnit 状态的直接写入路径；外部合并、发布、部署和验证操作只写事实、事件和原子完成证据。

第四阶段保留聚合图为兼容默认视图，新增原子依赖图作为审查入口；旧 viewer 只读兼容旧字段，不再生成新的双份原子数据。旧 `Group` 名称和 `group_id` 字段只保留在兼容层，新 canonical 模型使用 DeliveryUnit 和 delivery_unit_id。

旧账本中的 `parent_pr` 只在确认它表示 DeliveryUnit 的集成 PR 时，读取为 canonical `DeliveryUnitExternalFacts.pr`；旧执行策略值 `parent_pr` 只读映射为 `delivery_unit_pr`。新 canonical 字段和策略不再使用 `parent_pr` 这个名称，也不把交付单元表达成 Task 的父对象。

新增 closeout reconcile、protected recovery 或 recovery audit event 时，必须声明 contract version、viewer compatibility 和 persistent-state impact。旧 viewer 读取新事件时不得丢失原 closeout、merge receipt 或 blocked reason；无法安全读取时必须进入只读兼容或 fail closed，不得把新恢复事件解释为普通成功状态。

## Related ADRs

- [Multi-task Flow task execution and delivery boundaries](../../adr/0027-multi-task-flow-task-execution-and-delivery-boundaries.md)
- [First delivery unit is bootstrap by default](../../adr/0031-first-delivery-unit-bootstrap-by-default.md)
- [Multi-task Flow creation reconciliation and standalone Codex reconcile](../../adr/0034-multi-task-flow-creation-reconciliation.md)
- [Multi-task Flow CLI contract ownership](../../adr/0036-multi-task-flow-cli-contract-ownership.md)
- [编排版本绑定与前向升级](../../adr/0039-orchestration-version-binding-and-forward-upgrade.md)
- [初始化恢复的权限事务与原生写锁](../../adr/0040-initialization-recovery-permission-transaction.md)
- [机械升级保留结果不确定的调用](../../adr/0041-historical-side-effect-quiescence-audit.md)

## 9. 可行性与风险

可行性高，但这不是局部重命名，会影响 schema、计划校验、初始化和动态切割、运行时事件、merge-claim、group-close、view projection、dashboard 图和历史迁移。

最大风险是把 milestone 误当成可执行任务，或为了兼容旧生命周期字段继续保留第二套权威状态。milestone 必须是条件节点；Task 和 DeliveryUnit 必须是派生投影；外部事实和证据必须是状态评估的输入。

不建议一次性重写历史账本。应先实现新 schema、只读迁移和三种视图验证，再对可机械转换的历史数据执行受控迁移；无法机械判断的历史语义必须等待显式计划修订。

本设计锁定以下边界：AtomicNode + AtomicEdge 是唯一编排真相；Task 与 DeliveryUnit 是平级投影；里程碑以所有入边条件和所有显式验收条件的全量 AND 规则达成；空条件 planned milestone 无效；Task 和 DeliveryUnit 的业务状态由原子、里程碑和外部事实推导；Agent 运行观察单独记录；coordination 不再作为新任务类型或原子活动类型。

## 14. Native creation reconciliation

### REQ-DISPATCH-001

Contract 3 的 Flow dispatch operation 在 `conversation-create` 超时、进程终止、连接中断、已观察 thread 或资源可能已创建时 MUST 保留 `unknown`、native request identity、claim、容量和已知 creation observations，并 MUST 通过显式的 `flow creation-reconcile` 入口恢复；不得自动重复创建、手工写入成功结果或使用普通 `codex reconcile` 替代。

### REQ-DISPATCH-002

创建对账 MUST 从同一 Flow Ledger operation 派生 native request identity，并使用当前 `expected_revision`、唯一 `request_id` 和绑定 main actor 执行原子写入；对账不得创建新的 native request，不得修改已冻结的创建参数。

### REQ-DISPATCH-003

对账只有在 Codex thread 身份、model/thinking、初始化 handshake、独立 worktree owner、initial HEAD 和清洁状态均有匹配外部证据时，才能把 operation 解析为 `succeeded`；证据不足、thread 仍在初始化或任何身份冲突 MUST 保持 `unknown`。

### REQ-DISPATCH-004

仅当外部证据明确证明创建进程未启动、没有资源创建且没有观察到 thread identity 时，operation 才能解析为 `failed` 并释放 claim；查询不到 thread、缺少退出码或普通错误文本不能单独证明失败。

### REQ-DISPATCH-005

创建对账成功后 MUST 复用 dispatch resolution 和 notification idempotency 合同，绑定目标 thread、记录 reconciliation evidence 并最多生成一次 handoff notification；重放相同 request identity MUST 不得重复创建 thread 或发送通知。

派发前置核验 MUST 针对正式 CLI 创建路径、合法 claim 和原生证据对账能力；宿主列出 create/fork 工具本身 MUST NOT 被解释为已绕过或缺少授权隔离的阻塞。Skill 不提供宿主工具撤权或沙箱保证；直接创建仍不受支持，只有经 operation identity 与 native evidence 核验的正式创建结果可以绑定。真实绕过、orphan 和 unknown 继续保留资源及容量并按既有恢复边界停止，不以工具可见性代替调用证据。

### VER-DISPATCH-001

- covers: `REQ-DISPATCH-001`, `REQ-DISPATCH-002`, `REQ-DISPATCH-003`, `REQ-DISPATCH-004`, `REQ-DISPATCH-005`
- Method: runtime command、Codex app-server query、worktree evidence、engine mutation、revision fencing 和 notification tests。
- Pass condition: unknown operation 可由已知 thread 的完整证据安全恢复；证据不足继续 unknown；明确 pre-creation failure 才能 failed；任何重放不会产生第二个 thread、第二个 operation 或第二条 handoff notification。

创建对账是 Flow Ledger 的恢复动作，不是普通 Codex dispatch 的别名。`codex reconcile` 继续服务独立的 Codex dispatch journal；Flow runtime 必须通过 `flow creation-reconcile` 查询并更新正式运行账本。没有已知 thread identity 时，系统不得按标题、cwd、时间或相似度猜测资源；只有额外的、可验证的 native request 查询证据才能解除该限制。

### REQ-INITIALIZATION-RECOVERY-001

`initialization-recover` MUST 仅恢复绑定 main 所拥有的 unknown codex-exec dispatch，保留创建 native request、thread、worktree 和完整执行配置。原始精确角色握手 MUST 为 interrupted 且没有工作 items；允许没有助手回复。failed、active、未知或额外业务 turn MUST 拒绝。

### REQ-INITIALIZATION-RECOVERY-002

恢复 MUST 在原生副作用前持久化唯一、不自动过期的 attempt；恢复 writer MUST 取得原生独占锁后复核完整历史再发送固定握手。超时、崩溃或冲突后的重入 MUST 仅对账已注册 attempt，不新建会话或重发。成功 MUST 复读并绑定 original interrupted turn 与 registered completed recovery turn，保留摘要、配置、owner、HEAD、清洁状态和一次性 handoff 证据。最终历史核验与 dispatch 成功写入 MUST 保持同一原生 writer 锁；已登记 attempt 的对账同样 MUST 在锁内核验且不发送新 turn，释放后才准备 handoff。具体边界遵循 ADR 0040。

### REQ-INITIALIZATION-RECOVERY-003

恢复 MUST 在中性 resume 取得原生写锁后、首次权限 override 前保存完整原权限快照，禁止以全局默认值替代。固定握手使用只读权限；正式 dispatch 成功 MUST 先在同一锁内恢复原权限并通过原生 effective-settings 通知核验，成功 evidence MUST 绑定快照摘要。恢复失败保持 unknown，不准备 handoff；崩溃后重入只恢复和对账，不能重发握手或覆盖与原始及握手权限均不相同的配置。历史 attempt 缺少快照以及无法无损保存的命名 profile MUST fail closed，不能自动推断或迁移；保留历史账本读取能力。`show task-context` MUST 为已绑定 Task 返回上下文及实际 readiness，拒绝未绑定身份且不改写账本。

## 15. 编排版本绑定与前向升级

### REQ-UPGRADE-001

普通 flow 命令（含只读命令）MUST 核验调用 CLI 与编排绑定的包版本、build ID、source SHA 和合同集合；任一不匹配 MUST 拒绝并给出显式升级入口，不得隐式迁移。专用只读兼容检查和 upgrade dry-run MAY 读取历史信息，但 MUST 不产生业务写入或绑定切换。

### REQ-UPGRADE-002

升级 MUST 仅由显式 orchestration upgrade 触发，并由目标版本 CLI 自动完成必要的机械数据迁移及绑定切换；目标身份 MUST 与执行 CLI 的已验证 artifact 一致。升级入口可读取不匹配的源绑定，但 MUST 不把这一例外扩展为普通命令权限。迁移 MUST 不推断业务语义或改写 owner、对话、工作区及外部事实。

### REQ-UPGRADE-003

编排升级 MUST 仅前向推进，CLI MUST 拒绝降级及编排 rollback，不提供反向迁移。备份 MUST 用于独立灾难恢复，不能作为普通降级入口。Gateway 回滚和其他编排的绑定 MUST 不因单个编排升级而改变。

### REQ-UPGRADE-004

升级 MUST 持久化源身份、首次解析并冻结的不可变目标身份和进度；中断后 MUST 仅由显式 upgrade 续跑同一次升级，不重新跟随标签、不自动回滚或切换目标。账本与版本绑定不一致或升级未完成时，普通命令 MUST 拒绝操作，专用诊断 MUST 能报告状态。锁与恢复记录 MUST 防止 CLI/Worker 进入混合版本可写状态，daemon 通知 MUST 不作为升级正确性的必要条件。

### REQ-UPGRADE-005

升级 MUST 排斥该编排的并发持久写事务，沿用现有 lifecycle 排斥，并在原子发布后拒绝旧 CLI/Worker 和旧目录等待者写入。已验证的机械迁移 MAY 保留尚未证明静止的结果不确定的调用，但 MUST 原样保留业务图、unknown、attempt、claim 和容量，且迁移自身 MUST NOT 发起原生变更调用。迁移 MUST NOT 将既有调用可能继续完成或晚回执可能丢失掩饰为静止；不能证明转换保真、来源合同或旧 writer 排斥时 MUST 阻断，不强杀或伪造终态。

### REQ-UPGRADE-006

历史编排缺少可信绑定时，普通命令 MUST 拒绝。只有该编排的可验证历史证据唯一确定源身份时，显式升级入口才 MAY 机械补齐；证据不足 MUST 报告缺失并等待可验证来源，不得按当前 Gateway、全局安装或 latest 猜测。新 CLI MUST 保留支持范围内的历史诊断和前向迁移路径，旧 CLI/Worker MUST 无法写入升级后的编排。

### VER-UPGRADE-001

- covers: `REQ-UPGRADE-001`, `REQ-UPGRADE-002`, `REQ-UPGRADE-003`, `REQ-UPGRADE-004`, `REQ-UPGRADE-005`, `REQ-UPGRADE-006`
- Method: 隔离历史 ledger 与绑定 fixture、已验证 artifact 身份 fixture、CLI/Worker 并发写入、原生副作用调用观察、升级各落盘边界的崩溃注入及重入测试。目录升级安全测试的失败消息保留子进程实际结果，诊断不得放宽既有拒绝断言或更改锁实现。
- Pass condition: 普通命令跨版本或同版本不同 build 均拒绝；专用诊断及 dry-run 不改变业务数据或绑定；目标 CLI 完成迁移和绑定一致切换；中断只续跑冻结目标、不降级；机械迁移不发起原生变更，结果不确定的调用及 unknown/claim/容量不丢失，旧回调不能晚写；缺失绑定有唯一证据才补齐；旧 writer 不能绕过门禁；Gateway 和其他编排不受影响。

## 16. 保留结果不确定的调用的机械迁移

### 范围与术语

本节约束 notification、dispatch 及 recovery、archive/unarchive 在纯表示迁移中的保真与禁止重发。迁移可行、业务结果与原生静止是独立事实；术语以 [项目术语表](../../../GLOSSARY.md#编排升级) 为准。c4 握手恢复、业务继续执行、新建替代 run、Host 会话解析器、全局原生排空协议、新守护进程与通用恢复账本不在范围内。

```mermaid
flowchart LR
    A[只读检查源身份和机械转换] --> B{支持且业务保真?}
    B -->|否| C[列出全部阻塞项]
    B -->|是| D[报告迁移可行及保留的结果不确定的调用]
    D --> E[显式升级取得既有锁并重新评估]
    E --> F[原子发布目标与审计摘要]
    F --> G[拒绝旧 writer 和结果不确定的调用重发]
```

### REQ-MIGRATION-001

系统 MUST 分别表达机械迁移可行、业务结果及原生静止。已登记但未证明静止的调用 MAY 随机械迁移保留；迁移 MUST NOT 将其确认成功、失败或停止，不补造 READY、释放 claim/容量或恢复调度。报告 MUST 明示旧调用可能继续完成、晚回执可能无法写回，相关业务仍为 unknown。

### REQ-MIGRATION-002

系统 MUST 提供 `orchestration upgrade-check --run-id <run-id>`，只读输出 schema_version=1 的源与调用者身份、目录身份、revision/digest、绑定摘要、迁移支持和就绪状态、全部结果不确定的对象及 blocker、已有处理入口。通知 attempt、dispatch native request 与 recovery、归档方向及 operation identity MUST 原样列入摘要；缺失历史身份 MUST NOT 被补造。

### REQ-MIGRATION-003

upgrade-check、dry-run 与正式 upgrade MUST 共用机械迁移评估器；compatibility-check MUST 仅表示兼容性。dry-run MUST 报告 migration_supported、migration_ready 和完整 blocker，失败使用 RUN_MIGRATION_UNSAFE，不能在评估前返回成功。命令 help/schema MUST 同步，MUST NOT 将迁移就绪命名为静止就绪。

### REQ-MIGRATION-004

upgrade-check、compatibility-check 和 dry-run MUST NOT 改变 ledger、binding、upgrade、receipt、目录或原生资源，包括创建 lifecycle/ledger 锁。读取 MUST 使用 no-follow 安全读取、所有权及硬链接检查，校验前后目录身份、revision 和内容摘要；变化时以 observation_stale 阻断，不开启 writer、thread/resume 或原生变更接口。

### REQ-MIGRATION-005

迁移 MUST 保留 notification 的所有 unknown、原 attempt、recipient、prompt digest、请求和事件。迁移及其重入 MUST NOT 调用投递 provider；升级后同 request 重放和新 request MUST NOT 重发 unknown。旧 provider 晚回调 MUST 不能改变目标账本或绑定，其结果不得自动作为成功事实导入。

### REQ-MIGRATION-006

dispatch、native request、observed thread、recovery attempt、既有权限快照及缺失字段 MUST 原样迁移。缺失 recovery_turn_id 或权限快照 MUST NOT 通过猜测、重发恢复、创建替代 thread 或进入私有 writer 补齐；已有初始化恢复与权限事务的拒绝路径 MUST 保留。

### REQ-MIGRATION-007

archive/unarchive 结果不确定的状态 MUST 保留 thread、方向、operation_id 和原 attempt 时间；负向查询 MUST NOT 证明失败或停止，也不能更换原调用身份或重发。身份缺失时 MUST 明确拒绝身份变更；对账不在迁移事务内执行，一个方向的证据不得覆盖相反方向。

### REQ-MIGRATION-008

正式 upgrade MUST 在现有 lifecycle、维护、账本和绑定排斥下重新读取并评估，原子发布目标账本及绑定屏障。并发旧写事务必须在迁移前完成或在发布后拒绝，旧目录等待者 MUST 不能穿透；锁文件存在或某次 stopped MUST NOT 被声明为原生静止。只读报告不得作为提交授权或替代提交时评估。

### REQ-MIGRATION-009

升级 MUST 复用现有 prepared、冻结目标、原子发布、备份与前向续跑；审计 MUST 随 prepared 一同接受，包含源身份/revision/digest、绑定摘要、业务及结果不确定的对象集合摘要、转换规则、验证器与 writer 屏障判定。中断后仅续跑已冻结目标，摘要与恢复源不符 MUST 拒绝；不伪造 runtime/call.json、不新增独立恢复状态机、不自动清理备份或反向迁移。

### REQ-MIGRATION-010

目标 ledger contract MUST 为 5，schema_version 保持 2；读源支持 contract 3/4/5，机械迁移支持 3/4 到 5 及 5 的前向版本切换，更早格式只维持诊断与明确拒绝。业务结构不变时保持 api/frontend/viewer 合同；旧 contract-4 writer MUST 拒绝 contract 5。来源身份、机械转换或 writer 排斥不能被验证时 MUST 阻断，不提供 force 或静止声明绕过。

### REQ-MIGRATION-011

当前问题 MUST 以同一 lims-poc02-04-r10 使用 main 合入后正式发布的精确 artifact 完成安全升级验收；正式写入前重新盘点并另获授权。PR 前经验验收 MUST 使用当前 Candidate、校验完整性的实际旧包及正式数据的受控私有副本，验证全部业务和结果不确定的对象保真、不重发、旧 writer 拒绝与目标 CLI 可读；不得上传原始私有材料。副本或单测不等于正式问题已解决，合并与发布仍需独立确认。

### VER-MIGRATION-001

- covers: `REQ-MIGRATION-001`, `REQ-MIGRATION-002`, `REQ-MIGRATION-003`
- Method: 历史 unknown fixture 及三个公开调用面的输出矩阵。
- Pass condition: 不依赖历史静止回执的受支持机械迁移可就绪，完整列出结果不确定的调用和真实 blocker；兼容与迁移就绪不混同，不声明原生静止。

### VER-MIGRATION-002

- covers: `REQ-MIGRATION-004`
- Method: 只读命令前后全目录摘要、符号/硬链接、所有权与读取竞争注入。
- Pass condition: 文件与原生资源零变更，不创建锁；变化或不安全路径拒绝且不返回 ready。

### VER-MIGRATION-003

- covers: `REQ-MIGRATION-005`
- Method: 真实旧包的等待中通知晚回调、同请求和新请求重放，观察 provider 次数。
- Pass condition: 结果不确定的 attempt 原样迁移，旧回调不晚写，新旧请求不重发，迁移 provider 变更次数为零。

### VER-MIGRATION-004

- covers: `REQ-MIGRATION-006`
- Method: 缺失 recovery turn/权限快照、持久 claim 与未知创建 fixture。
- Pass condition: 缺失字段原样保留，不补造或替换身份，不启动 recovery writer/turn，不重建 thread，权限事务回归通过。

### VER-MIGRATION-005

- covers: `REQ-MIGRATION-007`
- Method: archive/unarchive 双向 unknown、负向查询、缺失身份与旧回调反例。
- Pass condition: 不重发，不轮换 operation_id 或 attempt 时间；缺失身份明确拒绝，旧回调不能写目标。

### VER-MIGRATION-006

- covers: `REQ-MIGRATION-008`
- Method: 原子目录交换与旧 reader/writer/绑定维护 writer、晚回调及旧目录等待者并发。
- Pass condition: 无混合格式可写窗口，提交时重评估，不把停止文件当作迁移或静止凭证。

### VER-MIGRATION-007

- covers: `REQ-MIGRATION-009`
- Method: 各落盘阶段崩溃、冻结目标重入及摘要/备份篡改。
- Pass condition: prepared 原子接受审计，前向续跑幂等，摘要及业务图可核验，不接受目标漂移或伪造恢复材料。

### VER-MIGRATION-008

- covers: `REQ-MIGRATION-010`
- Method: contract 3/4/5 源、目标及旧 writer 的实际消费矩阵。
- Pass condition: 支持声明与 schema 一致，目标读写和旧 writer 拒绝成立；更早格式诊断无写入且升级明确拒绝。

### VER-MIGRATION-009

- covers: `REQ-MIGRATION-002`, `REQ-MIGRATION-003`, `REQ-MIGRATION-010`
- Method: 实际 npm tarball 与临时 consumer 的 help/schema、检查、dry-run、升级和普通 flow。
- Pass condition: 公开入口消费完整打包资源，结果不确定的状态不阻断纯表示迁移也不被清除，源码与包行为一致。

### VER-MIGRATION-010

- covers: `REQ-MIGRATION-011`
- Method: 当前 Candidate 上校验实际旧 artifact、LIMS 私有副本及前后摘要。
- Pass condition: 同一数据形状的全部业务与结果不确定的对象保真，目标 CLI 可读，无新增 provider 变更调用，正式文件字节和其他资源不变；证据卡绑定 Candidate、合同与场景摘要。

### VER-MIGRATION-011

- covers: `REQ-MIGRATION-001`, `REQ-MIGRATION-009`, `REQ-MIGRATION-011`
- Method: Merge Receipt 与正式 artifact 存在后，独立授权执行同一 LIMS run 升级。
- Pass condition: upgrade completed 且目标 CLI 可读，ledger/binding/identity 一致；业务图、owner、thread/worktree、unknown/attempt/claim/容量按批准差异保留，无迁移触发的重复副作用；其他 run、Gateway/daemon 与全局安装不变，才可宣布原始升级问题解决。

## Visual Evidence

多交付单元任务图仅展示一个全局开始和一个全局结束；隔离静态演示已由主人确认。

![任务图的全局起终点](assets/task-graph-global-boundaries.png)

Gateway 故障页编排 ID 的指针与键盘焦点效果；隔离 `ui_demo`，由 owner 确认。

![指针选择文字，无焦点框](assets/gateway-focus-pointer.png)

![键盘导航，组合容器统一焦点](assets/gateway-focus-keyboard.png)

详情面板在当前工作区源码预览中验收；图中归属 chip 将两个原始字段合并展示，悬浮提示保留各自原值，交付方式使用独立图标加文本 chip。

![详情面板与归属 chip](assets/detail-inspector-policy-chips.png)

短视口（1440×900）的详情使用不透明底部抽屉，位于遮罩上方；内部保持两栏及各栏上下堆叠。

![短视口详情抽屉](assets/detail-inspector-short-viewport.png)

## 16. 编排输出与调用停止对账

### REQ-INVOCATION-001

Flow 正常结果 MUST 使用有背压的流式传输，默认不限制累计输出字节，不在父进程累计缓存完整结果；传输缓冲、诊断日志捕获与账本容量 MUST 分别约束，不能沿用通用执行器的小型捕获预算限制正常结果。stdout MUST 保持完整结果合同，不静默截断；下游断开时 MUST 报告交付失败，不能据此认定业务失败或自动重做业务。显式配置的输出预算 MUST 有明确适用范围，不能被静默忽略或改义；触发后 MUST 使用统一停止路径。

### REQ-INVOCATION-002

只读命令明确为 show、view（含 task-context 查询视图），MUST 在旧调用未证实停止时仍可读取一致快照，且报告停止状态，不把可读快照当作调度许可。查询 MUST 核验完整版本、绑定、actor 和目录身份，不创建或改写 invocation 标记，不续租、不归档、不通知、不调用原生 provider、不迁移或进行业务写入；不得因残留 invocation 的生命周期锁无限等待。绑定不一致或升级未完成时 MUST 继续拒绝普通查询；其他命令 MUST 通过副作用门禁，在当前身份旧调用未证实停止时继续阻断；第 16 节机械迁移仅可按冻结源调用摘要保留未知事实并隔离旧 writer，不能伪造静止，不得通过调用方声明 read_only 绕过。

### REQ-INVOCATION-003

每次副作用编排调用 MUST 在执行前登记可验证的调用身份和实际拥有的执行资源；正常返回、异常、超时与取消 MUST 共用停止核验。停止请求及证明 MUST 独立于 stdout/stderr；只有本调用所拥有的子进程、原生 transport 与已登记在途调用均有可验证终结证据时，才能发布 stopped。进程 close、PID 消失、锁释放或业务 operation 结束 MUST NOT 单独充当安全停止证明；证据不足时 MUST 保持 running。CLI 返回后执行的桌面 tool_request MUST 以独立 delivery attempt 和 provider receipt 对账，不能被 CLI 停止证明覆盖。

### REQ-INVOCATION-004

调用 journal MUST 追加保留开始、停止请求、必要资源证据和最终停止事实，作为停止事实的唯一来源；call.json MUST 仅为可重建投影。持久调用状态 MUST 仅有 running 和 stopped，不额外枚举恢复中间状态或业务结果、交付结果与停止状态的组合。停止事实 MUST 先于 stopped 投影持久化；崩溃后两者不一致时 MUST 核验或重建，不得仅凭投影放行。查询、停止核验及发布逻辑 MUST 共用实现，复用现有锁与业务凭证，不增加后台恢复服务或第二套业务账本。

### REQ-INVOCATION-005

系统 MUST 提供专用 invocation inspect/reconcile 边界。inspect MUST 只读报告缺失证据；reconcile MUST 核验绑定 main、request_id、expected_revision、invocation_id、原 marker digest 和证据摘要，在既有锁顺序内重验目录、版本及 canonical input；相同请求幂等，不同输入或并发冲突拒绝。恢复 MUST 保留原始 running 事实、业务图、owner、operation、claim、容量和已有外部事实，不重复消息、会话创建或其他原生业务副作用。旧 marker 缺失身份时，仅可信历史记录能唯一关联调用并证明停止才可补记证据；不能补造，也不能以 owner 批准替代事实。

### REQ-INVOCATION-006

专用恢复入口 MUST 允许经验证的修复版本在限定范围读取历史源并进行停止对账，冻结源与执行者身份，不放宽普通命令的 exact-version 门禁。恢复 MUST 不切换 run binding；停止对账与第 16 节机械迁移是独立入口，机械迁移 MAY 保留未证实停止的旧调用，不把迁移成功视为停止，也不要求先升级才能对账。持久格式、writer 屏障、help、JSON Schema 和精确发布产物 MUST 与合同一致；正式运行恢复、升级与安装发布 MUST 分别取得相应授权。

### VER-INVOCATION-001

- covers: `REQ-INVOCATION-001`
- Method: 精确发布产物的隔离 summary/full/summary 回归、跨越旧 1 MiB 和 64 MiB 边界的合成合法结果、慢消费者、断 pipe、大量 stderr 及显式预算测试。
- Pass condition: 原 5,828,273 字节完整结果交付成功；传输内存不随累计输出线性增长，总进程内存与缓冲分别报告且不隐藏子进程序列化成本；失败不伪装为完整 JSON，也不重做业务。

### VER-INVOCATION-002

- covers: `REQ-INVOCATION-002`
- Method: running 残留、活跃写者、慢消费者、绑定冲突和升级未完成场景的查询测试。
- Pass condition: 合法纯查询返回一致快照和停止状态，不改标记、续租或产生副作用；慢输出不持有维护排斥，残留生命周期锁不阻止读取；版本或升级门禁不被绕过，副作用继续阻断。

### VER-INVOCATION-003

- covers: `REQ-INVOCATION-003`
- Method: 正常结束、异常、取消、超时、父子进程崩溃与原生调用证据缺失的故障注入；分别观察 CLI 内原生调用和 CLI 返回后的桌面投递。
- Pass condition: 共用收尾路径且只覆盖本调用资源；缺失 provider receipt、未完成 intent、错误 thread/turn/attempt 或仅有死 PID 均不放行；控制通道不受输出故障影响。

### VER-INVOCATION-004

- covers: `REQ-INVOCATION-004`
- Method: 停止事实落盘与投影发布前后各崩溃点的重启测试，以及状态、事实源和模块边界审查。
- Pass condition: 不丢原始证据，不出现无审计放行；仅有两种持久状态、一个停止事实源、一套查询和停止核验实现，无新增后台恢复服务或不必要的锁。

### VER-INVOCATION-005

- covers: `REQ-INVOCATION-005`
- Method: inspect 零写入、reconcile 身份与 revision/digest 冲突、相同请求重放、并发及历史 marker 缺字段测试。
- Pass condition: 相同恢复请求幂等，冲突拒绝；业务图、claim、容量和既有凭证保留，不重发原生副作用；缺少唯一历史关联或停止事实时保持阻断。

### VER-INVOCATION-006

- covers: `REQ-INVOCATION-006`
- Method: 隔离历史源停止对账、独立机械迁移与迁移后新调用停止门禁的完整链路、格式兼容及旧 writer 拒绝路径、help/schema 与精确发布产物对照。
- Pass condition: 无升级与恢复互锁，恢复前后绑定不变；普通版本门禁不放宽，未知格式拒绝；未取得相应授权时不操作正式运行或全局安装。
