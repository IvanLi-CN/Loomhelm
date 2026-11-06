# Dev plan goals-first contract rewrite 实现状态

> Legacy compatibility snapshot. 当前实现状态见 `../dev-plan-goals-first/IMPLEMENTATION.md`。

## Current Status

- Implementation: 已实现
- Lifecycle: legacy-read-only
- Catalog note: `dev-plan` 已切到 goals-first、non-persistent contract，checker 与 replay fixtures 已同步

## Coverage / rollout summary

- `skills/dev-plan/SKILL.md` 已改为 goals-first section contract，并显式禁止持久 `plan` 载体。
- `skills/dev-plan/SKILL.md` 已明确 `<proposed_plan>` 自然语言正文默认使用简体中文，同时保留 required section 标题、固定字段、`flow_type` 值、executor、`$skill` 引用、命令、路径、代码标识符、日志与错误文本的原文。
- `bin/plan_contract_check.sh` 已新增 `Summary / Goals / Non-goals` 相关门禁，同时保留既有 flow lock、wave/task、skill binding 与 implement-only 禁止项。
- `bin/plan_contract_check.sh` 现已额外校验 required section order，并拒绝 `Task Orchestration` 中的持久计划载体任务。
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
- `skills/dev-plan/SKILL.md` 的 Operational Runbook 现已切回 `CODEX_HOME` 锚定命令，避免 skill 从任意项目 cwd 调用时找不到 `bin/plan_contract_check.sh` 与 bundled replay set。
- `Non-goals` placeholder 守卫现已继续覆盖 `None`、`N/A`、`no exclusions` 一类“没有排除项”的空语义文本，并新增 `non-goals-none-placeholder` 回放防回归。
- `run_cases()` 已改为按 `CASES.txt` 所在目录解析相对 fixture 路径，因此从 repo 外以绝对 `CASES.txt` 路径执行也能稳定通过。
- `skills/implement-only-flow/SKILL.md` 已改为通过 `Goals / Non-goals` 表达范围边界。
- `delivery_topology` 已进入 Flow Decision：新计划显式选择 `direct|aggregate-stack`；aggregate-stack 被 checker 强制要求 `prd/<topic>` integration branch、risk-gated child merge、owner-explicit final merge 与 Ticket 继承批准计划。
- aggregate-stack 的 `prd/<topic>` 已与 initiative envelope 收敛为同一 lowercase kebab-case topic 规则，计划阶段不会再批准后续 Ticket 无法接收的 branch。
- planner replay 已覆盖完整 aggregate-stack、缺 final merge policy，以及显式 `sub-agent:ticket` 再次调用 `$dev-plan` 的拒绝路径；普通 direct Issue/Ticket 解析任务不会只因描述文字被误判，无 topology 的历史计划继续按 direct 兼容。

## Remaining Gaps

- None currently tracked after the review-driven checker follow-up.

## Related Changes

- `docs/specs/README.md`
- `docs/specs/dev-plan-goals-first/SPEC.md`
- `skills/dev-plan/SKILL.md`
- `bin/plan_contract_check.sh`
- `skills/dev-plan/references/replay-cases/*`
- `skills/implement-only-flow/SKILL.md`
- `skills/initiative-flow/SKILL.md`

## References

- `./SPEC.md`
- `./HISTORY.md`
