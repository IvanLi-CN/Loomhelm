# Agent memory 与项目文档 promotion 分层 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 固化 `specs + solutions` 与 human-facing project docs 分层，并新增 project-doc promotion gate / skill / docs-migrate 轨道

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-04-22
- Legacy last-tracked: 2026-04-22
- Current lifecycle: active
- Catalog note: 固化 `specs + solutions` 与 human-facing project docs 分层，并新增 project-doc promotion gate / skill / docs-migrate 轨道

## Delivery Milestones

- [x] M1: 固化 Agent memory / human docs 分层，并补仓库级 docs 入口说明。
- [x] M2: 在共享 workflow 与 flow skill 中加入 `project_doc_disposition` gate。
- [x] M3: 新增 `$project-doc-promote`，并扩展 `$docs-migrate MODE=project-docs`。
- [x] M4: 收紧 PR `References` 规则，并同步 skills/docs 索引。

## Rollout Artifacts

### Docs touched

- `AGENTS.md`
- `docs/README.md`
- `docs/specs/README.md`
- `docs/solutions/README.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/normal-flow/SKILL.md`
- `skills/fast-flow/SKILL.md`
- `skills/local-merge-flow/SKILL.md`
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- `skills/docs-migrate/SKILL.md`
- `skills/docs-migrate/references/project-docs-mode.md`
- `skills/project-doc-promote/SKILL.md`
- `skills/README.md`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `98b5045` docs(workflow): add project-doc promotion gate
- `4ac9673` docs(workflow): close project-doc review gaps
- `b3f69a4` docs(workflow): harden project-doc promotion gates
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
