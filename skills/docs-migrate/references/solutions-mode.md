# `$docs-migrate` / `MODE=solutions`

本文件定义 `$docs-migrate` 在 `MODE=solutions` 时的详细流程：把 `docs/notes/**/*.md`、根 `docs/notes.md` 以及常见的排障/工作流 learnings 文档迁入 canonical `docs/solutions/**`。

## 适用对象

- `docs/notes/**/*.md`、根 `docs/notes.md`
- `docs/troubleshooting/**/*.md`、`docs/troubleshooting.md`
- `docs/workflow/**/*.md`、`docs/workflow.md`
- `docs/learnings/**/*.md`、`docs/learnings.md`
- troubleshooting / debugging / integration / perf notes
- workflow learnings、协作守卫、prompt/skill/CI 迁移经验

默认不迁移：

- ADR / RFC / 设计方案 / 架构总览
- 纯会议纪要、一次性任务流水账、未来无法复用的临时记录

## Canonical taxonomy

目标路径固定为：`docs/solutions/<category>/<slug>.md`

分类规则（v1）：

- `best-practices/`
  - 可复用默认做法、模式、守卫、约束
  - 例如：UI 证据规则、端口租约约束、branch naming defaults
- `workflow-issues/`
  - 流程、工具链、CI、prompt/skill 迁移、review/merge/cleanup learnings
  - 例如：legacy docs migration 入口收敛到 `$docs-migrate`、PR live truth-source、cleanup closeout
- `troubleshooting/`
  - 症状 -> 根因 -> 修复路径的排障文档
  - 例如：性能问题、集成故障、状态机错误、环境坑

若无法唯一分类：阻断并让主人确认，而不是猜。

## Frontmatter 约定

每个 solution 至少补齐：

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

可选字段：

```yaml
symptoms:
  - ...
root_cause: ...
resolution_type: <pattern|procedure|bugfix|migration|guardrail>
supersedes:
  - docs/solutions/<category>/<slug>.md
```

规则：

- v1 默认不上 solution id
- 若没有相关 spec，`related_specs` 写空列表 `[]`
- `supersedes` 只写在新的/当前有效 solution 上，列出它替代的旧路径
- 若某个旧 solution 已被取代，则旧文档本身标记为 `status=replaced`，并在正文或 `References` 中指向当前 replacement doc；不要把 `supersedes` 反向写回旧文档

## 0) 预检查

1. 确认 Git repo 与目标 worktree。
2. 若工作区不干净且会干扰迁移，优先改到隔离 worktree。
3. 确认 `docs/solutions/README.md` 已存在；若不存在，先按全局契约 bootstrap。

## 1) 发现候选源文档

默认搜索范围：

- `docs/notes/**/*.md`
- `docs/notes.md`
- `docs/troubleshooting/**/*.md`
- `docs/troubleshooting.md`
- `docs/workflow/**/*.md`
- `docs/workflow.md`
- `docs/learnings/**/*.md`
- `docs/learnings.md`
- 主人显式指定的 learnings / troubleshooting markdown

每个候选都要给出：

- 源路径
- 标题
- 你判断它属于 `best-practices / workflow-issues / troubleshooting` 中哪一类，以及理由
- 是否能看出关联 spec / 模块

## 1.1) 候选集合确认（默认需要）

- 显式 docs 迁移任务下，在进入入站链接检查、category/slug 映射、写入或删除前，默认先把“本次准备迁移的 notes/learnings 列表 + 目标分类”发给主人确认。
- 若当前仓库处于部分迁移态，只迁当前任务直接相关的那一部分 legacy notes；不要顺手把整批 notes 全搬走。
- 若本次只是 shared Step 2 mandatory gate，且当前任务相关 notes 集合已经是确定性的 task-relevant 子集，则允许 `main-agent` 自动继续；但必须在汇报里说明为何无需额外主人确认。
- 若命中的是 notebook-style / monolithic catch-all legacy note（尤其根 `docs/notes.md`），这里的“集合”允许细化成当前任务直接相关的 subsection(s) / slice；不要因为整份文档混装多个主题就强迫一次性整体迁移。

## 2) 引用检查

- 先找所有已获主人确认的待迁移文档的 Markdown 入站链接
- 若发现非 Markdown 引用，默认只汇报，不自动修改代码/脚本/配置

## 3) 规划映射

为每个源文档生成映射：

- `CATEGORY`：三类之一
- `SLUG`：由标题或文件名得到的稳定 kebab-case；若同一源文档在同一轮要拆出多个 subsection / slice，则必须附加稳定的 subsection heading / anchor discriminator，确保每个迁移单元得到不同 slug
- 目标路径：`docs/solutions/<CATEGORY>/<SLUG>.md`

默认仍是一对一映射；但对 notebook-style / monolithic catch-all legacy note，允许把当前任务直接相关的一个或多个 subsection(s) 规划成独立 canonical solution 映射。若同一源文档拆出多个 subsection / slice，这些映射必须各自使用不同 slug，不能因为共用源标题/文件名而撞到同一个 `docs/solutions/<category>/<slug>.md`。未命中的无关 remainder 保留在原文档，直到后续有更合适的迁移时机。

附带推断：

- `module`
- `problem_type`
- `component`
- `tags`
- `status`（默认优先 `active`；明显过时才 `stale`）
- `related_specs`

## 4) 重叠与替代处理

- 若目标路径不存在：正常创建
- 若 canonical 里已经有明显同主题文档：
  - v1 默认直接阻断，并把候选源文档、既有 canonical 路径与重叠理由发给主人确认
  - 若主人明确要求 `update` / `refresh` / `replaced`，再按确认后的单一路径执行；未确认前不要默认改写既有 solution
  - v1 不自动合并多个源文档，也不默认把第二个来源折叠进已有 canonical doc

## 5) 执行迁移

对每个迁移单元（默认是整个源文档；若源文档是 monolithic catch-all note，则允许是当前任务直接相关的 subsection/slice）：

1. 创建目标文件 `docs/solutions/<CATEGORY>/<SLUG>.md`
2. 补齐 frontmatter
3. 归并正文，建议结构：
   - `Context`
   - `Symptoms`（若适用）
   - `Root cause`（若适用）
   - `Resolution`
   - `Guardrails / Reuse notes`
   - `References`
4. 若原文没有明确“症状/根因”，但本质是 best practice / workflow issue，可跳过对应节，不要编造
5. 默认更新所有 Markdown 入站链接到新 canonical 路径；但若这次迁移只是从 monolithic legacy note 中抽取 task-relevant subsection(s) / slice，且旧路径仍保留承载其余主题内容，则不得批量重写所有旧链接。此时只允许重写那些你能明确证明本来就是在引用被抽取 subsection(s) 的 Markdown 链接；其余链接继续指向保留的 legacy note，等待后续更完整的拆分/迁移。
6. 删除旧文档前，再给主人确认旧路径 -> 新路径映射
7. 若当前调用只是 shared Step 2 / review 前置 knowledge gate，而删除旧文档的确认尚未拿到：允许停在“canonical `docs/solutions/**` 已建立 + legacy delete pending”的检查点；保留旧路径不删，但必须把 canonical `docs/solutions/**` 作为权威 knowledge 输入，并在汇报中显式写出 `pending delete approval`。若这次只抽取了 monolithic legacy note 的 task-relevant subsection(s)，则旧路径默认继续保留，等待后续任务逐步拆分或统一清理。

## 6) 校验

- 新路径都落在 `docs/solutions/<category>/` 下
- 每个新 solution 都含完整 frontmatter
- 若 `status=replaced`，正文或 `References` 中有明确的 replacement doc 路径；`supersedes` 仅出现在新的/当前有效 solution 上
- 若删除确认已获批准：已删除旧路径不再有 Markdown 引用残留
- 若删除确认尚未获批：canonical `docs/solutions/**` 路径已存在且 README / Markdown 引用已优先指向 canonical 目标；保留的 legacy 源路径已在汇报里显式标记为 `pending delete approval`
- 最终 diff 只含文档类改动

## 7) 汇报

至少汇报：

- 迁移数量
- 每个源路径对应的 canonical 新路径
- 每个新 solution 的 `category` 与 `status`
- 是否命中 `update` / `refresh` / `replaced` 冲突
- 若仍保留 legacy 旧路径待删除确认：`pending delete approval=<paths>`
- 删除列表与未处理 blocker
