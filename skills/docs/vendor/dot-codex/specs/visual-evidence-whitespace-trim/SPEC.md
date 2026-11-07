# Visual evidence 外缘空白与组件展示面规范

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## Context and Scope

组件证据的留白属于 Story 的展示语义，而不是截图文件的像素属性。截图时从像素推断背景并补边，无法判断颜色是否属于真实主题，容易制造多余边框、重复留白或嵌套卡片观感。本主题规定组件证据的源管理展示面、一次性 DOM 预检和页面级 trim-only fallback。

### In scope

- `$ui-visual-evidence` 与 `$storybook-screenshots` 的组件证据捕获合同。
- `$storybook-stories` 对被选为组件证据的 Story/docs 展示面要求。
- `skills/ui-visual-evidence/scripts/trim_whitespace.py` 的页面裁切与兼容阻断行为。

### Out of scope

- 业务仓库的组件样式、Story 组织、页面布局和历史证据图片。
- `firmware_preview`、`target_app_window` 或新的截图后端。
- 业务仓库 CI、`play`、测试配置、持久化测量回执和 owner-facing 测量字段。

## Requirements

### REQ-VISUAL-SURFACE-001

选作组件、片段、可复用状态或 `mock_ui` 证据的 DOM 源 MUST 提供外层 `[data-visual-evidence-surface]` 与其内的 `[data-visual-evidence-target]`。target MUST 包含全部可见组件效果，surface MUST 拥有目标的自然外边距。

### REQ-VISUAL-SURFACE-002

展示面 MUST 使用当前 Story 主题自有的不透明、均匀、纯色背景，且 MUST NOT 新增边框、圆角、阴影、渐变、图片背景、证据专用颜色、画框边界或嵌套卡片。已有合理留白时 MUST NOT 额外补留白。

### REQ-VISUAL-SURFACE-003

组件捕获 MUST 在截图前只做一次 DOM 预检，读取已声明 selectors、target/surface 矩形、containment、overflow 与 computed styles。预检 MUST 量化 `required_margin=clamp(round(long_edge * 0.02), 16, 48)`，并确认四边 target-to-surface 间距均在 `[required_margin, 48]`。

### REQ-VISUAL-SURFACE-004

当任一边超过 `48px` 时，捕获 MAY 仅在声明的 surface 内按已知 DOM 几何收紧该边至 `48px`；不得使用像素分析裁切。流程 MUST NOT 注入 DOM、改写样式、合成补边、推断背景或保存测量回执。

### REQ-VISUAL-SURFACE-005

缺少 selector、surface 透明或非自然背景、存在画框样式、target 越界、任一边小于 `required_margin` 或无法证明自然主题 surface 时，组件捕获 MUST 阻断并回到 `$storybook-stories`。阻断报告 MUST 使用 `视觉证据=不存在`、`空白裁剪=不适用` 并包含实测原因；合规且未收紧时使用 `空白裁剪=无需裁剪`，收紧时使用 `空白裁剪=已裁剪`。

### REQ-VISUAL-SURFACE-006

页面或完整页面 Storybook fallback MUST 保留 `trim_only`：仅检测边缘连通的统一背景并裁切多余外缘，保留可用的目标留白。`trim_whitespace.py --margin-policy=require_margin` MUST 保留 CLI 参数兼容，但 MUST 在任何像素分析前返回 `action=blocked` 与 `reason=source_managed_surface_required`，不得裁切、补边或合成组件图。

## Verification

### VER-VISUAL-SURFACE-001

- Method: inspect `$storybook-stories`, `$storybook-screenshots`, and `$ui-visual-evidence` contracts plus `skills_index_check.py`.
- covers: REQ-VISUAL-SURFACE-001, REQ-VISUAL-SURFACE-002, REQ-VISUAL-SURFACE-003, REQ-VISUAL-SURFACE-004, REQ-VISUAL-SURFACE-005
- Pass condition: selectors, opaque natural surface, formula, `[required_margin,48]` range, one-preflight boundary, no-mutation rules, and block/report states are explicit.

### VER-VISUAL-SURFACE-002

- Method: `python3 skills/ui-visual-evidence/scripts/test_trim_whitespace.py`.
- covers: REQ-VISUAL-SURFACE-006
- Pass condition: trim-only crop/no-op/internal whitespace regressions pass; `require_margin` blocks before pixel analysis, never crops or pads, and preserves the input bytes.

### VER-VISUAL-SURFACE-003

- Method: `python3 bin/spec_contract_check.py --path docs/specs/visual-evidence-whitespace-trim/SPEC.md` and the compatibility-copy comparison.
- covers: REQ-VISUAL-SURFACE-001, REQ-VISUAL-SURFACE-002, REQ-VISUAL-SURFACE-003, REQ-VISUAL-SURFACE-004, REQ-VISUAL-SURFACE-005, REQ-VISUAL-SURFACE-006
- Pass condition: canonical structure, normative requirements, verification traceability, ADR membership, and byte-identical stable/legacy Spec copies pass.

## Related ADRs

- [组件证据采用源管理展示面](../../adr/0007-source-managed-component-evidence.md)

## References

- `skills/storybook-stories/SKILL.md`
- `skills/storybook-screenshots/SKILL.md`
- `skills/ui-visual-evidence/SKILL.md`
- `skills/ui-visual-evidence/scripts/trim_whitespace.py`
