# 主题级 Spec 模型与历史 specs hygiene

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 当前 `docs/specs/**` 虽然承担工程流程真相源，但长期被写成“一任务一张工单”：包含 `Status`、`Milestones`、`Docs to Update`、`Change log` 等任务推进字段。
- 这种写法会让 spec 既不像真正的规格，也承担不了长期主题契约的职责；人和 Agent 都会把它误读成任务单。
- 前一轮已经补上了 `project_doc_disposition`、`$project-doc-promote` 与 `MODE=project-docs`，但那只解决了“稳定项目真相如何 promotion 给人类文档”，没有解决 `docs/specs/**` 本体失真。

## 目标 / 非目标

### Goals

- 把 `docs/specs/**` 重定义为 topic-level specification：一个 spec 描述一个稳定主题、能力、行为、接口或约束。
- 新建 spec 使用唯一 slug-only 目录 `docs/specs/<topic>/`；历史 ID-prefixed 目录仅保留读取兼容，规范化由明确确认的 hygiene 迁移完成。
- 让每个 spec 目录同时保留三层信息：`SPEC.md`（当前规范）、`IMPLEMENTATION.md`（实现状态/覆盖进度）、`HISTORY.md`（关键演进原因）。
- 把共享流程的 spec gate 改成 `spec_disposition=link|update|create|supersede|not_needed`，不再默认“一任务一 spec”。
- 保留 spec 中的验收 checklist、`Related PRs` 与 `Visual Evidence`，并把实现状态 / 变更原因从单次任务 prose 提炼进 companion docs，而不是把这些信息删掉。
- 扩展 `$docs-migrate` 的 `MODE=specs-hygiene`，支持历史 `docs/specs/**` 的批量回填与收敛。
- 对当前 `.codex` 仓的现有 `docs/specs/**` 做一轮 hygiene：把 `Status` / `Milestones` / `Change log` 等有价值细节迁到 companion docs，统一 README lifecycle + 轻量 implementation 摘要，并保留真正的主题规范内容。

### Non-goals

- 不把任务进度重新塞回 `SPEC.md` 正文的其它别名字段。
- 不把 `docs/solutions/**` 或 human-facing project docs 重新并入 `docs/specs/**`。
- 不在这轮实现里为所有外部项目仓库做批量自动改造。

## 范围（Scope）

### In scope

- `AGENTS.md`、`docs/README.md`、`docs/specs/README.md`、`docs/solutions/README.md` 对 spec 模型的全局描述。
- `skills/docs-plan/**`、`skills/project-engineering-workflow/SKILL.md`、`skills/spec-sync/SKILL.md`（以及 `plan-sync` compatibility alias）的 topic-spec 契约。
- `skills/pr-create/SKILL.md`、`skills/pr-merge/SKILL.md`、`skills/github-pr-body-images/SKILL.md` 的 PR 元数据约定。
- `skills/docs-migrate/**` 的 `specs-hygiene` 轨与 `auto` 分流。
- `skills/find-next-plan/**` 对 lifecycle-based spec 目录的兼容行为。
- 当前 `.codex` 仓现有 `docs/specs/**` 的 companion-doc 回填、README implementation 摘要回填与 README lifecycle 收敛。

### Out of scope

- 自动把 topic spec 再拆成强制统一的产品文档树。
- 为主题级 spec 引入新的 id 体系或额外索引文件。
- 在没有明确证据时自动合并多个历史 spec 为一个新 spec。

## 需求（Requirements）

### MUST

- `docs/specs/**` 必须被定义成 topic-level specification，而不是 work-item contract / task ticket。
- 每个 spec 目录默认必须由 `SPEC.md + IMPLEMENTATION.md + HISTORY.md` 共同承载规范、实现状态与关键演进原因。
- 共享流程在进入实现前必须判定 `spec_disposition=link|update|create|supersede|not_needed`。
- 当 `spec_disposition != not_needed` 时，关联 spec 必须至少覆盖背景、目标、范围、需求/契约与验收。
- `docs/specs/README.md` 必须表达 `active|superseded|archived` 生命周期，并通过 `Successor` 列指向后继路径；README 不能重新变回完整任务看板。
- 新建 canonical Spec、solution `related_specs`、视觉证据和 PR metadata 必须使用 `docs/specs/<topic>/...`；ID 仅可出现在明确标注的 legacy compatibility 路径或 fixture。
- 默认 spec 模板必须把 `Status`、`Milestones`、`Docs to Update`、`Plan assets`、`Asset promotion` 等 rollout / progress 信息放进 `IMPLEMENTATION.md`，把 `Change log` / 关键演进原因放进 `HISTORY.md`，而不是简单删除。
- spec 可以保留 `Acceptance checklist`、`Related PRs`、`Visual Evidence`，但必须明确这些内容服务于规格定义，而不是任务追踪。
- `pr-create` / `pr-merge` / `github-pr-body-images` 必须改用 `Spec Disposition` 作为当前 PR 与 spec 的关联语义；旧 `Spec Status` / `Plan Status` 仅保留读取兼容。
- canonical spec drift skill 名称必须是 `$spec-sync`；`$plan-sync` 只保留兼容别名，不再作为新写法输出。
- `$spec-sync` 在读取 legacy `docs/plan/**/PLAN.md` 引用时，若仓库已经 canonicalize 到 `docs/specs/**`，必须优先按显式路径、同一 diff Git rename，或由历史 catalog 中精确 `ID + source path` 证明的唯一 slug 映射到 owning canonical `SPEC.md`；只有当必须选择 canonical target 却无法证明或无法唯一映射时才阻断并要求 canonical 路径，不能要求历史 `PLAN.md` 也同步变化。仍是独立真相源的 readable legacy `PLAN.md` 保持合法同步目标。
- 对保留的 legacy ID-prefixed Spec 只读兼容目录，若 lifecycle catalog 已切换为 slug-only，可在 owning canonical ``HISTORY.md`` 使用精确的 ``- Legacy compatibility identity: \``#id\`.` 标记作为映射证明；任意普通文本出现 ID 都不构成证明。
- 若仓库尚未 canonicalize、legacy `docs/plan/**/PLAN.md` 仍是唯一 spec 真相源，`$spec-sync` 必须继续把该 `PLAN.md` 视为合法同步目标；不能因为 companion-doc 模型而把 legacy plan-only 仓库全部误判成 drift。
- 对已经 canonicalize 到 `docs/specs/**`、但历史上只有 `SPEC.md` 的旧 spec 目录，`$spec-sync` 必须继续把该 `SPEC.md` 视为合法同步目标；只有当目录里已经出现任一 companion doc 时，才要求 `IMPLEMENTATION.md` / `HISTORY.md` 也保持完整。
- 对 `spec_disposition=not_needed` / spec-free 运行，只有在当前分支未触碰任何 `docs/specs/**` 或 legacy `docs/plan/**` 时才允许返回 `none(spec-free)`；若 spec 文件也发生变化，必须视为阻断而不是自动放行。
- `$docs-migrate` 必须新增 `MODE=specs-hygiene`，用于历史 `docs/specs/**` 的批量整理。
- `$docs-migrate MODE=specs` 在 legacy-plan-only 场景下建立 slug-only canonical `docs/specs/<topic>/` 时，必须一次补齐 `SPEC.md`、`IMPLEMENTATION.md`、`HISTORY.md`，避免刚完成 canonicalization 就立刻被 companion-doc drift gate 阻断。
- 当前 `.codex` 仓现有 spec 必须完成至少一轮 companion-doc backfill，不得只更新未来模板而不处理现有 spec。
- 当仓库已经建立 lifecycle-based `docs/specs/**`，但仍保留 `docs/plan/**` 作为过渡期 task queue 时，`find-next-plan` 必须继续能从 legacy queue 里选到下一个任务，而不是被 lifecycle index 提前短路。
- 对 spec-free / `spec_disposition=not_needed` 的任务，`goto-impl-branch` 不得为了切 topic branch 而伪造新的 `docs/specs/**`。

### SHOULD

- lifecycle-based `docs/specs/README.md` 应继续保留稳定创建顺序，便于回溯主题演进。
- `docs/specs/README.md` 的 `Implementation` 列应保持短小、稳定、可快速扫描；详细状态不要重新塞回 README。
- 若历史 spec 仍残留 legacy `## Visual Evidence (PR)` heading，应统一回到单一 `## Visual Evidence`。
- `find-next-plan` 在 topic-spec 仓库里应明确报告“spec 目录不再编码任务队列”，而不是误选一个 `active` spec 当任务单。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 共享工程流程的 Step 2 先解决“当前任务与哪个 spec 的关系是什么”，而不是直接为任务建卡。
- `spec_disposition=link`：当前任务实现或引用既有 topic spec，不改变 spec contract。
- `spec_disposition=update`：当前任务改变了既有 topic spec 的 contract，需要先更新 spec 再实现。
- `spec_disposition=create`：当前任务引入新的稳定主题/契约，需要创建新的 topic spec。
- `spec_disposition=supersede`：当前任务用新 spec 取代旧 spec；README lifecycle 必须同步标记后继关系。
- `spec_disposition=not_needed`：当前任务不改变任何稳定 contract，也不需要依赖 spec 作为主规范输入。
- `MODE=specs-hygiene` 用于批量盘点既有 `docs/specs/**`，把旧 task-ticket section 中仍有价值的实现状态 / rollout 事实 / 变更原因迁入 companion docs，统一 lifecycle，并在需要时协同 `MODE=project-docs` 做人类文档 promotion。

### Edge cases / errors

- 若历史仓库仍依赖 legacy `docs/plan/**`，先通过 `MODE=specs` 建立 canonical `docs/specs/**`，再进入 `specs-hygiene`；不得跳过 canonical root。
- 若某个历史 spec 只剩任务过程而缺少稳定契约，应把它标记为 `archived` 或 `superseded` 并设置 `Successor`，而不是继续留作 `active`。
- 若同一轮既涉及新建 spec 又涉及旧 spec lifecycle 变更，README lifecycle 必须与实际 spec 路径同时更新，避免出现 dangling 引用。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| spec_disposition | workflow field | internal | New | None | codex-global | shared workflow / PR flows | topic-spec gate |
| spec-sync | skill | internal | New | None | codex-global | shared workflow / PR flows | canonical spec drift / sync 入口 |
| docs/specs lifecycle index | docs catalog | internal | Modify | `docs/specs/README.md` | codex-global | specs authors / agents | `active | superseded | archived` |
| docs-migrate MODE=specs-hygiene | skill mode | internal | New | `skills/docs-migrate/references/specs-hygiene-mode.md` | codex-global | docs migration | 历史 specs 批量回填 |
| Spec Disposition PR metadata | PR body contract | internal | Modify | None | codex-global | `pr-create` / `pr-merge` / `github-pr-body-images` | 替代 `Spec Status` |

## 验收标准（Acceptance Criteria）

- Given 一个 topic-spec 仓库，When 创建新 spec，Then 它会同时生成 `SPEC.md`、`IMPLEMENTATION.md`、`HISTORY.md`，并在 `docs/specs/README.md` 追加 `Lifecycle=active` + 轻量 `Implementation` 摘要。
- Given 一个任务只是在实现既有主题规范，When 进入共享 Step 2，Then 它会记录 `spec_disposition=link`，而不是默认新建任务 spec。
- Given 一个任务改变了稳定 contract，When 进入共享 Step 2，Then 必须先完成 `update` 或 `create` 对应的 spec 更新，之后才能进入实现。
- Given 一个历史 `SPEC.md` 仍包含 `Status`、`Milestones`、`Docs to Update` 等任务单 section，When 运行本轮 hygiene，Then 这些 section 的细节会被迁入 `IMPLEMENTATION.md` / `HISTORY.md`，而不是直接丢弃。
- Given 一个 Agent 只打开 spec 目录，When 它需要回答“现在做到哪了”或“为什么会变成这样”，Then 它可以直接从 `IMPLEMENTATION.md` / `HISTORY.md` 获取答案，而不必跨 PR / commit 历史搜索。
- Given 一个历史 spec 仍保留 `## Visual Evidence (PR)`，When 迁到新模型，Then 最终只保留单一 `## Visual Evidence` heading。
- Given 一个 lifecycle-based `docs/specs/README.md`，When 调用 `find-next-plan`，Then 它会返回“该目录不再编码任务队列”的明确结果，而不是误把 `active` spec 当成待办工单。
- Given 一个仓库已经有 lifecycle-based `docs/specs/README.md`，但 `docs/plan/README.md` 仍保留 legacy task queue，When 调用 `find-next-plan`，Then 它会回退到 legacy queue 继续选任务，并优先解析到 canonical `docs/specs/**/SPEC.md`。
- Given 一个合并前 PR，When `pr-create` / `pr-merge` 处理 spec metadata，Then 新正文使用 `Spec Disposition`，旧 `Spec Status` 只作为读取兼容。
- Given 旧会话或旧文案仍显式触发 `$plan-sync`，When 进入 spec drift gate，Then 它会转到 `$spec-sync` 的同一 tri-state 契约，而不是维护第二套规则。
- Given 调用方仍传入 legacy `docs/plan/<legacy-id>-*/PLAN.md` 作为 spec 引用，When 仓库已经把该主题迁到唯一的 canonical `docs/specs/<topic>/SPEC.md`，Then drift checker 仍会把 canonical `SPEC.md` 的变更视为有效同步，而不是错误阻断。
- Given 一个合法 slug 形如 `audit-logs`，When 没有历史 catalog 的精确 `ID + source path` 记录且没有同一 diff Git rename，Then drift checker 不得把它按五字符前缀重写成 `docs/specs/logs/SPEC.md`。
- Given 一个仓库仍只有 legacy `docs/plan/<legacy-id>-*/PLAN.md`，When 当前实现与该 `PLAN.md` 一起更新、但尚未建立 canonical `docs/specs/**`，Then drift checker 仍会把该 `PLAN.md` 视为有效同步目标，而不是因为 companion docs 缺失直接阻断。
- Given 一个仓库仍保留历史 ID-prefixed `docs/specs/<legacy-id>-*/SPEC.md`，且该目录仍是 `SPEC.md`-only 形态，When 当前实现与该 `SPEC.md` 一起更新、且尚未做 companion-doc backfill，Then drift checker 仍会把该 `SPEC.md` 视为有效同步目标，而不是要求先补齐 `IMPLEMENTATION.md` / `HISTORY.md`。
- Given 一个 legacy-plan-only 仓库通过 `$docs-migrate MODE=specs` 建立 canonical `docs/specs/**`，When canonicalization 完成后进入下一轮 Step 2 / drift gate，Then 新建的 canonical spec 目录已经包含 `SPEC.md`、`IMPLEMENTATION.md`、`HISTORY.md`，不会被“associated spec files are missing”立即打回。
- Given 旧计划目录名不是 lowercase kebab-case，When `$docs-migrate MODE=specs` 或 `MODE=specs-hygiene` 生成迁移映射，Then guard 必须阻断并要求显式的稳定 `--topic`，不得直接生成非 slug canonical Spec 路径。
- Given 一个历史 catalog 使用相对 catalog 目录的 inline-code 或 Markdown-link `Spec` 路径，When `$docs-migrate MODE=specs-hygiene` 证明 legacy ID 前缀，Then guard 必须将该路径规范化并可从可达 Git 历史读取精确 `ID + path` 证据。
- Given 一个任务被判定为 `spec_disposition=not_needed`，When 当前分支同时改动了实现文件和 `docs/specs/**`，Then drift checker 必须返回阻断并指出 spec-free 与 spec 改动冲突。
- Given 一个仓库既没有 `docs/specs/**` 也没有 `docs/plan/**`，When `goto-impl-branch` 用于明确为 `spec_disposition=not_needed` 的实现任务，Then 它会直接创建 topic branch 而不是伪造新的 spec 根。

## 验收清单（Acceptance checklist）

- [x] `docs/specs/**` 的全局定义已改为 topic-level spec。
- [x] 共享流程已改用 `spec_disposition`，不再依赖 spec 完成状态。
- [x] spec 模板与 README index 已改成“lifecycle + 轻量 implementation”，并默认生成 companion docs。
- [x] `docs-migrate` 已新增 `MODE=specs-hygiene`，并补充最小样例。
- [x] `.codex` 仓现有 `docs/specs/**` 已完成至少一轮 companion-doc backfill。
- [x] PR body / merge gate / image rewrite 契约已切到 `Spec Disposition`。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `git diff --check`
- `python3 /Users/ivan/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/docs-plan skills/docs-migrate skills/find-next-plan skills/pr-create skills/pr-merge skills/github-pr-body-images skills/project-engineering-workflow skills/spec-sync skills/plan-sync`
- `python3 -m unittest skills/find-next-plan/scripts/test_find_next_plan.py`
- `python3 -m unittest skills/spec-sync/scripts/test_spec_drift_check.py`
- `rg -n "IMPLEMENTATION.md|HISTORY.md|Implementation \\||MODE=specs-hygiene|spec_disposition" AGENTS.md docs skills`

### Quality checks

- active spec 的 `SPEC.md` 不再包含任务单 section，但同目录必须存在可读的 `IMPLEMENTATION.md` / `HISTORY.md`。
- lifecycle index 与 spec 目录实际路径一致。
- legacy 兼容只保留读取路径，不再作为新写法输出。

## Visual Evidence

None

## Related PRs

- None（local-merge path）

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：历史 spec 的 companion-doc 回填仍可能先以“提取旧字段 + commit trace”起步，个别主题后续还需要补更细的人工梳理。
- 风险：旧 PR/脚本仍可能携带 `Spec Status` 元数据；因此这轮只把它降级为读取兼容，而不是一次性抹掉所有历史痕迹。
- 假设：当前 `.codex` 仓现有 spec 基本都还对应有效主题，不需要本轮大规模做 `archived` / `superseded` 生命周期分流。

## 参考（References）

- `docs/specs/agent-memory-project-docs/SPEC.md`
- `docs/specs/global-solutions-docs-migrate/SPEC.md`
- `skills/docs-plan/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/docs-migrate/SKILL.md`
- `skills/spec-sync/SKILL.md`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`
