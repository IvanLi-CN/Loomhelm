---
status: accepted
---

# Topic Spec Skill 命名与兼容边界

## Context

`docs-plan` 最初承载过 work-item plan 语义，后来 canonical 文档模型已经改为长期主题级 `SPEC.md`。名称、legacy `PLAN.md` 模板和执行交接用语仍然会把主题规格误导成一次性实施计划。

## Decision

- repository-local 的 canonical Skill 名称为 `$topic-spec`，其唯一职责是创建或维护 `docs/specs/<topic>/` 下的 `SPEC.md`、`IMPLEMENTATION.md`、`HISTORY.md` 及必要的契约文件。
- `$dev-plan` 继续负责临时实施计划；`$topic-spec` 不生成 `Summary`、`Flow Decision`、`Task Orchestration` 等执行计划输出。
- `docs-plan` 不再是 repository-local Skill 或路由名称；新文档和新调用只使用 `$topic-spec`。
- legacy `PLAN.md` 模板只放在 `skills/topic-spec/templates/legacy/`，不属于新 Spec 模板集合。

## Consequences

- 新入口、Skill 索引、计划 checker 和回放 fixture 使用 `$topic-spec`，降低主题 Spec 与实施计划之间的误路由概率。
- 历史文档中的旧名称只保留为历史事实；它不再对应可调用 Skill，也不参与自动发现。
- 需要创建长期主题规格时唯一使用 `$topic-spec`；需要当前任务执行编排时使用 `$dev-plan`，二者不能互相替代。

## Related Specs

- [Topic-level Spec model](../specs/topic-spec-model/SPEC.md)
- [Dev plan goals first](../specs/dev-plan-goals-first/SPEC.md)
