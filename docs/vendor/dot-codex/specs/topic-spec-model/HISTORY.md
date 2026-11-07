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
- Retained ID-prefixed directories are read-only compatibility aliases: an exact `Legacy compatibility identity` marker is sufficient to route stale historical paths to the slug-only canonical spec, while new writes remain canonical.
- ADR 的完整取舍现在独立保留在 `docs/adr/`；本主题只记录 Spec 模型如何索引并兼容该关系。
- `## Related ADRs` uses one canonical empty form: a bare `None` line. The strict Spec checker, drift detector, and Initiative ADR contract guard reject the list-form placeholder; unchanged legacy and external Specs remain readable compatibility inputs.

## Legacy Change Log

- No legacy change-log section was recorded for this spec.
- Legacy compatibility identity: `#weppn`.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`

## Related Changes

- Scope authority and topic Spec boundaries are recorded in [ADR 0004](../../adr/0004-scope-authority-and-topic-spec-boundaries.md).
- Canonical requirements now use stable REQ/VER identifiers; execution facts remain in companion docs.
- The canonical topic-Spec checker now rejects execution, status, PR-list, command-list, and unresolved-decision section headings while preserving workflow prose as requirements context.
- The authoring Skill is canonically named `$topic-spec`; the former `docs-plan` route is retired and no compatibility alias is installed.
