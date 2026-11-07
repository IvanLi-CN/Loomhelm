# Flow continue lock guard 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 固化锁定 flow 优先级，阻止热更新文案把旧 session 误改路由到 local-merge

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-14
- Legacy last-tracked: 2026-03-14
- Current lifecycle: active
- Catalog note: 固化锁定 flow 优先级，阻止热更新文案把旧 session 误改路由到 local-merge

## Delivery Milestones

- [x] M1: 建立 flow continue lock guard 规格并登记索引
- [x] M2: 收紧共享 workflow / flow-continue / local-merge / prompt 的锁定优先级
- [x] M3: 新增 replay checker、fixtures 与 cases
- [x] M4: initiative recovery 识别 child integration CI 与 parent SHA-bound owner approval

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `AGENTS.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/local-merge-flow/SKILL.md`
- `prompts/advance-flow.md`
- `skills/wave-thread-flow/SKILL.md`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `91e9479` fix(flow): preserve locked flow across prompt drift
- `b39a914` docs(specs): adopt topic-level spec model
- current worktree: route child/parent frontier recovery through `$wave-thread-flow` and prevent generic parent final merge

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
