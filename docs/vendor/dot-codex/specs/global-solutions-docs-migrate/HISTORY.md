# 全局 solutions 复利模型与 docs-migrate 统一迁移技能 演进历史（#bb5xj）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `0250c7d` feat(workflow): add docs-migrate and solutions flow
- `ff68b01` fix(review): keep plan-migrate compatibility shim
- `ee8280a` docs(specs): close docs-migrate rollout
- `8a262c7` docs(review): align proof startup with codex runtime
- `b39a914` docs(specs): adopt topic-level spec model
- `b21cbfe` feat(skills): add solution sync and spec sync

## Legacy Change Log

- 2026-04-12: 创建 spec，固定 `specs + solutions` 与 `docs-migrate` 的首轮实现范围。
- 2026-04-12: 完成 `docs/solutions` 契约、`docs-migrate` skill 与全局入口接线；保留 `prompts/plan-migrate.md` 作为 compatibility shim，并收敛 solutions gate / legacy id 语义。
- 2026-04-12: 完成最小夹具验证与本地 review 收敛，规格进入已完成。
- Companion-doc spec 模型上线后，`MODE=specs` 也被补充为创建完整 spec 目录（`SPEC.md` + `IMPLEMENTATION.md` + `HISTORY.md`），避免 legacy-plan-only 仓库刚 canonicalize 完就撞上新的 drift gate。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#bb5xj`.
