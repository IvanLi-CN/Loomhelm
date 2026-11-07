# Storybook skill 增强与 docs-first 交付规范 演进历史（#ar7tp）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `444fd8d` feat(storybook): strengthen docs-first skill coverage
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- 2026-03-17: 新建规格，锁定 docs-first Storybook skill 升级范围与验收口径。
- 2026-03-17: 完成 Storybook skills、联动模板、索引与元数据升级，并通过本地 skill 校验。
- 2026-05-29: 将 Storybook 强制边界收敛到组件、片段与可复用状态；完整页面/流程默认改由稳定 `ui_demo` 取证，缺少 `ui_demo` 时才使用完整页面级 Storybook fallback。
- 2026-05-29: 收紧 `storybook-screenshots` 输出合同：该 skill 只能报告 `storybook_docs` / `storybook_canvas` 证据，`ui_demo` 成功态必须由 `$ui-visual-evidence` 的 demo/browser 路径报告。
- 2026-06-21: 补上 owner 显式非 Storybook 来源锁定合同，要求 Storybook skill 在整页/流程场景下只能作为“缺少合格 `ui_demo` 且无锁定冲突”时的合法 fallback。
- 2026-07-20: 配套收紧 Storybook 截图与模板入口的 PR 选择器语义，只保留 `PR: include` / `PR: none`，并明确自然语言 `Recommended PR subset...` 不再是有效 selector。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#ar7tp`.
