# Shared UI visual evidence gate

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## Related ADRs

None

## Context and Scope

This topic governs stable, owner-facing evidence for UI-affecting work, including the browser route used to validate deterministic web evidence. It covers Storybook, mock demos, firmware previews, and their evidence contract; it does not authorize real-program captures without the required owner confirmation.

## Requirements

### REQ-DETERMINISTIC-UI-EVIDENCE

- UI-affecting work MUST provide evidence from the selected deterministic source before its applicable closeout gate.
- The chosen source MUST respect an explicit owner source lock and MUST NOT silently downgrade to another source when that lock is unavailable.

### REQ-EGO-BROWSER-VALIDATION

- Ordinary deterministic web validation MUST use `$ego-browser` with one TaskSpace for the user goal.
- Chrome control and DevTools MUST remain narrow exception paths; browser tool failure MUST NOT silently broaden capture scope or bypass authorization.

## Verification

### VER-UI-EVIDENCE-ROUTING covers: REQ-DETERMINISTIC-UI-EVIDENCE, REQ-EGO-BROWSER-VALIDATION

- UI evidence replay and skill checks verify source selection, viewport handling, and the default browser route.
- The visual-evidence acceptance cases below verify that owner source locks and privacy boundaries are retained.

## 背景 / 问题陈述

- 当前 `~/.codex` 已经具备 Storybook 截图、浏览器页面截图、固件 framebuffer 预览这些能力件，但 shared workflow 里还没有把“给主人回传界面效果图”写成硬门禁。
- 对 Web UI 来说，若仓库本来就有 Storybook，Agent 仍可能直接去浏览器页面里临时截图，而没有先补齐组件/片段 stories/docs/play；反过来，若完整页面已有稳定纯前端 demo，Agent 也不应把整页重复塞进 Storybook。
- 结果是：UI 改动可能在“验证完成”“进入 PR 阶段”或 `Step 5L Ready` 之前，没有给出任何可控的视觉证据，主人只能靠口头描述验收。

## 目标 / 非目标

### Goals

- 为 `UI-affecting` 工作新增统一的 shared visual-evidence gate，在任何收口、PR 路径或 local-merge-ready 之前先回传稳定渲染图。
- 对 Web UI + Storybook 仓库新增组件/片段 Storybook 前置门禁，要求先补齐当前组件/片段变更面的 stories/docs/必要 play。
- 对完整页面/流程视觉证据，默认使用稳定 `ui_demo`；只有缺少合格 `ui_demo` 时才 fallback 到完整页面级 Storybook。
- 若主人显式要求 `web demo`、`ui_demo` 或其他非 Storybook 来源作为最终视觉证据，该来源必须被视为锁定来源；来源不可用时只能报 blocker 或先修复该来源，不能把 Storybook 结果表述成“已满足原要求”。
- 新增 `$ui-visual-evidence` 作为统一入口，收口 `UI-affecting` 判定、来源选择、mock-first 策略、聊天回图与 spec 落盘契约。
- 为 spec 模板收敛到单一 `## Visual Evidence`，把最终效果图作为统一证据源；若同一 section 同时容纳主人验收图与 PR 图，则用逐图 `PR: include` 明确白名单选出 PR 子集，或用 `PR: none` 显式声明 PR 无图，而不是再拆第二个 section。

### Non-goals

- 不引入新的视觉回归平台、像素基线系统或截图后端。
- 不为没有 Storybook 的 Web 仓库自动接入一整套 Storybook 基建。
- 不放宽真实程序截图的隐私/授权规则。

## 范围（Scope）

### In scope

- `AGENTS.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/normal-flow/SKILL.md`
- `skills/fast-flow/SKILL.md`
- `skills/local-merge-flow/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/storybook-stories/**`
- `skills/storybook-screenshots/**`
- `skills/ui-visual-evidence/**`
- `skills/docs-plan/SKILL.md`
- `skills/docs-plan/templates/SPEC.md`
- `skills/docs-plan/templates/PLAN.md`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`
- `skills/github-pr-body-images/SKILL.md`
- `prompts/pr-create.md`
- `skills/README.md`
- `docs/specs/README.md`

### Out of scope

- 业务仓库里的具体 UI 实现、真实 Storybook 配置或测试代码
- 外部图床、GitHub App 或新的远端截图托管方案
- 新的 runtime hook、自动截图服务或图床集成

## 需求（Requirements）

### MUST

- shared workflow 必须新增 `Step 3F Storybook 覆盖门禁` 与 `Step 4B 视觉证据门禁`。
- 若仓库已具备 Storybook 能力，且当前任务包含 Web UI 组件、片段或可复用状态改动，Agent 必须先用 `$storybook-stories` 补齐/更新 stories、docs 和必要 `play`，再进入对应组件/片段取证。
- 若当前任务是完整页面/流程取证，Agent 必须优先使用合格 `ui_demo`；`ui_demo` 必须 mock-only、无登录、无真实后端依赖，并可从 repo scripts 或静态资产复现。
- 若完整页面/流程缺少合格 `ui_demo` 且仓库已具备 Storybook 能力，允许使用完整页面级 Storybook fallback，并要求关键验收行为的 `play` 覆盖。
- 若主人已显式锁定完整页面/流程的最终证据来源为非 Storybook 来源，Agent 不得在未征得主人改口的情况下把 `视觉证据目标源` 改写为 `storybook_docs` / `storybook_canvas`；若锁定来源不可用，必须明确输出 `视觉证据=不存在` 与原因。
- `Step 4B` 必须从当前实现重新采集候选图，并以关联 Spec/Plan 的完整首选视觉证据比较渲染面与 render inputs；任何会改变它们的新提交都必须重新比较，纯证据落盘提交只有在当前比较确认内层 UI 未变时才免于再次询问主人。
- `$ui-visual-evidence` 必须统一输出 `Storybook覆盖`、`视觉证据目标源`、`视觉证据`、`聊天回图`、`证据落盘` 与 `视觉比较`，并作为非 UI 任务写出 `视觉证据=不适用` 与原因的统一入口。
- 若任务关联 spec 或 legacy plan，最终效果图默认落到单一 `## Visual Evidence`；只有显式标了 `PR: include` 的图片才允许进入 PR 正文，未标图片默认只用于主人验收；若 PR 不放图且该 section 仍保留 owner-facing 图片，必须写 `PR: none`。带 publishable 图片但既没有 `PR: include` 也没有 `PR: none` 的 preferred section 一律阻断。`Step 4 Ready` 不得在 `证据落盘=已落盘` 之前通过。
- `PR: none` 是 preferred `## Visual Evidence` section 唯一合法的显式无图语义，并且必须与任何 `PR: include` 互斥；不得再把“未标记即无图”或自然语言子集提示视为可接受语义。
- 对 legacy `Plan:` / `Plans:` 关联任务，最终效果图资产必须落在关联 `PLAN.md` 同目录下的 `assets/`，并通过 `./assets/<file>` 被 `## Visual Evidence` 引用；不得靠临时相对路径猜测落盘位置。
- `pr-create`、`pr-merge` 与 `github-pr-body-images` 必须统一通过 `skills/github-pr-body-images/scripts/pr_body_image_gate.py` 执行 Phase A / Phase B；成功态只接受 `rewritten` 或 `explicit_no_image`，不得各自手写另一套图片重写/验证逻辑。
- PR 正文中的发布图片必须由 `github-pr-body-images` 转成 GitHub 可渲染的 Markdown image blob URL，并在更新后回读 GitHub `bodyHTML` 做最终验证；裸 asset 文件名、repo-relative 图片路径、只列图片路径的 fenced code block，或渲染后仍残留 repo-relative `src/href` 都不能算作有效 `PR截图=存在`。
- 已经在本地验收阶段提交过的视觉证据，后续若直接复用到 PR，不得强制要求额外的 screenshot-only commit 或改写历史；只有在 PR 阶段新增/替换图片文件时，才进入 dedicated screenshot commit 策略。
- 当 PR 直接复用本地验收阶段已经提交过的图片时，PR 状态输出必须允许 `截图提交=不适用` 与 `提交授权=不适用`；不得把这种合法复用误降级为“缺少截图提交/授权”。
- 若首个 PR-side remote mutation（第一次 push、第一次创建 PR、或第一次把 PR 图片链接写入远端 PR body）会发布已提交的截图文件或其 PR 引用，则提交授权门禁必须在这个“首个远端变更”之前生效；不得等截图 phase 晚些时候再补问。
- 对历史 `## Visual Evidence` 文件，owner-facing 本地验收图不得写回 legacy PR block；应先迁入首选 `## Visual Evidence`。只有当首选 section 缺失或其中没有任何图片时，PR 路径才允许继续从 legacy PR block 取图；若首选 section 已有图片但缺少 `PR: include` / `PR: none`，必须阻断而不是 fallback。
- 若主人已经明确拒绝当前 PR 放图，则 preferred/legacy 两条 PR 取图路径都必须失效，最终保持 PR 正文无图。
- 若历史文件在本轮已经生成了新的主人验收图，则不得继续保留会指向旧 revision 的 legacy PR block；必须要么把当前 PR 子集迁到新 section 并退役旧 block，要么直接清空旧 block。

### SHOULD

- `ui_demo` 应作为完整页面/流程的默认截图目标源；`storybook_docs` 应作为组件/片段多状态证据默认来源。
- 若仓库本来就是 canvas-only Storybook，或单态/单交互节点更清晰，则 `storybook_canvas` 也可以作为通过 Step 3F 的稳定来源。
- Storybook 前置规则应按仓库能力落地：有 docs/autodocs 能力时优先 docs-first；canvas-only 仓库不得被误判为必须补 docs 才能过门禁。
- Step 3F 的通过条件必须按仓库当前约定判定，而不是仅按工具链能力判定：即使装有 docs/autodocs，只要仓库当前变更面沿用稳定的 canvas-only story 约定，也必须允许以 `storybook_canvas` 通过门禁。
- `$ui-visual-evidence` 在进入 Step 4B 时必须继承 Step 3F / `$storybook-stories` 已经确定的 Storybook 来源；若 Step 3F 已合法确定 `storybook_canvas`，后续不得再被 `storybook_docs` 默认值覆盖或重新阻断。
- `skills/README.md` 与 agent metadata 应把新的视觉证据入口列为可发现能力。
- 非 UI 任务应显式给出 `视觉证据=不适用` 的原因，而不是留空。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 当任务命中 `UI-affecting=yes`：
  - 先选择最稳定的渲染来源；
  - 若为 Web UI 组件/片段 + Storybook，则先清 `Step 3F`；
  - 若为完整 Web 页面/流程，则优先选择 `ui_demo`；
  - 再在 `Step 4B` 生成并回传最终视觉证据；
  - clear 后才允许声明 `Step 4 Ready`、进入共享 Step 5，或在 local-merge 路径进入 `Step 5L Ready`。
- 视觉证据来源优先级固定为：
  - `ui_demo`
  - `storybook_docs`
  - `storybook_canvas`
  - `mock_ui`
  - `firmware_preview`
  - `target_app_window`
- `$ui-visual-evidence` 负责统一决定：
  - 当前任务是否真的 `UI-affecting`
  - 是否必须先走 Storybook 覆盖
  - 该用哪个底层 skill 生成图片
  - 是否需要把图片写回 spec

### Edge cases / errors

- 若组件/片段变更检测到 Storybook，但 docs/support 不完整或渲染入口不稳定，必须报 `Storybook覆盖=阻断`，不能静默退回浏览器临时截图。
- 若完整页面/流程已有合格 `ui_demo`，不得仅因仓库存在 Storybook 就强制补完整页面 Storybook。
- 若完整页面/流程尚未确认“缺少合格 `ui_demo`”，不得直接跳过到 Storybook 最终证据路径。
- 若主人显式要求 `web demo` / `ui_demo` 后，Agent 仍将 Storybook 作为成功态回传，必须视为合同违约而非合法 fallback。
- 若当前不是 `UI-affecting` 任务，仍必须经由 `Step 4B` / `$ui-visual-evidence` 显式记 `视觉证据=不适用` 并给原因。
- `Step 4` 的视觉证据 hard gate 必须只在 `Step 4B` 生效；前置的 Step 4 通用 hard gate 不得要求在进入 `Step 4B` 之前就已经拿到 `视觉证据=存在`，否则会与门禁顺序自相矛盾。
- 若唯一可用来源是真实程序窗口截图，仍必须要求主人确认 `target_program` 与 `capture_scope`。
- 若 Step 4 的 base sync、proof 或其他修复改变了渲染面、渲染入口或 render inputs，旧视觉比较必须作废并重采；纯证据落盘提交仅在当前比较确认内层 UI 未变时例外。
- 若高风险 run 已经完成 `pre-PR local proof`，但 Step 4 后续又通过证据落盘等动作产生新的最终实现，则即使当前比较确认内层 UI 未变，也必须把 `pre-PR local proof` 在该最终实现上重新跑清。
- 若 local-merge proof 在 `Step 5L.1` 期间产出新提交，对 `UI-affecting` 工作必须先回到 `Step 4B` 针对新实现重清视觉证据门禁，之后才允许宣告 `Step 5L Ready`。
- 对 spec / legacy-plan 关联的 `UI-affecting` 工作，无论是 `可开 PR（local）` 还是 `Merge-ready（local）`，都不得仅凭 `视觉证据=存在` / `聊天回图=已展示` / `视觉比较=一致` 宣告 ready；还必须同时满足 `证据落盘=已落盘`。
- `pr-create` 不得在 `UI-affecting` PR run 的最近视觉比较已不覆盖当前渲染面或 render inputs 时宣告 `Step 5C Ready`；必须先回本地 Step 4B 重清视觉证据门禁。
- `pr-create` 也不得在缺少 Step 4B 终态的情况下宣告 `Step 5C Ready`：对 UI run 必须有覆盖当前实现的视觉证据 clear；对非 UI run 则必须显式带出 `视觉证据=不适用` 与原因。
- `pr-merge` 在真正调用 merge 之前，也必须再次确认 `UI-affecting` PR 的 Step 4B 仍覆盖当前实现；若 merge-path 自己让实现前进，必须先回本地 Step 4B 重清，再允许 merge。
- 若 `pr-merge` 进入时当前 PR fact set 根本缺少可接受的 Step 4B 状态（而不只是 stale），也必须先回本地 Step 3/4 重清视觉证据门禁；不得把“缺少 Step 4B 事实”当成可继续 merge 的空白状态。
- 对 `视觉证据=不适用` 的非 UI spec/plan PR，PR 路径必须记录 `PR截图原因=视觉证据不适用`，而不是误报 `Spec视觉证据缺失`。
- PR 阶段若以 wait/block/non-terminal 形态停下，状态输出必须带上当前 Step 4B 字段（至少 `视觉证据`、`聊天回图`、`视觉比较`，以及需要时的 `证据落盘` / `视觉证据原因`），供 `$flow-continue` 正确恢复是否需要回 Step 3/4。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| `Step 3F Storybook coverage gate` | workflow | internal | New | in-spec | shared workflow | `normal/fast/local-merge` | Web UI 组件/片段 + Storybook 的前置门禁 |
| `Step 4B visual evidence gate` | workflow | internal | New | in-spec | shared workflow | all engineering flows | 收口前的统一视觉证据门禁 |
| `$ui-visual-evidence` status contract | skill | internal | New | in-spec | Codex skills | shared workflow, flow skills | 统一输出状态字段与来源选择 |
| `ui_demo` full-page evidence source | skill | internal | New | in-spec | Codex skills | shared workflow, browser evidence flows | mock-only、无登录、无真实后端依赖的纯前端 demo surface |
| `storybook-stories` final report fields | skill | internal | Modify | in-spec | Codex skills | Web UI implementation turns | 新增 `Storybook覆盖` 与目标源 |
| `storybook-screenshots` evidence scope | skill | internal | Modify | in-spec | Codex skills | local review + PR evidence turns | 从 PR-only 扩到统一视觉证据 |
| `SPEC.md` visual evidence section | template | internal | Modify | in-spec | docs-plan template | spec authors | 收敛为单一 `## Visual Evidence` |
| `pr-create` evidence reuse rule | skill | internal | Modify | in-spec | Codex skills | PR setup flow | 允许按需复用统一视觉证据，并保留 `ui_demo` source type |

### 契约文档（按 Kind 拆分）

- None. 本规格只修改内部 workflow/skill/template 契约，以上表与对应正文即为真相源。

## 验收标准（Acceptance Criteria）

- Given 当前任务是 Web UI 组件/片段/可复用状态改动，且仓库已检测到 Storybook When Agent 试图离开本地开发循环 Then 它必须先清除 `Step 3F Storybook 覆盖门禁`，而不是直接去浏览器里临时截图。

- Given 当前任务是完整 Web 页面/流程视觉证据 When 存在合格 `ui_demo` Then Agent 必须从 `ui_demo` 取证，且不得强制新增完整页面级 Storybook。

- Given 当前任务是完整 Web 页面/流程视觉证据 When 缺少合格 `ui_demo` 且仓库已检测到 Storybook Then 允许使用完整页面级 Storybook fallback，并以 `storybook_docs` 或 `storybook_canvas` 作为页面 fallback 证据目标源，覆盖关键验收行为。

- Given 主人已显式要求最终证据来自 `web demo` / `ui_demo` When 该来源当前不可用 Then Agent 必须报告 `视觉证据=不存在` 与明确原因，或先修复该 demo 来源；不得把 Storybook 回图表述成“已满足原要求”。

- Given 当前任务是完整 Web 页面/流程视觉证据 When 尚未确认“缺少合格 `ui_demo`” Then Agent 不得直接跳到 Storybook 最终证据路径。

- Given 当前任务是 `UI-affecting` When Agent 准备宣告 `Step 4 Ready`、进入 PR 阶段或进入 `Step 5L Ready` Then 它必须先完成 `Step 4B 视觉证据门禁`，并把同一批最终图片回传到对话中。

- Given 当前任务有关联 spec When 本地视觉证据已经生成 Then 这些图片必须写入单一 `## Visual Evidence`，而不是只留在对话里。

- Given 当前任务 later 进入 PR 路径 When `## Visual Evidence` 里已经存在合适的最终图片 Then `pr-create` 只能提取显式带 `PR: include` 的图片进入 PR；未标图片默认只用于主人验收。若该 section 仍保留 owner-facing 图片但 PR 必须无图，则必须写 `PR: none`。只有当首选 `## Visual Evidence` section 缺失或其中没有任何图片，而旧 `## Visual Evidence` 仍保留有效图片时，migration 期间才允许继续从旧 block 取图。若主人拒绝 PR 截图，则 preferred/legacy 两条 PR 取图路径都必须停用，最终保持 PR 正文无图，而不必强制重新截图或拆第二个 section。

- Given `Step 4B` 已经为完整页面/流程确定 `视觉证据目标源=ui_demo` When 该证据 later 被选入 PR 正文或 PR 截图 metadata Then `pr-create` 必须保留 `source_type=ui_demo`，而不是把它重标为 `mock_ui` 或因枚举缺失而阻断。

- Given PR 正文的 `## Visual Evidence` 只有 asset 文件名、repo-relative 图片路径或 fenced code block 路径列表 When `pr-create` 或 `pr-merge` 执行 PR body 图片同步 Then 必须调用 `github-pr-body-images` 把这些 publishable 图片转换为 `![alt](https://github.com/<owner>/<repo>/blob/<sha>/<path>?raw=1)`；spec/plan 关联的裸文件名解析到关联文件同目录 `assets/`，spec-free 裸文件名没有可证明 repo path 时必须阻断而不是猜测；若重写后仍残留裸路径或输出图片数量与选中图片数量不一致，则该 PR body normalization 失败，不能把它报告为有效 PR 截图。

- Given 首选 `## Visual Evidence` section 已经有图片 When 它只写了诸如 `Recommended PR subset...` 之类的自然语言提示，但没有 `PR: include` 或 `PR: none` Then PR 图片 gate 必须阻断并给出 selector 缺失类原因，而不是把这类提示当成“显式无图”或“自动选图”。

- Given 首选 `## Visual Evidence` 仍保留主人验收图 When 该 section 明确写了 `PR: none` Then PR 路径必须把结果记为 `PR截图=不存在` 且 `PR截图原因=显式无图PR`，而不是 `Spec视觉证据缺失`。

- Given 历史 spec/plan 仍保留 `## Visual Evidence` When 本轮已经生成新的本地验收截图并写入首选 `## Visual Evidence` Then 流程必须同步退役或刷新旧 `## Visual Evidence` block，避免后续 PR 继续发布上一 revision 的旧图。

- Given 仓库已检测到 Storybook，但该仓库只维护稳定的 canvas stories When 当前任务需要清除 `Step 3F Storybook 覆盖门禁` Then 只要当前变更面已补齐可控的 canvas story/render 入口，`Storybook覆盖` 仍可判定为 `通过`，并以 `storybook_canvas` 作为合法证据源。

- Given 仓库装有 docs/autodocs 能力，但当前变更面沿用稳定的 canvas-only Storybook 约定 When 当前任务需要清除 `Step 3F Storybook 覆盖门禁` Then 流程仍必须允许以 `storybook_canvas` 作为合法通过路径，而不是仅因工具链具备 docs 能力就强制补 docs 页。

- Given Step 3F / `$storybook-stories` 已经为当前变更面合法确定 `视觉证据目标源=storybook_canvas` When 后续进入 `$ui-visual-evidence` / `Step 4B` Then 它必须沿用这个已清门禁的来源，而不是再默认改选 `storybook_docs` 或重新把 canvas-only 仓库判成阻断。

- Given 当前任务已经进入 PR 阶段，且后续 fix commit 改变了渲染面或 render inputs When 最近视觉比较不再覆盖当前实现 Then 无论是续推恢复还是同回合 PR 收敛，都必须先把 run 送回本地 Step 3/4 重新清除 `Step 4B 视觉证据门禁`，而不是继续停留在共享 Step 5 上用旧图收敛。

- Given `UI-affecting` PR 已进入 merge-path When merge-path 自己通过 branch update、conflict auto-heal 或 review-fix 让 `PR.head.sha` 前进 Then `pr-merge` 也必须在 merge 前再次检查 Step 4B 是否仍覆盖这个最新 `PR.head.sha`，否则先回本地 Step 3/4 重清视觉证据门禁，而不是只在 merge skill 内循环到共享 Step 5 的 checks/spec gate。

- Given 当前任务不是 UI 相关 When 进入视觉证据门禁 Then 流程必须显式得到 `视觉证据=不适用` 与一个具体原因，而不是被截图规则错误阻断。

- Given 当前任务不是 UI 相关但仍有关联 spec/plan When PR 路径判断 PR body 是否需要图片 Then 它必须输出 `PR截图=不存在` 且 `PR截图原因=视觉证据不适用`，而不是 `Spec视觉证据缺失`。

- Given 一个 PR run 已经续推到 `Step 5C Ready` 判定点 When 当前 fact set 既没有 UI 视觉证据 clear，也没有显式的非 UI `视觉证据=不适用` Then `pr-create` 不得宣告 `Step 5C Ready`；必须先回本地 Step 3/4 清除 `Step 4B`。

- Given 一个 `UI-affecting` PR 直接进入或恢复到 merge-path When merge 前检查发现当前 PR fact set 根本没有可接受的 Step 4B 事实 Then `pr-merge` 也必须先回本地 Step 3/4 重清 `Step 4B`，而不是只在“证据 stale”时才阻断 merge。

- Given PR 阶段这轮没有终态而是停在 wait/block When 后续需要由 `$flow-continue` 恢复 Then 这轮状态输出必须带上当前 Step 4B 的关键字段，让续推能判断是否要先回本地 Step 3/4 重清视觉证据门禁。

- Given PR 直接复用了本地验收阶段已经提交过的图片 When PR 状态层需要表达截图提交与提交授权状态 Then 它必须允许 `截图提交=不适用` 与 `提交授权=不适用`，而不是误报为缺少截图 commit 或 push 授权。

- Given 本地验收图已经随本地提交存在，且后续首个 PR-side remote mutation 会把这些图片或其 PR 引用发布到远端 When `pr-create` 还没获得截图提交授权 Then 流程必须在第一次 push / PR 创建 / PR body 图片回填之前就停下并请求授权，而不是先把这些图片或链接发布出去。

- Given local-merge 这轮没有终态而是停在 wait/block When 后续需要由 `$flow-continue` 恢复是否先回 `Step 4B` Then 这轮状态输出必须带上当前 Step 4B 的关键字段，至少包括 `视觉证据`、`聊天回图`、`视觉比较`，以及需要时的 `证据落盘` / `视觉证据原因`。

- Given 一个已锁定的旧会话开始于视觉证据比较契约生效之前 When 最近一次状态区 / 流程锚点完全缺少 `Storybook覆盖` / `视觉证据` / `聊天回图` / `视觉比较` / `证据落盘` Then `$flow-continue` 必须保持旧会话原本待续的 checks / review proof / merge / cleanup 路由，而不是仅因缺字段就回退到 `Step 3F/4B`。

- Given Storybook 截图只用于本地验收而不进入 PR 正文 When `Step 4B` 已判定 `视觉证据=存在` Then 最终回复仍必须把同一批图片回传到对话中，不能仅因 `PR截图=不存在` 就省略图片本体。

- Given Step 4 收口过程中出现新的本地提交 When 之前已经生成过视觉证据，且该提交改变了已验收视觉状态、渲染入口或 render inputs Then 旧证据必须作废，并重新比较当前候选图；不得以旧 SHA 或旧确认状态恢复。

- Given Step 4 收口过程中只新增了证据落盘提交 When 该提交仅把同一批已审图片、asset 引用、选择器或 legacy block 退役写回 spec / legacy plan，且没有改变渲染面或 render inputs Then 流程可以重新比较当前候选并复用 canonical 资产，而不必仅因这次提交再次询问主人。

- Given 当前 run 命中高风险改动并已经完成 `pre-PR local proof` When Step 4 后续又通过纯证据落盘提交产生新的最终实现 Then 即使当前比较确认内层 UI 未变，`pre-PR local proof` 仍必须在这个最终实现上重跑后，才能宣告 `Step 4 Ready`。

- Given local-merge proof 在 `Step 5L.1` 过程中产出新的 fix commit When 当前任务属于 `UI-affecting` Then 流程必须先把 run 送回 `Step 4B` 针对新实现重采/重验视觉证据，而不是直接宣告 `Step 5L Ready`。

- Given 当前任务已经进入 PR 阶段 When same-turn repair push、review-fix push 或 branch update 改变了 PR 当前实现 Then `pr-create` 不得直接宣告 `Step 5C Ready`；必须先确认共享 `Step 4B` 已覆盖该当前实现。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `python3 /Users/ivan/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/ui-visual-evidence`
- `python3 /Users/ivan/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/storybook-stories`
- `python3 /Users/ivan/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/storybook-screenshots`

### UI / Storybook (if applicable)

- Stories to add/update: `storybook-stories` report contract
- Docs pages / state galleries to add/update: None
- `play` / interaction coverage to add/update: None
- Visual regression baseline changes (if any): None

### Quality checks

- `git diff --check`
- `rg -n "Step 3F|Step 4B|视觉证据=|Storybook覆盖=|## Visual Evidence|ui-visual-evidence" AGENTS.md skills docs/specs -S`
- `python3 -m py_compile bin/visual_evidence_replay_check.py`
- `python3 bin/visual_evidence_replay_check.py --cases docs/specs/shared-ui-visual-evidence-gate/replay/cases.txt`

## Visual Evidence

## 方案概述（Approach, high-level）

- 继续复用已有的 Storybook、浏览器、固件预览能力，但把它们统一收口到 shared gate 和单一入口 skill 上。
- 把“组件/片段先补 Storybook，完整页面/流程优先用 `ui_demo`，缺少 `ui_demo` 才 fallback 到完整页面 Storybook”写成 shared workflow 的硬规则，而不是留给下游调用方自己记忆。
- 把最终效果图收敛到单一 `## Visual Evidence`，并用逐图 `PR: include` 明确白名单解决“主人验收图集”和“PR 只放其中一部分”的差异，同时避免主人验收图被默认带入 PR。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：这仍然是 prompt/skill 契约层的修正，不是 runtime 强制 hook；后续若新增入口且不读取这些规则，仍可能绕开。
- 风险：`UI-affecting` 判定仍需要 agent 按当前任务做事实判断；本轮通过统一入口和字段名降低漂移，但不能彻底消灭误判。
- 假设：现有 `storybook-stories`、`storybook-screenshots`、`ego-browser` 与 `firmware-display-preview` 已足够覆盖当前想要的主要证据来源。

## 参考（References）

- `docs/specs/storybook-skill-upgrade/SPEC.md`
- `skills/storybook-stories/SKILL.md`
- `skills/storybook-screenshots/SKILL.md`
- `skills/firmware-display-preview/SKILL.md`
