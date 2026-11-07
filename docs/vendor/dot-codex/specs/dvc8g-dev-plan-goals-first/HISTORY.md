# Dev plan goals-first contract rewrite 演进历史（#dvc8g）

> Legacy compatibility history. 当前规范正文见 `../dev-plan-goals-first/SPEC.md`。

## Decision Trace

- 新建 `#dvc8g`，把 `dev-plan` 的 goals-first 合同重写独立成 topic spec，避免挤进 `k4n8p` 或 `r4m7k` 的既有主题范围。
- 明确“不落盘 plan”是本次改造的硬边界：计划只作为当前回合的临时执行规格，长期真相仍由 spec/solution 承担。
- 首轮 local-merge review proof 先暴露了 `CASES.txt` 相对路径依赖调用方 cwd 的问题，随后补齐 `run_cases()` 相对路径解析。
- 第二轮 review proof 又指出：仅要求 section 存在还不足以兑现 goals-first；checker 还需要显式守住章节顺序和持久计划载体禁令，因此追加本轮 follow-up。
- 追加 follow-up 时，review proof 又发现 persisted-artifact matcher 误伤了普通产品语义（`decision log UI`）；因此把匹配范围缩窄，并新增正例回放防回归。
- 随后的 review proof 继续指出：缩窄后又漏拦了 plain planning `decision log` artifact；因此补成“planning artifact 命中，但产品 UI/API 语义放行”的双向规则。
- 再下一轮 proof 发现仅放行 UI/API 仍不够，产品语义还可能表现为 `decision log entries` 这类非 UI 文案；因此进一步收敛为“必须同时命中 planning context 才视为 decision-log artifact”。
- 最新一轮 proof 继续补齐两个边界：`handoff log` 必须被直接视为持久计划载体，同时 `workflow / task / session` 这类通用产品词不能再单独充当 `decision log` 的 planning context；因此 matcher 改成“显式 handoff log 拦截 + 仅对 planning/future-handoff 语义触发 decision-log artifact”。
- fresh proof 随后又指出：把 `handoff log` 直接并入通用 artifact object 会误伤普通产品 `handoff log UI/API` 任务；因此进一步改成“`handoff log` 也走 planning-context / future-handoff 判定 + 产品 UI/API safe exemption”，并新增正例回放。
- 后续 fresh proof 又补出两个漏口：一是清理遗留 `PLAN.md` 引用的任务不应仅因提到路径就被拦；二是 `next-session decision log entries API`、`future handoff log timeline` 这类带时间词的产品能力仍会被误伤。因此 path matcher 改成“路径 + 持久化动作，且排除 cleanup 动作”，同时 decision/handoff-log matcher 改成“显式 planning context 才拦截”，并补齐对应正例回放。
- 再下一轮 proof 继续抠出两个 contract 缺口：其一，“边清理边新建 `PLAN.md`” 这种 mixed task 不能因为出现 cleanup 动词就绕过禁令；其二，`Acceptance & Validation` 不能接受 `TBD later.` 这类占位文本。因此再次把 path matcher 收紧到“只要出现 `PLAN.md` 路径 + 持久化动作就拦”，并为 acceptance 新增 placeholder-only 拒绝规则与失败样例。
- 最新一轮 proof 又指出两类普通产品语义仍会误伤：一是泛化的 `plan file` 产品能力，二是 `agent decision log` 这种 agent-facing 功能词。因此继续缩窄 matcher：移除通用 `plan file` object 命中，并把 `agent` 从 decision-log planning context 中拿掉，同时补齐对应正例回放。
- 最新 follow-up proof 又补出两个新边界：其一，`timeline/history/entries` 这类普通名词不能单独充当 planning artifact 的安全豁免，否则 `create decision log timeline for the next planning handoff`、`create handoff log history for the next agent session` 会漏拦；其二，placeholder matcher 不能把具体验收里的 `Pending ...` 误判成占位。因此 safe matcher 再次收紧到“需命中明确产品 surface 才放行”，同时把 placeholder 词表缩窄到真正的 filler 短语，并补齐对应正反例回放。
- 随后 fresh proof 又指出两个更朴素的 contract 漏口：一是 `create decision log for future work`、`create handoff log for future work` 这类 plain planning artifact 仍会因缺少显式 `plan` / `agent session` 关键词而漏拦；二是 `Acceptance & Validation` 只有空 bullet (`-`) 时也会被当成有效内容。因此再次扩展 planning-context matcher 到 `future work / next work / follow-up` 语义，并把空 bullet 归类为 `ACCEPTANCE_EMPTY`，同时补齐对应失败样例。
- 最新 proof 又抠出两类新的产品误伤：其一，处理用户上传 `PLAN.md` 文件的产品能力不应被 path matcher 当成 persisted plan artifact；其二，`agent handoff log exporter/worker` 这类 agent-facing handoff-log 功能不应因为包含 `agent` 一词就被当成 planning handoff log。因此继续为 `PLAN.md` 路径加入产品文件支持豁免，并把 handoff-log planning context 从泛化 `agent` 收紧到 `agent session` 等明确 planning 语义，再补两条正例回放防回归。
- 最新 fresh review proof 又补出两类仍未覆盖的产品语义：其一，`update the importer to accept customer-provided PLAN.md` 这类 importer / consumer / processor wording 仍会被 `PLAN.md` path matcher 误拦；其二，`create the CSV exporter for next-session decision log entries` 这类 exporter / job / integration wording 仍会被 decision-log matcher 误判成 planning artifact。因此再次扩展产品 surface safe matcher，并补齐 importer/exporter 两条正例回放。
- 最新 fresh review proof 随后又指出两个反向漏口：safe matcher 放得过宽，会让 `write PLAN.md handoff job for future sessions`、`create a decision log job for future handoffs` 这类 planning artifact 被错误放行；同时 action matcher 只覆盖 `write/create/update` 一类动词，导致 `generate` / `keep` 变体漏拦。因此再次收窄 safe exemption，并补齐动作词与对应失败样例。
- 再下一轮 fresh review proof 继续指出三个结构漏口：其一，generic `workflow/pipeline` wording 仍会让 planning decision/handoff-log artifact 漏拦；其二，goal detail 只写 `TBD` / `待确认` 这类占位词也会通过；其三，`Acceptance & Validation` 只有 `Notes` / `Follow-up items` 这类标签文本时也会通过。因此再次把 `workflow/pipeline/job` 纳回 planning context，补齐 goal placeholder 与 acceptance label-only 拒绝规则，并新增对应失败样例。
- 最新 fresh local-merge proof 又补出两类 persisted-plan matcher 偏差：其一，普通产品 `progress log` UI/API 任务被误判成 planning artifact；其二，`move generated PLAN.md into a shared handoff folder` 这类搬运式维持动作仍然漏拦。因此把 `progress log` 改成仅在 planning context 下拦截，并把 `move/copy/rename/archive` 等动作纳入 persisted-artifact action matcher，同时补齐正反例。
- 最新 fresh local-merge proof 再次补出三类剩余漏口：其一，`prepare/setup handoff log` 这类常见 planning 动词仍会绕过 persisted-artifact matcher；其二，`Non-goals` 只写 `TBD` / `待确认` 也会通过；其三，`Goals` / `Acceptance & Validation` 里的 `TBA` / `TBC` 占位文本还没被视为 placeholder。因此继续扩展动作词与 placeholder 集，并补齐对应失败样例。
- 再下一轮 fresh local-merge proof 指出 `PLAN.md` 的 product-safe 例外仍过宽：`create/update PLAN.md with implementation steps` 会被误当成普通产品文件操作通过。因此继续收紧 `PLAN.md` product-safe matcher，要求出现明确的产品文件/API/importer/upload 语义锚点，并补两条对应失败样例。
- 随后的 fresh local-merge proof 又指出 `decision log` 的 product-safe surface 还缺 `plan templates` 这一类真实产品面，导致 “record workflow decision log history when users edit plan templates” 被误判成 planning artifact。因此继续把 `template/templates` 纳入 product-safe surface，并补一条对应正例样本。
- 再下一轮 fresh local-merge proof 进一步指出 `handoff log` 在同类 `plan templates` 产品句式下也会被误伤，例如 “create agent handoff log history when users transfer plan templates”。因此继续把 `plan template(s)` 提升为 `decision log / handoff log` 的显式 product-safe surface，并补一条 handoff-log 正例样本。
- 最新 fresh local-merge proof 又指出一个纯结构漏口：`## Goals` 里的空 bullet (`- `) 会被当成“存在 goal”，从而绕过 goals-first 合同。因此继续把 goal 校验改成“空 title 直接报错 + 仅非空 goal 才计入有效数量”，并补一条专门的失败回放。
- 最新 fresh local-merge proof 随后又指出 persisted-plan artifact 动作仍偏写入导向：generic `read/open PLAN.md for next handoff context` 会直接通过，等于允许通过“读取旧计划”重引入持久计划依赖。因此继续把 `read/open/load/view/inspect` 纳入 artifact action matcher，并补一条对应失败回放。
- 紧接着的 fresh local-merge proof 又指出 `PLAN.md` path matcher 的 planning-context 兜底里，泛化 `review` 会误伤真实产品任务：像 “add support for user-uploaded PLAN.md documents in import API and review page” 会因为 `review` 一词被当成 planning context。于是继续把 `review/审查` 从该 path-level planning-context 中移除，并补一条 import/review-page 正例回放。
- 最新 fresh local-merge proof 又把 goals-first 的另外两个空洞补了出来：`Summary` 与 `Non-goals` 仍然只按 bullet 标记计数，所以单独一个 `- ` 也能假装成有效必选章节。因此继续把两处检查都改成“至少一条非空 bullet”，并让空 non-goals bullet 单独报错，再补两条对应失败回放。
- 随后的 fresh local-merge proof 又指出 path-level planning-context 还是偏宽：即使是 `update the planning UI and import API to accept user-provided PLAN.md documents` 这种明显产品任务，也会因为 `planning` 一词被当成 persisted-plan planning context。于是继续把 `planning / 计划` 从 `PLAN.md` path 规则的覆盖条件里拿掉，只保留真正的 handoff/future/turn/wave 续推语义，并补一条 planning-UI 正例回放。
- 最新 fresh local-merge proof 继续补出一个更细的结构绕过：`Summary` / `Goals` / `Non-goals` 里的 bare dash（单独一行 `-`）会因为 bullet 提取只剥 `- ` 而被误算成非空内容。于是把三处 bullet 归一化统一改成 `^-\\s*` 剥离，并把对应失败样例改成 bare-dash 形态，确保空 bullet 无论是否带尾随空格都不能绕过。
- 最新 fresh local-merge proof 又指出 `skills/dev-plan/SKILL.md` 的 Operational Runbook 把 checker / replay 命令改成了相对路径，这会在 skill 从普通项目 cwd 调用时失效。因此把 runbook 命令重新锚到 `${CODEX_HOME:-$HOME/.codex}`，既保留 goals-first 语义，又恢复任意 caller cwd 下的可执行性。
- 最新 fresh local-merge proof 继续补出 `Non-goals` placeholder 的另一个空洞：`- None`、`- N/A` 这类“没有排除项”的空语义文本不会命中现有占位词表，从而让计划在未声明任何具体 non-goal 时通过 checker。因此把 `none / n/a / no exclusions / 无` 一类表达纳入 `NON_GOAL_PLACEHOLDER`，并补一条 `non-goals-none-placeholder` 失败回放。
- 主人发现内置 Plan Mode 生成的计划经常偏英文；根因是全局 `instruction.md` 虽有“默认简中”，但 `dev-plan` 的硬合同、示例与基础 replay 正例大量使用英文正文。因此在不改 checker 英文章节名的前提下，把 skill 语言规则收敛为“自然语言正文默认简体中文，机器合同 token 保持原文”，并把基础正例改成中文正文。
- initiative-flow review 发现 aggregate plan 的 `integration_branch` 原先接受大写和下划线，而 Ticket envelope 只接受 lowercase kebab-case topic。为避免计划通过后才在 handoff 失败，两个阶段统一为 `prd/<lowercase-kebab-case-topic>`。
- 将 Ticket 重规划门禁收敛到显式 `sub-agent:ticket` executor，避免普通 direct 任务仅因描述中出现 Ticket 或 Issue 就被误判为已继承计划的 Ticket 执行。

## Key Reasons / Replacements

- Initiative delivery 复用同一份批准的 `$dev-plan`：拓扑字段只在 aggregate-stack 中增加执行约束，避免每个 Ticket 重新进入 Plan Mode 或制造第二份计划真相。

- 实施阶段额外把 repo-local replay case 路径改成相对路径，并同步让 `run_cases()` 按 `CASES.txt` 目录解析这些路径；这样隔离 worktree 与 repo 外绝对调用都能命中新 checkout，而归档 session 继续保留绝对路径。

- `k4n8p` 只处理 flow lock 选项指导；`r4m7k` 只处理 fast-track closeout。两者都不足以承接本次 section contract 改写，因此创建独立后继 topic。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#dvc8g`.
