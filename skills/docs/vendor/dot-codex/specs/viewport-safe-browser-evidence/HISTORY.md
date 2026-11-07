# Viewport-safe browser evidence capture 演进历史（#5fsxh）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `9886a7f` docs(skills): enforce viewport-safe browser evidence capture
- `b39a914` docs(specs): adopt topic-level spec model
- 移动端验收在缺少主人、项目、spec 或稳定来源尺寸时采用 `393x852` CSS px，确保跨项目证据可比较；显式尺寸始终优先，避免默认值覆盖项目真实设备策略。

## Legacy Change Log

- 2026-05-29: 将 `ui_demo` 纳入 viewport-safe 浏览器证据契约：优先使用 demo 自身稳定场景并记录 `viewport_strategy=ui-demo-source`，缺少 source-managed viewport 时再走 `devtools-emulate`。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#5fsxh`.
