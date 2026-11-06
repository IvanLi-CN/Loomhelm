# `MODE=project-docs`

`project-docs` 轨用于把**历史文档、碎 spec、碎 solution 中已经稳定的项目级结论**整理到 repo 已建立的人类项目文档里。

## 目标

- 让人类维护者可以从 repo 已建立的人类项目文档直接读到“项目现在是什么、怎么维护”。
- 保留 `docs/specs/**` / `docs/solutions/**` 作为 Agent memory；`project-docs` 不是替换它们，而是把稳定结论提升出来。

## Target selection

- 目标路径必须优先服从项目现有人类文档结构与命名习惯：通常是 `docs/**`，也可能是根 `README.md`、`CONTRIBUTING.md`、`OPERATIONS.md` 等入口文档。
- 优先更新已有项目文档；只有没有合适承载面时才新建。
- 若项目缺少清晰的人类文档入口，可以补一个最小入口，但不要机械引入全局固定 taxonomy。

## Source handling

- 允许多个 `docs/specs/**` / `docs/solutions/**` 来源汇总到一个项目文档。
- 只抽取稳定项目真相：当前行为、结构边界、维护方式、使用约定。
- 不复制 milestone、review 循环、task checklist、临时 workaround 对话。
- 源 spec / solution 默认保留；`project-docs` promotion 不是删除它们的理由。

## Validation expectations

- `git diff --name-only` 仍然只能包含文档类文件。
- 结果必须给出：
  - `project_doc_disposition=update|create|defer|none`
  - `Project文档引用=<paths|none>`
  - `Project文档同步证据=<path@sha|none>`
- 若结论是 `defer`，必须记录 defer 原因、目标文档与后续动作。
