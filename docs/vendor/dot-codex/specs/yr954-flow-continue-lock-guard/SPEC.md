# Flow continue lock guard

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

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
- 让恢复层识别 initiative Ticket envelope 与 `PR_ROLE=child|parent`：child 回到 integration CI，parent 只能等待当前 head SHA 的主人最终批准。
- 新增本地回放校验资产，至少覆盖真实事故样例、一个负例 fixture、以及两个正例 fixture。

### Non-goals

- 不修改 Codex 官方二进制或依赖 undocumented runtime/config 开关冻结单个 session。
- 不改变 `local-merge` 已经显式锁定后的收敛/cleanup 语义。
- 不引入新的测试框架或远端依赖。

## 范围（Scope）

### In scope

- 更新 `AGENTS.md`、`skills/flow-continue/SKILL.md`、`skills/project-engineering-workflow/SKILL.md`、`skills/local-merge-flow/SKILL.md`、`prompts/advance-flow.md`。
- 新增本规格与 `docs/specs/README.md` 索引项。
- 新增 `bin/flow_continue_replay_check.py` 与对应 replay fixtures / cases。

### Out of scope

- 修改 `config.toml` 中的 provider/model/network 配置。
- 重写非 initiative `normal-flow`、`fast-flow`、`pr-create`、`pr-merge` 的既有 direct 路径语义。

## 需求（Requirements）

### MUST

- 最近一次显式 `flow_type` 锁定必须优先于后续 turn 读取到的 AGENTS/skills/prompt 热更新。
- built-in Plan Mode 一旦产出 `Flow Decision.flow_source=default_fast_track`，它也必须被视为合法 locked-flow 证据；后续恢复不得把它降回“未锁定”。
- 对未锁定为 `local-merge` 的 run，generic `继续 / 合并 / 收尾 / 合并并收尾` 只能推进当前锁定 flow；不能仅因后来读到了 `$local-merge-flow` 规则就改路由。
- 只有两种情况才允许进入 `$local-merge-flow`：
  - 当前 `active flow skill` 已经是 `$local-merge-flow`
  - 主人在锁定之后显式说出 `本地合主干 / local-merge / no-pr`
- 若恢复层推断出的 active flow 与最近一次显式锁定冲突，必须以锁定值为准；只有锁定之后的显式 flow switch 才能改写。
- child PR merge 后必须恢复 `$wave-thread-flow` 的 integration CI gate，而不是错误进入 Step 6 release tracking。
- parent PR 即使 `Step 5C Ready`，generic `继续 / 合并 / 收尾` 也不得触发最终 merge；只有主人明确批准该 PR 当前 `head_sha` 才能进入 `$pr-merge`。
- 本地回放检查必须能把真实事故 session 与人造负例 fixture 判为失败，并把显式 local-merge 切换的正例判为通过。

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

### Edge cases / errors

- 若只有后续 prompt/skill 热更新提到了 `local-merge`，但用户没有显式切 flow，这不构成合法改路由证据。
- 若缺少任何可恢复的 flow lock 证据，且当前 run 也不存在 built-in Plan Mode 产出的 `Flow Decision.flow_source=default_fast_track`，仍按现有流程阻断并只问 1 个关键问题；本规格不把 generic continuation 扩展成新的兜底默认 flow。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| `flow lock precedence` | skill/prompt contract | internal | Modify | None | main-agent | `AGENTS.md`, shared workflow, `$flow-continue`, `$local-merge-flow`, `/prompts:advance-flow` | 显式锁定优先于热更新语义 |
| `bin/flow_continue_replay_check.py` | script | internal | New | None | main-agent | 本地契约回放 | 检查 generic continue 是否误漂移到 local-merge |

### 契约文档（按 Kind 拆分）

None

## 验收标准（Acceptance Criteria）

- Given session `019ce28f-bc31-7d02-990f-c9f02c1bf028` When 用新的回放检查器重放该 JSONL Then 必须报告 `LOCKED_FLOW_DRIFT_TO_LOCAL_MERGE`。

- Given 一个已锁定 `fast-track` 的 fixture，用户只说 generic `请你合并 [$flow-continue]` When 回放里出现打开 `skills/local-merge-flow/SKILL.md` 的执行证据 Then 检查器必须判定失败。

- Given 一个已锁定 `fast-track` 的 fixture，用户后来显式改成 `local-merge / 本地合主干` When 回放里出现打开 `skills/local-merge-flow/SKILL.md` 的执行证据 Then 检查器必须判定通过。

- Given 一个已锁定 `fast-track` 的 fixture，用户只说 generic `请你合并 [$flow-continue]` When agent 继续留在 fast-track / PR 路径 Then 检查器必须判定通过。

- Given 一个 parent PR 已达到 `Step 5C Ready` When 用户只发出 generic continuation Then 恢复层必须停在 owner approval gate，而不是最终合并。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: N/A
- Integration tests: 使用 replay cases 与真实 session 做静态契约检查
- E2E tests (if applicable): N/A

### Quality checks

- `python3 bin/flow_continue_replay_check.py --cases docs/specs/flow-continue-lock-guard/replay/cases.txt`
- `python3 -m py_compile bin/flow_continue_replay_check.py`
- `git diff --check`

## 方案概述（Approach, high-level）

- 不赌 undocumented `config.toml` 开关，而是在自定义层把“锁定 flow 优先级”写成最先可见的硬规则。
- 用一个窄而稳定的 replay checker 把真实事故模式固化下来，避免今后再靠人工读 session 回忆根因。
- 保留 `local-merge` 的显式入口，但彻底切断 generic `合并 / 收尾` 对非 local-merge run 的追溯改路由。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：未来若新增新的 flow prompt 入口但没有同步这条锁定优先级规则，仍可能在新入口复发。
- 需要决策的问题：None
- 假设：当前公开可见的 Codex 配置与 CLI 帮助中，没有已确认可用的“冻结单个 session AGENTS/skills 语义”开关，因此本次修复应落在 `.codex` 自定义层。

## 参考（References）

- Session `019ce28f-bc31-7d02-990f-c9f02c1bf028`
- `sessions/2026/03/12/rollout-2026-03-12T22-59-56-019ce28f-bc31-7d02-990f-c9f02c1bf028.jsonl`
- `bin/plan_contract_check.sh`
