# Flow continue lock guard

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

Its receipt-review recovery details and replay assets are historical cleanup context only and are not a direct-flow entry point. Direct review follows `../mandatory-local-review-proof/SPEC.md`; generic continuation resumes the locked flow through ordinary current-head convergence.

## Related ADRs

- [0032: One Finalization Gate for Dev-Plan Owner Review](../../adr/0032-dev-plan-single-finalization-gate.md)

## Context and Scope

This topic covers recovery and generic continuation for locked direct flows. Review disposition is consumed from the direct review contract; historical permit/replay markers remain audit-only inputs.

## 背景 / 问题陈述

- session `019ce28f-bc31-7d02-990f-c9f02c1bf028` 证明：本次事故不是 agent “随口答错一句”，而是同一个 run 先锁成 `fast-track`，后续 turn 又在新的全局 `.codex` 自定义文案和最新 `$flow-continue` skill 注入后，被重新解释成了 `$local-merge-flow`。
- 事故链条可回放为三段：
  - 早期 turn 已通过 `request_user_input(flow_type)` 与 `<proposed_plan>.Flow Decision.flow_type` 锁定 `fast-track`。
  - 后续 turn 的 `turn_context.payload.user_instructions` 携带了更新后的 AGENTS 文案，并注入了已包含 `local-merge` 分流规则的 `$flow-continue` skill。
  - 用户只说了泛化的“请你合并 [$flow-continue]”，agent 却打开了 `skills/local-merge-flow/SKILL.md` 并执行了本地 merge 路径命令。
- 这说明当前自定义层缺少一条硬约束：已锁定 flow 必须优先于后续热更新文案；generic `继续 / 合并 / 收尾` 只能推进当前锁定 flow，不能把旧 session 追溯改写成新的 flow family。

## 目标 / 非目标

### Goals

- 把“最近一次显式 flow 锁定”固化为活跃 session 的稳定真相源。
- 收紧 `$flow-continue`、共享 workflow、`$local-merge-flow` 与 `/prompts:advance-flow` 的入口契约，禁止 generic `合并 / 收尾` 把 `normal / fast-track` session 改路由到 `local-merge`。
- 让恢复层识别 initiative Ticket envelope 与 `PR_ROLE=child|aggregate`：child 回到 integration CI，aggregate 只能等待当前 head SHA 的主人最终批准。
- 新增本地回放校验资产，至少覆盖真实事故样例、一个负例 fixture、以及两个正例 fixture。
- 保持 locked flow 优先于 prompt/skill 热更新；历史 permit replay 不得重新成为 direct review 的调度或门禁路径。

### Non-goals

- 不修改 Codex 官方二进制或依赖 undocumented runtime/config 开关冻结单个 session。
- 不改变 `local-merge` 已经显式锁定后的收敛/cleanup 语义。
- 不引入新的测试框架或远端依赖。

## 范围（Scope）

### In scope

- 更新 `AGENTS.md`、`skills/flow-continue/SKILL.md`、`skills/project-engineering-workflow/SKILL.md`、`skills/local-merge-flow/SKILL.md`、`prompts/advance-flow.md`。
- 新增本规格与 `docs/specs/README.md` 索引项。
- 保留 `bin/flow_continue_replay_check.py` 与对应 replay fixtures / cases 作为历史兼容审计材料；当前 direct flow 不以其作为 review gate。
- 更新 `skills/flow-continue/SKILL.md` 与现有 replay checker，使 verified issued-permit/base-fast-forward recovery 可执行且可回放。

### Out of scope

- 修改 `config.toml` 中的 provider/model/network 配置。
- 重写非 initiative `normal-flow`、`fast-flow` 与 workflow PR procedure 的既有 direct 路径语义。

## Requirements

### MUST

- 新 session 只锁定一个顶层 `flow_type=initiative|fast-track|normal|local-merge|implement-only|multi-task-flow`；`delivery_role=direct|child|aggregate` 只是 PR helper 的内部角色，不得成为第二个 flow。`multi-task-flow` 是 active 的多任务协调路由；任务内部的 direct PR 仍可复用 `$fast-flow`，但不得改变父级流程身份或收口责任。
- Runtime flow state MUST keep the parent route and a task-local direct route separate. A nested task-local `$fast-flow` may establish its own `fast-track` lock and PR evidence, but it MUST NOT overwrite the parent `multi-task-flow` identity, parent lock, or parent closeout state.
- `flow_source=default_initiative_complexity` 与 `flow_source=default_fast_track` 都是稳定 lock 证据。已锁定 flow 不得因 AGENTS/skill 热更新、generic continue 或复杂度重算而改变。
- legacy `fast-track + aggregate-stack` 只可在 recovery 中读成冻结的旧 Initiative 合同；不得由新计划生成，也不得在恢复时改写成新的 fast-track 或 initiative session。
- recovery 输入含 legacy `delivery_topology=direct` 时可以忽略该字段并恢复原 `flow_type`；新计划输出仍必须拒绝 `delivery_topology`。

- 最近一次显式 `flow_type` 锁定必须优先于后续 turn 读取到的 AGENTS/skills/prompt 热更新。
- built-in Plan Mode 一旦产出 `Flow Decision.flow_source=default_fast_track`，它也必须被视为合法 locked-flow 证据；后续恢复不得把它降回“未锁定”。
- 对未锁定为 `local-merge` 的 run，generic `继续 / 合并 / 收尾 / 合并并收尾` 只能推进当前锁定 flow；不能仅因后来读到了 `$local-merge-flow` 规则就改路由。
- 只有两种情况才允许进入 `$local-merge-flow`：
  - 当前 `active flow skill` 已经是 `$local-merge-flow`
  - 主人在锁定之后显式说出 `本地合主干 / local-merge / no-pr`
- 若恢复层推断出的 active flow 与最近一次显式锁定冲突，必须以锁定值为准；只有锁定之后的显式 flow switch 才能改写。
- child PR merge 后必须恢复 `$initiative-flow` 的 integration CI gate，而不是错误进入 Step 6 release tracking。
- aggregate PR 即使 `Step 5C Ready`，generic `继续 / 合并 / 收尾` 也不得触发最终 merge；只有主人明确批准该 PR 当前 `head_sha` 才能进入 workflow PR merge procedure。
- 本地回放检查必须能把真实事故 session 与人造负例 fixture 判为失败，并把显式 local-merge 切换的正例判为通过。
- 对 locked `normal`/`fast-track` run，generic continuation 只能路由到当前 flow 的 ordinary convergence；review lane 的刷新遵循当前 Candidate、Repair Batch 和 Lane Refresh Set 合同。

### REQ-FLOW-CONTINUE-REVIEW-DISPOSITION

Generic continuation preserves the current Candidate's review disposition: an `In-Scope Review Finding` continues through bounded current-PR repair or the shared review-proof contract's authorized late follow-up handoff; a `Design-Returning Review Finding` stops ordinary convergence and returns to design, and a `Review Observation` remains report-only. Missing, stale, malformed, or unavailable review output remains `unchecked` evidence and never becomes a repair task. A non-terminal review continuation must carry the matching candidate `repo_root`, base SHA, head SHA, exact live lane and scope, review profile, current locked flow, ownership promise, and cumulative Repair Batch count; a missing or mismatched anchor blocks relaunch and budget reset.

For an authorized late follow-up, continuation MUST preserve source repository/PR/base/head, cumulative source count, item evidence/reasons, authorized scope/status, and any existing follow-up PR. Finish the source flow and its owner merge gate first; after actual merge and required closeout, resume one independent `$fast-flow` against mainline containing that merge SHA through Step 5C Ready. Reuse the matching PR, keep budgets separate, and preserve publication authorization and the no-recursive-chain boundary; a missing source merge is an explicit pending handoff.

### SHOULD

- 共享 workflow、`$flow-continue`、`$local-merge-flow` 与 `/prompts:advance-flow` 的措辞应保持一致，避免一个入口要求显式 local-merge、另一个入口又允许 generic `合并` 改 flow。
- 回放校验输出应给出锁定 flow、generic continue 位置、local-merge 路由证据位置，便于快速追根因。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 当 run 已锁定为 `normal` 或 `fast-track`，后续用户只说 generic `请你合并 [$flow-continue]`：
  - 恢复层只能继续当前锁定 flow。
  - 即使本 turn 读到了新增的 `local-merge` 文案、skills 列表或 AGENTS 更新，也不得因此改走本地合主干路径。
- 当 run 已锁定为 `fast-track`，且用户随后显式改成 `local-merge / 不建 PR / 本地合主干`：
  - 最新显式锁定值改写为 `local-merge`
  - generic `继续 / 合并 / 收尾` 才能推进 `$local-merge-flow`
- 当当前 active flow 本来就是 `$local-merge-flow`：
  - generic `继续 / 合并 / 收尾` 仍按既有 `Step 5L` 语义推进，不受本修复影响。
- locked `normal`/`fast-track` 的 generic continuation 进入当前 flow 的 ordinary convergence；当前 Candidate 的 Formal Review Wave、Repair Batch 和 Lane Refresh Set 由 direct review contract 决定。历史 recovery marker 不得改变该路径或恢复 receipt-held review state。
- A continuation that sees a design-returning finding must stop ordinary convergence and preserve the design blocker; it cannot repair, relaunch, or reinterpret the finding as an evidence failure. An observation may continue without creating a repair wave.

### Edge cases / errors

- 若只有后续 prompt/skill 热更新提到了 `local-merge`，但用户没有显式切 flow，这不构成合法改路由证据。
- 若缺少任何可恢复的 flow lock 证据，且当前 run 也不存在 built-in Plan Mode 产出的 `Flow Decision.flow_source=default_fast_track`，仍按现有流程阻断并只问 1 个关键问题；本规格不把 generic continuation 扩展成新的兜底默认 flow。
- 若 base 不是线性 fast-forward、live PR 与候选不一致，或 repair SHA 不满足既有 source/scope/budget 约束，ordinary convergence 不适用；恢复层保留当前 blocker，不得借 generic continuation 重置或重开 epoch。
- 历史 replay marker、`convergence-reopen`、非可信或非 canonical 值，以及缺少必填 operand 的旧 repair-wave command，只能作为历史 invalid-route 样本；它们不得改变当前 direct-flow 路径。
- 历史 replay route 证据只用于验证 locked-flow 优先级；不得把 receipt 命令、repair permit 或 review-wave 调用作为当前 direct-flow 操作。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| `flow lock precedence` | skill/prompt contract | internal | Modify | None | main-agent | `AGENTS.md`, shared workflow, `$flow-continue`, `$local-merge-flow`, `/prompts:advance-flow` | 显式锁定优先于热更新语义 |
| `historical flow replay checker` | script | historical audit | Retained | None | main-agent | 历史兼容审计 | 检查 generic continue 是否误漂移到 local-merge；不参与当前 direct-flow gate |
| `current-head convergence` | skill contract | internal | Modify | None | main-agent | `$flow-continue`, workflow PR publication procedure | verified current head 继续 ordinary convergence；历史 permit/replay 状态不参与当前 review gate |

### 契约文档（按 Kind 拆分）

None

## 验收标准（Acceptance Criteria）

- Given session `019ce28f-bc31-7d02-990f-c9f02c1bf028` When 用新的回放检查器重放该 JSONL Then 必须报告 `LOCKED_FLOW_DRIFT_TO_LOCAL_MERGE`。

- Given 一个已锁定 `fast-track` 的 fixture，用户只说 generic `请你合并 [$flow-continue]` When 回放里出现打开 `skills/local-merge-flow/SKILL.md` 的执行证据 Then 检查器必须判定失败。

- Given 一个已锁定 `fast-track` 的 fixture，用户后来显式改成 `local-merge / 本地合主干` When 回放里出现打开 `skills/local-merge-flow/SKILL.md` 的执行证据 Then 检查器必须判定通过。

- Given 一个已锁定 `fast-track` 的 fixture，用户只说 generic `请你合并 [$flow-continue]` When agent 继续留在 fast-track / PR 路径 Then 检查器必须判定通过。

- Given 一个 aggregate PR 已达到 `Step 5C Ready` When 用户只发出 generic continuation Then 恢复层必须停在 owner approval gate，而不是最终合并。

- Given 一个 locked `fast-track` replay 保留当前 flow lock When 用户发出 generic `$flow-continue` Then checker 必须通过 ordinary current-head convergence，且不得把历史 receipt/permit marker 解释为新的 review gate。

- Given ordinary current-head convergence 所需的 live facts 缺失 When generic continuation 尝试恢复 Then checker 必须保留当前 blocker，不得通过历史 permit marker 推断可继续。

- Given generic continuation 后刷新事实显示 locked flow 或 live candidate 已失效 When replay 仍试图继续 ordinary convergence Then checker 必须保留 blocker，而不是把旧 marker 当作当前状态。

- Given repair facts 来自 user/tool、同一 message 含有重复键，或只刷新三元组的一部分 When generic continuation 后出现 recovery route Then checker 必须保留 blocker；旧 replay marker 不得成为当前状态转换真相。

## Verification

### VER-FLOW-CONTINUE-REVIEW-DISPOSITION covers: REQ-FLOW-CONTINUE-REVIEW-DISPOSITION

- continuation keeps observations report-only and preserves a design-returning blocker without relaunching ordinary review;
- current-head and locked-flow facts remain the only inputs to resume a Repair Batch, while missing or stale review output stays `unchecked`.

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: N/A
- Integration tests: 当前 direct-flow architecture checks；保留的 replay cases 仅作历史兼容审计材料
- E2E tests (if applicable): N/A

### Quality checks

- `python3 bin/instruction_architecture_check.py --repo-root .`
- `python3 -m py_compile bin/flow_continue_replay_check.py`（历史兼容脚本语法检查）
- `git diff --check`

## 方案概述（Approach, high-level）

- 不赌 undocumented `config.toml` 开关，而是在自定义层把“锁定 flow 优先级”写成最先可见的硬规则。
- 用一个窄而稳定的 replay checker 把真实事故模式固化下来，避免今后再靠人工读 session 回忆根因。
- 保留 `local-merge` 的显式入口，但彻底切断 generic `合并 / 收尾` 对非 local-merge run 的追溯改路由。
- 将历史 permit/replay 资产限制为兼容性与审计材料；`$flow-continue` 只负责识别当前锁定 flow 的事实并路由到 ordinary convergence。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：未来若新增新的 flow prompt 入口但没有同步这条锁定优先级规则，仍可能在新入口复发。
- 风险：replay 只有在结构化记录 permit/base/live-PR 前提时才检查续推路径；真实运行仍以 helper 和 refreshed live facts 为准。
- 需要决策的问题：None
- 假设：当前公开可见的 Codex 配置与 CLI 帮助中，没有已确认可用的“冻结单个 session AGENTS/skills 语义”开关，因此本次修复应落在 `.codex` 自定义层。

## 参考（References）

- Session `019ce28f-bc31-7d02-990f-c9f02c1bf028`
- `sessions/2026/03/12/rollout-2026-03-12T22-59-56-019ce28f-bc31-7d02-990f-c9f02c1bf028.jsonl`
- `bin/plan_contract_check.ts`
