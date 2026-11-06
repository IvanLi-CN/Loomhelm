---
name: solution-sync
description: "Read, refresh, or create docs/solutions for reusable engineering learnings."
---

# Solution sync (`docs/solutions/`)

当当前 run 需要清掉 solution gate、review/CI 暴露了新的可复用经验，或当前任务命中了相关 `docs/solutions/**` / legacy knowledge docs 时，使用本 skill。

## Goal

让 canonical `docs/solutions/**` 持续表达“下次遇到类似问题时该怎么更快、更稳地处理”，同时保持与 spec、项目文档、任务日志分层。

## Inputs（可选）

- `MODE=check|write`（默认 `write`）
- `SOURCE_HINTS=<spec/module/symptom/paths>`
- `TARGET_HINTS=<solution paths/category hints>`
- `LEGACY_OK=yes|no`（默认 `yes`）

## Hard rules

- canonical 目标文件只允许落在 `docs/solutions/<category>/<slug>.md`。
- 如果只命中了 legacy knowledge docs（`docs/notes/**`、`docs/troubleshooting/**`、`docs/workflow/**`、`docs/learnings/**`），不要手写重复 solution；先用 `$docs-migrate MODE=solutions|auto` 把当前任务相关子集 canonicalize，再继续本 skill。
- 优先 `update` / `refresh` 已有 canonical solution，避免平行创建重复主题文档。
- 只有 `main-agent` 可以在共享流程里写 `docs/solutions/**`；sidecar / sub-agent 默认只做 `MODE=check` 并回传 hint。
- 不要把任务时间线、PR 对话、review 循环流水账或项目当前真相原样塞进 solution；这些分别属于 workflow/PR 或 human-facing project docs。
- 若稳定结论已经应该给人类项目文档直接看，交给 `$project-doc-promote`；本 skill 只负责 `docs/solutions/**`。

## Workflow

1. Focused lookup

- 以当前 spec、模块名、症状、接口关键词、关键变更路径为线索，优先查 canonical `docs/solutions/**`。
- 若相关知识仍在 legacy knowledge docs，先经 `$docs-migrate` 建立 canonical solution，再继续判断。
- 记录 `Solution检索=命中|未命中|未检查` 与 `Solution引用=<paths|none|未检查>`。

2. Settle disposition

- `none`：没有新增可复用经验，或现有 solution 无需改动。
- `update`：已有 solution 结论仍成立，但需要补新证据、边界、命令或 guardrail。
- `create`：当前没有合适的 canonical solution，需要新建一篇。
- `refresh`：现有 solution 的路径、入口、命令、依赖或结论已漂移，需要刷新/替换。
- `MODE=check` 时返回 `solution_disposition_hint`；`MODE=write` 时返回正式 `solution_disposition`。

3. Write canonical solution (`MODE=write`)

- 优先复用已有 canonical solution；只有确实没有 owner 时才创建新文件。
- 保持最小可复用结构：`Context`、`Symptoms`、`Root cause`、`Resolution`、`Guardrails / Reuse notes`、`References`（按需增减）。
- 维护 frontmatter 最小 schema：`title/module/problem_type/component/tags/status/related_specs`；必要时补 `symptoms/root_cause/resolution_type/supersedes`。
- 若刷新/替换旧 solution，确保 `status`、`supersedes` 与引用关系一致。

4. Return evidence

- `MODE=check`：
  - `Solution检索=<命中|未命中|未检查>`
  - `Solution引用=<paths|none|未检查>`
  - `solution_disposition_hint=<none|update|create|refresh|未检查>`
  - `Solution同步证据=<solution_path@sha|none|未检查>`
- `MODE=write`：
  - `Solution检索=<命中|未命中|未检查>`
  - `Solution引用=<paths|none|未检查>`
  - `solution_disposition=<none|update|create|refresh|未检查>`
  - `Solution同步证据=<solution_path@sha|none|未检查>`

## Heuristics

优先考虑写/更 solution 的场景：

- 当前问题未来大概率还会重复出现。
- 本轮确认了更稳的命令、路径、边界条件或排障顺序。
- review / CI / main-sync 暴露出“旧经验已 stale”的事实。
- 同一问题在多个任务里重复被口头解释，但仓库里还没有 canonical solution。
