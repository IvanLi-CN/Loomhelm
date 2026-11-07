# PR post-open scope freeze 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: PR 打开后默认冻结范围，允许 behind/main-sync 必要兼容修复

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-15
- Legacy last-tracked: 2026-03-15
- Current lifecycle: active
- Catalog note: PR 打开后默认冻结范围，允许 behind/main-sync 必要兼容修复

## Delivery Milestones

None

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/pr-create/SKILL.md`
- `skills/fast-flow/SKILL.md`
- `skills/flow-continue/SKILL.md`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `b577074` fix(flow): freeze post-open PR scope
- `01a4501` fix(flow): generalize same-pr reopen scope
- `c39563c` fix(flow): extend reopen and freeze guardrails
- `7552826` fix(flow): persist same-pr reopen state
- `4986a57` fix(flow): bind reopen recovery to pr context
- `03654c5` fix(flow): tighten reopen recovery bindings
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
