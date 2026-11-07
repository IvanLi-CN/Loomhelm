# Flow continue lock guard 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

Permit/replay details below are historical rollout snapshots. Current direct flow uses ordinary current-head convergence and the active review contract; it does not use the historical replay checker as a Tier 3/4 gate.

## Current Status

- Continuation retains the authorized late-deferral list and source identity/count, waits at the source owner merge gate, and resumes or reuses one independent fast-flow follow-up after actual merge; it neither republishes duplicates nor resets the source repair budget.

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 固化锁定 flow 优先级，阻止热更新文案把旧 session 误改路由到 local-merge
- V3 recovery: 新 session 只恢复单一 `flow_type`；legacy topology/组合仅按冻结合同只读恢复。
- Alias coverage: replay checker 与 planner 统一识别 `多ticket倡议`、`倡议流` Initiative 锁定值。
- Current convergence: locked flow 只根据刷新后的 current-head facts 与 active review disposition contract 继续 ordinary convergence；Design-Returning Review Finding 停止普通收敛，Review Observation 只报告，缺少匹配 `repo_root`/base/head 或累计 batch anchor 时不重启 reviewer/预算，历史 replay marker、permit、receipt rebind 和 repair-wave route 不参与当前 direct-flow gate。
- Nested task-local `$fast-flow` state is tracked independently from the parent `multi-task-flow` route, so task PR evidence cannot rewrite parent flow identity or closeout ownership.
- Continuation replay tests bind the complete anchor: `repo_root`, base/head, lane, scope, review profile, locked flow, ownership promise, and cumulative Repair Batch count; any mismatch is rejected without relaunching work.
- The active Spec contract guard covers this disposition and anchor vocabulary alongside the canonical review Spec.
- Isolated-copy tests reject retired disposition terms in every active review Spec.
- Review replay rejects an unclassified repair and requires the complete candidate anchor for owner-authorized continuation.
- Instruction architecture checks cover the continuation disposition, Candidate-anchor fields, and behavioral boundary alongside the locked-flow contract.

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-03-14
- Legacy last-tracked: 2026-03-14
- Current lifecycle: active
- Catalog note: 固化锁定 flow 优先级，阻止热更新文案把旧 session 误改路由到 local-merge
- Legacy permit recovery: checker 只接受 generic continuation 前、当前 flow lock 下同一条 assistant message 中完整且无重复的 canonical structured facts；旧 recovery route 与 receipt rebind 仅保留为历史审计材料。

## Delivery Milestones

- [x] M1: 建立 flow continue lock guard 规格并登记索引
- [x] M2: 收紧共享 workflow / flow-continue / local-merge / prompt 的锁定优先级
- [x] M3: 新增 replay checker、fixtures 与 cases
- [x] M4: initiative recovery 识别 child integration CI 与 aggregate SHA-bound owner approval
- [x] M5: 为 issued permit/base fast-forward recovery 增加 route guard 与脱敏正负 replay
- [x] M6: 将 recovery marker 固定为可信原子快照，并覆盖部分、矛盾、非可信与 flow-switch 误路由
- [x] M7: 将 recovery route 固定为结构化调用，覆盖最新 marker、canonical 值、反向否定、顶层 reopen、draft bootstrap 与可选 head CLI 变体

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `AGENTS.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/local-merge-flow/SKILL.md`
- `prompts/advance-flow.md`
- `skills/initiative-flow/SKILL.md`
- `bin/flow_continue_replay_check.py`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `91e9479` fix(flow): preserve locked flow across prompt drift
- `b39a914` docs(specs): adopt topic-level spec model
- current worktree: route child/aggregate frontier recovery through `$initiative-flow` and prevent generic aggregate final merge

## Remaining Gaps

- None currently tracked; current direct flow follows refreshed current-head facts and the active Formal Review Wave disposition contract.

## References

- `./SPEC.md`
- `./HISTORY.md`
