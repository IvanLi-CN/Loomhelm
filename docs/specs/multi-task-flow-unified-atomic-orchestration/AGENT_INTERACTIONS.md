# Multi-task Flow Agent 角色与交互设计

本文描述主 Agent（main Agent）、交付 Agent（Delivery Agent）和任务 Agent（Task Agent）的职责、身份边界，以及它们与 CLI、Codex、外部平台和账本之间的交互时序。本文是统一原子编排主题的交互设计配套文档，不新增角色、状态或命令；长期需求与验收见 [SPEC.md](./SPEC.md)，对象关系见 [DATA_MODEL.md](./DATA_MODEL.md)，状态与恢复规则见 [STATE_MACHINES.md](./STATE_MACHINES.md)，命令接口见 [CLI_CONTRACT.md](./CLI_CONTRACT.md)。实现映射、mock 测试覆盖和已知设计偏差统一记录于 [IMPLEMENTATION.md](./IMPLEMENTATION.md#agent-角色交互的实现与验证)。

## 角色边界

| 角色 | CLI actor | 身份绑定 | 主要责任 | 写入边界 |
| - | - | - | - | - |
| 主 Agent（main Agent） | `role: "main"` | `control.owner_thread_id` | 归纳计划、批准运行、维护全局依赖图、选择交付拓扑、派发和对账、处理跨单元异常、最终收口 | 全局计划、交付单元调度、通知意图/发送 attempt/receipt 对账和受保护操作；不能伪造其他 Agent 的任务事实 |
| 交付 Agent（Delivery Agent） | `role: "group"` | `groups[].agent_thread_id` | 管理一个 regular DeliveryUnit 的父分支、集成 PR、集成验收、发布/部署/验证义务和 closeout | 仅所属 DeliveryUnit 生命周期、交付单元原子、父 PR/合并事实和自身协调状态 |
| 任务 Agent（Task Agent） | `role: "task"` | `tasks[].thread_id` | 读取自身任务上下文，推进原子、工作区、任务分支、child PR、rebase、合并和 closeout | 仅自身 Task、原子、任务 PR 和证据；不能创建或派发其他任务，不能修改依赖图或交付单元所有权 |

Bootstrap DeliveryUnit 是唯一由主 Agent 持有的交付单元：其 `owner_kind` 为 `main`，不绑定独立交付对话。regular DeliveryUnit 必须先绑定交付 Agent；恰有一个 contribution Task 时使用 shared-delivery 拓扑，多个 contribution Task 时使用 multi-task integration 拓扑。verification、release 和 deployment Task 不参与 contribution 数量判断。

## CLI 与 Codex 对话边界

正式调用使用固定版本的 `bunx --bun @loomhelm/multi-task-flow@<exact-version> flow <command> --input -`。每次写操作都携带 `run_id`、`actor`、唯一 `request_id` 和 `expected_revision`；revision 冲突必须先读取账本，不能盲目重试。`show`/`view` 是只读入口，`show` 的 `task-context` 只向绑定的任务 Agent 投影自身任务、依赖、原子、验收、工作区和阻塞事实。

对话创建只有一条路径：先由主 Agent 使用 `dispatch-group-claim` 或 `dispatch-claim` 领取账本 operation，再调用 `conversation-create`。该命令通过 `codex exec --worktree --json` 创建独立工作区，核对真实 thread、初始化 turn、model/thinking、工作区归属、初始 HEAD 和清洁状态；完成后才绑定对话。超时、断线、证据不完整或已观察到 thread 时保持 `unknown`，只能进入 `creation-reconcile`，不能再次创建。

初始化 prompt 只建立角色待命状态。正式 handoff 通过账本 notification 产生；主 Agent 领取唯一发送 attempt，使用允许的原生消息工具投递，再以 provider receipt 对账。`sent` 只表示平台接受，`acknowledged` 必须由收件 Agent 产生；通知确认不等于派发批准。

## 完整工作流

### Proposal、init 与批准

主 Agent 在 proposal 阶段先建立 canonical AtomicNode/AtomicEdge、TaskScope、DeliveryUnitScope、原子前驱和验收条件。`init` 只接受尚未绑定且处于 `planned` 的交付单元和任务，不创建对话。计划批准后，`execution_plan_id` 才支配调度；dispatch claim、starting 和对话创建都不能单独把运行推进到 `implementation`，真正的阶段转换来自首个 `task_started` 事实。

### 交付单元准备与派发

主 Agent 按需求结果归纳 `delivery_unit_id`，不能从 PR 数量、Agent 数量或文件重叠推断边界。交付 Agent 负责 regular 单元的父分支、父 PR、集成基线和 closeout；Task Agent 路径在 starting 前通常必须等待已发布且可核验的父 PR。唯一例外是 active、workspace-ready、main-owned 的 bootstrap 单元允许其 main-owned contribution Task 在父 PR definitively absent 时启动；发布中、结果 unknown 或已有非空父 PR 时仍阻塞。

### Shared-delivery 拓扑

一个 DeliveryUnit 恰有一个 contribution Task 时，交付单元对话、工作区、分支和 PR 同时服务 DeliveryUnit 与 Task。交付 Agent 负责交付单元边界，任务事实仍通过 TaskScope 和原子图表达；不会额外创建 child PR。任务完成、父 PR 合并和 DeliveryUnit closeout 仍是不同的事实和门禁。

### Multi-task integration 拓扑

一个 DeliveryUnit 有多个 contribution Task 时，交付 Agent 拥有父分支和集成 PR，每个 Task Agent 拥有独立对话、工作区、分支和 child PR。Task Agent 先通过 `task-context` 读取自身边界，再按原子顺序推进 `prepare-branch → create-pr → merge-pr → closeout`。child PR 合并事实可以使后继任务 ready，但不等于当前任务已经完成；当前 Task 仍须完成 closeout。交付 Agent 在所有 child PR 和集成验收满足后推进父 PR 合并及单元级 post-merge 工作。

### 状态、通知与恢复

AtomicNode/AtomicEdge 是唯一编排事实。Task 和 DeliveryUnit 状态是从原子、里程碑、外部 PR/CI/release/deployment/verification facts 推导的读取投影；Agent idle、连接状态、最新输出和观察器断开属于 runtime observation，不能覆盖业务状态。

任务首次进入 `ready` 时账本生成可派发 notification；主 Agent 确认通知意图、发送 attempt 和 provider receipt，并重新评估依赖后才能调用 `dispatch-claim`；收件方（包括作为 owner 的 main Agent）通过自身绑定的对话产生 `notification-ack`。`waiting`、`blocked` 和 DeliveryUnit coordination state 表达依赖与门禁，不创建新的 coordination Task。创建、通知、发布、合并和部署出现 unknown 时保留 operation、claim、容量和原生身份，先 reconcile；不能用错误消息推断副作用未发生。

### Release、deployment、verification 与 closeout

release、deployment 和 verification 是显式原子，不能从 contribution Task 隐式推断。DeliveryUnit 合并能力必须由有效 merge receipt、`merge_sha`、PR identity 和未失效事实共同证明；provider PR 的 `closed` 或 DeliveryUnit 的 `closed` 单独不能满足 `requires: merged`。closeout reconciliation 只追加审计事件：证据仍有效则保持 `closed`，证据否定则转为 `blocked`，证据不足则保持原业务状态并阻塞后续门禁。

## 工作流时序图

以下时序图按 canonical 合同描述应有的交互顺序；CLI 是命令入口，Runtime / Ledger 是授权、原子图、operation、事实和事件的持久边界，Codex 与 Git/CI/发布平台是外部证据来源。Agent 之间的消息只交接身份、读取入口或异常，不能替代账本提交。箭头上标出的命令名是实际命令；“核验”“执行”“读取”等文字是 Agent 或 provider 的动作，不代表新增 CLI 命令。

图中的 `Task completed` 是 canonical 投影；旧 `Task.state = closed` 是兼容账本收口事实，两者不能混用。时序图描述设计要求，实际实现与验证覆盖见 [IMPLEMENTATION.md](./IMPLEMENTATION.md#agent-角色交互的实现与验证)。图中的“单元负责人”在 bootstrap 中是 main Agent，在 regular 中是绑定的 Delivery Agent。

| 图 | 工作流 | 关键责任与门禁 |
| - | - | - |
| S1 | proposal、init、批准 | 主 Agent 建模，主人批准，execution plan 才约束调度 |
| S2 | regular Delivery Agent 创建与父 PR 准备 | 主 Agent 创建，Delivery Agent 确认 handoff 并准备集成边界 |
| S3 | bootstrap main-owned 完成流 | 不创建 Delivery Agent，只有明确 bootstrap 例外可无父 PR 开工 |
| S4 | regular shared-delivery 完成流 | 一个 contribution 复用 Delivery 对话、工作区、分支和唯一 PR |
| S5 | multi-task integration 完成流 | Task Agent 独立交付 child PR，Delivery Agent 集成父 PR |
| S6 | native creation unknown 与 reconcile | 保留 claim 和身份，只对账同一次创建 |
| S7 | 通知发送、确认、重放与失败 | provider 接受与收件 Agent 确认分离 |
| S8 | 开工基线、原子执行与父分支推进 | 资源由主 Agent 注册，实际 owner 同步证据后执行 |
| S9 | 父 PR 合并、release、deployment、verification | 外部动作受批准及当前 SHA 证据约束 |
| S10 | Task、DeliveryUnit 与 Run 收口 | 合并、任务完成、单元关闭、运行完成分开记录 |
| S11 | closeout 对账与受保护恢复 | unknown 冻结后续门禁，invalid 才进入 blocked 恢复 |
| S12 | plan revision、task migration 与 cut | 保留旧事实，高影响修订批准前 hold 受影响范围 |
| S13 | actor、revision、request 幂等拒绝 | 校验失败不执行外部副作用，不推进业务状态 |

### S1：Proposal、init 与批准

```mermaid
sequenceDiagram
    autonumber
    actor O as 主人
    participant M as 主 Agent
    participant C as CLI
    participant L as Runtime / Ledger
    M->>M: 建模 AtomicNode/Edge、scope、验收、交付拓扑与 actions
    M->>C: init（未绑定、planned 的初始计划与对象）
    C->>L: 校验并建立 run 与 owner_thread_id
    L-->>M: run_id、revision、候选计划
    Note over M,L: init 不创建 Codex 对话；初始对象不预填 thread
    M-->>O: 提交计划、依赖与操作边界供批准
    O-->>M: 批准具体计划与动作
    M->>C: plan-approve（plan_id、approval_id、actions）
    C->>L: 验证计划与批准，设置 execution_plan_id
    L-->>M: 新 revision 与批准事件
    Note over M,L: claim、starting、创建对话均不代表 implementation 已开始
    Note over C,L: 后续实际执行者经 CLI 提交开工进展，写入 task_started 事实
    L->>L: 据执行事实投影 implementation 阶段
```

`plan-propose` 用于提交新的 canonical candidate，提案后内容不可原地改写；已有运行的修订见 S12。主人批准由主 Agent 通过 CLI 记账，不要求主人亲自调用 CLI。

### S2：Regular Delivery Agent 创建与父 PR 准备

```mermaid
sequenceDiagram
    autonumber
    participant M as 主 Agent
    participant C as CLI
    participant L as Runtime / Ledger
    participant X as Codex
    participant D as Delivery Agent
    participant P as Git provider
    M->>C: dispatch-group-claim（group_id）
    C->>L: 校验批准、依赖、未绑定身份与未解决 operation
    L-->>M: operation_id（claimed）
    M->>C: conversation-create（operation_id、title、formal prompt）
    C->>X: codex exec --worktree --json（固定初始化 prompt）
    X-->>C: thread、初始化 turn、profile、worktree、initial HEAD
    C->>C: 核验归属、清洁状态、初始化完成、进程退出
    C->>L: 内部 bind/resolve，绑定 group thread
    L-->>C: dispatch succeeded、handoff notification 与唯一 attempt
    C-->>M: handoff.should_send、tool_request
    M->>X: 按 tool_request 投递正式 handoff
    X-->>D: 正式任务与账本读取入口
    X-->>M: provider receipt
    M->>C: notification-reconcile（同一 attempt）
    C->>L: 记录 sent
    D->>C: notification-ack（绑定 group actor）
    C->>L: 记录 acknowledged
    D->>P: fetch 已核验主干，准备干净父分支
    D-->>M: 提交真实 workspace / branch 资源证据
    M->>C: resource-update
    C->>L: 注册 active 资源及其 owner
    D->>C: development-baseline-sync；lifecycle-record workspace_ready
    C->>L: 核验 dispatch、资源、owner、SHA 与 lineage
    D->>C: publish-branch-claim / publish-pr-claim
    C->>L: 校验计划动作并领取 publication operation
    D->>P: 发布父分支与集成 PR，查询实际结果
    P-->>D: branch / PR identity 与 provider evidence
    D->>C: publish-branch-resolve / publish-pr-resolve
    C->>L: 记录父分支、父 PR 与发布事实
    Note over D,L: 按依赖推进对应 group 原子；普通 contribution 开工前父 PR 必须可核验
```

图中 publication 分别执行各自 claim、外部动作和 resolve，不能把两次外部副作用合成一个未对账操作。创建中断转 S6；正式通知的失败、重放和先后关系见 S7。

### S3：Bootstrap main-owned 完成流

```mermaid
sequenceDiagram
    autonumber
    participant M as 主 Agent兼单元负责人
    participant C as CLI
    participant L as Runtime / Ledger
    participant P as Git / CI provider
    M->>C: init / 批准 main-owned bootstrap 与其任务
    C->>L: 校验 bootstrap owner 与任务执行策略
    Note over M,L: 不 dispatch-group、不创建 Delivery 对话、不伪造 group actor
    M->>P: 核验实际 workspace、主干与工作分支
    P-->>M: 干净工作区、HEAD、归属与基线证据
    M->>C: resource-update；记录 workspace readiness
    C->>L: bootstrap active、workspace ready
    M->>C: 以 main actor 推进 main-owned contribution
    C->>L: 检查父 PR 是否 definitively absent
    alt 父 PR 明确不存在且满足 bootstrap 例外
        L-->>M: 允许开工
        M->>C: task-update / atom-update（本任务原子及证据）
        C->>L: 写入开工与原子完成事实
    else 父 PR 发布中、unknown 或已存在
        L-->>M: 不适用无父 PR 例外；按普通父 PR 门禁处理
    end
    M->>C: 领取计划内父分支 / 父 PR publication operation
    M->>P: 发布并查询真实父 PR
    P-->>M: publication receipt
    M->>C: resolve publication；记录验收证据
    Note over M,P: 后续父 PR 合并、post-merge 与 closeout 复用 S9、S10
```

此图只展示明确批准的 main-owned bootstrap 路径，不把 regular 单元或任意任务转换为 main-owned。`group-update` 不能用来绕过 ownership、workspace 或恢复边界。该例外不是“所有 bootstrap 任务都可以忽略父 PR”。

### S4：Regular shared-delivery 完成流

```mermaid
sequenceDiagram
    autonumber
    participant M as 主 Agent
    participant D as Delivery Agent兼贡献执行者
    participant C as CLI
    participant L as Runtime / Ledger
    participant P as Git / CI provider
    Note over M,L: 按 S2 绑定 Delivery 对话并完成正式 handoff
    D->>C: 读取唯一 contribution 的 scope、原子与验收
    C->>L: 解析 shared_delivery 拓扑与绑定身份
    L-->>D: 同一 Delivery 对话、workspace、branch、PR
    Note over D,L: 不创建额外 Task 对话，不创建 child PR；不伪造 task actor
    D->>C: 以绑定 group actor 写入所属 Task 的进展与原子证据
    C->>L: 校验 TaskScope 与原子前驱
    D->>P: 在共享工作区实现、自测并刷新唯一 PR
    P-->>D: 当前 head SHA、CI / review evidence
    D->>C: 记录任务质量与单元验收事实
    C->>L: 重新计算必要原子和里程碑
    D-->>M: 通知唯一父 PR 已满足合并条件
    Note over M,P: 按 S9 批准并合并；唯一 PR 只记录一份 merge receipt
    D->>C: 完成 Task closeout 与 DeliveryUnit closeout
    C->>L: 分别写入任务收口、单元收口事实
    L-->>M: 任务 / 交付单元投影与通知
```

同一物理对话承担两层责任，不等于两种 scope 可以混写：Task 原子和 DeliveryUnit 预设原子仍分别有自己的 ID、依赖和结果。release、deployment、verification Task 是否另有执行者由已批准计划决定，不因 contribution 数量为一而被省略。

### S5：Multi-task integration 完成流

```mermaid
sequenceDiagram
    autonumber
    participant M as 主 Agent
    participant D as Delivery Agent
    participant C as CLI / Runtime
    participant A as Task Agent A
    participant B as Task Agent B
    participant P as Git / CI provider
    Note over M,D: S2 完成父分支、父 PR 与 Delivery handoff 门禁
    M->>C: dispatch-claim（Task A）
    C-->>M: claimed operation
    M->>C: conversation-create
    C-->>M: 核验 Codex 证据后绑定 A，返回 handoff
    M->>A: 通过 S7 正式投递、对账并由 A 确认
    A->>C: show task-context；读取 Task A 原子、依赖、验收
    A-->>M: 提供独立 workspace / branch 资源证据
    M->>C: resource-update
    A->>C: development-baseline-sync；lifecycle-record
    A->>C: task-update；atom-update（按前驱推进）
    A->>C: 领取计划内 child branch / child PR publication
    A->>P: 发布 child PR，目标为 Delivery 父分支
    P-->>A: 实际 publication、检查与 review 证据
    A->>C: resolve publication；记录质量证明；merge-claim
    A->>P: 合并自身 child PR 并查询结果
    P-->>A: 匹配 PR、head/base、merge SHA 的 merge receipt
    A->>C: merge-resolve
    C->>C: 记录 pr_merged；重新评估两张依赖图
    C-->>M: 后继任务首次 ready 的通知（通过 S7）
    Note over A,M: A 的 child PR 已集成不表示 A 已 completed；A 继续 closeout
    M->>C: 确认通知后重读上下文、核验容量和依赖，dispatch-claim B
    M->>C: conversation-create B；正式 handoff
    M->>B: 通过 S7 交接绑定身份与上下文入口
    B->>C: 读取新父分支基线，独立推进自身原子
    B->>P: 发布、验证并合并自身 child PR
    P-->>B: provider merge receipt
    B->>C: merge-resolve；继续自身 closeout
    D->>C: 读取全部 child PR、任务与集成验收事实
    D->>P: 核验集成分支当前 SHA 的检查证据
    D->>C: 完成交付单元 scope 的集成验收
    Note over D,P: 父 PR 合并与 post-merge 继续 S9；最终收口继续 S10
```

A → B 只表示计划明确声明的依赖；无依赖任务可在容量允许时并行。消息、任务列表顺序和文件重叠都不产生依赖边。child PR 合并由实现批准覆盖，父 PR 合并另需单元级 protected approval。

### S6：Native creation unknown 与 reconcile

```mermaid
sequenceDiagram
    autonumber
    participant M as 主 Agent
    participant C as CLI
    participant L as Runtime / Ledger
    participant X as Codex exec / app-server
    M->>C: conversation-create（已 claim 的 operation）
    C->>L: 冻结 native request、profile、cwd、title、prompt
    C->>X: 启动一次 codex exec 初始化
    X-->>C: 已观察 thread / worktree / initial HEAD
    X--xC: 超时、断线或证据冲突
    C->>L: operation unknown；单调保留已观察身份、claim 与容量
    C-->>M: UNKNOWN；要求 creation-reconcile
    M->>C: creation-reconcile（同一 operation，当前 revision）
    C->>L: 读取冻结请求及已知 thread
    C->>X: thread/read、初始化 turn 与 workspace 证据查询
    alt thread、初始化、profile、归属与工作区证据完整一致
        X-->>C: 可核验的 reconciliation evidence
        C->>L: 同一 operation succeeded；绑定 thread；生成 handoff
        C-->>M: 交给 S7 投递正式任务
    else 仍在初始化、查不到 thread 或证据不足
        X-->>C: 不足以证明成功或无副作用
        C->>L: 保持 unknown 与 claim，不清空已知资源
    else 明确证明创建前未启动进程且未创建资源、未观察 thread
        X-->>C: pre-creation failure evidence
        C->>L: failed；释放 claim；保留审计
    end
    Note over M,X: unknown 不再次创建；codex reconcile 不操作 Flow Ledger，不能替代 creation-reconcile
```

### S7：通知发送、确认、重放与失败

```mermaid
sequenceDiagram
    autonumber
    participant A as 事件产生 Agent
    participant M as 主 Agent / 投递协调者
    participant C as CLI / Ledger
    participant X as 原生消息平台
    participant R as 收件 Agent
    A->>C: 提交进展、合并或完成事实（notification intent）
    C->>C: 提交事件、按 ready 代次去重 / 合并通知
    C-->>M: pending notification
    M->>C: notification-prepare（或记账结果已领取 attempt）
    C-->>M: 唯一 attempt、should_send、tool_request
    alt should_send 为 true
        M->>X: 按返回的收件 thread 与 prompt 投递一次
        X-->>R: 正式消息
        alt 平台明确接受
            X-->>M: 匹配 attempt 的 provider receipt
            M->>C: notification-reconcile outcome sent
            C->>C: 记录 sent，不推断已读或开工
            R->>C: notification-ack（自身绑定 actor）
            C->>C: 校验 recipient 与 sent，记录 acknowledged
        else 平台结果不确定
            M->>C: notification-reconcile outcome unknown
            C->>C: 保留 attempt，禁止再次发送，继续对账
        else provider 明确证明未投递
            M->>C: notification-reconcile outcome failed
            C->>C: 保留失败记录，才允许领取新 attempt
        end
    else 重放、并发或未解决 attempt
        C-->>M: should_send false 或在途门禁错误
        Note over M,X: 不重复发送、不改写状态解锁
    end
    Note over R,C: 收到消息早于 sent 落账时，先等对账；NOTIFICATION_NOT_SENT 不可绕过
    opt 收件者为主 Agent，通知包含新 ready 任务
        M->>C: notification-ack；重读账本并重新检查派发门禁
        M->>C: dispatch-claim（选定任务）
    end
```

收件者既可能是 Delivery/Task Agent（formal handoff），也可能是 main Agent（进展、后继 ready、完成或升级）。main 只有在自身就是 recipient 时才能 ack。事件产生者负责提交账本事实和通知意图，投递协调者使用返回的 `tool_request` 完成发送及 provider 对账，收件者确认处理。持久交接边界是 intent → attempt → provider receipt → recipient ack，发送本身不改变业务状态，也不授予 Task Agent 任意跨线程发送权限。

### S8：开发基线、原子执行与父分支推进

```mermaid
sequenceDiagram
    autonumber
    participant M as 主 Agent
    participant A as 已绑定执行 Agent
    participant C as CLI / Ledger
    participant P as Git / CI provider
    A->>C: show（所属 scope / task-context）
    C-->>A: 原子前驱、当前 lineage、资源与验收
    A->>P: Delivery fetch 主干；Task 核验父分支 current SHA
    P-->>A: 实际 HEAD、clean、branch、owner 证据
    A-->>M: 提交资源证据
    M->>C: resource-update（worktree / branch）
    A->>C: development-baseline-sync mode initial
    C->>C: 核验 dispatch、native evidence、资源与 lineage
    A->>C: lifecycle-record workspace_ready
    loop 每个满足前驱条件的原子
        A->>C: atom-update 或 group-atom-update，进入执行
        A->>A: 执行该原子工作，收集对应 result / evidence
        A->>C: 原子 completed 与证据
        C->>C: 更新事实，重新计算 Task / DeliveryUnit 投影及 ready 通知
    end
    opt 父分支因合并、update-branch 或 cut 推进
        A->>C: 读取已记录 lineage event 与新 SHA
        A->>P: 执行所属工作区 rebase / 对齐与重新验证
        P-->>A: 新 HEAD、clean、检查证据
        A->>C: development-baseline-sync mode refresh（previous receipt、lineage event）
        A->>C: 重新 lifecycle-record
    end
    Note over A,C: baseline-sync 只记证据，不执行 fetch/reset/rebase；initial_head 不是 development baseline
```

运行观察不参与以上状态推导：Agent idle、断线或最后输出不能把 Task 标成完成，也不能撤销已记录的 merge receipt。普通阻塞由负责 Agent 记账并留在原任务内处理；确认外部问题需改变任务或依赖时，提交证据给 main，按 S12 修订。

### S9：父 PR 合并、release、deployment 与 verification

```mermaid
sequenceDiagram
    autonumber
    actor O as 主人
    participant M as 主 Agent
    participant D as 单元负责人
    participant A as 计划指定的后置工作执行者
    participant C as CLI / Ledger
    participant P as Git / CI / 发布部署平台
    D->>P: 核验父 PR identity、target、head/base、当前检查与审查
    P-->>D: 匹配当前候选的证据
    D-->>M: 提交最终目标、证据和受保护合并请求
    M-->>O: 请求单元级合并批准
    O-->>M: 批准具体 DeliveryUnit 与目标
    M->>C: protected-approve kind delivery_unit_merge
    D->>C: merge-claim（父 PR）
    C->>C: 核验批准、当前依赖、证据与并发占用
    D->>P: 合并父 PR，查询真实结果
    P-->>D: PR identity、merge SHA、provider receipt
    D->>C: merge-resolve
    C->>C: 记录 merged 里程碑；重新评估 post-merge 原子
    loop 仅执行计划声明的 release / deployment / verification
        A->>C: 读取 scope、前驱、目标和验收要求
        opt 当前原子为 release 或 deployment
            A-->>M: 提交实际发布 / 部署目标与证据边界
            M-->>O: 请求对应受保护批准
            O-->>M: 批准具体动作
            M->>C: protected-approve kind release 或 deploy
        end
        A->>P: 执行已批准动作，或线上 verification
        P-->>A: release artifact / deployment / verification evidence
        A->>C: 通过所属 scope 的原子与事实入口记账
        C->>C: 校验对应 result / evidence，更新里程碑与投影
    end
    Note over A,P: 外部动作 unknown 时保留 operation 并按该操作合同对账；不盲目重发
```

release、deployment、verification 只按已批准计划的原子和 scope 执行，不要求无条件全部存在，也不从贡献任务推断新任务、版本或发布安排。TaskScope 工作由相应 Task owner 执行，DeliveryUnitScope 工作由单元负责人执行。release/deploy 的批准不替代仓库发布 policy；provider PR 单纯 `closed`、消息“已合并”或旧 SHA 上的 CI 不能替代合并回执。

### S10：Task、DeliveryUnit 与 Run 的收口

```mermaid
sequenceDiagram
    autonumber
    participant T as Task 负责人
    participant D as 单元负责人
    participant M as 主 Agent
    participant C as CLI / Ledger
    participant P as Git / CI provider
    T->>C: 提交自身全部 work 原子与所需里程碑证据
    C->>C: 投影 Task completed；另行保留兼容收口事实
    T->>C: task-update（兼容账本 closeout）
    C-->>M: 任务完成通知，经 S7 投递与确认
    D->>P: 核验 parent merge SHA 上 CI、post-merge 和 follow PR
    P-->>D: 与当前交付身份一致的证据
    D->>C: 记录必要单元原子 / 里程碑；group-close
    C->>C: 核验任务、parent merge、CI、post-merge、follow PR 与未解决操作
    alt 必要证据齐备
        C->>C: DeliveryUnit closed，追加 closeout event
        C-->>M: 单元收口结果与通知
    else 条件未满足或存在 unknown
        C-->>D: 保持门禁，返回具体阻塞证据路径
    end
    M->>C: show（全部单元、operations、follow PR、资源）
    C-->>M: 一致快照
    M->>C: run-complete（全部单元已关闭且无未解决 operation / follow PR）
    C->>C: 追加 run_completed
    Note over M,P: 运行完成不自动清理；保留账本与资源，清理另需主人确认
```

Task 的成功投影为 `completed`，旧 Task `closed` 可以表示其他管理性终止，不是证明成功的单独依据。

### S11：Closeout 对账与受保护恢复

```mermaid
sequenceDiagram
    autonumber
    participant D as 单元负责人 / 核验调用方
    participant M as 主 Agent
    actor O as 主人
    participant C as CLI / Ledger
    participant P as Provider
    D->>P: 只读核验已 closed 单元的 PR 与最新证据
    P-->>D: 当前 observation、merge SHA、identity、证据引用
    D->>C: group-closeout-reconcile（原 closeout、计划、revision、影响范围）
    alt valid
        C->>C: 保持 closed，追加有效审计事件
    else unknown
        C->>C: 保持原业务状态，追加 unknown 核验结果
        C->>C: 冻结受影响下游的新派发，等待新证据
    else invalid
        C->>C: 追加失效事件；DeliveryUnit blocked
        C-->>M: 上游失效与受影响 dependency paths
        M-->>O: 请求复用原单元身份的受保护恢复
        O-->>M: 批准恢复范围
        M->>C: protected-approve kind delivery_unit_recovery
        D->>C: group-reopen
        C->>C: 校验 workspace、branch、owner、PR、baseline；blocked 到 active
    end
    Note over D,C: 不直接 closed 到 active，不覆盖旧 closeout / receipt / Task result
    Note over M,P: 已执行的下游 operation 保留结果，各自 reconcile，不自动回滚
```

新增需求使用 S12 的 successor DeliveryUnit，不能借 `group-reopen` 改写原责任边界。

### S12：Plan revision、task migration 与动态 cut

```mermaid
sequenceDiagram
    autonumber
    participant A as Task / Delivery Agent
    participant M as 主 Agent
    actor O as 主人
    participant C as CLI / Ledger
    participant P as Git provider
    A-->>M: 提交范围变化、外部阻塞、原因与证据
    M->>C: show（当前 execution plan、事实与在途操作）
    C-->>M: 一致快照
    M->>C: plan-propose（非空 diff 的 canonical candidate）
    C->>C: 推导 revision 类型；设置 active_plan_id
    alt planning_revision
        M-->>O: 提交修订计划供批准
        O-->>M: 批准
        M->>C: plan-approve
    else implementation_low_impact
        C->>C: 核验结构化原因，自动批准低影响修订
    else implementation_high_impact
        C->>C: 保留旧 execution_plan_id；仅 hold 受影响任务与后继
        M-->>O: 提交原因、证据、影响范围与候选图
        alt 批准新图
            O-->>M: 批准
            M->>C: plan-approve
            C->>C: 切换 execution_plan_id；保留旧版本与事件
        else 放弃候选
            M->>C: plan-abandon
            C->>C: 恢复旧 execution plan 的调度
        end
    end
    opt 需要替换已启动任务责任边界
        M->>C: task-migrate（新 planned task ID、原因与证据）
        C->>C: 旧任务 superseded；保留其 thread、事实与事件历史
    end
    opt 已批准计划要求动态 cut
        M->>C: cut-claim
        C->>C: 阻止新合入，等待已有占用
        M->>P: 核验当前父 SHA 与已合并主干结果
        P-->>M: 真实分支 / merge 证据
        M->>C: cut-apply
        C->>C: 原子记账 SHA 与归属；未完成开发任务及已有对话移至下一单元
        Note over A,C: 已完成开发、原单元 post-merge 工作与 follow PR 留在原单元
        M-->>A: 交接新归属与 lineage 读取入口
        A->>C: 读取新上下文，按 S8 rebase、验证并刷新 baseline
    end
```

图中的 migration 与 cut 是经批准变更的条件分支，不是每次 plan revision 的自动副作用。closed 单元的新需求必须创建 successor DeliveryUnit；不修改原 closeout 历史。Task Agent 可以上报，但不能自行修订全局图、迁移其他任务或创建任务对话。

### S13：Actor、revision 与 request 幂等边界

```mermaid
sequenceDiagram
    autonumber
    participant A as 调用 Agent
    participant C as CLI
    participant L as Runtime / Ledger
    A->>C: mutation（run_id、actor、request_id、expected_revision、payload）
    C->>L: 校验命令入口、绑定身份、请求及 revision
    alt foreign thread / actor role 或 scope 不匹配
        L-->>A: ACTOR_MISMATCH / FORBIDDEN
    else 相同 request_id 且 canonical input 相同
        L-->>A: REPLAYED；返回原结果，不重复副作用或通知
    else 相同 request_id 但 canonical input 不同
        L-->>A: 拒绝 request identity 冲突
    else 旧 expected_revision
        L-->>A: REVISION_CONFLICT
        A->>C: show（重读并重新判断）
        C-->>A: 最新状态与 revision
    else 直接调用内部 dispatch-bind-request / dispatch-resolve
        C-->>A: CLI_ONLY_DISPATCH
    else 正常命令且所有门禁满足
        L->>L: 原子提交事实、事件和新 revision
        L-->>A: result、revision、operation / notification
    end
    Note over A,L: 各分支表示独立拒绝场景，不规定多错误输入的校验优先级
```

## 交互不变量

- 每个 Agent 只能使用与其绑定的 `thread_id` 和账本 actor role；复制 ID 不能产生第二个控制器。
- 主 Agent 是全局调度者，交付 Agent 是单一 DeliveryUnit 的所有者，任务 Agent 是单一 Task 的所有者；所有权不能通过普通更新或计划顺序改写。
- CLI 写入必须带 revision fence；相同 request 只能以相同 canonical input 幂等重放。
- 原生创建必须经过 `dispatch-claim → conversation-create → native evidence reconcile → formal handoff`；绕过路径是编排违规，不能静默接管结果。
- Task 完成、child PR 集成、DeliveryUnit 父 PR 合并、release/deployment/verification 和 closeout 是不同状态边界，不能互相替代。

## 参考

- [Task Agent ledger-driven progression](../../adr/0035-task-agent-ledger-driven-progression-and-dispatch-notifications.md)
- [Task execution and delivery boundaries](../../adr/0027-multi-task-flow-task-execution-and-delivery-boundaries.md)
- [Task Agent child PR ownership](../../adr/0025-task-agent-owned-child-pr-delivery.md)
