# Solutions 知识库

`docs/solutions/` 用来沉淀 **跨任务可复用的经验资产**：排障结论、稳定做法、工作流守卫、迁移注意事项。它与 `docs/specs/` 的职责不同：

- `docs/specs/**`：稳定主题、能力、接口或约束的 topic-level spec，回答“这个主题长期应该保持什么为真”。
- `docs/solutions/**`：跨任务经验，回答“下次遇到类似问题时不要再从零想一遍”。
- repo 已建立的其他项目文档 / 入口文档：项目当前真相，回答“这个项目现在是什么、怎么理解/维护”；通常位于 `docs/**`，也可能是根入口文档，路径与层级应尊重项目自身情况。

## 路径约定

- 固定路径：`docs/solutions/<category>/<slug>.md`
- 默认 **不使用 solution id**；身份由 `category + slug + frontmatter` 提供。
- `slug` 使用稳定 kebab-case，尽量体现主题而不是一次性任务编号。

推荐分类（v1 最小集）：

- `best-practices/`：可复用的默认做法、约束、模式、守卫。
- `workflow-issues/`：流程、工具链、CI、prompt/skill 迁移、协作约束。
- `troubleshooting/`：带症状/根因/修复路径的问题排查、性能/集成/故障经验。

## 什么时候写 / 更新 / 刷新

在 `normal / fast-track / local-merge` 这类共享工程流程里：

- 开工前：若当前任务能命中相关的实际 solution 文档（`docs/solutions/<category>/*.md`，不含本 `README.md`），先做 focused lookup；默认入口是 `$solution-sync MODE=check`。
- 收口前：必须判定 `solution_disposition=none|update|create|refresh`；默认入口是 `$solution-sync`。
- 重构/迁移后：若旧经验的路径、命令、依赖、入口或结论发生漂移，执行 refresh。

推荐语义：

- `none`：本轮没有新增可复用经验，或现有 solutions 无需改动。
- `update`：已有 solution 结论仍成立，但需要补新证据/约束/适用条件。
- `create`：出现了新的可复用经验。
- `refresh`：已有 solution 因重构/迁移/入口变化而 stale，需要刷新或替换。

## Frontmatter 约定

以下字段为 v1 的最小 schema：

### 必填字段

```yaml
---
title: <human title>
module: <repo area or subsystem>
problem_type: <best_practice|workflow_issue|bug|performance|integration|ui|debugging>
component: <component or boundary>
tags:
  - <tag>
status: <active|stale|replaced>
related_specs:
  - docs/specs/<topic>/SPEC.md
---
```

### 可选字段

```yaml
symptoms:
  - <symptom>
root_cause: <one-line cause>
resolution_type: <pattern|procedure|bugfix|migration|guardrail>
supersedes:
  - docs/solutions/<category>/<slug>.md
```

字段说明：

- `status=active`：当前建议仍可直接复用。
- `status=stale`：仍有参考价值，但命令/路径/接口已漂移。
- `status=replaced`：当前文件已被新的 canonical solution 取代；应在正文或 `References` 里直接指向替代它的当前文档。
- `supersedes`：只写在**新的/当前有效** solution 上，列出它替代的旧 solution 路径；不要把它写回 `status=replaced` 的旧文档里。
- `related_specs`：引用与此经验直接相关的 spec；没有则写空列表 `[]`。

## 写作规则

- 不把整篇 solution 复制进 spec；在 spec 里只引用相关路径或结论。
- 若这些结论已经变成项目当前真相，需在收口前额外判定 `project_doc_disposition`，并通过 `$project-doc-promote` 或 `$docs-migrate MODE=project-docs` 提升到合适的项目文档。
- 优先保留：症状、根因、有效方案、适用边界、反例/禁忌。
- 不要把一次性会议记录、纯任务日志、或与未来复用无关的流水账塞进 solutions。
- 若同主题已存在 canonical solution，优先 `update` / `refresh`，避免平行重复文档。

## 最小正文结构（建议）

```md
# <title>

## Context
- 相关模块/边界
- 触发场景

## Symptoms
- ...

## Root cause
- ...

## Resolution
- ...

## Guardrails / Reuse notes
- ...

## References
- docs/specs/...
```

## 迁移与 discoverability

- legacy `docs/notes/**`、零散 troubleshooting notes、workflow learnings 迁入 canonical taxonomy 时，统一使用 `$docs-migrate` 的 `solutions` 或 `auto` 模式；日常 focused lookup / update / refresh 则走 `$solution-sync`。
- `docs/solutions/` 是全局显式知识库；未来 agent 应在开工前与 review 前优先检索它，而不是把类似内容继续散落回 `docs/notes/**`。
- `docs/solutions/**` 不替代 human-facing project docs；当稳定结论已经应该给人类直接看时，应 promotion 到项目文档，而不是长期停留在 solution。
