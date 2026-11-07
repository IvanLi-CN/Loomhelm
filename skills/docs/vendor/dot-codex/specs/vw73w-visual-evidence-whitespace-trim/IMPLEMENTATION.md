# Visual evidence 外缘空白裁剪规范 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 页面保留 trim-only；组件证据改由 Story 源管理展示面与一次 DOM 预检保证自然留白

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-26
- Legacy last-tracked: 2026-07-15
- Current lifecycle: active
- Catalog note: 页面保留 trim-only；组件证据改由 Story 源管理展示面与一次 DOM 预检保证自然留白

## Delivery Milestones

- [x] M1: 建立 `docs/specs/visual-evidence-whitespace-trim/SPEC.md` 规格并更新 specs 索引
- [x] M2: 新增共享外缘空白裁剪 helper
- [x] M3: 同步 `ui-visual-evidence` 与 `storybook-screenshots` 契约
- [x] M4: 补充 helper 自测与本地校验
- [x] M5: 将组件 / `mock_ui` 证据升级为源管理展示面与一次 DOM 预检，禁止截图时补边

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`: 新增 `docs/specs/visual-evidence-whitespace-trim/SPEC.md` 规格索引
- `docs/specs/visual-evidence-whitespace-trim/SPEC.md`: 固化源管理展示面、一次 DOM 预检、页面 trim-only 与组件 hard-block 契约
- `skills/ui-visual-evidence/SKILL.md`: 明确组件展示面、量化留白、无 DOM mutation 与 `视觉证据=不存在` 阻断语义
- `skills/storybook-stories/SKILL.md`: 让选定组件证据的 Story 提供展示面，不将其误作 coverage 或 `play` 要求
- `skills/storybook-screenshots/SKILL.md`: 捕获前读取一次 DOM，仅在展示面内按几何收紧多余空白
- `skills/ui-visual-evidence/scripts/trim_whitespace.py`: 保留 trim-only 页面路径；兼容 require-margin 参数但在像素分析前 hard-block
- `skills/ui-visual-evidence/scripts/test_trim_whitespace.py`: 覆盖页面 trim-only 与 require-margin 无像素分析、无裁切、无补边回归

### Plan assets

- Directory: `docs/specs/visual-evidence-whitespace-trim/assets/`
- In-plan references: None
- Visual evidence source: not used for this skill/script change

### Asset promotion

None

## Related Changes

- `188e114` feat(ui-evidence): trim excessive screenshot whitespace
- `b39a914` docs(specs): adopt topic-level spec model
- Current policy update: include `ui_demo` in visual evidence trimming contract
- Current policy update: component / `mock_ui` evidence use source-managed surfaces instead of pixel inference or synthetic padding

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
