# Review proof 去重与等待语义守卫 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: shared review-proof contract 改按真正审查进展启动态，并以 runtime banner 作为 sandbox 真相源

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-17
- Legacy last-tracked: 2026-04-12
- Current lifecycle: active
- Catalog note: shared review-proof contract 改按真正审查进展启动态，并以 runtime banner 作为 sandbox 真相源

## Delivery Milestones

- [x] M1: 建立规格、共享 review-proof 短规约与索引登记
- [x] M2: 收紧 `$codex-review-loop` / `$flow-continue` / shared workflow / prompts，并瘦身重复规则
- [x] M3: 新增 focused replay checker 与 replay fixtures
- [x] M4: 跑本地检查并收口到可继续 local-merge handoff

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `docs/specs/review-proof-dedupe-wait-guard/SPEC.md`
- `skills/project-engineering-workflow/references/review-proof-short-contract.md`
- `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
- `skills/codex-review-loop/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/local-merge-flow/SKILL.md`
- `prompts/advance-flow.md`
- `prompts/pr-create.md`
- `prompts/pr-merge.md`
- `bin/review_proof_replay_check.py`
- `docs/specs/review-proof-dedupe-wait-guard/replay/*`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `dab0cc2` fix(flow): guard review proof lifecycle
- `8a262c7` docs(review): align proof startup with codex runtime
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
