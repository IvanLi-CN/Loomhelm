# Review proof ownership 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: startup_success 仅认真正审查进展输出，init timeout 提高到 300s；sandbox 真相源改看 runtime banner

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-16
- Legacy last-tracked: 2026-04-12
- Current lifecycle: active
- Catalog note: startup_success 仅认真正审查进展输出，init timeout 提高到 300s；sandbox 真相源改看 runtime banner

## Delivery Milestones

- [x] M1: 建立 review proof ownership 规格并登记索引
- [x] M2: 收紧 `$codex-review-loop` 的 startup / timeout / restart / stale-proof 契约
- [x] M3: 收敛共享 wait-state 规则并瘦身下游 skills/prompts

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `skills/codex-review-loop/SKILL.md`
- `skills/project-engineering-workflow/references/review-proof-short-contract.md`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`
- `prompts/goto-impl-branch.md`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `6d1ac7f` fix(review): preserve active proof lifecycle
- `8a262c7` docs(review): align proof startup with codex runtime
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
