# PR 续推 skill 瘦身与诊断优先级收敛 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 收拢 approval/mergeability/continue 诊断优先级，新增 focused replay checker 并瘦身 PR 续推 skill

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-15
- Legacy last-tracked: 2026-03-15
- Current lifecycle: active
- Catalog note: 收拢 approval/mergeability/continue 诊断优先级，新增 focused replay checker 并瘦身 PR 续推 skill

## Delivery Milestones

- [x] M1: 建立规格与共享 PR 诊断短规约
- [x] M2: 压缩共享 workflow 与 3 个入口 skill
- [x] M3: 新增 focused replay checker 与 fixtures
- [x] M4: 跑本地检查并收口到 merge-ready（local）

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `docs/specs/pr-skill-diagnosis-thinning/SPEC.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
- `skills/flow-continue/SKILL.md`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`
- `bin/pr_skill_replay_check.py`
- `docs/specs/pr-skill-diagnosis-thinning/replay/*`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `97e541d` fix(skill): tighten pr diagnosis routing
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
