# Dev plan goals-first contract rewrite 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实，避免这些细节散落到 PR / Git 历史里。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: `dev-plan` 已切到 goals-first、non-persistent contract，checker 与 replay fixtures 已同步
- 显式 `$dev-plan` 现在通过 `bin/plan-cli.sh` 将 canonical raw-plan 校验和 owner-facing projection 校验收敛为一个 `pass/reject` 结果；raw checker 只承担底层诊断，不再单独代表最终成功。
- 新 v2 task 在 `Task Orchestration` 中声明 `title`、`purpose` 和 `outputs`。 Projection 从同一份解析事实生成九段审阅视图与 Mermaid 波次/依赖图，不创建第二份执行 manifest。
- Projection 的 `任务卡` 同时展示 canonical task 和 batch 生命周期字段。`验收清单` 按合并前后阶段生成独立验收卡片，覆盖所有 canonical acceptance ID；长断言和证据按语义单元自然换行，不再依赖多列长文本表格，并在最终化时拒绝事实漂移。拒绝诊断不回显 raw-plan 原文，历史 JSONL 要求单一 `proposed_plan` block，章节提取忽略 fenced heading。
- The finalizer now rejects NUL input before raw checking. It preserves direct `[model, effort]` task lines in the owner view. It rejects duplicate route-driving sections, traverses candidate roots component-by-component without following symlinks, and ignores fenced proposed-plan markers in both historical parser and JSONL validation.
- Follow-up boundary repairs preserve direct-task skills; retired coordinator aliases are rejected. They cover optional direct-task arrow spacing without silently dropping tasks. They reject non-regular projection inputs before reading and stop historical wrapper extraction at the first valid closing marker while rejecting extras.
- The latest repair closes the remaining v2 guard bypass. Canonical task display metadata now receives Constraint-reference and persisted-plan-artifact checks. The historical direct-plan parser and shell JSONL route share the same whitespace-tolerant wrapper boundary and ignore no contract data outside the proposed-plan block. FIFO coverage now uses a platform-neutral temporary root.

## Pre-merge release decision

- New plans keep release behavior in existing sections and do not add retired plan-level arrangement fields, new stop-condition values, or a final version string.
- At Step 5C, runtime reads the target repository policy and current PR facts and returns a decision card covering publish applicability, components, channel, bump rule, predicted version, target identity, policy source, and collision policy. Route absence is routing-only and is not a no-release decision.
- `merge-only` and `merge+cleanup` lock the target repo/branch, base-tag source, bump rule, channel, components, collision policy, and merge-SHA binding as an executable rule. Owner confirmation must include the version expectation before merge continuation.
- After merge, `release_expected` and actual version/tag/artifact facts are evaluated only from `target_repo + target_branch + merge_sha`; missing or conflicting facts remain unknown/blocked.

## Coverage / rollout summary

- `skills/dev-plan/SKILL.md` 已改为 goals-first section contract，并显式禁止持久 `plan` 载体。
- `skills/dev-plan/SKILL.md` 已明确 `<proposed_plan>` 自然语言正文默认使用简体中文，同时保留 required section 标题、固定字段、`flow_type` 值、executor、`$skill` 引用、命令、路径、代码标识符、日志与错误文本的原文。
- `skills/dev-plan/SKILL.md` 已明确 canonical raw-plan 通过后才生成 owner-facing projection。 Projection 固定为九段视图和 Mermaid 波次/依赖图。
- `bin/plan-cli.sh` 已加入 stdout-only 的 tool-root-bound projection 路由；普通项目使用可信安装入口和 stdin，dot-codex 开发使用当前候选入口及配套 checker。它拒绝 proposed-plan wrapper、历史 JSONL、重复 machine registry、projection section drift 和缺失 Mermaid graph。
- `bin/plan_contract_check.ts` 已新增 `Summary / Goals / Non-goals` 相关门禁，同时保留既有 flow lock、wave/task、skill binding 与 implement-only 禁止项。
- `bun run bin/plan_contract_check.ts --plan <file|->` 已直接检查最终 Markdown，并复用既有章节/合同校验；fast-track 的 Non-goals 与验收会跨章节校验 required PR delivery path、live PR、current head 和 Step 5C convergence，三项交付事实必须位于同一条 `assertions=` 中；其中每个 assertion unit 独立判定正向性，允许同字段同时记录“Step 4 without PR 被拒绝”的反例，并拦截创建、打开、复用或省略 direct PR delivery 的等价排除表述，同时保留 aggregate / child PR exclusion 的 direct delivery 豁免。
- `bin/plan_contract_check.ts` 现已额外校验 required section order，并拒绝 `Task Orchestration` 中的持久计划载体任务。
- `bin/plan_contract_check.ts` 现已为显式 `$dev-plan` 的五类交付 flow 校验发布安排字段，并为 included/deferred/not-applicable 提供稳定 finding codes；历史 JSONL 未声明新字段时保持兼容。
- executor/profile contract now distinguishes Initiative `task:<name>` containers from read-only `sub-agent:<name>` children, validates supported model/effort pairs, and preserves old unprofiled sub-agents only through explicit recovery mode.
- read-only validation covers Chinese and English workspace/worktree plus task-local/filesystem write declarations, splits contradictory clauses, and preserves native `$review-agent` high-requirement reviews as `gpt-5.6-sol, medium`; legacy `$codex-review-loop` bindings are rewritten during migration.
- persisted-plan artifact matcher 已细化：既能拦截 planning `decision log` / `handoff log` artifact 与混合式 `remove ... and create ... PLAN.md` 任务，又不会把普通产品语义（如 `decision log UI`、`workflow decision log entries`、`next-session decision log entries API`、`agent decision log export API`、`handoff log UI/API`、`future handoff log timeline`、`plan file upload API`）或纯清理遗留 `PLAN.md` 引用的任务误判成 plan artifact。
- `Acceptance & Validation` 现已拒绝 placeholder-only 文本（如 `TBD later.`），不再把任意非空占位行当作有效验收。
- persisted-plan artifact safe matcher 进一步收紧为“必须命中明确产品 surface（如 `UI` / `page` / `API` 等）才可豁免”，避免 `decision log timeline for the next planning handoff`、`handoff log history for the next agent session` 这类带 `timeline/history` 的 planning artifact 因普通名词误放行。
- `Acceptance & Validation` placeholder matcher 已继续缩窄：仍会拒绝 `TBD later.`、`pending validation` 一类占位表达，但不再把 `Pending jobs remain visible in the queue after refresh.` 这种具体验收误判为 placeholder。
- `decision log` / `handoff log` artifact matcher 现已额外覆盖 `future work`、`next work/session/handoff`、`follow-up` 等 plain planning 语义，避免 `create decision log for future work`、`create handoff log for future work` 这类无显式 `plan` 字样的持久 planning artifact 漏拦。
- `Acceptance & Validation` 现已把仅含空 bullet（如单独一行 `-`）视为无效内容；空 bullet 不再能绕过“至少一条可观察验收”门禁。
- `PLAN.md` / `PLANS.md` path matcher 已加入产品文件支持豁免：当任务明确是在处理用户上传、导入、接受或读取这类产品文件能力时，不再误判为 persisted plan artifact；但真正的 `PLAN.md` 落盘/维护任务仍会被拦截。
- `handoff log` matcher 已收紧为“future/next/follow-up/agent session” 等 planning 语义，而不再把泛化 `agent handoff log exporter/worker` 这类 agent-facing 产品能力误判成 planning artifact。
- persisted-plan artifact safe matcher 现已继续放宽到 importer / consumer / processor / exporter / job / integration / connector / pipeline 等产品 surface，因此 `update the importer to accept customer-provided PLAN.md` 与 `create the CSV exporter for next-session decision log entries` 这类正常产品任务不再被误判；plain planning artifact 失败样例仍保持拦截。
- persisted-plan artifact safe matcher 现已再次收窄：`job / workflow / pipeline` 不再单独充当 safe exemption，且 `PLAN.md` path safe 只在无 planning context 时生效；这样 `write PLAN.md handoff job for future sessions`、`create a decision log job for future handoffs` 这类 planning artifact 会重新被拦截，而 importer / exporter / API 等正例仍保持通过。
- persisted-plan artifact 动作 matcher 现已补齐 `generate / initialize / keep`，因此 `generate a handoff log for future sessions` 与 `keep a handoff log for future sessions` 这类 planning artifact 不再漏拦。
- decision/handoff-log matcher 现已把 generic `workflow / pipeline / job` 重新视为 planning context，但同时把 `entries` 加回 product-safe surface，避免 `workflow decision log entries` 这类产品语义被误伤。
- `Goals` 检查现已拒绝 placeholder-only detail（如单独 `TBD` / `待确认`）；只有出现至少一条非占位的具体 detail，goal 才算满足新合同。
- `Acceptance & Validation` 现已拒绝 label-only 文本（如单独 `Notes`、`Follow-up items`、`备注`）；只有出现非占位、非标签式的真实验证说明才计入 meaningful acceptance。
- persisted-plan artifact matcher 现已把 `progress log` 从无条件 planning-object 匹配里拆出，改成“只有带 planning context 且不带 product-safe surface 时才拦截”，因此普通 `progress log UI/API` 功能不会再被误伤。
- persisted-plan artifact 动作 matcher 现已继续补齐 `move / copy / rename / relocate / archive` 等搬运式维持动作，因此“把 `PLAN.md` 移到未来 handoff 目录”这类变体不再漏拦。
- persisted-plan artifact 动作 matcher 现已继续补齐 `prepare / setup / set up` 等准备类动词，因此“prepare handoff log for next session”这类 planning artifact 不再漏拦。
- `PLAN.md` / `PLANS.md` 的 product-safe matcher 现已从“动作 + 路径即可放行”收紧为“动作 + 产品锚点 + 路径”或“路径 + 文件/内容锚点 + user/upload/product 语义”；因此 `create/update PLAN.md with implementation steps` 这类泛化维护动作不再被误放行。
- persisted-plan artifact 动作 matcher 现已补齐 `read / open / load / view / inspect`，因此 generic `read/open PLAN.md for next handoff context` 这类“读取持久计划”的执行安排也会被拦截；只有命中产品文件/API/importer 语义锚点时才可放行。
- `PLAN.md` path matcher 的 planning-context 豁免判定已不再把泛化 `review` / `审查` 视为强 planning 语义；这样带 `review page` 的产品导入/展示任务会继续走 product-safe 放行，而不会因为 UI wording 被误拦。
- `PLAN.md` path matcher 的 planning-context 豁免判定现已进一步移除泛化 `planning / 计划`；只剩 handoff / future / next / wave / turn 一类真正的执行续推语义会覆盖 product-safe 例外，因此 `planning UI + import API + user-provided PLAN.md` 这种产品任务不会再被误拦。
- `decision log` / `handoff log` 的 product-safe surface 现已补齐 `template / templates`，因此产品 `plan templates` 场景里的 decision-log history 不会再因为包含 `plan` 而被误当成 planning context。
- 对 `decision log` / `handoff log` 的 product-safe matcher 现已进一步显式识别 `plan template(s)`，并放宽到足以覆盖 “log history ... plan templates” 这类真实产品句式，而不需要整体放宽 `workflow/job/plan` planning-context 规则。
- `Goals` 检查现已拒绝空 bullet（如单独 `- `）；空 goal title 会直接报错，且不会再被误计为有效 goal 项。
- `Summary` 与 `Non-goals` 检查也不再只看 bullet 标记数量；空 bullet 现在不会充当有效摘要或有效排除项，空 `Non-goals` bullet 会直接报错。
- `Non-goals` 检查不再只看 bullet 数量；placeholder-only bullet（如 `TBD` / `待确认`）现在会被显式拒绝。
- `Goals` 与 `Acceptance & Validation` 的 placeholder matcher 现已补齐 `TBA / TBC` 等常见缩写，避免占位文本绕过现有 `TBD/TODO` 检查。
- replay fixtures 已批量切到新结构，并新增 `missing-goals`、`missing-non-goals`、`goals-empty-orchestration-only`、`goal-without-detail`、`invalid-section-order`、`persisted-plan-artifact-in-orchestration`、`mixed-plan-cleanup-create-artifact`、`decision-log-artifact-in-orchestration`、`handoff-log-artifact-in-orchestration`、`placeholder-acceptance` 失败样例，以及 `positive-normal-decision-log-ui`、`positive-normal-decision-log-entries`、`positive-normal-handoff-log-ui`、`positive-normal-plan-md-cleanup`、`positive-normal-next-session-decision-log-api`、`positive-normal-future-handoff-log-timeline`、`positive-normal-plan-file-upload-api`、`positive-normal-agent-decision-log-api` 正例。
- `positive-normal`、`positive-fast-track` 与 `positive-implement-only-pure` 三个基础正例已切为中文正文，继续保留英文机器合同标题与固定 token。
- replay fixtures 已追加 `decision-log-timeline-planning-handoff-artifact`、`handoff-log-history-agent-session-artifact` 两个失败样例，以及 `positive-normal-pending-state-acceptance` 正例，专门守住这轮 review 暴露的两类回归。
- replay fixtures 已继续追加 `decision-log-future-work-artifact`、`handoff-log-future-work-artifact` 与 `blank-acceptance-bullet` 失败样例，守住 plain future-work planning artifact 与空验收 bullet 两个新增边界。
- replay fixtures 现已继续追加 `positive-normal-plan-md-user-upload`、`positive-normal-plan-md-importer`、`positive-normal-agent-handoff-log-exporter` 与 `positive-normal-next-session-decision-log-exporter`，防止产品文件支持、importer/exporter 产品 surface 与 agent-facing handoff-log 功能再次被误伤。
- replay fixtures 现已继续追加 `plan-md-handoff-job-future-sessions-artifact`、`decision-log-job-future-handoffs-artifact`、`generate-handoff-log-future-sessions-artifact` 与 `keep-handoff-log-future-sessions-artifact`，守住 safe exemption 过宽与 action verb 过窄两类 false-negative 回归。
- replay fixtures 现已继续追加 `decision-log-workflow-artifact`、`handoff-log-pipeline-artifact`、`goal-placeholder-detail`、`acceptance-notes-only` 与 `acceptance-follow-up-items-only`，守住 generic workflow/pipeline wording、goal 占位 detail 与 acceptance 标签文本三类回归。
- replay fixtures 现已继续追加 `move-plan-md-handoff-artifact` 与 `positive-normal-progress-log-ui`，分别守住“搬运 persisted `PLAN.md` 仍应被拦截”与“产品 `progress log` 功能不应被误伤”两类边界。
- replay fixtures 现已继续追加 `prepare-handoff-log-next-session-artifact`、`non-goals-placeholder`、`acceptance-tba-only` 与 `goal-tba-detail`，分别守住准备类 planning artifact、`Non-goals` 占位 bullet，以及 `TBA/TBC` 占位文本两类回归。
- replay fixtures 现已继续追加 `create-plan-md-implementation-steps-artifact` 与 `update-plan-md-implementation-steps-artifact`，守住“generic PLAN.md create/update wording 被 product-safe 例外误放行”的回归。
- replay fixtures 现已继续追加 `read-plan-md-handoff-context-artifact`，守住“generic PLAN.md read/open wording 重新引入持久计划依赖”的回归。
- replay fixtures 现已继续追加 `positive-normal-plan-md-import-review-page`，守住“product-safe PLAN.md import/review page wording 被弱 planning `review` 误伤”的回归。
- replay fixtures 现已继续追加 `positive-normal-plan-md-planning-ui-import`，守住“product-safe PLAN.md import/UI wording 被泛化 `planning/计划` 误伤”的回归。
- replay fixtures 现已继续追加 `positive-normal-plan-template-decision-log-history`，守住“产品 plan templates 场景的 decision-log history 被 planning-context 误伤”的回归。
- replay fixtures 现已继续追加 `positive-normal-plan-template-handoff-log-history`，守住“产品 plan templates 场景的 handoff-log history 被 planning-context 误伤”的回归。
- replay fixtures 现已继续追加 `goal-blank-bullet`，守住“空 goal bullet 被误计为有效 goal 项”的结构回归。
- replay fixtures 现已继续追加 `summary-blank-bullet` 与 `non-goals-blank-bullet`，守住“空 Summary / Non-goals bullet 伪装成有效必选章节”的结构回归。
- goals-first blank-bullet 守卫现已进一步覆盖 bare dash 变体：`Summary`、`Goals`、`Non-goals` 中单独一个 `-` 不再被当成非空内容，相关失败样例也已切到 bare-dash 形态防回归。
- `skills/dev-plan/SKILL.md` 的 Operational Runbook 现已切回 `CODEX_HOME` 锚定命令，避免 skill 从任意项目 cwd 调用时找不到 `bin/plan_contract_check.ts` 与 bundled replay set。
- 普通规划只执行一次 raw-plan 检查；只有 checker/fixture implementation 变更的验收阶段才运行完整 `--cases`，避免把 fixture 回放加入每次计划成本。
- `Non-goals` placeholder 守卫现已继续覆盖 `None`、`N/A`、`no exclusions` 一类“没有排除项”的空语义文本，并新增 `non-goals-none-placeholder` 回放防回归。
- `run_cases()` 已改为按 `CASES.txt` 所在目录解析相对 fixture 路径，因此从 repo 外以绝对 `CASES.txt` 路径执行也能稳定通过。
- `skills/implement-only-flow/SKILL.md` 已改为通过 `Goals / Non-goals` 表达范围边界。
- 新计划只输出一个顶层 `flow_type`；checker 拒绝 `delivery_topology` 和双 flow 绑定。
- Initiative 被 checker 强制要求 `prd/<topic>` integration branch、risk-gated child merge、owner-explicit final merge 与 Ticket 继承批准计划，并只绑定 `$initiative-flow`。
- planner replay 已覆盖新 fast-track、Initiative、显式 normal、非法混用，以及 recovery-only legacy aggregate。
- 当前计划合同只接受 V5 入口；旧会话与旧代际合同不再读取、迁移或恢复。
- repository-local Skills 索引已由 `bin/skills_index_check.ts` 进行可执行校验，确保新增流程入口不会只存在于文档而遗漏索引。
- v2 profile-bearing task lines now remain in canonical facts and share the full planning-artifact guard set. They reject malformed direct raw-plan fences. Legacy wrapper validation ignores malformed fences outside the wrapper, and projection text neutralizes bare URL autolinks. Shell/Python heading and CRLF handling remains aligned. Product tasks that import user-provided `PLAN.md` content are excluded from the persisted-plan-artifact guard. Direct finalizer calls with unencodable input return a stable rejection finding.
- Flow Decision routing now shares unfenced, indentation-tolerant parsing across the shell checker, Python finalizer, and flow-continue replay checker.
- The finalizer now validates the unresolved candidate entrypoint, imported contract modules, and raw checker path component by component. Symlinked source paths are rejected before candidate execution can escape into runtime or another checkout.

- read-only matcher 现已拒绝 `implement the bug fix` 等多词 implementation assignment，同时允许 `git stash list/show` 等纯检查命令；对应边界已加入 replay fixtures。

## Remaining Gaps

- None currently tracked after the review-driven checker follow-up.

## Scope Constraint Coverage

- `bun run bin/plan_contract_check.ts --plan` rejects provenance sections and their source/authorization-heading variants, quoted owner messages, and owner-source mappings in final plans.
- The checker validates optional `C*` constraint ids and their links to existing `A*` acceptance items, and rejects Task Orchestration references to declared constraints.
- No persistent plan, authorization trace, scope ledger, or Task Evidence Set artifact is created by the implementation.

## Acceptance Manifest

- 新计划使用稳定 ID、类别、证据模式、验证目标和关键断言；checker 可输出规范化 manifest。
- 历史 replay set 保持显式 legacy acceptance 解析，新输出和少量 strict unit cases 使用完整映射。
- receipt 侧已验证 manifest 强制绑定、当前 SHA closure 与高风险单 receipt direct evidence；未增加 checker replay 或模型验证轮次。

## Related Changes

- `docs/specs/README.md`
- `docs/adr/0030-dev-plan-single-source-wave-thread.md`
- `docs/specs/dev-plan-goals-first/SPEC.md`
- `skills/dev-plan/SKILL.md`
- `bin/plan_contract_check.ts`
- `skills/dev-plan/references/replay-cases/*`
- `skills/implement-only-flow/SKILL.md`
- `skills/initiative-flow/SKILL.md`

## References

- `./SPEC.md`
- `./HISTORY.md`

## Wave Thread 移除边界

Wave Thread 的 Skill、专属历史读取、旧状态机、回放、CLI 与三档任务 Profile 已移除。现行共享多任务解析器保留独立合同；其他直接流程的历史 JSONL 校验不受此移除影响。
