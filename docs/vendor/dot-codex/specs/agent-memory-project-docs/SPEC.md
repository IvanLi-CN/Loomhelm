# Agent memory 与项目文档 promotion 分层

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 当前全局文档模型已经收敛出 `docs/specs/**` 与 `docs/solutions/**`，但它们都更偏工程流程与 Agent memory。
- 若没有额外的 promotion 契约，项目级当前真相会持续埋在碎 spec / solution 中，人类维护者必须沿着任务历史才能理解项目。
- 先前对 Compound 风格分层的讨论已经明确：仓库内不落 `plans/`，`notes/` 也不作为 canonical knowledge store；真正缺的是“Agent memory -> human-facing project docs”的持续治理能力。

## 目标 / 非目标

### Goals

- 固化文档角色分层：`docs/specs/**` 与 `docs/solutions/**` 继续承担 Agent memory / engineering memory，repo 已建立的人类项目文档 / 入口文档（通常 `docs/**`，也可为根入口文档）承担 human-facing current truth。
- 在共享工程流程里新增 `project_doc_disposition=none|update|create|defer`，并把它变成 merge-ready 前的显式 gate。
- 新增 `$project-doc-promote` skill，负责按项目自身文档结构把稳定结论提升到合适的项目文档。
- 扩展 `$docs-migrate`，使其同时支持历史文档 / 碎 spec / solution 到项目文档的批量 promotion。
- 统一 PR 正文 `References` 约定：按相关性引用 `Specs`、`Solutions`、`Project Docs`。

### Non-goals

- 不把 `plans/` 恢复成仓库内 artifact。
- 不把 `notes/` 恢复成 canonical knowledge store。
- 不给所有项目强制固定同一套 `docs/` 目录骨架。

## 范围（Scope）

### In scope

- `.codex/AGENTS.md` 的全局文档模型、PR 引用与 promotion gate 规则。
- `skills/project-engineering-workflow/SKILL.md` 及相关 flow skill 的新 gate / 状态字段。
- workflow PR publication procedure 的 PR `References` 规则。
- 新 skill `skills/project-doc-promote/`。
- 扩展 `skills/docs-migrate/` 及其 references。
- `docs/README.md`、`docs/specs/README.md`、`docs/solutions/README.md` 等人类可读入口说明。

### Out of scope

- 批量重写外部项目仓库的人类文档结构。
- 为项目文档引入全局固定 taxonomy。
- 单独新增一个仓库内 `plans/` 文档空间。

## 需求（Requirements）

### MUST

- 全局工程记忆模型继续固定为 `docs/specs/** + docs/solutions/**`，且不恢复 `notes/` / `plans/` 为 canonical。
- `docs/specs/**` 与 `docs/solutions/**` 必须明确标注为 Agent / 工程流程导向，而不是项目文档替身。
- 共享工程流程在 merge-ready 前必须完成 `project_doc_disposition=none|update|create|defer` 判定。
- 若 `project_doc_disposition=update|create`，对应项目文档必须在收口前落盘并形成 `Project文档同步证据=<path@sha>`。
- 若 `project_doc_disposition=defer`，必须记录 defer 原因、目标文档与后续动作；不能只写“以后再说”。
- 项目文档的目标路径必须优先服从项目已有 `docs/` 结构；不得强推统一目录骨架。
- PR 正文在相关时必须显式给出 `Specs`、`Solutions`、`Project Docs` 引用。
- `$project-doc-promote` 必须只提升稳定项目真相，不得把整段 task log / milestone / review 过程直接复制到项目文档。
- `$docs-migrate MODE=project-docs` 必须支持“历史迁移 + 批量提升”，且允许多个 spec / solution 汇总到一个项目文档中。

### SHOULD

- 仓库在缺少清晰人类文档入口时，补一个最小 index / overview 文档，便于人类查阅。
- `skills/README.md` 与 docs 入口文案同步说明新 skill 与新 gate。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 共享工程流程继续以 `specs + solutions` 作为 Agent memory 输入；但在 Step 4 收口前，必须额外判断是否需要把稳定结论 promotion 到项目文档。
- `project_doc_disposition=none`：本轮没有需要进入人类项目文档的稳定真相。
- `project_doc_disposition=update`：已有项目文档需要更新。
- `project_doc_disposition=create`：现有项目文档没有合适承载面，需要新增人类文档。
- `project_doc_disposition=defer`：已经确认需要 promotion，但本轮因范围或时机原因暂缓；必须留下可执行 defer 记录。
- PR body 的 `References` 负责把本轮关联的 `Specs`、`Solutions`、`Project Docs` 串起来；`local-merge` 路径虽不创建 PR，也沿用同一引用模型作为统一口径。

### Edge cases / errors

- 若项目现有 `docs/` 结构无法唯一推导 promotion 目标，优先更新现有总览/索引文档；若仍无法确定，再阻断并只问 1 个关键问题。
- 若历史 spec / solution 中混有大量一次性任务 prose，`project-docs` 迁移只能抽取稳定结论，不能整文照搬。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| project_doc_disposition | workflow field | internal | New | None | codex-global | shared workflow / flow skills | merge-ready 前必须决议 |
| project-doc-promote | skill | internal | New | None | codex-global | shared workflow / docs tasks | 日常 promotion |
| docs-migrate project-docs mode | skill mode | internal | Modify | `skills/docs-migrate/references/project-docs-mode.md` | codex-global | docs taxonomy migration | 历史迁移 + 批量提升 |
| PR References: Specs / Solutions / Project Docs | PR body contract | internal | Modify | `skills/project-engineering-workflow/references/pr-publication-procedure.md` | codex-global | PR flows | 三类引用统一口径 |

## 验收标准（Acceptance Criteria）

- Given 一个任务只更新 agent memory，When 进入 Step 4 收口，Then 可以显式记录 `project_doc_disposition=none` 并继续。
- Given 一个任务改变了项目级当前真相，When 进入 Step 4 收口，Then 必须先写入或新建合适的项目文档，或者留下完整 `defer` 记录。
- Given 仓库已有自定义的 `docs/` 结构，When `$project-doc-promote` 或 `$docs-migrate MODE=project-docs` 选择目标文档，Then 必须优先复用现有结构，而不是强制固定 taxonomy。
- Given 一个 PR 关联了 spec、solution 与项目文档，When workflow PR publication procedure 生成/重写 PR body，Then 相关引用会显式出现在 `References` 中。
- Given 一个历史 spec / solution 批量收敛到人类项目文档的任务，When 运行 `$docs-migrate MODE=project-docs`，Then 允许多个来源汇总到一个项目文档，但原 spec / solution 仍保留为 Agent memory。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `git diff --check`
- `rg -n "project_doc_disposition|Project Docs|project-doc-promote|MODE=project-docs" AGENTS.md docs skills`
- `python3 /Users/ivan/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/project-doc-promote`

### Quality checks

- 项目文档路径与说明不得硬编码全局目录骨架。
- `specs/solutions` 与 `docs/**` 项目文档的职责表述必须一致。

## Visual Evidence

None

## 方案概述（Approach, high-level）

- 保持 `specs + solutions` 作为工程记忆主轴，不再新增仓库内 `plans` 或恢复 `notes`。
- 把“需要人类直读的稳定结论”从工程记忆中提升出来，但提升目标路径交给项目自身文档结构决定。
- 用一个轻量的日常 promotion skill + 一个批量迁移 mode 来分工治理增量与历史积累。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：若项目没有任何既有人类文档结构，promotion 目标仍可能需要一次人工判断。
- 风险：PR flow 与 local-merge flow 若输出字段不同步，会让后续恢复语义产生偏差。
- 假设：PR 正文继续允许 `Spec:` / `Specs:` 兼容 legacy 写法，同时新增 `Solutions:` 与 `Project Docs:`。

## 参考（References）

- `docs/specs/global-solutions-docs-migrate/SPEC.md`
- `AGENTS.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/project-engineering-workflow/references/pr-publication-procedure.md`
- `skills/docs-migrate/SKILL.md`
