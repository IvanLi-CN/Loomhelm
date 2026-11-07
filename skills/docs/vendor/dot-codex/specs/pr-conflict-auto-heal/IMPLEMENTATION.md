# PR conflict auto heal 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 将“Actions 缺席其实是 PR 冲突”收口到 freshness gate，并自动解冲续推

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-15
- Legacy last-tracked: 2026-03-15
- Current lifecycle: active
- Catalog note: 将“Actions 缺席其实是 PR 冲突”收口到 freshness gate，并自动解冲续推

## Delivery Milestones

- [x] M1: 建立 `docs/specs/pr-conflict-auto-heal/SPEC.md` 规格并登记索引
- [x] M2: 在 shared Step 5 中前置 conflict-aware absence diagnosis
- [x] M3: 收紧 `workflow PR publication procedure` / `workflow PR merge procedure` / `$flow-continue` 的 auto-heal 路径
- [x] M4: 扩展 replay checker 与 fixtures

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `docs/specs/pr-conflict-auto-heal/SPEC.md`
- `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
- `skills/project-engineering-workflow/references/ci-tracking-short-contract.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- `skills/project-engineering-workflow/references/pr-merge-procedure.md`
- `skills/flow-continue/SKILL.md`
- `bin/pr_skill_replay_check.ts`
- `docs/specs/pr-conflict-auto-heal/replay/*`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `b282add` fix: auto-heal PR conflict diagnostics
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
