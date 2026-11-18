---
name: multi-task-flow
description: 通过隔离的 JSON 账本、按需创建的交付单元和任务对话、PR 协调及已认证的本地仪表板，编排依赖驱动的 Codex 任务。
version: 3.0.0
---

# Multi-task flow

从当前账本判断是否可派发；task-ready 通知确认独立追踪。普通进度可直接更正等待或阻塞。工作区准备可通过 `lifecycle-record workspace_ready` 和 `baseline_sync` 一次记账；未关联已授权操作的外部合并通过 `merge-observe` 留存观测，不推进依赖。

## 适用范围与授权

用于主人批准的、具有明确依赖的正式多对话编排。明确要求使用本 Skill 时，创建或继续正式运行并交付仪表板；明确要求审查、诊断或仅制定计划时，只做 proposal 或只读查询，不初始化、不创建对话。生命周期为 `proposal → initialized run → scheduled run → completed run`。与 `$dev-plan` 独立，`init` 不接收其专用字段、plan digest 或 handoff envelope。

使用标准角色名：主 Agent（main Agent）负责计划、调度、账本与收口；交付 Agent（Delivery Agent）负责所属交付单元的 parent PR 集成；任务 Agent（Task Agent）负责所属任务。英文是稳定运行时标识，中文是正式称谓，不改用别名。任务 Agent 可为直接 PR 使用 `$fast-flow`，不接管主 Agent 的编排责任。

实现计划批准覆盖计划内的对话、工作区、push、分支发布、child PR 创建／更新／合并、通知、检查和 cut。parent PR 合入集成分支仍须针对该单元的 `protected-approve`；release、deployment 各需独立受保护批准。计划修订、范围扩大、目标漂移、新环境重新批准；计划修订的分级审批见下述参考文档。

## 命令与事实来源

正式 flow 使用已发布包的精确版本：`bunx --bun @loomhelm/multi-task-flow@<exact-version> --output json flow <command> --input -`，stdin 为一个 JSON 对象。不得用 `npx`、`latest`、兼容线标签、裸缓存二进制或仓库源码路径替代。普通命令（含只读）必须匹配 run 绑定的 package/version/build/source 与合同集合；安装新 CLI 不授权升级已有运行。

权威账本为 `~/.local/share/multi-task-flow/data/runs/<run-id>/`，独立于 Skill 安装目录和 `CODEX_HOME`。Agent 编写的 Markdown 需求存放于 run 的 `requirements/`。禁止手改账本；每次写入提供绑定 actor、唯一 `request_id`、当前 `expected_revision` 和 payload。冲突先重读；相同 request ID 仅重放完全相同的操作。`show`/`view` 读取一致快照，Markdown、Mermaid、候选 JSON 和复制的 ID 都不能代替运行事实。

按操作读取当前 Skill 包内的参考文档；字段与命令先查 [CLI 合同](references/cli-contract.md)、`flow --help` 和 `flow schema --format json`，接口不足以解释实际结果时才检查运行时源码。

| 操作时机 | 必读参考 |
| - | - |
| 初始化、任务归纳、原子图或计划修订前 | [计划与图](references/plan-and-graph.md) |
| 创建／派发、执行配置、通知或初始化恢复前 | [原生派发与对账](references/native-dispatch-and-reconciliation.md) |
| 准备工作区、同步基线、PR、cut 或收口恢复前 | [基线、PR 与 cut](references/baseline-pr-and-cut.md) |
| viewer 身份核验、展示、租约或服务维护前 | [共享 viewer](references/shared-viewer.md) |
| 版本不匹配、编排升级或历史账本迁移前 | [CLI 合同](references/cli-contract.md) 与 [共享 viewer](references/shared-viewer.md) 的对应恢复章节 |

开发／测试使用明确隔离的 profile 和 root。命令中的 `<skill>` 指已安装目录，只有明确测试候选 checkout 才能改指候选；运行输入不是外部仓库源码路径。

## 交付边界与计划

先说明每个 contribution Task 的交付目标，把适合一起交付、一起验收的任务归入同一个 `delivery_unit_id`；只有可独立交付、独立验收的结果才拆单元。PR／Agent 数量、文件／模块边界、并行性、SPEC/ADR 编写、父 PR 初始化、准备与实现的先后及角色差异，都不能单独作为拆分理由。

默认首个单元为唯一的 `bootstrap`：`owner_kind: "main"`、无交付单元对话绑定，由主对话协调准备、实现、验证、合并与收口；首个为 regular 必须在提案记录例外原因和证据。一个 bootstrap 即可完成整次交付，例如登录跳转修复中的诊断、测试、前后端修改与文档更新，无需另建 regular。后续 regular 由独立交付对话负责，激活前绑定真实身份。既有类型、owner 与对话绑定不可通过普通更新或计划修订改写，本版本不提供原地所有权转移。

归纳后再选拓扑：regular 单元恰好一个 contribution Task 时共享对话、工作区、分支和唯一 PR；多个贡献任务分别创建任务对话、工作区、分支和 child PR，由单元集成。verification、release、deployment 不计入贡献数量；证据任务与 PR 贡献分开建模。成员由原子 scope 派生，每个贡献任务恰有一个单元归属，策略必须匹配拓扑。

`init` 前形成完整 canonical plan：任务类型仅为 `contribution`、`verification`、`release`、`deployment`；明确开始、结束、里程碑、各贡献任务的 work 原子和全部 `atomic_edges`。交付单元生命周期按 `prepare-parent → create-pr → merge-pr → closeout` 可达，贡献任务按 `prepare-branch → create-pr → merge-pr → closeout` 可达；保存显式 `lifecycle_role`。系统提供节点，不补造依赖；不从数组顺序、名称、分组或文件重叠推导边。

规划单元 PR、必要的 child PR、post-merge release/deployment/verification，以及带来源和置信度的预计时间。默认最多三个任务并行，等待／阻塞释放名额；parent PR 默认串行，regular 仅在依赖允许时并行。多个任务的拓扑至少有两个任务节点。等待、阻塞、集成与单元管理用协调状态和里程碑表达。

## 主流程与硬门禁

1. **恢复或初始化**：优先继续已绑定当前主对话的未完成 run；先核验 owner 与版本，记录 run ID、revision、owner thread ID。所有权或 fork 控制关系不明时暂停变更。新运行按批准计划执行 `init`，只传未绑定、`planned` 单元和规范任务；该命令写账本，不创建对话。bootstrap 在同一主会话工作区记录工作区事实并发布 parent PR。
2. **交付仪表板**：按共享 viewer 合同核验配置、CLI、runtime 身份。身份一致且服务运行时执行 `service ensure → service login → 浏览器核验`；身份异常、服务缺失／停运只报告证据，不以 ensure、安装或升级修复。首次交付须有正式账本、主对话绑定、依赖图和渲染页面上的当前 revision；proposal、候选 `init-input.json` 或打开工具的成功回执均不算交付。
3. **创建与派发**：Contract 3 唯一入口是 `dispatch-group-claim`／`dispatch-claim → conversation-create → native evidence reconcile → formal dispatch`。先核验精确版本 CLI、claim 与原生证据能力；缺失则报告 capability gap。任何 Agent 都不得调用 `mcp__codex_app__create_thread`、`fork_thread`、裸 `thread/start` 或 `thread/resume + turn/start` 绕过正式路径。发现 `orphan thread / orchestration violation` 或证据绕过时保留 claim 和容量，暂停受影响运行交给主人，不绑定、不 resolve、不 handoff、不作为依赖事实。
4. **建立开发基线**：独立工作区、owner、资源与真实 SHA 核验后，执行 `resource-update`、`development-baseline-sync` 和 `lifecycle-record`。regular 贡献任务还必须有 provider 证明 open 的 parent PR；仅 main-owned bootstrap 在 workspace ready 且 provider 明确证明 parent PR `absent` 时例外。`initial_head` 只是创建快照，不是开发基线。
5. **调度与记账**：任务 Agent 收到正式派发即读取自身 `task-context`，按原子推进至 closeout，不等待固定握手或自行派发任务。用 `task-update`、`atom-update` 记录事实；普通阻塞留在负责对话与账本。活跃单元只要有 ready 且未绑定的贡献任务，就不能记 idle，必须派发／对账，或记录带任务引用的 waiting、带原因的 blocked。
6. **合并与收口**：每次 merge 先 `merge-claim`，通过绑定 Git provider 核对 PR、head/base、检查和质量证据，外部执行后查询 provider，再 `merge-resolve`。单元须完成 parent merge、merge SHA 上的 CI、计划 post-merge 任务和全部已知 follow PR；所有单元关闭且无未解决 operation／follow PR 后才 `run-complete`。资源逐项登记，运行数据与必要服务保留到主人确认清理。

所有创建、通知、合并或 cut 的结果不确定时，保留 `unknown`、claim、容量和已知资源，先用对应命令对账再重试；错误消息不证明失败。只有受审计的 `initialization-recover` 可以在原 thread/worktree 恢复一次固定初始化握手，不授权裸用原生恢复工具或重发正式任务。

通知遵循“记账 → 领取唯一 attempt → `should_send: true` 时按返回 `tool_request` 调用原生发送 → receipt reconcile”。重放不再次发送，unknown 不重发；`sent` 只表示平台接受，只有收件会话可记 `notification-ack`。工具可见性不等于绕过事实，提示词禁令也不等于工具权限隔离。

## 仪表板浏览器路径

优先从宿主浏览器清单选择 `ChatGPT in-app browser` 打开仪表板；宿主未提供该浏览器时，按 `$ego-browser` 执行。

打开一次性 `service login` URL，从渲染页面核对目标 run ID 和当前 revision，保持页面打开接收 SSE／heartbeat 更新。login URL 是凭据，不写普通日志、账本或 PR；连接／会话恢复才需重新导航。打开或登录失败先按宿主文档诊断，不凭一次失败判定浏览器缺失或静默切换；重试取得新 ticket。无允许的浏览器可渲染时报告失败阶段、证据、阻塞和稳定运行 URL，不声称交付完成。Chrome／Computer Use 升级遵循 `$gui-escalation-gate`；真实程序截图逐次确认目标程序与范围。

## 修订、升级与维护

计划提案后不可变；通过 `plan-propose` 修订，由运行时判断影响，不能自声明变更类型。高影响修订保留旧 execution plan、hold 受影响任务及后继，批准后再调度；已启动任务改边界或身份必须 `task-migrate`，不覆盖历史事实。

版本不匹配先 `orchestration compatibility-check`。只有主人批准准确 run 的升级后，才执行目标版本的 `orchestration upgrade --dry-run` 和正式 upgrade；代码安装、viewer 升级、账本维护与业务控制权独立授权。升级保留 unknown／attempt／claim／容量，不重发调用，不提供编排 rollback；中断只续跑冻结目标。历史只读账本不因展示而迁移，维护不得冒充原 owner 或补造业务事实。
