# 全局 solutions 复利模型与 docs-migrate 统一迁移技能 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 收敛 docs-migrate / docs-solutions / 全局入口接线与 compatibility shim

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-04-12
- Legacy last-tracked: 2026-04-12
- Current lifecycle: active
- Catalog note: 收敛 docs-migrate / docs-solutions / 全局入口接线与 compatibility shim

## Delivery Milestones

- [x] M1: 新增 `docs/solutions` 契约与最小 frontmatter/schema 说明。
- [x] M2: 新建 `skills/docs-migrate/` 并承接 `plan-migrate` 的安全迁移能力。
- [x] M3: 更新全局 AGENTS、核心 flow、docs-plan 与入口 prompt 对 `docs-migrate` / `solutions` 的引用。
- [x] M4: 将 `prompts/plan-migrate.md` 收敛为兼容 shim，并完成最小夹具验证与本地 review 收敛。
- [x] M5: `MODE=specs` 的 canonical bootstrap 已明确要求同时创建 `SPEC.md`、`IMPLEMENTATION.md`、`HISTORY.md`，与 companion-doc drift gate 对齐。

## Rollout Artifacts

### Docs touched

- `.codex/AGENTS.md`: 加入 `docs/solutions` 与 `docs-migrate` 规则。
- `docs/solutions/README.md`: 建立 canonical knowledge-store 契约与 frontmatter/schema 说明。
- `skills/docs-migrate/**`: 新建迁移 skill 与 track-specific 参考。
- `skills/docs-plan/SKILL.md`: 扩展 root-resolution 与知识库关系说明。
- `skills/codex-review-loop/SKILL.md`: 加入 solutions knowledge pass 与 disposition hint 约定。
- `skills/project-engineering-workflow/SKILL.md`: 写入 solutions 检索/处置/刷新门禁。
- `prompts/goto-impl-branch.md`: 从 legacy 迁移提示切换为 `$docs-migrate`。

### Plan assets

- Directory: `docs/specs/global-solutions-docs-migrate/assets/`
- In-plan references: `![...](./assets/<file>.png)`
- Visual evidence source: maintain `## Visual Evidence` in this spec when owner-facing or PR-facing screenshots are needed.
- If an asset must be used in impl (runtime/test/official docs), list it in `资产晋升（Asset promotion）` and promote it to a stable project path during implementation.

### Asset promotion

None

## Related Changes

- `0250c7d` feat(workflow): add docs-migrate and solutions flow
- `ff68b01` fix(review): keep plan-migrate compatibility shim
- `ee8280a` docs(specs): close docs-migrate rollout
- `8a262c7` docs(review): align proof startup with codex runtime
- `b39a914` docs(specs): adopt topic-level spec model
- `b21cbfe` feat(skills): add solution sync and spec sync
- `1ce2aff` fix(review): block incomplete associated specs

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
