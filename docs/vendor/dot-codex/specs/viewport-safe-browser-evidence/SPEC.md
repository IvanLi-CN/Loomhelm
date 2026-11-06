# Viewport-safe browser evidence capture

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 当前 Storybook / 浏览器证据链已经要求 mock-first、元素优先与稳定来源，但没有把“指定 viewport 的截图必须怎样达成”钉成硬规则。
- 这留下了执行歧义：agent 很容易退化成“打开 Storybook canvas 页面、调整浏览器窗口尺寸、再截 browser viewport”，导致浏览器会话被持续改窗，和视觉证据本身混在一起。
- 如果不收紧这条契约，后续 `ui_demo`、`storybook_canvas`、`storybook_docs` 与 `mock_ui` 仍可能重复走同样的坏路径，既影响主人复查，也让截图元数据缺少一致真相源。

## 目标 / 非目标

### Goals

- 统一 `ui_demo`、`storybook_canvas`、`storybook_docs` 与 `mock_ui` 的 viewport-safe 截图契约：默认不依赖浏览器窗口 resize 来满足目标尺寸。
- 明确浏览器证据的优先级：来源自带 viewport / `emulate.viewport` / 元素级截图优先，`browser-resize-fallback` 仅保留为末级兜底。
- 为相关 skills 增加统一的 `requested_viewport` 与 `viewport_strategy` 元数据约定，便于后续 audit 与复盘。
- 让 `storybook-stories` 在响应式验收场景下提供稳定的 Storybook 入口，而不是把 viewport 控制责任推迟给截图阶段。
- 为未声明尺寸的移动端验收提供确定的 `393x852` CSS px 默认 viewport，同时保留主人、项目、spec 与来源 surface 的显式覆盖能力。

### Non-goals

- 不修改 `chrome-devtools-mcp`、Storybook upstream、或任何业务仓库中的具体 story/config 实现。
- 不扩展到真实应用窗口截图（`target_app_window`）或固件显示类证据源。
- 不引入新的截图后端、视觉回归平台或外部依赖。

## 范围（Scope）

### In scope

- `docs/specs/README.md`
- `skills/storybook-screenshots/SKILL.md`
- `skills/ui-visual-evidence/SKILL.md`
- `skills/storybook-stories/SKILL.md`
- `AGENTS.md`
- `skills/storybook-screenshots/agents/openai.yaml`
- `skills/ui-visual-evidence/agents/openai.yaml`
- `skills/storybook-stories/agents/openai.yaml`
- `skills/README.md`

### Out of scope

- `AGENTS.md` 顶层提示词
- `skills/project-engineering-workflow/references/pr-publication-procedure.md` 与其他非本轮直接使用的 flow / review skills
- 任何 repo 外截图脚本或浏览器自动化实现

## 需求（Requirements）

### MUST

- `storybook_canvas` 与 `storybook_docs` 的特定 viewport 证据必须优先来自 Storybook 自身可控 surface，而不是浏览器窗口 resize。
- `ui_demo` 的特定 viewport 证据必须优先来自 demo 自身可控场景，并记录 `viewport_strategy=ui-demo-source`；若 demo 没有 source-managed viewport，则使用 `devtools-emulate`，并继续优先元素级截图。
- `mock_ui` 的特定 viewport 证据必须优先由负责该证据源的 current-truth skill 提供稳定 viewport 控制，并继续优先元素级截图。
- 浏览器证据统一记录 `requested_viewport=<name|WxH|none>` 与 `viewport_strategy=<ui-demo-source|storybook-viewport|devtools-emulate|browser-resize-fallback>`。
- `capture_scope=browser-viewport` 只能在“整个浏览器渲染区域本身就是证据目标”时使用，不能替代元素级截图成为默认路径。
- `browser-resize-fallback` 只能在来源自带 viewport 与 `devtools-emulate` 都无法满足时使用，并且必须记录原因、恢复原始窗口尺寸；恢复失败时不得把该会话当作最终 owner-facing 浏览器状态。
- `storybook-stories` 必须要求：若验收依赖 mobile/tablet/desktop 等响应式尺寸，稳定 Storybook 入口本身就要绑定对应 viewport 或等价响应式场景，而不是把这件事留给后续截图动作。
- 移动端证据在主人、项目、spec、Storybook story 与 demo scenario 都未声明 viewport 时，必须使用 `393x852` CSS px，并记录 `requested_viewport=393x852`；任何显式 viewport 都优先于该默认值。
- `393x852` 只定义响应式验收的 CSS viewport，不代表设备物理像素，也不要求模拟特定 User-Agent。
- 默认值生效时，必须先通过来源自带 viewport 或来源适用的 emulation 路径将实际渲染 surface 绑定到 `393x852` CSS px 并验证，再记录 `requested_viewport=393x852`；禁止只写元数据而保持任意渲染尺寸。
- Storybook 证据不得用截图阶段的临时 emulation 代替稳定 story/docs viewport；默认值必须落在可复现的 Storybook surface 上，无法绑定时回到 Storybook coverage 或报告阻断。

### SHOULD

- skills 索引与 agent metadata 文案应同步强调 viewport-safe、element-first 的默认路径。
- 文本示例应明确 `ui_demo` source-managed 场景优先 `ui-demo-source`，Storybook 场景优先 `storybook-viewport`，普通浏览器页面优先 `devtools-emulate`。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 解析移动端验收 viewport 时：
  - 优先使用主人显式尺寸，其次使用项目、spec 或来源 surface 已绑定的尺寸。
  - 所有显式来源均缺失时，使用 `393x852` CSS px。
  - 默认值生效时先应用并验证实际渲染 viewport，再写入 `requested_viewport=393x852`，并按所选证据源记录 `viewport_strategy`。

- Storybook canvas/docs 取证时：
  - 若截图依赖特定 viewport，先选择或建立已绑定目标 viewport 的 Storybook surface。
  - 然后对实际渲染内容做元素级截图；只有整个浏览器渲染区域就是证据目标时才允许 `browser-viewport`。
  - 默认 `viewport_strategy=storybook-viewport`。
- 普通浏览器 `mock_ui` 取证时：
  - 若截图依赖特定 viewport，先使用显式 `chrome-devtools` 例外路径的 `emulate.viewport` 设定目标尺寸。
  - 然后优先以页面元素为目标截图；默认 `viewport_strategy=devtools-emulate`。
- `ui_demo` 取证时：
  - 若 demo surface 自带稳定 viewport/scenario，优先使用该 source-managed 场景；默认 `viewport_strategy=ui-demo-source`。
  - 否则按普通浏览器 mock 证据走显式 `chrome-devtools` 例外路径的 `devtools-emulate` + 元素级截图。
- 对这些浏览器证据：
  - 只有在默认路径都不可行时，才允许 `browser-resize-fallback`。
  - 一旦用到 fallback，必须先记录失败原因，再恢复窗口外尺寸，最后才能进入 handoff / 回图语义。

### Edge cases / errors

- 若 Storybook 仓库没有可复用的 viewport 约定，`storybook-stories` 必须要求沿用仓库现有方式建立稳定入口；不得用“先调浏览器大小再截”替代。
- 若元素级截图无法覆盖目标（例如证据目标确实是整页浏览器渲染区域），允许 `capture_scope=browser-viewport`，但仍不得先把它降级成 resize 驱动。
- 若 `browser-resize-fallback` 无法恢复原始窗口尺寸，相关 skills 必须报告 blocker，而不是把浏览器留在被改过的尺寸继续对外交付。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| Storybook viewport-safe capture contract | skill | internal | Modify | in-spec | Codex skills | `storybook-screenshots`, review flows | 新增 viewport metadata 与 resize fallback 约束 |
| Browser viewport-safe capture ladder | skill/policy | internal | Modify | in-spec | Codex skills + AGENTS | `ui_demo`, `mock_ui` evidence flows | `ui_demo` 优先 source-managed demo scenario，`mock_ui` 由 current-truth evidence path 提供稳定 viewport 控制 |
| Visual evidence source sizing rules | skill | internal | Modify | in-spec | Codex skills | `ui-visual-evidence`, shared workflow | 统一四类浏览器证据的优先级 |
| Responsive Storybook entry requirement | skill | internal | Modify | in-spec | Codex skills | `storybook-stories`, UI implementation turns | 响应式验收入口前置到 Storybook 覆盖阶段 |
| Discovery / agent copy for viewport-safe evidence | doc | internal | Modify | in-spec | Codex skills | skills index, agent picker | 文案同步新默认路径 |

### 契约文档（按 Kind 拆分）

- None. 本计划只修改内部 skills / metadata / docs 索引，以上表与对应 `SKILL.md` / metadata 文本即为真相源。

## 验收标准（Acceptance Criteria）

- Given `storybook-screenshots` 需要一张 mobile/tablet/desktop 尺寸下的 Storybook 证据图 When agent 读取该 skill Then 默认路径必须是“Storybook 自带 viewport / 稳定 surface + 元素级截图”，而不是“改浏览器窗口大小再截视口”。

- Given current-truth evidence path 为 `mock_ui` 生成特定 viewport 的浏览器证据 When agent 读取对应技能与策略 Then 默认路径必须优先稳定 viewport 控制，并只在整页本身是证据目标时才使用 `capture_scope=browser-viewport`。

- Given current-truth evidence path 为 `ui_demo` 生成特定 viewport 的浏览器证据 When demo surface 已定义稳定 viewport/scenario Then 默认路径必须优先使用 demo 自身场景；否则才使用 `devtools-emulate`。

- Given `ui-visual-evidence` 为 `ui_demo`、`storybook_docs`、`storybook_canvas` 或 `mock_ui` 选择证据来源 When agent 进入截图步骤 Then 必须沿用统一的 viewport-safe ladder，并把 `browser-resize-fallback` 保持为末级兜底而不是默认方案。

- Given 当前任务要求移动端视觉验收，但主人、项目、spec 与稳定渲染来源均未指定 viewport When `ui-visual-evidence` 解析验收尺寸 Then 必须使用 `393x852` CSS px，并记录 `requested_viewport=393x852`。

- Given `storybook-stories` 面对一个依赖响应式断点验收的 UI 变更 When agent 补 Storybook 覆盖 Then skill 必须要求稳定 Storybook 入口显式承载该 viewport，而不是把 viewport 决策留到截图阶段。

- Given skills index 或 agent picker 文案 When 用户或 agent 查找这些 skills Then 至少能看到 viewport-safe / element-first 的新默认口径，而不是继续暗示 browser resize 是常规手法。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `python3 skills/.system/skill-creator/scripts/quick_validate.py skills/storybook-screenshots`
- `python3 skills/.system/skill-creator/scripts/quick_validate.py skills/ui-visual-evidence`
- `python3 skills/.system/skill-creator/scripts/quick_validate.py skills/storybook-stories`
- `python3 skills/.system/skill-creator/scripts/quick_validate.py skills/storybook-screenshots`
- `git diff --check`

### Quality checks

- `rg -n "393x852|requested_viewport|viewport_strategy|ui-demo-source|browser-resize-fallback|devtools-emulate|storybook-viewport|prefer .*element|resize_page" skills docs/specs`
- 人工 spot-check 4 个主 skill 与相关 metadata / 索引文案的默认路径是否一致。

## 方案概述（Approach, high-level）

- 继续沿用现有 Storybook / browser / visual-evidence 技能边界，只收紧“viewport 如何达成”的默认路径。
- 把 Storybook 取证与通用浏览器取证分别锚定到各自最稳定的控制面：前者优先 source-managed viewport，后者优先由 current-truth evidence path 提供的稳定 viewport 控制。
- 把 `ui_demo` 锚定到 demo 自身稳定场景；没有 source-managed 场景时再走通用浏览器 mock 梯度。
- 保留 `browser-resize-fallback`，但把它从默认做法降级为可审计、可恢复、可阻断的末级例外路径。

## Visual Evidence

本次只修改 Skill、Spec 与索引契约，不改变任何渲染界面，因此视觉证据不适用。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：部分仓库的 Storybook viewport 能力可能较弱，因此 `storybook-stories` 只能要求“稳定入口”而不能强制某一种实现写法。
- 风险：`393x852` 不能代表所有移动设备；它只在没有显式项目尺寸时提供一致基线，不能覆盖额外的小屏、宽屏或横屏测试需求。
- 风险：若未来需要把同一套 metadata 暴露到更多 flow/PR 输出，还需要追加联动点；本轮只覆盖直接使用的 source skills 与索引文案。
- 假设：当前仓库已有的 `chrome-devtools` / Storybook 能力足以支撑默认路径，`browser-resize-fallback` 只会是少数例外。

## 参考（References）

- `docs/specs/storybook-skill-upgrade/SPEC.md`
- `docs/specs/shared-ui-visual-evidence-gate/SPEC.md`
- `docs/specs/visual-evidence-whitespace-trim/SPEC.md`
- Storybook official docs: Viewport essentials, Story / Canvas doc blocks
- Chrome DevTools MCP source: `take_screenshot`, `take_snapshot`, `includeIframes`
