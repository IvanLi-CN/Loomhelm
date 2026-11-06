# Viewport-safe browser evidence capture 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 统一浏览器证据的非改窗优先截图契约，并为未指定尺寸的移动端验收提供 `393x852` CSS px 默认 viewport

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Current lifecycle: active
- Catalog note: 统一浏览器证据的非改窗优先截图契约，加入 `ui_demo` source-managed 场景优先，保留 resize 仅作可恢复兜底

## Delivery Milestones

- [x] M1: 新建 `docs/specs/viewport-safe-browser-evidence/SPEC.md` 规格并登记到 `docs/specs/README.md`
- [x] M2: 更新 4 个主 skill 的 viewport-safe 浏览器证据契约
- [x] M3: 同步相关 agent metadata / skills 索引并完成本地校验

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`: 新增 `docs/specs/viewport-safe-browser-evidence/SPEC.md` 索引行
- `skills/storybook-screenshots/SKILL.md`: 新增 Storybook viewport-safe 截图契约与 metadata，并为直接移动端截图调用继承 `393x852` CSS px fallback
- `AGENTS.md` 与 evidence skills：新增通用浏览器 viewport-safe 截图梯度与 resize fallback 约束
- `skills/ui-visual-evidence/SKILL.md`: 统一 Storybook、`ui_demo` 与 mock 浏览器证据的 source sizing ladder；未声明移动端尺寸时使用 `393x852` CSS px，并保持主人、项目、spec 与来源 surface 的显式覆盖优先级
- `skills/storybook-stories/SKILL.md`: 增加响应式 Storybook 入口前置要求，并在缺少显式尺寸时把 `393x852` CSS px 绑定到选定证据 surface
- `skills/storybook-screenshots/agents/openai.yaml`: 刷新默认 prompt，并保持显式 viewport 优先于移动端 fallback
- `skills/ui-visual-evidence/agents/openai.yaml`: 刷新默认 prompt，并保持 owner、project、spec、Storybook/demo source 的完整 viewport 优先级
- `skills/storybook-stories/agents/openai.yaml`: 刷新默认 prompt，并传播移动端 viewport 优先级与 fallback
- `skills/README.md`: 刷新技能索引简介，并保留 owner 锁定来源对 Storybook fallback 的约束

### Plan assets

- Directory: `docs/specs/viewport-safe-browser-evidence/assets/`
- In-plan references: None
- Visual evidence source: not used for this policy-only change

### Asset promotion

None

### Visual evidence

- Disposition: not applicable
- Reason: policy-only Skill, Spec, and index changes do not alter a rendered surface
- PR selector: `PR: none`

## Related Changes

- `9886a7f` docs(skills): enforce viewport-safe browser evidence capture
- `b39a914` docs(specs): adopt topic-level spec model
- Current policy update: include `ui_demo` in viewport-safe evidence ladder
- Current policy update: add `ui-demo-source` viewport strategy for source-managed demo scenarios
- Current policy update: use `393x852` CSS px as the fallback mobile acceptance viewport when no explicit size exists
- Current policy update: require the fallback viewport to be applied and verified on the rendered surface before metadata is recorded
- Current policy update: keep Storybook fallback viewport binding on the stable story/docs surface rather than capture-time emulation
- Current policy update: remove `devtools-emulate` from Storybook-only evidence metadata because capture-time emulation is unsupported there
- Current policy update: make Storybook coverage materialize the fallback viewport before capture

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
