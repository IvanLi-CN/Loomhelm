# 主题级 Spec 模型与历史 specs hygiene 演进历史

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `b39a914` docs(specs): adopt topic-level spec model
- `b21cbfe` feat(skills): add solution sync and spec sync
- `6ecce09` fix(spec-sync): honor legacy spec refs

## Current Model Corrections

- 初版 topic-level 模型纠正了“一任务一 spec”的问题，但把部分 `Status` / `Milestones` / `Change log` 细节删得过头了。
- 当前版本改为：`SPEC.md` 只保留规范正文；实现状态与 rollout 事实迁到 `IMPLEMENTATION.md`；关键演进原因迁到 `HISTORY.md`。
- 这样 Agent 仍然可以在 spec 目录内直接回答“现在做到哪了”“为什么会变成这样”，而不用回头跨 PR / commit 历史搜证。
- 随后的 review 收敛又补了一层 legacy 兼容：在 canonical `docs/specs/**` 尚未建立前，legacy `docs/plan/**/PLAN.md` 仍必须被 `spec-sync` 视为有效同步目标；一旦通过 `$docs-migrate MODE=specs` 建立 canonical 目录，该目录也必须一次补齐 companion docs，避免刚迁完就被新的 drift gate 反咬。
- 同一轮 review 还收紧了兼容边界：历史上已经 canonicalize、但仍是 `SPEC.md`-only 的旧 spec 目录不应被立刻硬阻断；只有当目录里已经开始使用 companion docs，才要求 `IMPLEMENTATION.md` / `HISTORY.md` 保持完整。
- 后续将新建身份从 ID 改为稳定 topic slug：历史 ID 目录不批量重命名，读取与 Git rename 映射继续兼容；新建目录、related_specs、视觉证据与 PR metadata 一律使用 `docs/specs/<topic>/`。
- Legacy drift mapping now requires proof before stripping an apparent ID prefix: an exact historical catalog `ID + source path` row or a same-diff Git rename. This prevents valid slugs such as `audit-logs` from being rewritten as `logs`.
- Canonical target identity is now validated independently of legacy-ID proof: an unproven or historical directory name that is not lowercase kebab-case cannot become a new Spec path until the caller supplies an explicit stable topic slug.
- Legacy-ID proof now normalizes catalog-relative paths after Markdown unwrapping and searches reachable catalog history, so the lifecycle-only catalog transition does not make existing ID-prefixed directories impossible to hygienically rename.

## Legacy Change Log

- No legacy change-log section was recorded for this spec.
- Legacy compatibility identity: `#weppn`.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
