# Review model and effort defaults 实现状态（superseded）

> 本目录仅保留历史兼容读取；当前模型选择合同以 `../workflow-agent-model-selection/SPEC.md` 为准。

## Current Status

- Implementation: 已实现
- Lifecycle: superseded
- Successor: `../workflow-agent-model-selection/SPEC.md`
- Catalog note: 本重复主题已由现行 workflow model-selection 合同取代；保留此目录仅供历史兼容读取

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-17
- Legacy last-tracked: 2026-03-17
- Current lifecycle: superseded
- Catalog note: 现行模型自主选择、用户例外和 review profile 以 `../workflow-agent-model-selection/SPEC.md` 为准

## Delivery Milestones

- [x] M1: 建立 `docs/specs/review-effort-by-pr-stage/SPEC.md` 规格并登记索引
- [x] M2: 统一 review-loop 的模型、允许档位与默认矩阵
- [x] M3: 同步 shared workflow 与 PR 入口的 direct proof / convergence 文案
- [x] M4: 完成静态 CLI、文档一致性与 spec drift 检查

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `docs/specs/review-effort-by-pr-stage/SPEC.md`
- `docs/specs/review-effort-by-pr-stage/IMPLEMENTATION.md`
- `docs/specs/review-effort-by-pr-stage/HISTORY.md`
- `skills/codex-review-loop/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `54a9c9b` docs(workflow): align review effort defaults by pr stage
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
