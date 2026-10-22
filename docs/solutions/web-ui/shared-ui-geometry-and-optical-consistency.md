---
title: UI design implementation and visual consistency
module: web-ui
problem_type: design-implementation
component: shared-ui
tags:
  - design-tokens
  - css
  - responsive-ui
  - component-library
  - storybook
  - visual-evidence
  - design-handoff
  - component-states
  - interaction-design
  - accessibility
  - async-state
status: active
related_specs: []
---

# UI design implementation and visual consistency

## Context

UI 设计实现的一致性不只是某个按钮的尺寸或颜色，而是页面层级、布局盒子、可见表面、内容排版、交互状态、响应式行为和组件组合边界共同遵守一份契约。这个 Solution 用于把设计交接落成可实现、可操作、可验证的 UI，覆盖按钮、输入框、下拉框、搜索框、筛选条、工具栏、表单、抽屉、列表、看板和其他页面级工作流。

这类问题不应被记录成“某个按钮需要减 1px”的局部技巧；只要多个控件共享尺寸、边框、背景或状态语义，同一套设计实现规则就应覆盖它们。

从设计稿落地页面时，视觉层级、间距节奏、排版基线、交互状态、响应式布局、焦点路径、错误恢复和数据新鲜度应共同形成实现契约，而不是把设计还原压缩成若干孤立的像素修正。

## Symptoms

- 具有主题色填充的控件看起来比同尺寸的未填充控件大 1px，即使 `getBoundingClientRect()` 的宽高相同。
- 输入框、选择器、按钮或搜索容器在同一工具栏中出现上下错位，或 wrapper 与子控件同时绘制边框。
- `lg`、`icon-lg` 或紧凑尺寸在组件类名中声明了尺寸，但被基础 primitive、全局 reset 或页面级样式覆盖。
- 桌面端排列正常，移动端却出现小于 44px 的触控区域、文字挤压或横向溢出。
- 只验证了 DOM 尺寸，却没有验证背景、透明边框、阴影、圆角和 focus ring 的实际绘制结果。
- 静态截图看起来接近设计稿，但 loading、empty、error、readonly、partial success 或 unknown result 没有可理解的视觉和操作路径。
- 页面级刷新、抽屉关闭、编辑取消或路由跳转会丢失草稿、上下文或焦点，导致用户不知道当前操作是否仍然有效。
- 控件缺少可访问名称、原生表单语义、键盘焦点管理或足够大的移动端命中区，视觉上完成但实际不可用。

## Root cause

### Layout geometry and painted surface are different contracts

元素的外部布局盒子决定相邻元素如何排列，背景、边框、阴影和圆角决定用户看到的表面。`border-box`、透明边框和 `background-clip` 的组合会让两个外部尺寸相同的控件产生不同的可见边缘；填充色穿过透明边框时，控件会产生视觉上多出 1px 的错觉。

### CSS ownership is ambiguous

全局 `button { border: 0 }`、Tailwind primitive 类、组件变体类和页面覆盖规则如果没有固定顺序，可能会清除用于稳定尺寸的透明边框，或者让同一元素同时拥有两套高度、边框和阴影。复合控件还容易让 wrapper 与内部 `Input` 或 `SelectTrigger` 重复负责边框和圆角。

### Metrics are fragmented across variants and breakpoints

当尺寸散落在 cva、Tailwind 类、传统 CSS 和媒体查询中时，`default`、`sm`、`lg`、图标按钮、表单控件与移动端触控尺寸会逐渐漂移。没有明确的语义映射时，修复一个变体很容易破坏另一个变体。

### Perceived size is also controlled by visual hierarchy

相同的 DOM 宽高不代表相同的视觉重量。高对比度填充、深色边框、外阴影、较粗字重、图标与文字的间距以及不对称内边距，都会让一个控件看起来比旁边的控件更大或更靠外；这属于可见表面和内容排版的差异，不应直接归因于布局尺寸。

### Verification covers only one state

单一主题、单一视口或单一状态无法暴露填充色、禁用态、焦点态、长文本、深色主题和移动端触控区域的问题。尺寸相等也不能证明视觉表面相等。

### Design handoff is visual-only

如果交接只包含静态截图和少量尺寸，开发者无法判断页面层级、状态转换、焦点移动、草稿保留、失败恢复和权限收紧应该如何表现，于是只能用局部 CSS 或临时交互猜测设计意图。

### Component checks do not prove workflow continuity

单个组件在 Storybook 中正常，不代表它放进页面后仍能保持上下文、焦点和数据状态。背景刷新、导航、抽屉、表单提交和异步写入会把多个组件连接成一条用户流程，必须在组合层验证。

## Resolution

### 1. Define a small shared metric contract

把几何基线集中到设计 token 中，并让所有共享控件使用 `box-sizing: border-box`。建议至少区分紧凑工具栏、普通表单和移动端触控三个层级，例如 `38px`、`42px` 和 `44px`；边框宽度固定为 `1px`，除非设计明确要求其他值。

| Contract layer | Responsibility | Verification target |
| - | - | - |
| Layout geometry | 外部宽高、对齐和相邻间距 | `getBoundingClientRect()`、`box-sizing` |
| Painted surface | 背景、边框、阴影、圆角和 focus ring | `background-clip`、computed styles、截图 |
| Content geometry | 图标、文字、line-height 和内边距 | 内容不溢出、不改变外部尺寸 |
| Responsive ergonomics | 触控区域、折行和可用宽度 | 移动视口下至少 `44px` 的交互区域 |

### 2. Turn design handoff into an implementation contract

设计交接至少要同时说明语义变体、外部布局盒、可见表面、交互命中区域、内容排版、所有交互状态和响应式例外；只给一张静态截图或只给一个高度值，无法判断填充、边框、焦点环和禁用态如何共同占据空间。

| Handoff item | Implementation contract | Evidence |
| - | - | - |
| Variant and size | `data-variant`、`data-size` 或等价的组件 API | 组件矩阵覆盖所有语义组合 |
| Geometry | `box-sizing`、固定高度/最小高度、内外间距和对齐基线 | DOM 尺寸与 computed style |
| Painted surface | 背景裁剪、边框、阴影、圆角和 focus ring 的唯一 owner | 固定主题下的截图或像素比较 |
| Interaction states | hover、active、focus-visible、disabled、loading 和 permission/error 状态 | 键盘与状态 Storybook 场景 |
| Composition | wrapper、子控件、图标和文字各自的布局责任 | 搜索框、筛选条、工具栏组合场景 |
| Responsive behavior | 移动端触控尺寸、折行、隐藏/溢出规则 | 桌面与移动视口证据 |

### 3. Define the page and workflow contract

UI 实现的最小交付对象应是“页面或工作流 + 组件状态”，而不是一张静态画面。开始编码前，明确主次层级、密度、可见操作、允许的上下文、每个请求状态和失败后的用户选择；把不可见的状态也纳入设计，而不是等后端返回后临时补文案。

| Contract layer | Decide before coding | Evidence |
| - | - | - |
| Information hierarchy | 主标题、主要操作、次要操作、筛选/导航和内容优先级 | 桌面与移动页面捕获 |
| State model | loading、empty、error、readonly、permission change、partial success 和 unknown result | 状态 Storybook 或 login-free demo |
| Interaction continuity | 原生提交、焦点移动与恢复、抽屉键盘行为、取消、返回和上下文保留 | 键盘路径与组合交互 |
| Data freshness | stale、refreshing、后台刷新、草稿保护和写入结果确认方式 | 可控刷新/失败场景 |
| Responsive behavior | 折行、隐藏、溢出、触控尺寸和移动导航策略 | 固定桌面/移动视口证据 |

页面视觉验收应在这些契约明确之后进行；否则像素接近也无法证明用户流程正确。

### 4. Map semantic sizes once

在共享组件中建立稳定的尺寸语义，例如 `default`、`sm`、`icon`、`icon-sm`、`lg` 和 `icon-lg`，再由统一的 `data-size` 或同等语义选择器应用高度、最小高度、宽度、圆角和内边距。移动端的触控尺寸应通过明确的响应式规则映射，而不是在每个页面重新写一套像素值；确有例外时，为导航切换、图标占位等用途命名并记录例外原因。

### 5. Separate the hit box from the visible surface

需要保持外部尺寸稳定时，让控件保留固定宽高和 `1px` 边框占位；填充变体使用 `background-clip: padding-box`，使背景不覆盖透明边框。不要为了抵消视觉上的 1px 而给填充变体额外加宽或减高，否则会把视觉问题转化为真实的布局不一致。

### 6. Assign one visual owner per surface

普通输入框和选择器由自身负责高度、边框、圆角、背景和 focus ring；搜索框、筛选条等复合控件则由 wrapper 负责外框，内部输入控件只负责内容布局，并显式清除重复的边框、阴影和圆角。一个可见表面只保留一个 owner，避免通过负 margin 或页面级偏移掩盖重复绘制。

### 7. Make the cascade intentional

先应用浏览器 reset，再应用共享组件的语义基线，最后才允许页面级布局覆盖。共享 CSS 应优先使用 `data-slot`、`data-size` 和 `data-variant` 等稳定契约选择器；不要依赖偶然的 class 顺序，也不要用 `!important` 把层叠问题藏起来。每次修改基础规则后，检查 `button`、`input`、`select` 以及复合 wrapper 的 computed style，确认实际生效的是预期规则。

### 8. Verify with a state matrix

为共享控件维护一个可重复打开的 Storybook 或其他源代码管理的验证面，至少覆盖浅色和深色主题、紧凑和表单尺寸、填充和未填充变体、输入框和选择器、禁用态和键盘焦点态，以及 `lg` 和 `icon-lg`。页面级验证再覆盖桌面视口和移动视口，并包含长文本、空值、溢出和复合控件组合。

推荐按以下顺序排查：先比较 DOM 尺寸和 computed style，再确认 CSS 层叠与边框归属，然后在固定主题和视口下检查实际绘制，最后回到页面级覆盖规则。视觉证据应来自可重复的 Storybook 或 login-free demo 表面，并只截取明确的验证目标，避免把浏览器缩放、截图裁剪或无关页面差异误判为组件回归。

### 9. Preserve intent across interaction and async state

背景刷新、轮询、路由切换和异步写入不能静默覆盖用户正在编辑的内容或改变当前操作上下文。表单应以用户编辑基线计算变更，刷新只更新已确认的数据；提交结果要区分成功、部分成功、失败和结果待确认，并为非成功结果保留可见、可恢复的下一步。

焦点也是设计状态的一部分：打开抽屉或编辑器后把焦点移到明确的起点，关闭或取消后恢复到触发控件；键盘用户不能被困在不可见区域，移动端操作不能依赖只有图标但没有名称的控件。可访问名称、原生 `form` 提交和 `focus-visible` 不是实现细节，而是页面交互契约。

### 10. Compare visual weight after geometry is stable

当外部盒、内容盒和 computed style 已经一致时，再比较背景与边框的可见范围、阴影扩散、文字和图标的视觉中心、相邻留白以及主题对比度。优先调整共享的 surface、typography、spacing 或 elevation token，并保持布局尺寸不变；只有设计明确要求不同层级时，才为填充、描边、静音和危险状态建立不同的视觉重量。

### 11. Diagnose by mismatch layer, then fix the shared contract

当反馈是“看起来大 1px”“边缘不齐”或“这个状态比另一个状态更挤”时，先按现象定位不一致发生在哪一层，再修复最接近根因的共享契约。这个方法同样适用于标签、菜单项、分页、卡片、表格控件和工具栏，不只适用于按钮。

| Observation | First check | Likely fix |
| - | - | - |
| DOM 外部尺寸相同，但填充控件看起来更大 | 背景是否覆盖透明边框，边框颜色和阴影是否改变了可见边缘 | 统一 `background-clip`、边框占位和表面 token，不修改单个变体的宽高 |
| 相邻控件的 DOM 尺寸不同 | `box-sizing`、高度来源、line-height、padding 和层叠顺序 | 收敛到共享尺寸 token 与稳定的 `data-size` 契约 |
| 只有复合控件出现错位或双重边框 | wrapper 与内部输入/触发器各自绘制了哪些属性 | 指定一个 surface owner，内部控件只保留内容布局职责 |
| 只有 hover、focus、disabled 或 loading 状态异常 | 伪元素、focus ring、阴影和状态层是否改变了布局或可见边界 | 让状态层不参与外部尺寸，补齐状态矩阵并验证键盘路径 |
| 桌面正常、移动端异常 | 触控命中区、最小宽度、文字折行和横向溢出规则 | 用响应式语义 token 处理例外，不在页面上叠加临时像素偏移 |

推荐的实现闭环是：固定浏览器缩放、主题和视口复现问题；记录外部盒、内容盒和 computed style；确认唯一的 surface owner；在共享 primitive 或 token 层修复；最后重新检查同一组件的变体、状态、主题、组合和移动视口。若只能通过负 margin、额外 `1px` 或页面级 `!important` 让单张截图对齐，应先退回检查组件契约是否缺失。

## Guardrails / Reuse notes

- `getBoundingClientRect()` 相等只是必要条件，不是视觉一致性的充分条件；还要比较 `background-clip`、边框颜色、阴影、圆角和 focus ring。
- 修复“看起来大 1px”时，先检查透明边框是否被背景绘制、边框是否被 reset 清掉，以及 wrapper 和子控件是否重复绘制；不要直接修改某一个变体的宽高。
- 高度、边框、阴影和圆角应各自只有一个明确 owner；复合控件内部的输入框不能重新拥有外框。
- 所有共享尺寸都应来自 token 和语义变体；页面级微调只能表达真实的布局例外，不能替代组件契约。
- 移动端优先保证交互区域和文字可用性，再处理紧凑排列；不要为了桌面端对齐而把触控控件压缩到 `44px` 以下。
- 每个共享组件的视觉修复都应补充对应的状态矩阵或 Storybook 覆盖，并在页面验证中确认主题、视口和组合关系没有回归。
- 设计交接验收应先确认语义、几何、表面、状态和组合责任，再确认像素结果；否则实现者只能从截图猜测规则，局部修正很容易在其他控件或响应式断点上回归。
- 视觉验收应区分“实际尺寸不一致”和“视觉重量不一致”：前者修复布局契约，后者修复表面、排版、间距或层级 token，不用额外 `1px` 偏移把两类问题混在一起。
- 静态截图不是完整 UI 规格；设计交接至少要能回答页面在加载、空数据、失败、只读、权限变化、部分成功和结果待确认时显示什么、允许什么操作以及如何恢复。
- 背景刷新不得覆盖未提交的用户意图；草稿、当前项目/任务上下文和焦点恢复都应作为组合工作流的一部分验证。
- 可访问名称、原生表单语义、键盘路径、焦点陷阱/恢复和移动端命中区属于设计验收，不应在视觉验收后作为“另外补的工程细节”。
- 组件 Storybook 证明局部状态，页面或 login-free demo 证明组合层级和响应式行为；两者缺一不可时，不要把单一截图当作完整验收。

## References

- [`web/src/index.css`](../../../web/src/index.css) defines shared theme tokens, control metrics, border ownership and background clipping.
- [`web/src/components/ui/button.tsx`](../../../web/src/components/ui/button.tsx) defines semantic button variants and sizes through `data-*` contracts.
- [`web/src/components/ui/input.tsx`](../../../web/src/components/ui/input.tsx) and [`web/src/components/ui/select.tsx`](../../../web/src/components/ui/select.tsx) show the ordinary form-control ownership boundary.
- [`web/src/components/ui/ControlMetrics.stories.tsx`](../../../web/src/components/ui/ControlMetrics.stories.tsx) provides a reusable state matrix for themes, sizes and control combinations.
- [`web/src/components/product/ProductShell.tsx`](../../../web/src/components/product/ProductShell.tsx) and [`web/src/components/product/TaskViews.tsx`](../../../web/src/components/product/TaskViews.tsx) show page composition, responsive navigation and multi-view presentation boundaries.
- [`web/src/features/tasks/TaskForm.tsx`](../../../web/src/features/tasks/TaskForm.tsx) and [`web/src/features/projects/ProjectForm.tsx`](../../../web/src/features/projects/ProjectForm.tsx) are form-level examples for preserving user intent and expressing write results.
- [`docs/design/HANDOFF.md`](../../design/HANDOFF.md) contains the product surface and responsive design context used by the shared UI implementation.
