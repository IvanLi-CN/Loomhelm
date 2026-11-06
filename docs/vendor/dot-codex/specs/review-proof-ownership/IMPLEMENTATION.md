# Review proof ownership 历史实现记录

> 本主题已由 [`mandatory-local-review-proof`](../mandatory-local-review-proof/SPEC.md) 替代。本文件仅保留历史实现上下文，不定义当前路由、门禁或 proof 生产方式。

## Current Status

- Implementation: historical
- Lifecycle: superseded
- Active contract: `mandatory-local-review-proof`

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-16
- Legacy last-tracked: 2026-04-12
- Current lifecycle: superseded
- Catalog note: helper-owned proof 与 native-agent receipt 均为历史实现；当前 direct flow 使用 successor contract

## Delivery Milestones

- [x] M1: 建立 review proof ownership 规格并登记索引
- [x] M2: 建立 read-only sub-agent 的 terminal / schema / stale-proof 契约
- [x] M3: 收敛共享 wait-state 规则并瘦身下游 skills/prompts
- [x] M4: `flow_receipt.py record --kind review --wave-id <wave> --lane <lane> --review-result-json <structured-result>` 登记结构化结果
- [x] M5: shared flow 改为 main-agent 单写入与按 SHA 短生命周期 receipt

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `bin/flow_receipt.py`
- `bin/test_flow_receipt.py`
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
