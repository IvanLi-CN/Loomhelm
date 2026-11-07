---
name: docs-migrate
description: "Migrate legacy planning/spec docs or notes/learnings into canonical docs/specs or docs/solutions, batch-clean existing specs, or batch-promote stable project truth into repo-established human-facing project docs."
---

# Docs migrate

当主人要把 legacy 文档体系收敛到 canonical taxonomy 时使用本 skill。它是 **docs-only** 的统一迁移入口：

- `docs/plan/**` 或散落 planning/spec markdown -> `docs/specs/**`
- 现有 `docs/specs/**` 中仍像任务单的历史 spec -> 主题级 spec catalog（`MODE=specs-hygiene`）
- `docs/notes/**/*.md`、`docs/notes.md`、troubleshooting notes、workflow learnings -> `docs/solutions/**`
- 历史 spec / solution / 散落项目文档中的稳定项目结论 -> repo 已建立的人类项目文档路径（通常 `docs/**`，也可为根入口文档）
- 混合场景 -> 按 `auto` 分流到四条轨道

## Inputs（可选）

- `MODE=specs|specs-hygiene|solutions|project-docs|auto`
- `PATH_HINTS=<路径片段/关键字>`：用于缩小候选集合

缺省策略：

- 明显是 legacy planning/spec 文档 => `specs`
- 明显是“现有 specs 本身需要回填/去任务单化” => `specs-hygiene`
- 明显是经验/排障/流程 learnings => `solutions`
- 明显是 human-facing 项目文档整理 / promotion / 历史收敛 => `project-docs`
- 混合 taxonomy 或主人只说“迁移文档体系” => `auto`

## Canonical targets

- `specs`：`docs/specs/<topic>/`（新的 canonical 主题 spec 目录；必须包含 `SPEC.md`、`IMPLEMENTATION.md`、`HISTORY.md`，不生成 ID）
- `specs-hygiene`：现有 `docs/specs/**` + `docs/specs/README.md`（去 task-ticket 化、补 lifecycle、并在明确确认后把 legacy ID 目录规范化到 slug-only 目录、更新入站引用）
- `solutions`：`docs/solutions/<category>/<slug>.md`（默认不上 solution id）
- `project-docs`：项目自有的人类项目文档路径（通常 `docs/**`，也可为根入口文档；目标位置由项目现有结构决定，不固定）

Historical ID repair is internal compatibility, not a public Skill. Only when an existing catalog or inbound link proves that an ID must be reconstructed may this workflow call `scripts/gen_legacy_spec_id.ts --legacy-compat --repo <repo>`. New Specs never receive an ID.

## Hard rules

- **docs-only**：只允许修改文档类文件与文档资源；不要改实现代码/测试/运行配置。
- **一对一迁移（带受控例外）**：`specs` / `solutions` 轨默认一个源文档只对应一个 canonical 文档；v1 不自动合并多个来源。但若源文档本身是 notebook-style / monolithic catch-all legacy note（尤其根 `docs/notes.md`），且当前调用只需要迁移其中确定性的 task-relevant subsection(s)，允许抽取这些 subsection(s) 到一个或多个 canonical `docs/solutions/**` 文档；未命中的无关 remainder 保留在原文档，后续再处理。
- **受控 synthesis**：`specs-hygiene` 与 `project-docs` 允许多个来源或多个历史 section 汇总，但必须保留清晰的归属和后继关系。
- **候选集合默认先确认**：显式 docs 迁移任务、`auto` 分流结果不唯一、或候选跨越当前任务边界时，必须先把“准备迁移哪些源文档/主题”发给主人确认；但当 `$docs-migrate` 只是为了满足 shared Step 2 mandatory gate，且候选集合已被当前任务收敛成**确定性的 task-relevant 子集**时，允许 `main-agent` 直接继续，不额外停下来等主人确认。
- **删除前确认**：删除旧文档前必须先给主人列出“旧路径 -> 新路径”映射或 lifecycle 决议。
- **shared Step 2 / goto-impl 的 canonicalization checkpoint**：若当前调用只是为了建立 canonical `docs/specs/**` / `docs/solutions/**` 入口以清掉共享门禁，则在主人尚未批准删除 legacy 源文档时，可以先停在“canonical 目标已建立、旧路径删除待确认”的检查点；但必须把 retained legacy 源文档标记为 `pending delete approval`，且不得把这轮迁移描述成“已完全清理完成”。
- **受保护分支只读**：若当前在 `main/master/trunk` 或其他受保护主分支上，只允许候选发现、映射预演与引用检查；任何写入、链接更新、rename 或删除都必须先进入 dedicated docs/topic branch 或隔离 worktree。
- **排除设计文档**：ADR/RFC/Architecture/Design/Manual 等非 planning/non-solution 文档默认排除。
- **脏工作区优先隔离**：若当前工作区不干净且迁移会污染无关改动，独立任务优先用 `$git-worktree` 隔离；若当前是 Codex 托管任务/worktree，必须使用其原生生命周期或停下报告，禁止嵌套手工 Worktree。除非主人明确授权，不要擅自 stash 或处理无关改动。
- **避免重复 canonical 文档**：若发现高重叠或既有 canonical 目标冲突，先阻断并说明，而不是自动合并。

## Workflow

1. **Preflight**
   - 确认 Git repo、当前分支、工作区状态。
   - 若工作区不干净且迁移会污染无关改动：优先改到隔离 worktree。
   - 若当前仍在 `main/master/trunk` 或其他受保护主分支：先切到 dedicated docs 分支或隔离 worktree；未切走前只允许只读预演。

2. **Resolve mode**
   - `specs`：legacy planning/spec/work-item style 文档 -> canonical `docs/specs/**`
   - `specs-hygiene`：现有 `docs/specs/**` 的 topic-spec 回填、section cleanup、lifecycle 收敛
   - `solutions`：notes/learnings/troubleshooting/workflow learnings
   - `project-docs`：repo 已建立的人类项目文档的历史整理、批量 promotion、稳定结论收敛
   - `auto`：逐个候选分类；有歧义就阻断

3. **Collect candidates**
   - 先发现候选源文档，按模式或 `auto` 分流给出“源路径 -> 目标轨道”的候选清单。

4. **Candidate gate**
   - 若当前是显式 docs 迁移任务，或候选集合存在歧义/跨任务风险：先让主人确认“哪些候选真的要迁移”。
   - 若当前只是 shared Step 2 mandatory gate，且候选集合已经被上下文收敛成确定性的 task-relevant 子集：`main-agent` 可直接继续，但必须在结果里说明为什么这个集合可自动确认。

5. **Collect inbound links + run track-specific migration**
   - `specs`：读取 `references/specs-mode.md`
   - `specs-hygiene`：读取 `references/specs-hygiene-mode.md`
   - `solutions`：读取 `references/solutions-mode.md`
   - `project-docs`：读取 `references/project-docs-mode.md`
   - `auto`：先分流，再分别执行四条轨道；若同一轮同时涉及多轨，优先顺序为 `specs -> specs-hygiene -> solutions -> project-docs`
   - 对 `specs` / `specs-hygiene`，先运行 `scripts/specs_migrate_guard.ts` 生成 slug 映射、冲突、入站链接和确认需求；guard 只读，不替代文档内容迁移。
   - 若 guard 返回 `topic_slug_required`，必须用明确的稳定 kebab-case `--topic <topic>` 重跑；不得把含空格、大小写或其他非 slug 字符的目录名直接作为新 Spec 身份。
   - guard 只有在当前或可达历史 catalog 以精确 `ID + path` 证明前缀，或调用方显式提供匹配的 `--legacy-id` 时，才会把 `<prefix>-<topic>` 去前缀。catalog 的 path 可为相对 catalog 目录的路径，也可使用 inline-code 或 Markdown link 包装；没有该证据时，`specs` 只在完整目录名已是 kebab-case 时才保留它作为 slug；`specs-hygiene` 阻断并要求 proof；不要按五字符外观猜测旧 ID。

6. **Validate before handoff**
   - `git diff --name-only` 只包含文档与文档资源
   - 若旧路径已获批删除：已删除的旧路径不再有 Markdown 引用残留
   - 若旧路径因“等待主人确认删除”而暂时保留：canonical 目标路径必须已存在，并在结果里显式记录 `pending delete approval`
   - `specs` 轨：`docs/specs/README.md` 行路径都存在且 Index 顺序合法
   - `specs-hygiene` 轨：active specs 不再把 task-ticket section 留在 `SPEC.md`，而是把实现状态 / 演进历史回填到 companion docs；所有 legacy rename 映射、slug 冲突和入站链接均已确认，README lifecycle 与实际 spec 文件一致
   - `solutions` 轨：canonical 文档路径存在、frontmatter 完整、`status`/`related_specs` 合法
   - `project-docs` 轨：目标项目文档路径存在，内容是 human-facing 当前真相而非 task prose

7. **Report**
   - 汇报迁移数量、删除列表、canonical 新路径、未处理 blocker
   - 若仍保留 legacy 源文档等待删除确认：显式写出 `pending delete approval=<paths>`
   - 需要 docs-only commit 时，单独征求主人是否提交

## Progressive disclosure

- `references/specs-mode.md`：legacy planning/spec -> canonical `docs/specs/**`
- `references/specs-hygiene-mode.md`：现有 `docs/specs/**` 的 topic-spec 回填与 lifecycle 收敛
- `references/solutions-mode.md`：定义 `docs/notes -> docs/solutions` 的分类、frontmatter、refresh/supersede 规则
- `references/project-docs-mode.md`：定义 human-facing 项目文档 promotion / 批量迁移的目标选择与写作边界
- `references/mode-fixtures.md`：最小样例，帮助快速确认五种模式的期望落点
- `scripts/gen_legacy_spec_id.ts`：仅用于已证明的历史 ID 修复
