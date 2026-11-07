# Dev plan goals-first contract rewrite

> Legacy compatibility snapshot. 当前有效规范见 `../dev-plan-goals-first/SPEC.md`；本文只保留旧 `#dvc8g` 身份与历史合同供恢复读取。

## 背景 / 问题陈述

- 现有 `dev-plan` 更强调 `Task Orchestration` 波次格式与 `Scope & Boundaries` 占位章节，导致计划容易“格式合规但目标不够锁定”。
- 主人明确要求新的显式 `$dev-plan` `<proposed_plan>` 回到“不落盘的临时执行规格”定位：前半段先讲摘要、目标与非目标，后半段才讲执行安排；长期知识仍只进入 `docs/specs/**` 或 `docs/solutions/**`。
- repo 内已经有两个相邻 topic spec：`docs/specs/dev-plan-flow-lock-options/SPEC.md` 处理 flow lock 选项指导，`docs/specs/fast-track-merge-intent-closeout/SPEC.md` 处理 fast-track merge intent closeout；它们都不是这次 goals-first 合同重写的直接 owner，因此本次需要单独建一个新 topic spec。

## 目标 / 非目标

### Goals

- 把显式 `$dev-plan` 的输出契约改成 goals-first：`Summary`、`Flow Decision`、`Goals`、`Non-goals`、`Task Orchestration`、`Acceptance & Validation`、`Assumptions/Defaults`。
- 明确 `<proposed_plan>` 只是当前回合的临时执行规格，不得引入 `PLAN.md`、`PLANS.md` 或其他持久计划载体。
- 强化“goals-first”不仅是章节集合，还包括章节顺序：`Goals / Non-goals` 必须在 `Task Orchestration` 之前出现。
- 默认使用简体中文撰写 `<proposed_plan>` 的自然语言正文，除非主人显式要求其他语言。
- 保留现有 `flow_type` 锁定、wave/task 编排、`$skill` 绑定、`implement-only` 禁止 spec 任务、`fast-track` / `local-merge` flow-specific 守卫。
- 为交付拓扑增加显式 `delivery_topology=direct|aggregate-stack`：旧计划缺字段按 direct 读取，aggregate-stack 必须一次写清 integration branch、child merge、final merge 与 Ticket plan 继承策略。
- 让 checker 与 replay fixtures 一起切到新口径，避免 skill 文案、校验器与样例互相漂移。

### Non-goals

- 不修改 `normal-flow`、`fast-flow`、`local-merge-flow` 的业务终点语义。
- 不把 checker 升级成“计划质量评分器”或重型语义分析器。
- 不新增第三类长期记忆载体；长期主题契约继续放 `docs/specs/**`，复用知识继续放 `docs/solutions/**`。
- 不把 required section 标题、固定字段、`flow_type` 值、executor、`$skill` 引用、命令、路径、代码标识符、日志或错误文本翻译成中文。
- 不接管未显式引用 `$dev-plan` 时的官方原味 built-in Plan Mode 默认结构。

## 范围（Scope）

### In scope

- `docs/specs/README.md`
- `docs/specs/dev-plan-goals-first/*`
- `skills/dev-plan/SKILL.md`
- `bin/plan_contract_check.sh`
- `skills/dev-plan/references/replay-cases/*`
- `skills/implement-only-flow/SKILL.md` 的最小 wording 对齐

### Out of scope

- 其他 flow skill 的终点语义重写
- GitHub / PR / merge runtime 逻辑
- 新增外部 plan 存储、plan 历史日志或进度账本

## 需求（Requirements）

### MUST

- `dev-plan` 必须把 `Goals` 与 `Non-goals` 设为必选章节，且 `Goals` 中每个 goal 都需要标题与后续关键细节说明。
- `dev-plan` 必须明确：除主人显式要求英文或其他语言外，`<proposed_plan>` 的自然语言正文默认使用简体中文。
- `dev-plan` 必须明确：required section 标题、固定字段、`flow_type` 值、executor、`$skill` 引用、命令、路径、代码标识符、日志与错误文本保持原文，不因中文优先规则被翻译。
- `dev-plan` 的推荐 skeleton 与主要正例应使用中文正文，避免示例把 Agent 输出带回英文。
- `Summary`、`Goals` 与 `Non-goals` 的必选 bullet 都必须包含非空内容；单独的空 bullet 不能充当有效章节内容。
- `Task Orchestration` 必须继续使用 wave/task 二维编排和 `$skill` 绑定，但章节职责仅限执行安排，不再承载设计说明；新计划使用 flow-scoped `main-agent` / `sub-agent:<name>` / `task:<name>` executor 与 `[model, effort]` profile。
- `Scope & Boundaries` 不再是必选章节；范围语义默认由 `Goals` 与 `Non-goals` 承担。
- checker 必须拦截：缺失 `Goals`、缺失 `Non-goals`、`Goals` 为空、goal 空标题 bullet、goal 只有标题没有细节。
- checker 必须拦截：`Summary` 只有空 bullet，以及 `Non-goals` 只有空 bullet 或空 exclusion 项。
- checker 必须拦截：goal detail 只有占位词（如 `TBD`、`待确认`）而没有具体范围/约束/成功信号的计划。
- checker 必须把常见占位缩写（如 `TBA`、`TBC`）视作与 `TBD` 同类的无效 detail / acceptance 文本。
- checker 必须拦截：章节顺序退回 execution-first、以及 `Task Orchestration` 中出现 `PLAN.md` / `PLANS.md` / progress ledger / planning decision log / handoff log 等持久计划载体。
- persisted-plan artifact matcher 必须避免误伤正常产品语义；例如 `decision log UI`、customer-provided `PLAN.md` importer，以及 `next-session decision log` exporter / integration 这类功能词汇不能仅因包含 `decision log` 或 `PLAN.md` 就被判成落盘计划载体；但带明确 planning context 的 `job/workflow/pipeline` 等 generic wording 仍必须继续拦截。
- persisted-plan artifact matcher 也必须允许产品 `plan template(s)` 相关的 decision-log/history 功能；`plan template` 属于产品面，不等于 planning context。
- 对 `decision log` / `handoff log` 来说，`plan template(s)` 应被当成显式 product-safe surface，而不是被 `plan|workflow|job` 一类 planning-context 词误吞。
- persisted-plan artifact matcher 的动作覆盖必须包含 `write/create/update` 之外的常见等价动作，例如 `generate`、`initialize`、`keep`，避免 planning artifact 因动词变体漏拦。
- checker 必须允许正常产品 `progress log` UI/API/export 功能，不得把泛化 product-facing `progress log` 任务一律判成 persisted plan artifact；但带 planning context 的 `progress log` 仍应继续拦截。
- checker 必须继续拦截对 persisted `PLAN.md` / planning artifact 的搬运式维持动作，例如 `move`、`copy`、`rename`、`archive`，不能只拦“创建/更新”。
- checker 必须继续拦截 planning artifact 的常见准备类动词，例如 `prepare` / `setup` / `set up`，避免 persisted handoff log 仅因动词变化漏拦。
- checker 对 `PLAN.md` / `PLANS.md` 的 product-safe 例外必须要求明确的产品文件/API/importer/upload 等语义锚点；单独的 `create/update/read PLAN.md` 之类泛化文件操作仍必须被拦截。
- checker 必须拒绝 `Non-goals` 中的占位 bullet（如 `TBD`、`待确认`），不能仅因为“有 bullet”就通过。
- checker 必须拦截：`Acceptance & Validation` 只有 `Notes`、`Follow-up items`、`备注` 等标签式说明，而没有真实验证活动或通过条件的计划。
- checker 必须继续保留现有 flow lock、`Flow Decision`、wave/task、`$skill`、`implement-only` 禁止项等 guardrail。
- checker 必须拒绝 aggregate-stack 缺少任一 required strategy 字段，并拒绝显式 `sub-agent:ticket` 在 Task Orchestration 中再次绑定 `$dev-plan`；同时校验 flow-scoped executor、profile 与 sub-agent 只读边界。普通 direct task 仅因提及 Ticket 或 Issue 不得被误判。
- replay fixtures 与 `CASES.txt` 必须更新到新合同，并新增至少一组 goals-first 专用失败样例。

### SHOULD

- `Summary` 保持高度概括：一句结论加少量高价值要点，不把设计细节塞进摘要。
- `Acceptance & Validation` 至少保留一条可观察的完成判据或验证方式。
- `implement-only-flow` wording 应改成通过 `Goals / Non-goals` 承担范围表达，避免继续暗示旧 section 名。

## 功能与行为规格（Functional/Behavior Spec）

### `<proposed_plan>` section contract

- `<proposed_plan>` 的主阅读顺序应是：`Summary -> Flow Decision -> Goals -> Non-goals -> Task Orchestration -> Acceptance & Validation -> Assumptions/Defaults`。
- 以上 section contract 只在主人显式引用 `$dev-plan` 时生效；未显式引用时，built-in Plan Mode 保持官方原味结构。
- `Goals` 承担结果、范围边界、接口/数据流、关键约束、成功条件等可确定细节；`Non-goals` 只承担排除范围。
- `Task Orchestration` 只回答“谁在什么波次做什么”，不重复解释目标和接口。
- 若 `Task Orchestration` 出现在 `Goals / Non-goals` 之前，则视为违反 goals-first 合同，即使章节都存在也不得通过。
- section 标题和固定字段继续作为机器合同使用英文；标题下的 owner-facing 说明、goal 细节、non-goal、任务描述、验收标准和假设默认使用简体中文。

### Non-persistent plan boundary

- `dev-plan` 产生的计划不落盘，不创建 `PLAN.md`、`PLANS.md`、planning decision log、progress ledger 等持久计划文档。
- `Task Orchestration` 若显式要求写入、维护、同步、追加上述持久计划文档，也必须被 checker 拦截。
- 如果实现过程中出现需要长期保留的稳定契约，必须写入 spec；如果出现跨任务复用经验，必须写入 solution。

### Checker contract

- `bin/plan_contract_check.sh` 继续定位为结构契约检查器。
- `run_cases()` 必须把相对 fixture 路径解析到 `CASES.txt` 所在目录，而不是依赖调用方当前工作目录。
- 新增的 goals-first 检查只验证最低结构充分性，不自动评价计划是否“最佳”。
- checker 必须显式验证 required section order，不能只检查 section 是否“存在 somewhere”。
- checker 必须显式拒绝 `Task Orchestration` 中的持久计划载体任务，而不是只依赖 skill prose。
- checker 对持久计划载体的匹配必须足够窄，避免把正常功能实现词汇误判成 plan artifact。
- 已有 flow 绑定与实现安全边界不得因本次 section 改名而退化。
- aggregate-stack 只能在已声明 `delivery_topology` 时启用；缺失 topology 的历史计划继续按 legacy direct 通过，避免把新增合同反向施加给旧会话。

## 验收标准（Acceptance Criteria）

- Given 更新后的 `skills/dev-plan/SKILL.md` When 主人或 agent 阅读 contract Then 必须能看到 goals-first、non-persistent plan 和 `Task Orchestration` 仅负责安排的明确规则。

- Given 主人在 built-in Plan Mode 中显式引用 `$dev-plan`，且没有显式要求英文计划 When agent 输出 `<proposed_plan>` Then 自然语言正文应以简体中文为主，同时保留 required section 标题、固定字段、`flow_type` 值、executor、`$skill` 引用、命令、路径、代码标识符、日志与错误文本的原文。

- Given 更新后的 `bin/plan_contract_check.sh` When 检查缺失 `Goals`、缺失 `Non-goals`、`Goals` 为空、goal 无细节的 replay fixture Then 必须分别报出对应 finding，并让案例按预期失败。

- Given 更新后的 `bin/plan_contract_check.sh` When 检查 `Task Orchestration` 早于 `Goals / Non-goals` 或 orchestration 中出现 `PLAN.md` / progress ledger 的 replay fixture Then 必须分别报出 section order 与 persisted artifact 对应 finding，并让案例按预期失败。

- Given 现有 flow lock / wave / skill binding / implement-only 禁止项 replay fixtures When 跑完整 replay 套件 Then 既有 required code 仍然成立，不得因为 goals-first 改造而失去原本 guardrail。

- Given 一个 aggregate-stack `<proposed_plan>` When 缺少 `integration_branch`、`child_merge_policy`、`final_merge_policy` 或 `ticket_plan_policy` 任一字段 Then checker 必须给出对应 finding；完整 aggregate 计划与 legacy direct 计划必须通过。

- Given 一个 aggregate-stack `<proposed_plan>` 使用 `prd/My_Topic` 这类非 lowercase kebab-case integration branch When checker 解析 Flow Decision Then 它必须在计划阶段拒绝该 branch，避免后续 Ticket envelope 才发现不兼容的 initiative identity。

- Given 一个显式 `sub-agent:ticket` 实现任务 When Task Orchestration 让它再次调用 `$dev-plan` Then checker 必须拒绝该计划；Ticket 必须继承批准计划并由 `$implement` 执行。

- Given 一个 `delivery_topology=direct` 的 `main-agent` 任务 When 该任务实现 `$dev-plan` 的 Issue/Ticket 解析能力并绑定 `$dev-plan` Then checker 必须接受它，不能只因描述文本包含 Ticket 或 Issue 而套用 Ticket 重规划禁令。

## 验收清单（Acceptance checklist）

- [ ] goals-first 章节顺序与职责已经在 skill 中写清楚。
- [ ] 不落盘计划的边界已经显式写入 contract。
- [ ] 简体中文优先与机器合同 token 不翻译的语言边界已经写入 skill。
- [ ] checker 已能识别 goals-first 最低结构错误。
- [ ] checker 已能拦截 execution-first 章节顺序回退。
- [ ] checker 已能拦截持久计划载体任务。
- [ ] replay fixtures 已覆盖新老 guardrail。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `bash bin/plan_contract_check.sh --cases skills/dev-plan/references/replay-cases/CASES.txt`
- `git diff --check`

### Quality checks

- 人工 spot-check `skills/dev-plan/SKILL.md` 的前 200 行，确认没有继续暗示持久 plan 文件。
- 人工 spot-check 正例与失败样例，确认 `Goals / Non-goals` 已成为计划主体。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：若只改 skill 文案、不改 checker 与 fixtures，repo 会重新出现多个“真相源”互相打架。
- 风险：若 goals 检查写得过重，可能把 checker 误推成计划质量评估器，因此本次只做最低结构门禁。
- 假设：现有实现方接受 `Goals` 使用“标题 bullet + 后续说明行”这种轻量结构，不需要引入表格或额外 schema。

## 参考（References）

- `docs/specs/dev-plan-flow-lock-options/SPEC.md`
- `docs/specs/fast-track-merge-intent-closeout/SPEC.md`
- `skills/dev-plan/SKILL.md`
- `bin/plan_contract_check.sh`

## Visual Evidence

PR: none

本兼容规范只描述计划合同、checker、迁移器与 replay fixtures，不产生 UI 或其他视觉交付面。
