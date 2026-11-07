# 全局 solutions 复利模型与 docs-migrate 统一迁移技能

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 当前全局工程流程把 `docs/specs/**` 作为主规范，但没有与之对等的全局经验知识库入口。
- 历史上存在 `docs/notes` 一类经验笔记诉求，也存在 `prompts/plan-migrate.md` 这种只覆盖 spec/planning 文档的迁移入口。
- 若继续维持“spec-only + prompt-era migration”，知识无法在开工前检索、收口时沉淀，也无法在重构后被系统刷新。

## 目标 / 非目标

### Goals

- 将全局文档模型收敛为 `specs + solutions`：`specs` 管长期 topic-level spec，`solutions` 管跨任务经验。
- 用正式 skill `docs-migrate` 取代 `plan-migrate` 的主入口职责，统一覆盖 `specs / solutions / auto` 三种迁移模式；legacy prompt 仅保留兼容 shim。
- 在全局 AGENTS 与核心 flow 中加入 solution lookup、solution disposition、solution refresh 三道门禁，并补一个日常使用的 `$solution-sync` 入口。
- 新 Spec 采用 slug-only path；已有 ID path 保留读取兼容，目录规范化只在显式 `$docs-migrate MODE=specs-hygiene` 确认后执行。

### Non-goals

- 不为 `solutions` 引入独立 id、全局台账或额外 README 级索引。
- 不批量迁移业务仓库中的历史 notes/spec 文档。
- 不改变 `implement-only` 的 spec-gate 语义。

## 范围（Scope）

### In scope

- 新增 `docs/solutions/README.md` 与分类目录、solution frontmatter 与状态约定。
- 新建 `skills/docs-migrate/` 并迁移 `prompts/plan-migrate.md` 能力。
- 更新 `.codex/AGENTS.md`、`skills/docs-plan/SKILL.md`、`skills/project-engineering-workflow/SKILL.md`、`skills/solution-sync/SKILL.md`、`prompts/goto-impl-branch.md` 等入口。
- 把 legacy `prompts/plan-migrate.md` 收敛成只负责转发到 `$docs-migrate` 的兼容 shim。

### Out of scope

- 外部项目仓库中的实际 docs 迁移执行。
- 为 `solutions` 引入独立 id 或强制索引台账。

## 需求（Requirements）

### MUST

- `docs/solutions/**` 成为全局显式知识库，路径固定为 `docs/solutions/<category>/<slug>.md`。
- `solutions` 默认不使用 id；身份由 `category + slug + frontmatter` 提供。
- `docs-migrate` 必须保留 docs-only、删除前确认、一对一迁移、引用检查等安全边界。显式 docs 迁移任务默认需要主人确认候选集合；但 shared Step 2 mandatory gate 下，对确定性的 task-relevant legacy docs 子集允许无额外确认自动迁移。若 legacy source 是 notebook-style / monolithic catch-all note（尤其根 `docs/notes.md`），允许把当前任务直接相关的 subsection(s) / slice 提升为 canonical `docs/solutions/**`，而不强迫整份文档一次性整体迁完。
- `docs-migrate` 的 `specs` 模式必须继续兼容 legacy `docs/plan/** -> docs/specs/**` 迁移，并直接产出 `docs/specs/<topic>/`；`$docs-plan-id` 只保留显式 legacy compatibility shim。
- `docs-migrate` 的 `specs` 模式在建立 canonical `docs/specs/**` 时，必须一次补齐 `SPEC.md`、`IMPLEMENTATION.md`、`HISTORY.md`，不能只留下孤立 `SPEC.md`。
- `docs-migrate` 的 `specs` 模式不得把 `docs/plan/README.md` 这类 legacy index/landing 文档误判成一对一 spec 候选。
- 即便 `docs/plan/README.md` 不是一对一 spec 候选，`docs-migrate` 的 `specs` 模式在 legacy-plan-only 仓库里仍必须能 bootstrap canonical `docs/specs/README.md`，避免 Step 2 因缺 canonical spec root 而卡死。
- `docs-plan` 的 root-resolution 必须在 dedicated docs/topic branch 或隔离 worktree 上调用 `$docs-migrate MODE=specs`；受保护分支保持只读，不能绕过该保护写入 canonical spec。
- 当 `docs-migrate` 只是为了清掉 shared Step 2 / `goto-impl` 的 canonical spec gate 时，若删除 legacy 源文档仍需主人确认，允许先保留旧路径并继续；但必须把 canonical `docs/specs/**` 视为权威输入，并显式记录 `pending delete approval`，不得把 cleanup 说成已完成。
- `docs-migrate` 的 `solutions` 模式必须支持 `docs/notes/**/*.md`、根 `docs/notes.md`，以及常见的 `docs/troubleshooting/**` / `docs/workflow/**` / `docs/learnings/**` 一类知识文档迁移到 `docs/solutions/**`。
- 当同一 monolithic legacy knowledge doc 在一轮里拆出多个 subsection / slice 时，`solutions` 轨必须为每个迁移单元生成不同的 canonical slug/path；不得因为共用源标题或文件名而发生目标路径碰撞。
- 当 `docs-migrate` 只是为了清掉 shared Step 2 / review 前置 knowledge gate 时，`solutions` 轨也必须允许先建立 canonical `docs/solutions/**`、再把 legacy notes 保留为 `pending delete approval`；不得让 delete approval 反过来堵死 mandatory solution gate。
- 全局流程必须显式要求：开工前查 solutions、收口前判定 `solution_disposition`、重构/迁移后 refresh solutions。
- `$solution-sync` 必须成为 shared solution gate 的 canonical 日常入口：focused lookup、`solution_disposition` 判定与 canonical `docs/solutions/**` 写入/refresh 都优先走它；legacy knowledge 的迁移仍由 `$docs-migrate` 负责。
- `/prompts:goto-impl-branch` 若发现 task-relevant legacy knowledge docs（`docs/notes/**/*.md`、`docs/notes.md`、`docs/troubleshooting/**/*.md`、`docs/troubleshooting.md`、`docs/workflow/**/*.md`、`docs/workflow.md`、`docs/learnings/**/*.md`、`docs/learnings.md`），不得把 solutions migration gate 仅当作提示交给主人；它必须先在 handoff 前清掉该 shared Step 2 gate（允许停在 canonical 已建立但 legacy delete 仍 `pending delete approval` 的检查点）。
- 当 focused Solution Lookup 明确未命中任何 task-relevant canonical solution 或上述 legacy knowledge docs 时，共享流程必须允许把 `solution_disposition` 初始化为 `none`，而不是在 Step 4 因 `未检查` 被无条件卡死。
- legacy-plan-only 仓库必须先在非受保护分支完成 `docs/specs/<topic>/` canonicalization；实现分支命名不再依赖 `SPEC_ID`。
- `/prompts:plan-migrate` 作为兼容 shim 时，必须继续保留 trailing text 的过滤语义，并把它传给 `$docs-migrate` 作为 `PATH_HINTS`；不得把旧调用静默扩成 repo-wide 扫描，也不得把旧有“迁移 planning/spec 文档”的默认语义改写成 `solutions` / `auto` 分流。

### SHOULD

- `docs-migrate` 支持 `auto` 模式，按 planning/spec 与知识文档特征自动分流。
- `docs/solutions/README.md` 提供最小 frontmatter schema、目录选择规则与何时更新/替换/作废 solution 的说明。
- 旧 prompt-era 文案应被清理，避免未来 run 继续把 `/prompts:plan-migrate` 当成 canonical 入口；若保留 shim，也只允许用于兼容。

### COULD

- 提供少量示例路径或示例 frontmatter，帮助后续仓库对齐。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 当主流程命中 spec gate 时：仍以 `docs/specs/**` 为 topic-level spec；若需要迁移 legacy 计划文档，则调用 `$docs-migrate` 的 `specs` 或 `auto` 模式，而不是 prompt。
- 当主流程或 `goto-impl` 只是为了先建立 canonical spec 输入时：允许在 delete-confirm checkpoint 前先停在“canonical spec 已建立、legacy cleanup 待批准”的状态，但必须显式报告 pending cleanup。
- 当任务需要复用既有经验时：全局规则与共享工程流会把 `docs/solutions/**` 视为默认检索入口。
- 当一次实现/评审收口发现新经验、补强旧经验或大改导致旧经验漂移时：主流程要求声明 `solution_disposition=none|update|create|refresh`。
- 当用户显式要求迁移 docs 体系时：`$docs-migrate` 根据 `mode` 执行 `specs`、`solutions` 或 `auto` 迁移，并在 docs-only 边界内完成链接修复与旧文档删除。

### Edge cases / errors

- 若候选文档无法明确归入 planning/spec 或 knowledge/solution，`docs-migrate` 必须阻断并要求主人确认，而不是猜。
- 若候选文档是 ADR/RFC/Architecture/Design 等设计文档，默认排除迁移。
- 若 `solutions` 迁移发现高重叠目标，v1 仅允许阻断/提示；不在首次迁移中自动合并多篇来源。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| docs-migrate | skill | internal | New | None | codex-global | 主工程流程 / docs 迁移任务 | 取代 `plan-migrate` 的主入口职责 |
| solution-sync | skill | internal | New | None | codex-global | 主工程流程 / PR 收敛 / 日常 solution 维护 | canonical 日常 solution gate 入口 |
| docs/solutions | docs taxonomy | internal | New | None | codex-global | 主工程流程 / 未来仓库 | 默认知识库入口 |
| solution_disposition | workflow field | internal | New | None | codex-global | project-engineering-workflow / local-merge-flow / normal-flow / fast-flow | 收口前必须判定 |

### 契约文档（按 Kind 拆分）

None

## 验收标准（Acceptance Criteria）

- Given 当前 `.codex` 仓库仍有 `prompts/plan-migrate.md`，When 本轮实现完成，Then 它最多只保留为兼容 shim，且仓库内不再把 `/prompts:plan-migrate` 当成 canonical docs 迁移入口。
- Given 一个只包含 legacy `docs/plan/**` 的 planning/spec 文档场景，When 使用 `$docs-migrate` 的 `specs` 模式，Then 能迁移到 slug-only `docs/specs/<topic>/`、保持 README 创建顺序与删除前确认。
- Given 同一 legacy planning/spec 场景通过 `$docs-migrate MODE=specs` 完成 canonicalization，When 下一轮 shared Step 2 / drift gate 读取新建的 `docs/specs/**`，Then 对应 spec 目录已经包含 `SPEC.md`、`IMPLEMENTATION.md`、`HISTORY.md`，不会因为 companion docs 缺失被立即阻断。
- Given 同一场景里还存在 `docs/plan/README.md` When `$docs-migrate` 发现 specs 候选 Then 不得把该 legacy index README 当成一对一 spec 候选或生成伪造的 canonical Spec。
- Given 一个 legacy-plan-only 仓库里只剩 `docs/plan/README.md` 而尚无 `docs/specs/README.md` When `$docs-migrate` 执行 `MODE=specs` Then 它仍必须先 bootstrap canonical `docs/specs/README.md`，即使没有任何可做一对一迁移的 spec 候选，也不能把仓库留在“没有 canonical specs root”的状态。
- Given 主人在受保护默认分支上开启一个 legacy-plan-only 仓库的 planning session When `docs-plan` 做 specs-first root resolution Then 它必须先进入 dedicated docs/topic branch 或隔离 worktree；未切走前只做预演，不能在默认分支旁路写入。
- Given 一个包含 `docs/notes/**/*.md`、根 `docs/notes.md` 或常见 `docs/troubleshooting/**` / `docs/workflow/**` / `docs/learnings/**` 知识文档的场景，When 使用 `$docs-migrate` 的 `solutions` 模式，Then 会生成 `docs/solutions/<category>/<slug>.md`、补齐 frontmatter、修复 docs 引用，并且不会创建 solution id。
- Given `solutions` 迁移是为了清掉 shared Step 2 / review 前置 knowledge gate，且旧 notes 删除仍需主人确认 When `$docs-migrate` 执行 `MODE=solutions` Then 它可以先建立 canonical `docs/solutions/**` 并把旧 notes 标记为 `pending delete approval`，而不是因为“尚未删除旧文件”卡死在 gate 前。
- Given 根 `docs/notes.md` 或其他 legacy note 是 monolithic catch-all 文档，且只存在一个与当前任务直接相关的 subsection / slice When shared Step 2 或 `$docs-migrate` 的 `solutions` 轨为当前任务清 gate Then 允许只把这段 task-relevant subsection / slice 提升为 canonical `docs/solutions/**`，并保留其余无关内容在原 legacy 文档中，不能要求把整份混装文档一次性整体迁完。
- Given 同一 monolithic legacy note 在一轮里要拆出多个 task-relevant subsection / slice When `$docs-migrate` 规划 canonical `docs/solutions/**` 映射 Then 每个 subsection / slice 都必须带有稳定的子标题/anchor 区分符，从而得到不同的 slug/path，而不是互相覆盖到同一个 canonical solution 文件。
- Given monolithic legacy note 只被部分抽取，而旧文档仍保留其余主题内容 When `$docs-migrate` 处理 Markdown 入站链接 Then 不得把所有旧链接一刀切改写到新 canonical solution；只有那些能明确证明原本就在引用被抽取 subsection / slice 的链接才允许重写，其余链接必须继续指向保留的 legacy note。
- Given 核心工程流程继续推进实现任务，When 流程进入开工前、收口前与重构后刷新阶段，Then 全局规则已能明确提示 solution lookup、solution disposition 与 solution refresh，且 shared Step 2 上的确定性 legacy-docs 迁移不会把自动流程降级成必须停下来等主人确认。
- Given 当前 run 命中了已有 solution 或 review/CI 暴露出新的可复用经验，When main-agent 需要清掉 solution gate，Then 默认通过 `$solution-sync` 完成 focused lookup、`solution_disposition` 判定与 `docs/solutions/**` 写入/refresh；只有 legacy source 仍未 canonicalize 时才先切到 `$docs-migrate`。
- Given `/prompts:goto-impl-branch` 发现 task-relevant legacy knowledge docs（`docs/notes/**/*.md`、`docs/notes.md`、`docs/troubleshooting/**/*.md`、`docs/troubleshooting.md`、`docs/workflow/**/*.md`、`docs/workflow.md`、`docs/learnings/**/*.md`、`docs/learnings.md`） When 它准备把 topic branch handoff 到实现阶段 Then 它必须先清掉 shared Step 2 的 solutions migration gate（允许 canonical 已建立但 legacy delete 仍 `pending delete approval`），而不是把未执行的 gate 只写进摘要后继续 handoff。
- Given focused Solution Lookup 明确未命中任何 task-relevant canonical solution 或上述 legacy knowledge docs When 当前 run 继续推进到 Step 4 收口 Then 共享流程必须允许把 `solution_disposition` 记为 `none`，不得因为 `未检查` 而无条件阻断无关任务。
- Given 当前工作命中一个只有 legacy `docs/plan/**` 且 canonical topic 尚未知的仓库 When 它需要把主人带到正确的实现分支 Then 它必须先在非受保护分支建立 canonical `docs/specs/<topic>/SPEC.md`，再进入实现分支；若旧 `docs/plan/**` 删除仍待主人确认，只能报告 `pending delete approval`，不能把 cleanup 伪装成已完成。
- Given 旧的 `/prompts:plan-migrate` 调用仍携带附带路径/关键字（例如某个具体 legacy doc 路径） When 兼容 shim 把请求转交给 `$docs-migrate` Then 这些 trailing text 必须继续作为 `PATH_HINTS` 缩小候选范围，而不是被忽略导致 repo-wide 扫描。
- Given 旧的 `/prompts:plan-migrate` 宏或习惯调用没有额外说明 taxonomy When compatibility shim 接手该调用 Then 它必须继续把这次调用解释为 planning/spec 迁移并转给 `$docs-migrate MODE=specs`；若要迁移 notes/learnings/troubleshooting 或混合 taxonomy，必须改为直接调用 `$docs-migrate`。
- Given 后续 run 读取新的全局 AGENTS/skills，When 它们恢复旧 session，Then 现有 flow 锁定语义与 legacy ID path 的读取兼容性不被破坏。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: 如为新脚本补辅助脚本，则至少做基础 CLI happy-path 与分类分流自检。
- Integration tests: 用最小夹具覆盖 `specs`、`solutions`、`auto` 三种迁移模式。
- E2E tests (if applicable): None。

### UI / Storybook (if applicable)

- Not applicable。

### Quality checks

- `python3 -m compileall`（若新增 Python 脚本）
- 与本次改动直接相关的文本 grep / 入口检查
- 必要时执行 `bash /Users/ivan/.codex/bin/plan_contract_check.sh` 等已有局部脚本

## Visual Evidence

None

## 方案概述（Approach, high-level）

- 先落 spec，把新文档模型与迁移 skill 契约钉死，再做 skill/规则改造。
- `specs` 与 `solutions` 职责分离：前者继续是长期主题规范，后者是可检索、可更新、可替换的知识资产。
- `docs-migrate` 只解决 taxonomy 迁移与安全边界，不在 v1 内承担大规模知识去重/合并。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：全局 AGENTS/flow 文案一旦写得过重，可能影响旧 session 恢复与未来默认路由。
- 需要决策的问题：`docs/solutions` v1 分类是否先保持 3 类最小集。
- 假设（需主人确认）：不需要为 `solutions` 额外引入 index 表或 id。

## 参考（References）

- `skills/docs-migrate/SKILL.md`
- `skills/docs-migrate/references/specs-mode.md`
- `skills/docs-migrate/references/solutions-mode.md`
- `skills/docs-plan/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/solution-sync/SKILL.md`
- `AGENTS.md`
