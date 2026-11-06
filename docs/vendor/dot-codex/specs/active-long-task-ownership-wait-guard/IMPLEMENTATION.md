# 长任务 ownership 与等待语义守卫 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 收紧 live 长任务的 ownership promise、停靠语义与 focused replay 守卫
- Receipt budget coverage: 本地命令默认 1800 秒、一次 transient retry、内层预算继承已进入 shared contract。

## Historical rollout snapshot

- Legacy status snapshot: 已实现
- Legacy created: 2026-04-08
- Legacy last-tracked: 2026-04-08
- Current lifecycle: active
- Catalog note: 收紧 live 长任务的 ownership promise、停靠语义与 focused replay 守卫

## Delivery Milestones

- [x] M1: 建立规格、shared long-task contract 与索引登记
- [x] M2: 收紧 `AGENTS.md`、`$flow-continue`、shared workflow、`$codex-review-loop` 与共享摘要口径
- [x] M3: 新增 focused replay checker 与最小化 replay fixtures
- [x] M4: 跑本地检查并收口到可继续 local-merge handoff

## Rollout Artifacts

### Docs touched

- `docs/specs/README.md`
- `docs/specs/active-long-task-ownership-wait-guard/SPEC.md`
- `AGENTS.md`
- `skills/README.md`
- `skills/project-engineering-workflow/references/active-long-task-short-contract.md`
- `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
- `skills/project-engineering-workflow/references/review-proof-short-contract.md`
- `skills/flow-continue/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/codex-review-loop/SKILL.md`
- `bin/active_long_task_replay_check.py`
- `docs/specs/active-long-task-ownership-wait-guard/replay/*`

### Plan assets

None

### Asset promotion

None

## Related Changes

- `61bac95` fix(workflow): guard active long-task ownership waits
- `b39a914` docs(specs): adopt topic-level spec model

## Remaining Gaps

- None currently tracked.

## References

- `./SPEC.md`
- `./HISTORY.md`
