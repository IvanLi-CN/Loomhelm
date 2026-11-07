# PR convergence batching 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 风险触发 pre-PR local proof、PR 批量收敛与 checks 缺席快速诊断

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-14
- Legacy last-tracked: 2026-03-14
- Current lifecycle: active
- Catalog note: 风险触发 pre-PR local proof、PR 批量收敛与 checks 缺席快速诊断

## Delivery Milestones

- [x] M1: 建立 `docs/specs/pr-convergence-batching/SPEC.md` 规格并登记索引
- [x] M2: 在 shared Step 4/5 中前置风险触发的 `pre-PR local proof`
- [x] M3: 固化 PR 批量收敛、current-SHA validation evidence 与 checks 缺席诊断门
- [x] M4: 为自动收敛增加 `3` 次 repair permit 止损
- [x] M5: 统一 `CI-Operator` sub-agent 的首选模型为 `gpt-5.6-luna + low`，绑定单一 PR head SHA，将主 agent CI 等待改为阻塞式 barrier，并把共享不变量集中到 CI tracking contract

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `skills/project-engineering-workflow/references/ci-tracking-short-contract.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/codex-review-loop/SKILL.md`
- `skills/pr-create/SKILL.md`
- `skills/fast-flow/SKILL.md`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `d443ac1` fix(flow): batch PR convergence before remote churn
- `71c44e5` fix(review): preserve convergence budgets across repair pushes
- `f565cff` fix(flow): enforce resumable PR convergence gates
- `281b1cd` fix(flow): honor no-write PR proof gates
- `b4544c8` fix(review): rerun stale pre-pr proofs on new heads
- `3b0afb3` fix(review): bind proof budget to current PR batch
- `90e80dd` fix(docs): persist PR budget bindings consistently
- `2c11073` fix(review): harden proof-only convergence rules
- `4895098` docs(review): add pragmatic stop-loss after repeated reviews
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
