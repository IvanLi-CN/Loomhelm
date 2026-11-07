# 规格（Spec）总览

`docs/specs/**` 是 **topic-level specification catalog**：每个 spec 对应一个稳定主题、能力、接口或约束的长期契约。它回答的是“这个主题长期应该保持什么为真”，而不是“这次任务做到了第几步”。

每个 spec 目录默认同时承载三层信息：

- `SPEC.md`：当前有效规范 / 主题契约；`## Related ADRs` 列出当前关联 ADR，或写 `None`
- `IMPLEMENTATION.md`：实现覆盖、当前状态、剩余缺口与 rollout 事实
- `HISTORY.md`：主题局部生命周期、替换、兼容性与必要背景；不复制 ADR 的完整取舍理由

`docs/specs/**` 的主视角仍然是工程流程与 Agent memory，不是项目级人类文档入口。若某项结论已经成为项目当前真相，应再整理到 repo-established human-facing project docs / entry docs（通常 `docs/**`，也可为根入口文档），而不是长期只留在 spec 里。

> Legacy compatibility: historical repos may still contain `docs/plan/**/PLAN.md` or ID-prefixed spec directories. New entries must use `docs/specs/<topic>/SPEC.md`.

## 快速新增一个规格

1. 选择一个唯一且稳定的 topic slug。
2. 新建目录：`docs/specs/<topic>/`（`<topic>` 使用简短 kebab-case）。
3. 在该目录下创建 `SPEC.md`、`IMPLEMENTATION.md`、`HISTORY.md`：
   - `SPEC.md` 写清主题的背景、范围、稳定 `REQ-*` 需求、`VER-*` 验证与 `## Related ADRs`；关联 ADR 按路径升序列出 Markdown 链接，无关联时写 `None`；执行状态、命令、PR/commit 关联分别写入 companion docs；
   - `IMPLEMENTATION.md` 记录当前实现状态与覆盖进度；
   - `HISTORY.md` 记录主题局部生命周期、替换、兼容性与相关 PR / commit / 后继 spec。
4. 在下方 Index 表**表尾**新增一行，并把 `Lifecycle` 设为 `active`。

## 目录与命名规则

- 每个新规格一个目录：`docs/specs/<topic>/`。
- `<topic>` 是短、稳定、唯一的 kebab-case slug；它是新 spec 的身份，不生成 ID。
- 历史 ID 目录继续可读，批量规范化、冲突检查与入站链接更新由 `$docs-migrate MODE=specs-hygiene` 在明确确认后完成。
- 人类可读标题写在 Index 的 `Topic` 列；标题变更不强制改目录名。
- 规范正文：`docs/specs/<topic>/SPEC.md`
- 实现状态：`docs/specs/<topic>/IMPLEMENTATION.md`
- 演进历史：`docs/specs/<topic>/HISTORY.md`

## Lifecycle 说明

仅允许使用以下最小生命周期值：

- `active`：当前主题 spec 仍是有效真相源。
- `superseded`：已被 `Successor` 列指向的 topic spec 取代。
- `archived`：仅保留历史参考，不再作为当前规范输入。

## Implementation 列说明

- `Implementation` 只保留**轻量摘要**，用于快速回答“这个 spec 现在实现到哪”。
- 推荐值：
  - `未开始`
  - `部分完成 (x/y)`
  - `已实现`
  - `待刷新`
- 详细状态、覆盖清单、rollout 事实与剩余缺口必须写在 `IMPLEMENTATION.md`，不要把 README 再膨胀回完整任务看板。

## Index 顺序约定

- `docs/specs/README.md` 的 Index 按创建顺序维护：最早创建的规格在前，后创建的规格在后。
- 新增规格时把新行追加到 Index 表尾；仅更新 `Lifecycle` / `Implementation` / `Notes` 时不得重排既有行。
- README 只保留 `Lifecycle` 与轻量 `Implementation` 摘要；详细实现状态与演进原因必须落在 spec 目录内的 companion docs，而不是只留在 workflow / PR / 提交历史里。

## Index

| Topic | Lifecycle | Implementation | Spec | Successor | Notes |
| - | - | - | - | - | - |
| PR freshness gate | active | 已实现 | `pr-freshness-gate/SPEC.md` | - | PR 阶段 stale/conflict 前置门禁 |
| PR wait-state closeout | active | 已实现 | `pr-wait-state-closeout/SPEC.md` | - | 防止纯等待态被误当成可收尾停靠点 |
| Local merge cleanup closeout | active | 已实现 | `local-merge-cleanup-closeout/SPEC.md` | - | 收紧 local-merge cleanup 决策树与恢复语义 |
| Global port preview governance | active | 已实现 | `global-port-preview-governance/SPEC.md` | - | 统一本地长驻服务的端口归属检查、稳定随机分配、冲突处理与预览 URL 交付规则 |
| Flow continue lock guard | active | 已实现 | `flow-continue-lock-guard/SPEC.md` | - | 固化锁定 flow 优先级，阻止热更新文案把旧 session 误改路由到 local-merge |
| PR convergence batching | active | 已实现 | `pr-convergence-batching/SPEC.md` | `0016-bind-review-repairs-to-approved-scope.md`, `0017-review-readiness-and-runtime-launch.md` | CI remains SHA-bound; Review Readiness gates runtime formal launch, scoped findings form one Repair Batch, and only the final Candidate refreshes affected lanes |
| PR post-open scope freeze | active | 已实现 | `pr-post-open-scope-freeze/SPEC.md` | - | PR 打开后默认冻结范围，允许 behind/main-sync 必要兼容修复 |
| PR skill diagnosis thinning | superseded | 已实现 | `pr-skill-diagnosis-thinning/SPEC.md` | `agent-instruction-architecture/SPEC.md` | focused PR 规则已并入统一 instruction architecture 与共享 references |
| Dev plan flow lock option guidance cleanup | active | 已实现 | `dev-plan-flow-lock-options/SPEC.md` | - | 移除 `flow_type` 选项完备性的硬约束，只保留完整列表建议与 local-merge 别名兼容 |
| PR conflict auto heal | active | 已实现 | `pr-conflict-auto-heal/SPEC.md` | - | 将“Actions 缺席其实是 PR 冲突”收口到 freshness gate，并自动解冲续推；CI 缺席遵循共享四字段合同 |
| Review proof ownership | superseded | 已实现 | `review-proof-ownership/SPEC.md` | `mandatory-local-review-proof/SPEC.md` | Historical ownership model retained only for audit |
| Storybook skill upgrade | active | 已实现 | `storybook-skill-upgrade/SPEC.md` | - | 将 Storybook 交付升级为组件/片段优先：状态矩阵、关键 play、docs/canvas 双来源截图，整页证据默认走 `ui_demo` |
| Review proof dedupe and wait guard | superseded | 已实现 | `review-proof-dedupe-wait-guard/SPEC.md` | `mandatory-local-review-proof/SPEC.md` | Historical replay compatibility; active proof uses direct structured evidence |
| Review model and effort defaults | superseded | 已实现 | `review-effort-by-pr-stage/SPEC.md` | `workflow-agent-model-selection/SPEC.md` | Model selection remains separate from sub-agent proof acceptance |
| Fast-track merge intent closeout | active | 已实现 | `fast-track-merge-intent-closeout/SPEC.md` | `0003-external-fact-delivery-gates.md`, `0008-direct-pr-merge-preflight.md`, `0021-runtime-derived-pre-merge-release-route.md`, `0024-stop-condition-driven-release-decision.md` | direct PR 通过只读 preflight 锁定 live head 并使用 `--match-head-commit`；区分普通合并与 cleanup；Step 5C 决策卡读取目标仓库策略和当前 PR 事实；预合并 route 静默派生且无发布面时不改标签；merge 后 release chain 独立 |
| Local review necessity and proof | active | 已实现 | `mandatory-local-review-proof/SPEC.md` | `0014-direct-review-evidence.md`, `0016-bind-review-repairs-to-approved-scope.md`, `0017-review-readiness-and-runtime-launch.md`, `0032-flow-scoped-model-profile-allowlists.md` | Agent 记录 Tier 1..4 与理由；Review Readiness 后按当前 SHA 运行时创建 fresh structured review evidence，并按 exact six-profile direct-review allowlist 独立绑定 lane profile；完整 owner pair 原样交给 runtime，不进入 receipt review state machine |
| Shared UI visual evidence gate | active | 已实现 | `shared-ui-visual-evidence-gate/SPEC.md` | `0003-task-scoped-pr-visual-evidence.md`, `0004-scope-authority-and-topic-spec-boundaries.md` | 任务级 PR 选图、受管正文、同路径基线比较与 touched-file 文档迁移已接入 |
| Visual evidence whitespace trim | active | 已实现 | `visual-evidence-whitespace-trim/SPEC.md` | `0007-source-managed-component-evidence.md` | 页面保留 trim-only；组件证据由 Story 源管理展示面和一次 DOM 预检保证自然留白 |
| Active long-task ownership wait guard | active | 已实现 | `active-long-task-ownership-wait-guard/SPEC.md` | - | 收紧 live 长任务的 ownership promise、停靠语义与 focused replay 守卫 |
| Retire zellij service manager | active | 已实现 | `retire-legacy-service-manager/SPEC.md` | - | 删除已废弃服务托管 skill 与 repo 内配套辅助链，保留本机运行态残留为 out of scope |
| Local chat image snapshots | active | 已实现 | `local-chat-image-snapshots/SPEC.md` | - | 为 owner-facing Chat 图片新增不可变快照 helper、Markdown/HTML Stop hook 与 Chat/PR URL 分离规则 |
| PR live GitHub truth source | active | 已实现 | `pr-live-github-truth-source/SPEC.md` | - | 当前 PR blocker 从 live facts 推导；CI policy、expected checks、exact-SHA evidence 和 gate effect 分层 |
| Global solutions docs-migrate | active | 已实现 | `global-solutions-docs-migrate/SPEC.md` | - | 收敛 docs-migrate / docs-solutions / 全局入口接线与 compatibility shim |
| Native background preview handoff guard | active | 已实现 | `stable-preview-runtime/SPEC.md` | - | 为 owner-facing localhost handoff 收紧 native-background 契约，并补 pid-backed lease 自愈 |
| Viewport-safe browser evidence capture | active | 已实现 | `viewport-safe-browser-evidence/SPEC.md` | - | 统一非改窗优先截图契约；未指定尺寸的移动端验收默认使用 `393x852` CSS px，resize 仅作可恢复兜底 |
| Agent memory and project docs promotion | active | 已实现 | `agent-memory-project-docs/SPEC.md` | - | 固化 `specs + solutions` 与 human-facing project docs 分层，并新增 project-doc promotion gate / skill / docs-migrate 轨道 |
| Topic-level spec model | active | 已实现 | `topic-spec-model/SPEC.md` | `0004-scope-authority-and-topic-spec-boundaries.md` | 让 `docs/specs/**` 回归可追溯主题级需求规格，并以 companion docs 承接实施与历史事实 |
| Initiative delivery flow | superseded | 历史 | `initiative-flow/SPEC.md` | - | 历史协调契约，已退役 |
| Dev plan goals-first contract rewrite | active | 已实现 | `dev-plan-goals-first/SPEC.md` | `0004-scope-authority-and-topic-spec-boundaries.md`, `0006-internal-plan-authorization-and-scope-constraints.md`, `0021-runtime-derived-pre-merge-release-route.md`, `0023-dev-plan-release-delivery-scope.md`, `0031-dev-plan-owner-review-projection.md`, `0032-dev-plan-single-finalization-gate.md` | 将显式 `dev-plan` 收敛为 canonical raw-plan 校验后生成九段 owner-facing projection 的单一最终门禁，并保留历史 JSONL 只读兼容 |
| GUI escalation gate | active | 已实现 | `gui-escalation-gate/SPEC.md` | - | 保留 GUI 插件能力，以 `ego-browser` 作为默认浏览器入口，并把 Chrome control / DevTools 收口为显式例外、Computer Use 收口为最高升级路径 |
| Dev plan default fast-track auto-lock | active | 已实现 | `dev-plan-default-fast-track-auto-lock/SPEC.md` | - | 未显式指定 flow 时默认锁定 `fast-track` + `merge-ready`，并把 `default_fast_track` 纳入合法 flow lock 证据 |
| Git skill convergence | active | 已实现 | `git-skill-convergence/SPEC.md` | - | 将纯 git/local repo 操作收敛为 `git-branch`、`git-worktree`、`git-sync`、`git-cleanup`，并清退旧 prompts/skills |
| Mainline baseline and topic branch freshness contract | active | 已实现 | `mainline-baseline-topic-branch-freshness/SPEC.md` | - | 显式 `$dev-plan` 必须声明具体开发基线，并把 shared workflow 的 topic branch 创建 / 双阶段同步收敛成统一合同 |
| CVM imagegen fallback skill | active | 已实现 | `cvm-imagegen-skill/SPEC.md` | - | 新增显式 CLI 生图 fallback skill，固定使用 `CVM_API_KEY` 与 `https://vibe-code.ivanli.cc/v1`，不覆盖系统 `imagegen` |
| Workflow execution receipts | active | 进行中 | `workflow-execution-receipts/SPEC.md` | - | 以非 tracked receipt 复用 validation/lifecycle 事实，并维护 review-orchestration 清退清单 |
| Agent instruction architecture | active | 已实现 | `agent-instruction-architecture/SPEC.md` | - | 全局风险核心、深共享 Module、薄授权入口与行为回放门禁 |
| Workflow agent model selection | active | 已实现 | `workflow-agent-model-selection/SPEC.md` | `0003-external-fact-delivery-gates.md`, `0014-direct-review-evidence.md`, `0016-bind-review-repairs-to-approved-scope.md`, `0017-review-readiness-and-runtime-launch.md`, `0032-flow-scoped-model-profile-allowlists.md` | Review Readiness gates runtime launch; review and task execution keep independent allowlists with lane/task scopes; complete owner pairs pass unchanged to runtime, which owns support and errors; no automatic fallback |
| Shared testbox agent workspace | superseded | 历史；运行入口已退役 | shared-testbox-heavy-validation/SPEC.md | agent-vm/SPEC.md | 原共享宿主模型的历史事实 |
| XP Infra public hostname convention | active | 已实现 | `xp-infra-public-hostname-convention/SPEC.md` | - | 固定标准公网节点的成对 hostname，并由只读 audit 检测 drift |
| Fresh thread dispatch | active | 已实现 | `fresh-thread-dispatch/SPEC.md` | - | 显式新 Codex task 的模型、环境、紧凑 handoff 与工具边界；flow-owned lock 和完整 owner pair 原样交给 runtime，不做 flow-level fallback |
| Parallel direct PR flow | superseded | 历史 | `parallel-pr-flow/SPEC.md` | - | 历史并行协调契约，已退役 |
| Empirical acceptance review gate | active | 部分完成 (3/4) | `empirical-acceptance-review-gate/SPEC.md` | - | 对无法由确定性本地验证证明的外部行为，绑定 Candidate、验收合同和经验性证据，并在回归时停止普通 review/fix 收敛 |
| Code Hosting Platform Boundary | active | 已实现 | `code-hosting-platform/SPEC.md` | - | GitHub 与自托管 Gitea 控制面、精确 SHA 安全语义及四字段 CI facts envelope |
| Native Incus Agent VM | active | 协议 4 在线内存调整与 48 GiB 额度候选待验收；既有回收已验收 | agent-vm/SPEC.md | - | 显式租约、原生 NAT 与懒释放 |
| Release Tracking | active | 部分完成 | `release-tracking/SPEC.md` | - | 专用角色、完整发布链、有限自动恢复与安全单次重跑；运行时验收另行核实 |
| mcu-agentd 集成清退 | active | 已实现 | `mcu-agentd-retirement/SPEC.md` | - | 三个受维护源头均已清退；不规定或迁移各项目工具 |
| Multi-task flow | active | 已实现 | `multi-task-flow/SPEC.md` | [0035](../adr/0035-task-orchestration-ledger.md), [0040](../adr/0040-dev-plan-standalone-typescript-finalizer.md) | 独立任务依赖、单编排账本、动态父 PR 和只读实时视图；不绑定 dev-plan |
| Dev-plan standalone TypeScript finalizer | active | 已实现 | `dev-plan-standalone-typescript-finalizer/SPEC.md` | - | dev-plan 独立校验与投影、TypeScript 唯一实现、仅保留安全启动 launcher |
