# Visual evidence 外缘空白裁剪规范 演进历史（#vw73w）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `188e114` feat(ui-evidence): trim excessive screenshot whitespace
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- 2026-03-26: 新建 follow-on 规格，锁定 Mock + Storybook 视觉证据的外缘空白裁剪契约。
- 2026-03-26: 完成共享 helper、技能契约和本地测试/校验。
- 2026-05-29: 将 `ui_demo` 纳入 mock-first 视觉证据标准化范围，与 `mock_ui`、`storybook_docs`、`storybook_canvas` 使用同一外缘空白裁剪契约。
- 2026-07-15: 将组件/片段/可复用状态与 `mock_ui` 证据从“保守 trim + fail-open”升级为硬留边门禁，新增 `margin_policy=trim_only|require_margin` 与 `evidence_surface` 双模式语义，并保留 `空白裁剪` 作为兼容状态字段。
- 组件证据改为源管理展示面：Story 提供 `data-visual-evidence-surface` / `data-visual-evidence-target` 与自然主题留白；截图端只做一次 DOM 预检和 surface 内几何收紧，`require_margin` helper 改为像素分析前阻断。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#vw73w`.
