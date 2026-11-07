# 本地聊天图片快照存储 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 为 owner-facing Chat 图片新增不可变快照 helper、Markdown/HTML 图片 Stop hook 门禁与 Chat/PR URL 分离契约

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-04-11
- Legacy last-tracked: 2026-04-11
- Current lifecycle: active
- Catalog note: 为 owner-facing Chat 图片新增不可变快照 helper、Markdown/HTML 图片 Stop hook 门禁与 Chat/PR URL 分离契约

## Delivery Milestones

- [x] M1: 新建 `docs/specs/local-chat-image-snapshots/SPEC.md` 规格并更新 specs 索引
- [x] M2: 新增本地聊天图片快照 helper 与自测
- [x] M3: 为 `user-inline-assets/` 补 git ignore 规则
- [x] M4: 同步全局提示词、AGENTS 与受影响 skills 的聊天图片契约
- [x] M5: 新增 `owner_facing_image_gate.py`、Stop hook 配置与坏例/修复例 replay 测试
- [x] M6: 同步 Chat/PR 双 URL 契约与两个 canonical Spec

## Rollout Artifacts

### Docs touched

- `instruction.md`: 新增全局本地聊天图片快照规则
- `AGENTS.md`: 新增 owner-facing Markdown/HTML 图片快照硬规则
- `skills/ui-visual-evidence/SKILL.md`: 视觉证据聊天回图改为快照路径
- `skills/storybook-screenshots/SKILL.md`: Storybook 本地聊天图改为快照路径
- `skills/ui-visual-evidence/SKILL.md`: mock/browser 本地截图聊天回图改为快照路径
- `skills/firmware-display-preview/SKILL.md`: `preview.png` 与聊天展示路径分离
- `docs/specs/README.md`: 新增 `docs/specs/local-chat-image-snapshots/SPEC.md` 索引
- `bin/owner_facing_image_gate.py`: Stop hook 图片 source 校验与一次续跑语义
- `bin/test_owner_facing_image_gate.py`: 单元测试与 replay runner
- `docs/specs/local-chat-image-snapshots/replay/cases.json`: 远程/相对/HTML/代码/超链接坏例与豁免例
- `hooks.json`: 注册 owner-facing 图片 Stop hook
- `skills/pr-create/SKILL.md`: 明确 Chat 与 PR 图片 URL 不复用

### Plan assets

- Directory: `docs/specs/local-chat-image-snapshots/assets/`
- In-plan references: None
- Visual evidence source: not used for this prompt/script change

### Asset promotion

None

## Related Changes

- `f9ebf1c` feat(images): snapshot local chat images
- `b39a914` docs(specs): adopt topic-level spec model

## Rollout Note

- PR 合并后通过 `/hooks` 手动 review/trust 新 Stop hook，并重启或开启新任务验证实际生效；不通过旁路命令绕过该门禁。

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
