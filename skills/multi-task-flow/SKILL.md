---
name: multi-task-flow
description: 通过隔离的 JSON 账本、按需创建的交付单元和任务对话、PR 协调及已认证的本地仪表板，编排依赖驱动的 Codex 任务。
version: 3.0.0
---

# Multi-task flow

## 术语约定

本文统一使用以下双语标准称谓：主 Agent（main Agent）负责整个编排；交付 Agent（Delivery Agent）负责所属交付单元；任务 Agent（Task Agent）负责所属子任务。英文名称是稳定的运行时角色标识，中文名称是面向读者的正式称谓，两者不得互相删减或替换为其他别名。

本 Skill 用于经主人批准、具有明确任务依赖的正式多对话运行。它拥有独立的输入合同和运行时生命周期，与 `$dev-plan` 相互独立，也不会迁移或修改已有运行。初始化是有副作用的运行时操作；只读审查、诊断、代码探索或仅制定计划时不得调用本 Skill。主 Agent（main Agent）按需创建和管理平级的交付单元及任务对话。恰好只有一个 contribution Task 的 regular 交付单元使用共享交付拓扑：交付单元对话、工作区、分支和 PR 同时服务两个作用域。存在多个 contribution Task 时，使用独立的任务 Agent 对话和 child PR，由交付 Agent（Delivery Agent）负责父 PR 集成。主 Agent（main Agent）负责调度，并将只提交证据的工作与产生 PR 的贡献工作分开。

每次运行可以包含一个 `bootstrap` 交付单元，后接零个或多个 `regular` 交付单元。默认第一个交付单元 MUST 为 `bootstrap`；只有提案记录了明确的例外原因和证据时，才允许第一个单元为 `regular`。Bootstrap 是唯一的主会话所有单元：绑定的主对话可以提交初始 SPEC/ADR/计划文档并管理第一个 parent PR。它使用 `owner_kind: "main"`，没有交付单元对话绑定，且必须位于第一位。Regular 单元保留交付单元所有权合同，激活前必须有交付单元对话；当其中恰好只有一个 contribution Task 时，该对话同时拥有任务对话、工作区、分支和 PR。Parent PR 默认串行；只有依赖允许时，regular 单元才可以并行。交付单元类型、所有权和交付单元对话绑定不能通过普通交付单元更新或计划修订改写。本版本不提供原地所有权转移命令；已有运行保留当前所有权。先初始化计划中的 bootstrap，再发布其 parent PR，并在同一个主会话工作区记录工作区和发布回执。

这仍然是依赖驱动交付的顶层活动流程。当拓扑声明包含多个任务时，已批准的运行至少需要两个任务节点；权威运行时账本是任务、交付单元、依赖和收口状态的唯一事实来源。

## 意图与交付合同

主人明确要求使用本 Skill 进行任务编排时，默认意图是创建或继续正式运行并交付其仪表板。不得静默降级为只提供提案 Markdown 文档。只有在主人明确要求审查、诊断或仅制定计划时，才使用 `proposal`。四个生命周期阶段是 `proposal`、`initialized run`、`scheduled run` 和 `completed run`。

第一次交付只有在以下条件全部满足时才算完成：权威账本存在于 `~/.local/share/multi-task-flow/data/runs/<run-id>/`，运行已绑定当前主对话，依赖图已存在，并且通过仪表板浏览器路径打开显示当前 revision。Markdown、Mermaid 和 candidate `init-input.json`（候选输入）都只是辅助输入，不能替代账本或仪表板。

主人批准计划实现后，计划内部的编排和仓库协作操作均获授权，包括任务派发、创建对话、工作区、Git push、分支发布、child PR 创建或更新、child PR 合并、通知、检查和 cut 操作。交付单元 parent PR 合并到集成分支需要单独的 `protected-approve`；发布和部署操作各自需要独立的受保护批准。计划修订、范围扩大、目标漂移和新环境都需要重新批准。按 `init`、`service ensure`、`service login` 及下文的宿主浏览器路径顺序执行。保持页面打开；SSE and heartbeat（SSE 和 heartbeat）更新会暴露后续 revision，通常无需重新导航，只有连接或会话恢复时才重新导航。

如果初始化、viewer ensure/login 或浏览器交付失败，必须报告失败阶段、准确结果和阻塞原因。不得把提案描述为已初始化或已完成的运行。继续已经绑定当前主对话的未完成运行；所有权不确定时，在变更前暂停。把 run ID、revision、owner thread ID 和仪表板入口记录到对话中。

## 仪表板浏览器路径

交付或检查仪表板前，先检查当前宿主暴露的浏览器能力。在 ChatGPT Desktop 或 Codex Desktop 中运行时，默认使用宿主提供的内置浏览器。这条仪表板专用路径优先于通用 `$ego-browser` 路径，但不改变其他浏览器任务的路由。读取宿主暴露的工具文档，并使用其支持的浏览器选择或打开接口；不能仅凭产品名称、浏览器 ID 或工具名称推断能力存在。

在该 built-in browser（内置浏览器）中打开一次性的 `service login` URL，然后从渲染页面核对目标 run ID 和当前账本 revision。保持已认证页面打开以接收更新。成功的打开工具响应本身不代表仪表板交付完成。把 login URL 当作凭据保护。

如果宿主没有可用的内置浏览器，记录缺失能力并按允许的 `$ego-browser` 路径执行。打开或登录失败时必须先诊断，不能静默切换浏览器或复用已消费、已过期的登录 ticket。授权重试必须取得新 ticket。任何 Chrome 或 Computer Use 升级仍须遵守 `$gui-escalation-gate`，真实程序截图仍需要明确的目标程序和范围批准。如果没有允许的浏览器能够渲染仪表板，报告浏览器交付阻塞和稳定运行 URL，不得声称交付成功。

## Dev-plan 集成

新运行只接收本 Skill 的仓库、交付单元、任务、依赖、所有权和验收输入。`init` 拒绝 dev-plan 专用字段，也不要求 plan digest、handoff envelope 或外部计划来源。任务 Agent（Task Agent）可以为自己的直接 PR 调用 `$fast-flow`，主 Agent（main Agent）仍保留任务图、账本、parent PR 和交付单元收口责任。

为了获取模型、合同和展示要求，读取当前 Skill 包内对应的 SPEC 和 design references；不要把运行时输入解析为外部仓库源文件。命令中的 `<skill>` 必须指向已安装 Skill 目录，除非明确测试候选 checkout，否则不能指向候选 checkout。依赖安装使用 `bun install --frozen-lockfile`，本地资源构建从 `<skill>` 目录执行 `bun --no-install run build`。正式运行独立存在于 `~/.local/share/multi-task-flow/data/runs/`，不受 Skill 安装目录和 `CODEX_HOME` 影响。查看或维护 viewer 前读取 `references/shared-viewer.md`。代码升级不会重写运行数据。历史只读运行升级 viewer 不需要迁移；只有写能力新近丢失时，才需要准确的兼容性报告批准。主人批准的维护迁移使用 `references/shared-viewer.md` 中的独立 `ledger-maintenance-check` / `ledger-maintenance-apply` 命令，保留原所有者，不得冒充所有者。普通绑定主会话的迁移权限不变。

## 计划与调度

### Contract 3 不可绕过硬门禁

主 Agent 在调用 `init` 前 MUST 形成完整 canonical plan：每个 contribution Task 都必须有自己的原子任务；原子图 MUST 明确声明开始节点、结束节点、里程碑节点和全部 `atomic_edges`。系统预设的交付单元生命周期原子只提供节点定义，不提供依赖关系；生命周期关系必须由 Agent 在 plan 中显式声明。运行时不得从任务图、交付单元数组顺序、原子数组顺序或名称推导任何原子依赖。

对话创建只有一条正式路径：`dispatch-claim`/`dispatch-group-claim` → exact-version CLI `conversation-create` → native evidence reconcile → formal dispatch。Contract 3 下任何 Agent 都不得直接调用 `mcp__codex_app__create_thread`、裸 `thread/start`、`codex://threads/...` 或 `thread/resume + turn/start` 创建或启动交付对话；这些结果不能绑定到账本。唯一例外是由 CLI `initialization-recover` 按 ADR 0038 在同一已观察 thread/worktree 内执行的受审计固定握手恢复，仍不得裸调用原生 API。发现绕过路径时必须记录 `orphan thread / orchestration violation`，保持 claim 和容量占用并停止调度，不能释放 claim 后静默重试或伪造成功。

Delivery Unit 的四个预设生命周期原子必须按 `prepare-parent → create-pr → merge-pr → closeout` 保持可达顺序；Contribution Task 的四个预设生命周期原子必须按 `prepare-branch → create-pr → merge-pr → closeout` 保持可达顺序。两层原子不得混用；不再预设 `verify-integration` 或 `verify-task-pr`。两节点之间允许插入 Agent 创建的 work、milestone 和并行分支，但只能使用 Agent 声明的边形成路径；缺失、逆序、无关或自动补出的关系都必须使计划拒绝。

### 交付单元归纳

Use the published npm CLI only with the exact-version Bun runner and one JSON object on stdin: `bunx --bun @loomhelm/multi-task-flow@<exact-version> flow <command> --input -`. Read `references/cli-contract.md` for the human command and envelope contract, `flow --help` for the invocation surface, and `flow schema --format json` for machine-readable command metadata. The runtime schema is implemented by the package's `skills/multi-task-flow/lib/schema.ts`; source inspection is a diagnosis fallback only when these surfaces cannot explain an observed result. Do not replace this form with `npx`, `latest`, a compatibility-line tag, a bare cached binary, or a repository-local source path. `init` is an owner-approved mutating command that binds the repository and the main conversation to a new run. It accepts only unbound `planned` groups and canonical task definitions, and writes the initial ledger; it does not create group or task conversations. `migrate` is the only explicit schema v1 or schema v2/contract 1 to schema v2/contract 2 write path: it requires the bound main actor, exact run ID, request ID and expected revision, retains a complete backup, increments the ledger revision with its request record, and is idempotent only for identical canonical input. Read-only review, diagnosis, and planning must use `show`/`view` and must not call `init` or a native conversation-creation tool. `show` reads a consistent snapshot. For each mutation supply a unique `request_id`, the current `expected_revision`, the bound actor and command payload. On conflict read the ledger and reconsider; replay the identical request ID only for the identical operation. Do not edit the ledger JSON manually. Agent-authored Markdown requirements are ordinary files under the run's `requirements/`.

只读审查、诊断和计划工作使用源检查或 `show`/`view`；完整命令和 envelope 合同以当前 Skill 包的 `references/cli-contract.md` 与 `flow schema --format json` 为准，源代码仅在这些接口无法解释实际结果时作为诊断回退。

交付单元的数量和边界由主 Agent（main Agent）在规划上下文中根据需求结果和 contribution Task 的作用共同归纳；主人批准的是主 Agent 生成的完整计划，不需要预先指定交付单元数量。PR 数量、Agent 数量、文件边界、模块边界和可并行性都是归纳后的执行结果或约束，不能单独作为拆分原因。

主 Agent 必须先为每个 contribution Task 说明它服务的需求结果，再把共同完成同一个可验收需求结果的任务归入同一个 `delivery_unit_id`。如果任务分别产生独立的需求结果、可以分别交付并分别验收，才拆成不同的 `delivery_unit_id`。不能因为“一个任务看起来像一个能力”或“一个任务需要一个 PR”就创建一个新的交付单元。

归纳结果只落在已批准计划的原子 scope 中：每个 contribution 或 documentation work 原子使用唯一的 `TaskScope { kind: "task", task_id, delivery_unit_id }`；`DeliveryUnitDefinition` 不复制 `task_ids`，成员由原子 scope 派生。主 Agent 的中间推理不作为新的 Proposal 类型或独立账本对象持久化。

归纳完成后才选择执行拓扑：同一 `delivery_unit_id` 恰好有一个 contribution Task 时，使用共享交付拓扑；有多个 contribution Task 时，使用多任务集成拓扑。共享拓扑复用交付单元对话、工作区、分支和 PR；多任务集成为每个任务创建独立对话、工作区、分支和 child PR。verification、release 和 deployment Task 不增加 contribution Task 数量。

计划校验必须保证每个 contribution Task 有且只有一个交付单元归属，并保证执行策略与归纳结果一致。缺少归属、出现多个归属或任务策略与拓扑冲突时，计划必须被拒绝；不能退回“一项任务一个交付单元”的隐式默认。计划批准后不得静默重新归纳，必须通过计划修订处理。

先建模原子任务及其前驱；每个原子任务都是不可再拆的调度单位。新任务定义只能使用四种类型：`contribution`、`release`、`deployment` 或 `verification`。 `development`、`other` 和 `coordination` 仅是历史账本值，不能由 `init` 或计划修订引入。等待、阻塞、集成和交付单元管理通过交付单元协调状态和里程碑表达。把连续原子任务分组为子任务，然后同时校验两张图和显式交接事实。交付单元恰好只有一个 contribution Task 时选择共享交付拓扑；verification、release 和 deployment Task 不计入该数量。计划交付单元 PR，仅在多贡献单元中计划 child PR，并同时计划单元级 post-merge release、deployment、 verification 任务及带来源和置信度的预计时间。默认最多三个任务并行运行；等待和阻塞任务释放运行名额。主人一次批准实现计划；该批准覆盖计划已表示的所有操作，包括计划中的仓库写入。只有交付单元合并以及 release/deploy 操作在最终目标和证据边界暂停等待受保护批准。不能从分组顺序或文件重叠推断依赖。

### 分阶段计划修订

Skill 的目录将可执行命令入口放在 `scripts/`，可复用实现模块放在 `lib/`，回归测试放在 `tests/`；`scripts/` 中的文件是受支持的命令接口，`lib/` 中的文件是导入的实现细节。`lib/schema.ts` 中的运行时合同及其在 `lib/contract.ts` 中的投影是计划修订语义的权威来源。第一次真实 `task_started` 事件之前，编排处于 `planning`；之后保持在 `implementation`。dispatch claim、创建对话、`starting` 状态和计划选择不会跨过这个边界。

提案后计划内容不可变。`active_plan_id` 标识选中的候选，`execution_plan_id` 标识当前约束调度的已批准版本。使用 `plan-propose` 提交 canonical candidate；运行时推导 `planning_revision`、`implementation_low_impact` 或 `implementation_high_impact`。不得提交自声明的变更类型。计划修订必须有非空 diff 和重新批准。低影响实现修订需要结构化原因并自动批准；高影响实现修订需要原因和证据，保留旧 execution pointer，仅 hold 受影响任务及其后继，并在新图调度前使用 `plan-approve`。使用 `plan-abandon` 恢复旧 execution plan。

不能在计划 payload 中改写已启动任务的边界或运行时身份。使用带有新 planned task ID、结构化原因和证据的 `task-migrate`；旧任务及其事实和事件保留为 `superseded`。仪表板和 `view` 投影分别保留 phase、生命周期、candidate/execution plan、revision diff 和 hold 原因。不能从 candidate ID、`starting`、dispatch claim 或 terminal plan label 推断完成。

`examples/ledger-initialization/initial.json` 是合成的、未经批准的起始示例，不是可执行的真实计划。实际初始化前替换所有示例身份、日期和任务细节。 `examples/orchestration-viewer/ledger.ts` 提供另一个更丰富的合成仪表板示例；可复现的静态预览和 live demo 见 `examples/README.md`。

在对话中记录运行身份。正式数据只存在于 `~/.local/share/multi-task-flow/data/runs/<run-id>/`。开发和测试必须使用明确隔离的 profile 和 root。Conversation ID 与 run ID 不同。fork 的关系或控制权不确定时，在 dispatch、cut 或 merge 前暂停，并在需要绑定时询问主人。所有者转移需要明确的所有者决定、核实过的前任对话状态以及没有未解决操作。不能仅凭复制的 ID 声称存在第二个主控制器。

使用 `dispatch-group-claim` 或 `dispatch-claim`，然后通过本 Skill 的 CLI 调用 `conversation-create`。命令绑定原生 request identity，通过 app-server 创建并初始化对话，并解析带执行配置的真实 thread ID。初始 group/task thread ID 无效；unknown 结果保留 claim 和容量，必须用真实原生证据对账后再重试，无法确定时询问主人。不能编造 thread ID 或重复创建。`task-update` 记录实际执行、等待、阻塞和完成； `atom-update` 按顺序记录原子。普通阻塞留在负责的对话和账本中。关键进度先作为 pending notification 记账，再使用允许的原生通信工具投递或确认；sent 和 acknowledged 是不同状态。

任务 Agent 收到正式派发后，先使用派发消息中的 `run_id`、`task_id`、自身 `thread_id` 和 exact package version 读取自己的作用域上下文：`printf '%s' '{"run_id":"<run-id>","actor":{"role":"task","thread_id":"<task-thread-id>"},"section":"task-context","task_id":"<task-id>"}' | bunx --bun @loomhelm/multi-task-flow@<exact-version> flow show --input -`。该只读投影是任务执行清单的入口，包含任务、所属交付单元、依赖边、原子节点和边、工作区资源、验收相关事实、阻塞原因与当前 `ready` 状态；只能读取绑定到自身对话的任务。随后按返回的原子和现有账本事实推进，使用 `task-update`、`atom-update` 及对应的 PR/事实命令记录自己的进展和证据，直到 `closeout`；不要等待固定握手回复，也不要自行创建或派发其他任务。需要主 Agent 处理时，仅通过账本产生的通知或阻塞、完成消息报告。

只要仍有 ready 且未绑定的 contribution task，活跃交付单元就不能记录为 idle；应记录 running、带任务引用的 waiting 或带原因的 blocked，然后派发或对账。

## 执行配置与 CLI 创建

运行只有一个完整的 `config.execution_profile = { model, thinking }`。交付单元和任务可以独立覆盖；没有覆盖时各自使用运行默认值。新对象按 `kind-v1` 推荐表物化配置，手动修改后保持原值；只有主人明确要求重新推荐时才执行 `execution-profile-recommend`。创建后的对话内调整属于会话运行时，不回写账本，也不主动重设。

使用 `execution-profile-update` 修改对象，payload 为 `{ target_type: "group" | "task", target_id, execution_profile: { model, thinking } | null }`；使用 `execution-profile-default-update` 修改默认值，payload 为 `{ execution_profile: { model, thinking } }`。所有写入都带标准 owner/request/revision envelope，并通过 app-server `model/list` 验证组合。认证网页复用相同 mutation contract，保留选择和 URL，并显示服务端错误。外部 source viewer 保持只读。

`conversation-create` payload 为 `{ operation_id, title, prompt }`。CLI 使用参数数组和关闭的 stdin 启动 `codex exec -C <repository> --worktree --json -m <model> -c 'model_reasoning_effort="<thinking>"' <固定初始化提示词>` ，完整透传已锁定配置；工作区由 Codex 创建，脚本不调用 `git worktree add`。`prompt` 是兼容保留的正式任务，只在成功结果的 `handoff.formal_prompt` 返回，首轮不执行。收到 `thread.started` 立即记录身份；绑定前必须核验独立工作区、Codex 归属元数据、实际配置、初始 HEAD、初始化回合完成以及进程正常退出。`project_id` 为空不单独失败。标题通过 `thread/name/set` 写入，不另开回合。绑定后创建正式派发通知并领取持久 attempt；主对话仅在 `handoff.should_send: true` 时调用内置 `send_message_to_thread`，使用返回的 `tool_request` 并对账平台回执。创建请求重放返回 `should_send: false`，不得再次派发。超时、创建后错误或证据冲突保留 unknown 和已知资源，先对账，不重复创建。只有没有观察到线程身份，且回执明确 `process_started: false`、`resources_created: false` 的创建前失败才允许释放 claim；新 exec 请求不能使用历史 `thread/start` 失败回执。历史 `thread/start` 与 `create_thread` 证据继续读取，不重建已有线程或中断在途 CLI。

恢复 unknown creation 只能调用同一 exact-version CLI 的 `flow creation-reconcile`，使用绑定的 run、operation、native request 和当前 revision 查询原生 thread 并写回 Flow Ledger。对账成功必须有匹配 thread、初始化 handshake、execution profile、独立 worktree owner、HEAD 和清洁状态证据；没有已知 thread identity 或仅查询不到 thread 时保持 unknown，不按标题、cwd 或时间猜测，也不调用普通 `codex reconcile`。

native request ID 一旦绑定，完整创建参数（含 transport、cwd、prompt、title 和 execution_profile）即冻结；相同内容可以再次绑定，不同内容复用 ID 必须拒绝。已知线程、工作区、初始 HEAD 和执行事实通过 `creation_observations` 单调保留；后续空 unknown 回执不能遗忘它们，failed 门禁不能依赖可变 transport。明确失败且完成对账的请求才允许修正配置并重新 claim。未绑定 native request 的 claim 遇到配置变化会终止旧 claim，审计记录保留旧 profile、原因和新 claim 要求。

旧账本缺少默认 profile 时保持只读。历史 `schema-2/contract-2` 账本若任务缺少 `execution_owner`、`conversation_policy` 或 `delivery_policy` 也保持只读，并在普通写入口返回 `HISTORICAL_LEDGER_READ_ONLY`；先用 `ledger-maintenance-check` / `ledger-maintenance-apply` 的 `action: "contract"` 仅补出缺失策略键的显式 `null`，再按需由绑定主会话显式调用 `execution-profile-migrate`，两项迁移分别携带 request ID、expected revision、源 SHA256、operation digest、维护身份、批准引用和完整备份。部分策略声明不自动补齐，PR、owner 和 lifecycle 事实也不由迁移推断。历史 `create_thread` 证据可读；新增创建通过 CLI 证据解析。

## 主动通知闭环

记账命令可以在 `payload.notification` 中提供 `{ "mode": "auto" | "deliver" | "none", "recipient": "owner" | { "thread_id": "..." } }`。`auto` 保留各命令现有的默认通知规则，`deliver` 明确创建主动投递意图，`none` 禁止主动投递；旧字段 `notify_main: true` 继续等价于向 `owner` 投递。

记账命令先提交通知事实，再领取唯一持久 `delivery_attempt_id`，返回 `should_send`、`tool_request` 和回执身份。 `notification-prepare` 与兼容名称 `notification-send` 都只领取意图，不调用 CLI `thread/resume + turn/start`。仅当 `should_send: true` 时，主对话调用内置 `send_message_to_thread`；随后使用 `notification-reconcile` 写回真实平台结果， payload 包含 `notification_id`、相同 `delivery_attempt_id`、唯一 `reconciliation_id`、`outcome` 和 `provider_receipt: { provider: "codex-app-tools", evidence_ref, message_id?, recipient_thread_id, prompt_digest }` 。新的原生 attempt 必须让收件线程和 prompt digest 与领取意图一致；没有回执保持 unknown，只有证实未投递才可记 failed。`codex-app-tools` 直接 `notification-deliver` 只允许领取 unknown，不能直接记录 sent/failed；兼容 `notification-sent` 不接受该 provider，原生对账必须匹配 attempt 和 provider，历史 provider attempt 不能直接套用原生回执。`sent` 表示平台接受，不能推断已读、处理或开工。

相同请求重放返回 `should_send: false`，不能再次发送。持久 unknown attempt 跨工具调用占用通知，不依赖常驻文件锁。并发领取或未解决 attempt 禁止再次发送； unknown 必须先对账。历史外部发送的文件锁仍保护其在途回合，遇到 `NOTIFICATION_IN_FLIGHT` 不得改写状态解锁。只有收件会话可调用 `notification-ack`， main 不能代确认。使用 `notification-reconcile --input -` 的查询形式恢复 pending、failed、unknown 和长期未确认的 sent；明确 failed 才可创建新 attempt。

## 开工前基线

创建时只记录 `native_evidence.initial_head`；它不是开发基线。正式派发包含 run/target、仓库、归属、范围、基线与验收要求。交付 Agent（Delivery Agent）必须 fetch 已核验远端的主干并记录真实 SHA 和 fetched_at；任务 Agent（Task Agent）继承所属交付单元当前父分支已核验 SHA。仅允许在本次新建、干净且 Codex 归属一致的工作区对齐并建立工作分支。fetch 失败、脏工作区或归属不明必须阻塞，不覆盖文件，不使用缓存替代 fetch。

Agent 提供资源证据，由主对话通过 `resource-update` 注册 active worktree/branch；目标 owner 调用 `lifecycle-record` 的 `workspace_ready`，新 CLI dispatch 还需 `baseline: { sha, head, clean: true, source, fetched_at? }`，SHA 必须与 HEAD 相同，交付单元 fetched_at 不早于 dispatch，任务 SHA 必须匹配交付单元 current_sha。开发基线存于 dispatch 的 `development_baseline`，并独立保留创建初始 HEAD。任务和交付单元协调进入 running 均受此门禁保护；历史已绑定对话不追加此要求。

Contract-3 的开发基线由 `development-baseline-sync` 明确提交。首次同步使用 `mode: "initial"`，在 dispatch、native evidence、workspace、branch、owner、resource 和 lineage 均已核验后建立空 baseline；之后每次父分支 lineage 通过 `group-base-reconcile`、合并或 cut 推进，都先使用 `mode: "refresh"` 携带 previous receipt 和匹配的 lineage event，再重新调用 `lifecycle-record`。`initial_head` 只表示 native creation 时的初始 HEAD，development baseline receipt 表示本次 workspace evidence 已对应的可工作 SHA，二者不能互换。同步只记录 Agent 已完成的证据，不 fetch、reset、rebase、更新 provider、创建 PR、改变 owner、替代 task-base 或收口 cut。

## PR 与 cut

任务或交付单元 Agent 每次执行 PR 合并前都必须使用 `merge-claim`，并通过绑定的 Git provider 核对真实 PR identity、目标、当前 head/base、适用检查和任务质量证明。在共享交付拓扑中，唯一的交付单元 PR 同时是 contribution Task PR，并只有一份 merge receipt。在多贡献拓扑中，child PR 合并由实现批准覆盖，交付单元 PR 仍要求针对该交付单元的事先 `protected-approve`。脚本输入只是 Agent 报告，不是独立的 provider 证据。外部调用后查询 provider，并使用 `merge-resolve` 记录匹配回执；结果不确定时记录 `unknown`、保留占用并在重试前完成对账。不能根据未经核实的错误声称操作失败。负责的对话记录其作用域的质量证明；共享 contribution Task 不得创建 child PR。原交付单元 PR 已合并，而后续 mainline follow-up PR 携带剩余交付单元变更时，协调者使用 `merge-claim` 的 `mode: "parent-followup"`，记录原 PR 和 merge SHA，并针对集成分支解析 follow-up PR；这会推进交付单元 merge SHA，但不会改写原始回执。

收口后的外部事实发生冲突时，调用方使用 `group-closeout-reconcile` 提交原收口事件、计划身份、PR observation、结果和证据引用；`valid` 保持 `closed`，`invalid` 转为 `blocked`，`unknown` 保留业务状态但冻结受影响的下游门禁。不得新增 `reconciling` 等业务状态或覆盖原始事实。只有主 Agent 通过 `protected-approve` 批准 `kind: "delivery_unit_recovery"` 后，交付单元负责人才能使用 `group-reopen` 将同一 DeliveryUnit 从 `blocked` 恢复为 `active`；该命令不会创建 PR、workspace 或 successor。`group-update` 不得绕过这个恢复边界，也不得执行 `closed -> active`。

child PR 出现冲突或检查失败时，任务 Agent 首先判断问题是否由自身变更造成。自身问题留在同一任务和 PR 中修复。确认是外部问题后，向主 Agent 提交诊断证据、影响和候选编排调整；主 Agent 在创建独立修复贡献任务或改变依赖前询问主人。基线变化始终由任务 Agent 负责：rebase、重新验证并刷新任务基线证据后才能重试。普通执行不会在 Agent 之间转移任务工作区或 PR。

经批准的动态 cut 使用 `cut-claim` 阻止新合入并等待已有占用，然后使用 `cut-apply` 原子记录当前已核验的父 SHA 和归属变更。已完成的开发工作留在原交付单元；未完成的开发子任务及其已有对话移动到下一个默认交付单元。原交付单元的 release、deployment 和 verification 任务仍留在原单元，并在其 PR 合并后运行。下一个 parent branch 必须包含上一 parent PR 实际合入主干的结果，之后其开发 PR 才能合入。follow PR 继续归属于原交付单元；分支推进时刷新当前 SHA 和检查/审查证据，不改变 cut 归属。外部 provider 的 `update-branch` 只能通过带有匹配前后 SHA、branch、parent PR、provider 和明确 update-branch 证据的 `group-base-reconcile` 记录，不能当作 merge 或 follow PR。拥有 follow PR 的任务 Agent 通知主 Agent，主 Agent 协调受影响未完成任务 Agent 的 rebase。

交付单元只有在 parent merge、合并 SHA 上的 CI、计划中的 post-merge 任务和已知 follow PR 全部完成后才收口。所有交付单元关闭且没有未解决 operation 或已知 follow PR 后，主 Agent（main Agent）才可以记录 `run-complete`。`resource-update` 分别跟踪每个资源。保留运行数据和必要服务，直到主人确认清理；清理时只处理本次运行的准确资源。

## 仪表板

Use the published npm CLI only in this form: `bunx --bun @loomhelm/multi-task-flow@<exact-version> service <command> --input -`. Before viewer use, run read-only `--version` and `service status` with the same exact version. Do not use `npx`, `latest`, a compatibility-line tag, a bare cached binary, or a repository-local source path as a substitute. If `status` reports `installed: false`, stop and guide the owner through approval: explain that installation writes the fixed user data root, reserves the configured loopback port, creates the user-level launchd service, and does not require administrator access; ask for explicit approval for this exact installation. Do not call `install` until that approval is received. After approval, select a platform-matched, verified bundle produced by the protected Skill Runtime release workflow, show the exact source path, and call `install`; user-side source or bundle builds are forbidden. Then call `ensure` with `{ "run_id": "<run-id>", "thread_id": "<main-thread-id>", "api_version": 1 }`. All projects and conversations share its stable `http://127.0.0.1:<configured-port>/runs/<run-id>/` entry. The CLI returns structured `ok/code/result`; `ensure` never builds, installs, upgrades or selects another port. Ordinary Agents may ensure, renew, release, inspect and obtain login entry points, but must not trigger installation, upgrade, rollback, credential maintenance or import without owner authorization. After `ensure`, call `login` and open its single-use URL using the Dashboard browser route when delivering or viewing a run.

使用已安装的用户服务时，唯一推荐入口是 `bunx --bun @loomhelm/multi-task-flow@<exact-version> service <command> --input -`。运行前用同一个 exact version 执行 `--version` 与只读 `service status`；不得改用 `npx`、`latest`、兼容线 tag、未锁版本的裸 CLI 或仓库内源码路径。正式服务根目录的 `config/service.json.current_build` 是已安装 build 的唯一配置事实；对应 `releases/<current_build>/manifest.json` 的 `service_version`、`source_sha` 和 `platform` 是该 build 的 bundle 身份，当前运行时 `status` 返回的 `build_id` 必须等于 `current_build`，`source_sha` 必须与 manifest 一致。CLI package version 与 bundle `service_version` 是独立字段，不能从 npm 缓存目录、`candidates/` 目录名或另一字段推断当前运行版本。若 `status` 报告 `installed: false`，暂停并引导主人针对这次具体安装批准；未获批准前不得调用 `install`。若 `installed: true` 但 `running: false`，或上述 build/source/version 任一字段缺失或不一致，只收集只读证据并停止；不得用 `ensure` 作为版本修复，不得调用 `install`、`upgrade`、`rollback`、凭据维护或导入。只有已安装身份一致时，普通 Agent 才能按正常运行路径调用 `ensure`，再调用 `login` 并通过仪表板浏览器路径打开其一次性 URL。获得安装批准后只能选择由受保护的 Skill Runtime 发布流程产出的、平台匹配且已验证的 bundle，展示准确源路径；禁止用户侧从源码或 npm CLI 目录构建 bundle。所有项目和对话共享稳定的 `http://127.0.0.1:<configured-port>/runs/<run-id>/` 入口；CLI 返回结构化 `ok/code/result`。

用户级 launchd 服务独立于对话拥有后台生命周期，不要求管理员权限，也不会在登录时自动启动。独立的 main-thread/run lease 有效期为 60 分钟；相关成功编排命令会续租。长时间等待期间显式 renew。已连接浏览器页面每 60 秒续租一次，TTL 为五分钟。收口时只释放本次运行的 Agent lease；不能停止共享服务或释放其他运行的 lease。最后一个 lease 过期会触发退出但不会删除数据；下一次 `ensure` 可恢复崩溃。未完成账本不会保持进程存活。

使用可选 `run_id` 调用 `login` 获取一次性的 60 秒浏览器入口。把该 URL 当作凭据，不能写入普通日志、账本或 PR。稳定的 run/plan 链接不包含凭据。登录后，`/` 列出运行，`?plan=<plan-id>` 选择历史计划。服务校验 Host/Origin，并使用 HttpOnly/SameSite 浏览器会话。服务链接不可用时先调用 `ensure`。只有当前订阅的运行持有文件监听器。

每运行的自定义 HTML/CSS/JS 仍支持放在 `data/runs/<run-id>/view/`。必须包含 `{ "api_version": 1, "frontend_contract": 1 }` 的 `view.manifest.json`。声明缺失或不兼容时保留文件，并带警告回退到共享模板。相对 API/资源路径必须留在 `/runs/<run-id>/` 内；这属于同一用户信任域。页面需要保留依赖图、计划/实际时间线、group 归属、状态、阻塞原因、PR、需求和真实对话链接。对话链接使用真实 ID 和 canonical `codex://threads/<thread-id>` anchor。

对于示例和外部 fixture，使用通用的只读源目录 viewer。它接受绝对的源运行数据目录，校验账本和文件系统身份，分配随机的 `view-<id>` 展示身份，并通过同一个 singleton 提供服务。它原地读取源目录，不在正式 `data/runs` 下发布，不允许编排写入，并在显式浏览器 view lease 过期时移除映射。不能增加 example 专用服务模式，也不能把源视图当作真实运行。

The explicitly installed shared user service uses the system-service exception for its background lifecycle. See `references/shared-viewer.md` for fixed-port ownership, compatibility, maintenance and migration recovery.

显式安装的共享用户服务使用系统服务例外管理后台生命周期。固定端口所有权、兼容性、维护和迁移恢复见 `references/shared-viewer.md`。

## 编排版本与显式升级

普通 flow（包括只读）必须使用与该编排账本及运行绑定完全一致的包版本、build、source 和合同集合。版本不匹配时先用 `multi-task-flow orchestration compatibility-check --run-id <run-id>` 诊断；只有主人明确授权升级该正式编排后，才使用目标版本 CLI 执行 `orchestration upgrade --run-id <run-id> --dry-run <version|tag>` 和不带 dry-run 的相同命令。安装新 CLI 或阅读本 Skill 不授权迁移已有正式运行。

新初始化原子发布 contract 4 和 schema-2 版本绑定，保留 Contract 3 的原子编排及初始化恢复语义。显式升级通过整个 run 目录的原子发布迁移受支持账本并切换绑定，保留源目录恢复快照，CLI 侧不可逆，不提供编排 rollback。升级中断只续跑登记的冻结目标；普通 flow 不得修复或跳过升级阶段。缺少可信历史身份、没有机械迁移链或无法证明原生调用已停止时保持阻断；不要改账本、释放 claim、强杀进程或按全局 Gateway 版本猜测。专用诊断与 dry-run 不产生业务写入或绑定切换。完整阶段及错误码见 canonical CLI 合同。

## Contract 3 强制边界

Contract 3 下任何 Agent 都不得直接调用 `mcp__codex_app__create_thread`、`fork_thread` 或其他原生 thread-create/fork 工具创建 group/task 对话；`conversation-create` 是唯一入口。宿主无法保证普通 Agent 不具备上述原生创建能力时，必须在 dispatch 前报告 capability gap 并阻塞运行，不能用提示词约定替代工具授权。

发现未由 `conversation-create` 产生、未绑定 dispatch operation 或未经过 native evidence 核验的 `codex://threads/<thread-id>` 时，将其标记为 orphan thread / orchestration violation；不得绑定、resolve、handoff、释放 claim 或容量，也不得把它作为依赖事实，暂停受影响运行并交给主人复核。

regular 贡献任务必须先有 workspace ready 和已创建且验证为 open 的 parent PR；只有 main-owned bootstrap 在 workspace ready 且 provider 明确证明 parent PR `absent` 时可例外，pending、unknown、closed 或缺少证据都不满足例外。

## 中断初始化恢复

创建超时或连接中断后先用 `flow creation-reconcile` 对账；如果明确是原始初始化握手 interrupted，可由绑定 main 使用标准 envelope 调用 `flow initialization-recover`，payload 仅包含 `operation_id`。它只在原 thread/worktree 上执行一次固定 READY 握手，不能传正式任务、替换执行配置或创建新会话；仅支持已验证 writer 排斥的 codex-cli 0.169.0。已保存 attempt 后无论退出码如何都不得重发：读取当前 revision，以 `creation-reconcile` 验证注册的 original/recovery turn 链。只有 intent 而无法证明 turn 是否启动时保持 unknown 并报告审计阻塞，不能释放 claim。该入口是受审计的恢复例外，不授权 Agent 裸用 resume/start 操作正式对话。
