---
name: project-doc-promote
description: "Promote stable conclusions from docs/specs or docs/solutions into human-facing project docs."
---

# Project doc promote

当一次任务已经在 `docs/specs/**` 或 `docs/solutions/**` 中沉淀出稳定结论，且这些结论应该进入**人类项目文档**时使用本 skill。

## 适用场景

- merge-ready 前需要判定 `project_doc_disposition`
- 某次变更改变了项目级当前真相、结构边界、使用方式或维护方式
- 同一主题已经被多个碎 spec / solution 反复触碰，应该整理成项目文档

## Inputs（可选）

- `SOURCE_REFS=<spec/solution paths>`
- `TARGET_HINTS=<现有 docs 路径或章节>`
- `MODE=check|write`（默认 `write`）

## Hard rules

- 人类项目文档默认优先落在 repo 已建立的人类文档位置：通常是 `docs/**`，但也可以是根 `README.md`、`CONTRIBUTING.md`、`OPERATIONS.md` 等既有入口文档；**目标路径必须尊重项目自身情况**，不要强推统一目录骨架。
- 优先更新已有项目文档；只有找不到合适承载面时才新建。
- 只提升稳定项目真相：结构说明、当前行为、维护约定、用户/维护者需要直接理解的结论。
- 不要把 task log、milestone、review 循环、临时工作上下文原样复制到项目文档。
- 若本轮确定应该 promotion 但不适合立即落盘，必须返回 `project_doc_disposition=defer`，并附带完整 defer 记录。
- 历史批量迁移或跨多个来源的集中整理，优先交给 `$docs-migrate MODE=project-docs`；本 skill 更偏单任务收口。

## Workflow

1. **Read source truth**
   - 读取当前任务相关的 `docs/specs/**`、`docs/solutions/**` 与已有项目文档。
   - 先判断哪些内容已经是“项目当前真相”，哪些仍只是任务过程。

2. **Choose disposition**
   - `none`：没有需要进入人类项目文档的新结论。
   - `update`：已有项目文档需要补充/改写。
   - `create`：当前没有合适项目文档承载这些稳定结论。
   - `defer`：已确认需要 promotion，但本轮不能安全落盘；必须写清楚原因、目标与后续动作。

3. **Select target docs**
   - 优先复用项目现有 overview/reference/architecture/guide/operations 等结构。
   - 若项目没有清晰入口，选择最小合理目标，并在必要时顺手补一个可发现入口；不要机械创建固定目录。

4. **Write human-facing docs**
   - 以项目视角重写内容，强调“现在是什么、怎么理解、怎么维护”。
   - 如需保留工程细节，只保留对人类维护有价值的部分，并在正文中引用 spec / solution 路径而不是复制整段。

5. **Return gate evidence**
   - `Project文档引用=<paths|none>`
   - `project_doc_disposition=none|update|create|defer`
   - `Project文档同步证据=<path@sha|none|未检查>`
   - `Project文档defer记录=<reason; target; follow_up | none>`

## Promotion heuristics

满足任一条时，默认应 promotion：

- 改变了项目级行为、结构或职责边界
- 后续人类维护者在不读 spec / solution 的情况下也需要知道
- 同一主题已经在多个任务里重复出现
- 当前结论已经稳定，不再只是本次任务的临时上下文

## Output expectations

- 默认返回一句结论 + 紧凑证据块。
- 若 `MODE=check`，只给 disposition 与建议目标，不写文件。
- 若 `MODE=write` 且结论为 `update|create`，必须同步写入项目文档并给出 `Project文档同步证据`。
