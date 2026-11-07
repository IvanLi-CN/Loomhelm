# Storybook skill 增强与 docs-first 交付规范 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 将 Storybook 交付升级为组件/片段优先：主要状态矩阵、关键 play 测试、docs/canvas 双来源截图，并把完整页面证据默认分流到 `ui_demo`

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-17
- Legacy last-tracked: 2026-03-17
- Current lifecycle: active
- Catalog note: 将 Storybook 交付升级为组件/片段优先：主要状态矩阵、关键 play 测试、docs/canvas 双来源截图，并把完整页面证据默认分流到 `ui_demo`

## Delivery Milestones

- [x] M1: 建立 `docs/specs/storybook-skill-upgrade/SPEC.md` 规格并更新 specs 索引
- [x] M2: 升级 `storybook-stories` 与 supporting reference / metadata
- [x] M3: 升级 `storybook-screenshots` 并同步 `pr-create`
- [x] M4: 更新模板、skills 索引并完成校验与本地提交

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`: 新增 `docs/specs/storybook-skill-upgrade/SPEC.md` 规格索引
- `skills/storybook-stories/SKILL.md`: 升级为 docs-first Storybook 交付规范
- `skills/storybook-stories/references/state-coverage.md`: 新增状态矩阵与 docs 布局参考
- `skills/storybook-stories/agents/openai.yaml`: 刷新 skill UI 元数据
- `skills/storybook-screenshots/SKILL.md`: 扩展 docs/canvas 双来源截图规则
- `skills/ui-visual-evidence/SKILL.md`: 新增 `ui_demo` 页面/流程证据源并按对象分流
- `skills/storybook-screenshots/agents/openai.yaml`: 新增 skill UI 元数据
- `docs/specs/shared-ui-visual-evidence-gate/replay/*`: 复用主视觉证据 spec 的 focused replay 覆盖 Storybook 边界回归
- `skills/pr-create/SKILL.md`: 扩展视觉证据来源枚举
- `skills/docs-plan/templates/SPEC.md`: 更新 Storybook 质量门槛描述
- `skills/README.md`: 补充 `storybook-stories` 并刷新 Storybook 相关简介

### Plan assets

- Directory: `docs/specs/storybook-skill-upgrade/assets/`
- In-plan references: None
- PR visual evidence source: not used for this docs/skill change

### Asset promotion

None

## Related Changes

- `444fd8d` feat(storybook): strengthen docs-first skill coverage
- `b39a914` docs(specs): adopt topic-level spec model
- Current policy update: route full-page visual evidence through `ui_demo`
- Current policy update: keep `storybook-screenshots` final source reporting limited to Storybook evidence sources
- Current policy update: Storybook skills must preserve owner-explicit non-Storybook evidence locks instead of reframing fallback as success
- Current policy update: Storybook screenshot/template entrypoints now teach only `PR: include` / `PR: none`; free-text PR subset hints are no longer valid selector guidance

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
