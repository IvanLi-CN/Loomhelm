# Storybook skill 增强与 docs-first 交付规范

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## Context and Scope

This canonical spec governs the repository-local Storybook skills and their shared full-page visual-evidence routing. The page fallback rule below is limited to canonical skills, metadata, replay coverage, and related implementation status; legacy ID-prefixed specs and HISTORY remain unchanged.

## Requirements

### REQ-STORYBOOK-PAGE-FALLBACK-EXCEPTION

Full-page or page-flow Storybook fallback MUST require both an absent qualified `ui_demo` and an existing explicit owner, project, or active-spec page exception. The absence of `ui_demo` alone MUST NOT authorize the fallback, and an owner-locked non-Storybook source MUST continue to block it.

## Verification

### VER-STORYBOOK-PAGE-FALLBACK-EXCEPTION covers: REQ-STORYBOOK-PAGE-FALLBACK-EXCEPTION

Verify the canonical skills, three affected `agents/openai.yaml` files, implementation status, and focused replay cases. The replay checker must emit `FULL_PAGE_STORYBOOK_FALLBACK_WITHOUT_EXPLICIT_EXCEPTION` for the no-exception case, preserve direct owner, project-documentation, active-spec, and direct English grant exception passes, preserve component and owner-lock outcomes including English owner-source locks, reset prior page authorization or missing-`ui_demo` state when any new user full-page request begins even when it also names a component, bind missing-demo facts, authorization, and owner locks to the named page, retain every page-scoped owner lock in one user event, require a unique page target for an otherwise ambiguous multi-page Storybook route, reject a multi-page route that names only one page and would inherit that page's grant, permit an explicit owner lock withdrawal for that same page, treat an explicitly unavailable qualified `ui_demo` as missing but do not treat conditional absence wording as confirmed evidence, require qualified or stable availability before clearing missing-demo state, give current qualified `ui_demo` evidence precedence when one message contains historical absence and current availability, recognize missing-demo wording without treating negated or unqualified availability as current availability, evaluate permission clauses within the same page/fallback clause so a later unambiguous page approval can supersede historical denial without importing unrelated approvals, retain denial cues across intervening wording, carry a conditional follow-up such as `This approval takes effect only after ...`, `This exception is conditional ...`, or `after owner approval` onto the preceding page authorization, treat a trailing page-specific exclusion such as `not for this page` as a denial for that page, require release approvals to mention the Storybook fallback itself, reject conditional approval wording including `only after`, reject derived English denial forms such as `disallowed`, and treat negated, not-yet-approved, or question wording as no authorization with exactly one expected blocker finding; a request explicitly limited to a reusable component must not create a full-page fallback context.

After a component-only turn, an assistant's subsequent explicit page-level Storybook result must still pass the page exception gate and preserve that page's owner lock. Storybook evidence explicitly limited to the reusable component remains allowed.

Only an explicit withdrawal of that page's source requirement may release its owner lock; revoking another page's source requirement or a Storybook fallback must not release the lock.

## Related ADRs

None

## 背景 / 问题陈述

- 当前 `storybook-stories` 只要求“补一个能渲染的 story”，更像最低合格线，不足以驱动 Web UI 项目的系统化展示、组件状态矩阵与交互验证。
- 当前 `storybook-screenshots` 只支持 `storybook_canvas`，无法直接把 docs 页里的状态矩阵作为 PR 视觉证据。
- `docs-plan` 模板、skills 索引与 workflow PR publication procedure 的来源枚举还没有同步 Storybook docs-first 的工作方式，导致 Storybook 更像可选附属物，而不是稳定的 UI 交付面。

## 目标 / 非目标

### Goals

- 将 `storybook-stories` 升级为组件/片段优先的 Storybook 交付 skill：默认补 stories、聚合 docs 页、主要状态矩阵与关键 `play` 交互验证。
- 将 `storybook-screenshots` 升级为同时支持 `storybook_canvas` 与 `storybook_docs` 两类 mock 视觉证据来源。
- 同步 workflow PR publication procedure、`docs-plan` 模板、skill 元数据与 skills 索引，使 Storybook 相关约束在 UI 任务中可被稳定发现与复用。
- 保持现有 skill 名称与入口不变，避免把既有调用链打碎。
- 明确完整页面/流程默认通过稳定 `ui_demo` 取证；只有缺少合格 `ui_demo` 且 owner、project 或 active spec 已明确授权页面级例外时才 fallback 到完整页面级 Storybook，缺少 `ui_demo` 本身不构成授权。

### Non-goals

- 不新增第三条顶层 Storybook workflow skill。
- 不引入新的截图后端、视觉回归平台或额外的外部依赖。
- 不修改任何具体业务仓库的 Storybook 配置或示例代码。

## 范围（Scope）

### In scope

- `skills/storybook-stories/**`
- `skills/storybook-screenshots/**`
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- `skills/docs-plan/templates/SPEC.md`
- `skills/README.md`
- `docs/specs/README.md`

### Out of scope

- PR body image helper 的 URL 改写机制
- 业务仓库里的组件、页面、测试实现
- 与 Storybook 无关的 UI 交付技能

## 需求（Requirements）

### MUST

- `storybook-stories` 必须把“新/改 UI 组件、片段或可复用状态 => stories + docs/state gallery + 必要交互验证”定义成默认交付。
- 若仓库支持 Storybook docs，组件/片段必须默认补聚合 docs 页，且 docs 以静态展示为主，不默认依赖 Controls/可调参面板。
- 组件/片段必须默认覆盖主要状态矩阵。
- 页面内部 UI 若具备独立状态、交互或复用价值，默认应抽成组件/片段并补 Storybook；纯布局、文案或无交互的一次性 glue UI 可由 `ui_demo` 页面证据覆盖。
- 完整页面/流程默认不要求新增页面级 Storybook；视觉证据默认来自合格 `ui_demo`。
- 当缺少合格 `ui_demo` 且存在 owner、project 或 active spec 已明确授权的页面级例外时，允许 fallback 到完整页面级 Storybook，并要求关键验收行为的 `play` 覆盖；没有该例外时必须报告 blocker。
- 若主人显式锁定完整页面/流程的最终证据来源为 `web demo`、`ui_demo` 或其他非 Storybook 来源，Storybook skill 只能维持组件/片段覆盖或报告 blocker/fallback 背景，不得把 Storybook 结果表述成满足该锁定要求。
- `storybook-screenshots` 必须支持 `source_type=storybook_canvas|storybook_docs`，两者都归类为 mock 证据。
- workflow PR publication procedure 的视觉证据来源枚举必须同步新增 `storybook_docs`。
- `docs-plan` 模板里的 Storybook 质量门槛必须显式覆盖 stories、docs pages、play/interactions。
- `storybook-screenshots` 与 `docs-plan` 模板在讲 PR 图片选择器时，必须只使用 `PR: include` / `PR: none` 两种语义；像 `Recommended PR subset...` 这类自然语言提示不得再被描述成有效 selector。
- `storybook-stories` 与 `storybook-screenshots` 都必须有匹配的 `agents/openai.yaml`，且文案与增强后的职责一致。

### SHOULD

- `storybook-stories` 应把状态覆盖矩阵与 docs 布局准则拆到独立 reference，避免 `SKILL.md` 过长。
- `storybook-screenshots` 应优先推荐 docs 网格截图用于多状态证明，单一状态或交互节点继续优先 canvas 截图。
- `skills/README.md` 应把两条 Storybook skill 都列为可发现入口。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- UI 组件/片段变更时，`storybook-stories` 先检测 Storybook 与 docs 能力，再按仓库现有约定补充或更新：
  - 独立 stories；
  - 聚合 docs 页；
  - 适用的 `play` 交互测试。
- docs 页必须以适合浏览的静态陈列为主，推荐 1-3 列响应式网格，一页展示多个主要状态；每个展示状态仍要保持为可独立访问的 story。
- 完整页面/流程默认用稳定 `ui_demo` 提供视觉证据；Storybook 只承担其中可复用组件/片段的状态覆盖。
- 若缺少合格 `ui_demo` 且已有 owner、project 或 active spec 明确授权页面级例外，页面/流程 Storybook fallback 必须代表完整页面，并在 `play` 中覆盖关键验收路径；例外不存在时必须报告 blocker。
- `storybook-screenshots` 在生成 PR 证据时：
  - 多状态总览优先允许从 docs 内容区域截图；
  - 单状态、动效前后对比或交互节点继续允许从 canvas 截图。

### Edge cases / errors

- 若仓库检测到 Storybook 但没有 docs/autodocs/MDX 能力，`storybook-stories` 不得静默跳过 docs；必须要求补齐既有栈支持的 docs 路径，或明确报 blocker。
- 若页面/流程缺少合格 `ui_demo` 且已有明确页面级例外需要 Storybook fallback，`storybook-stories` 必须要求先查仓库既有 mock/provider 约定，不允许现编私货式方案；没有明确例外时必须报告 blocker。
- 若页面/流程已经被主人显式锁定为非 Storybook 证据来源，`storybook-stories` 与 `storybook-screenshots` 不得把 Storybook fallback 写成最终成功态。
- 若 `storybook_docs` 用作截图来源，`storybook-screenshots` 仍不得截入 Storybook chrome、地址栏或无关 UI。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| `storybook-stories` workflow contract | skill | internal | Modify | in-spec | Codex skills | UI implementation turns | 新增 docs-first、状态矩阵、`play` 约束 |
| `storybook-screenshots` source types | skill | internal | Modify | in-spec | Codex skills | PR visual evidence flows | 新增 `storybook_docs` |
| `ui_demo` page evidence boundary | skill | internal | New | in-spec | Codex skills | UI visual evidence flows | 完整页面/流程默认使用稳定 mock-only demo surface |
| workflow PR publication visual evidence source enum | procedure | internal | Modify | in-spec | Codex skills | PR setup flow | 接受 `storybook_docs` |
| `docs-plan` Storybook quality gate | template | internal | Modify | in-spec | Codex skills | specs authors | 模板要求 stories + docs + interactions |

### 契约文档（按 Kind 拆分）

- None. 本计划只修改内部 skill/template 契约，以上表与对应 `SKILL.md`/模板正文即为真相源。

## 验收标准（Acceptance Criteria）

- Given `storybook-stories` When skill 被用于 Web UI 组件、片段或可复用状态任务 Then 文本必须把 stories、docs 页与适用的 `play` 测试都视为默认交付，而不是可选建议。

- Given 当前变更是完整页面/流程视觉证据 When 存在稳定 mock-only `ui_demo` Then 不得强制新增完整页面级 Storybook；应从 `ui_demo` 取证。

- Given 当前变更是完整页面/流程视觉证据 When 缺少合格 `ui_demo` 且存在 owner、project 或 active spec 明确授权的页面级例外 Then 允许使用完整页面级 Storybook fallback，并覆盖关键验收行为；若没有该例外则报告 blocker。

- Given 主人已显式要求最终证据来自 `web demo` / `ui_demo` When 页面/流程 later 只能从 Storybook 取图 Then Storybook skill 不得把该结果报告为满足锁定要求；必须把控制权交回统一视觉证据门禁以报告 blocker 或等待主人改口。

- Given `storybook-stories` When 仓库支持 Storybook docs Then skill 必须要求为组件/片段提供静态状态画廊型 docs 页，并说明 docs 默认不以 Controls playground 为主。

- Given `storybook-screenshots` When 任务需要 Storybook 视觉证据 Then skill 必须接受 `storybook_canvas` 与 `storybook_docs` 两种来源，并给出对应的 capture / metadata 规则。

- Given `storybook-screenshots` 或 `docs-plan` 模板 When 文本描述 PR 图片选择器 Then 只能教 `PR: include` / `PR: none`，不得再把自然语言 `Recommended PR subset...` 之类的说明表述成有效选择器。

- Given workflow PR publication procedure When 读取视觉证据来源枚举 Then 必须能看到 `storybook_docs` 被支持并指向 `$storybook-screenshots`。

- Given `skills/README.md` When 浏览 Storybook 相关 skill Then 必须同时看到 `storybook-stories` 与 `storybook-screenshots`，且简介能反映 docs-first 与视觉证据职责。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `python3 skills/.system/skill-creator/scripts/quick_validate.py skills/storybook-stories`
- `python3 skills/.system/skill-creator/scripts/quick_validate.py skills/storybook-screenshots`
- `python3 skills/.system/skill-creator/scripts/generate_openai_yaml.py skills/storybook-stories --interface ...`
- `python3 skills/.system/skill-creator/scripts/generate_openai_yaml.py skills/storybook-screenshots --interface ...`
- `git diff --check`

### UI / Storybook (if applicable)

- Stories to add/update: `storybook-stories` contract, `storybook-screenshots` capture contract, `ui-visual-evidence` source enum, workflow PR publication source enum, `docs-plan` Storybook gate
- Visual regression baseline changes (if any): None

### Quality checks

- Skills 索引与 agents metadata 文案对齐
- Storybook 新旧来源兼容性人工 review

## Visual Evidence

## 方案概述（Approach, high-level）

- 继续沿用现有两条 Storybook skill 的职责边界，但把 `storybook-stories` 收敛为组件/片段/可复用状态的 UI 交付真相源，把 `storybook-screenshots` 抬升为 docs/canvas 双来源证据源。
- 完整页面/流程的默认视觉证据由稳定 `ui_demo` 承担，Storybook 页面级覆盖只作为缺少合格 `ui_demo` 且存在现有明确页面级例外时的 fallback；缺少 `ui_demo` 单独不授权页面级 Storybook。
- 用一份轻量 reference 承载状态矩阵与 docs 布局建议，避免核心 `SKILL.md` 变成大杂烩。
- 所有联动点只做必要增量兼容，不引入新的 top-level flow 或新的外部工具依赖。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：若业务仓库已有特殊 Storybook 约定，skill 需要优先继承仓库现有写法，不能把这里的 fallback 当成强制实现样式。
- 风险：`storybook_docs` 进入截图来源后，若调用方仍只识别旧枚举，可能需要补更多联动点；本轮先覆盖 workflow PR publication procedure 入口。
- 假设：增强后的 Storybook 规范主要用于 Web UI 仓库；非 UI 仓库检测不到 Storybook 时仍按 skip 路径工作。

## 参考（References）

- `skills/storybook-stories/SKILL.md`
- `skills/storybook-screenshots/SKILL.md`
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- Storybook official docs: docs blocks / MDX / `play` / mocking
