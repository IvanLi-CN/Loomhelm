# 长任务 ownership 与等待语义守卫

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- session `019d686e-a52e-7f30-8efa-d88fd784f327` 与 `019d681b-85d0-7541-bf8e-ccc81816cdaf` 暴露出同一类编排缺口：assistant 已明确承诺“继续盯着 / 继续 relay-poll”，但 live 长任务仍未终态时却提前结束回合，迫使主人再补“继续 / 盯着 / 你自己处理”这类无信息消息。
- 现有 `docs/specs/pr-wait-state-closeout/SPEC.md`、`docs/specs/review-proof-ownership/SPEC.md`、`docs/specs/review-proof-dedupe-wait-guard/SPEC.md`、`docs/specs/fast-track-merge-intent-closeout/SPEC.md` 已经把 PR `外部门禁等待态` 与 `active review proof` 的专用等待语义收紧了，但缺少一个更高层、可复用的 generic 长任务 ownership 契约，无法覆盖普通 exec/browser/test/job 场景，也没有把“口头承诺继续、实际提前停下”统一定义成不合格行为。
- 当前相关口径分散在 `AGENTS.md`、`$flow-continue`、shared workflow、`$codex-review-loop` 与已有短规约之间。partial-read 场景下，agent 仍可能只抓到局部规则，把“下一步很明确、只是继续等”错误当成合法停靠点。

## 目标 / 非目标

### Goals

- 明确 generic `active long task` 的共享契约：定义、`ownership promise`、合法停靠原因、默认轮询节奏，以及 generic continuation 的恢复语义。
- 规定：只要 live 长任务的下一步仍然只是 poll / relay / wait / 同路径重试，且不需要主人新的决定或授权，就必须在同一 turn 内继续推进。
- 让 `AGENTS.md`、`$flow-continue`、`$project-engineering-workflow`、`$codex-review-loop` 统一引用同一套口径，而不是各自散写一段“继续盯着”的语义。
- 新增 focused replay checker，直接覆盖这两条 cited sessions 对应的两种事故：`active review proof` 提前停靠、普通 live exec/task 提前停靠。

### Non-goals

- 不修改 Codex runtime / Desktop 的底层 turn 管理或通知逻辑。
- 不扩到更广的浏览器 consumer 面。
- 不把所有历史 session 全量变成通用大回放框架；本次只做 focused replay guard。

## 范围（Scope）

### In scope

- 更新 `docs/specs/README.md` 与本规格。
- 新增 shared `active long task` 短规约。
- 更新 `AGENTS.md`、`skills/README.md`、`$flow-continue`、`$project-engineering-workflow`、`$codex-review-loop`，并在需要时补 shared contract 交叉引用。
- 新增 focused replay checker 与最小化 replay fixtures / cases。

### Out of scope

- 修改 `config.toml` 或其他与本问题无关的本地配置。
- 修改 `gh CLI` 远端控制面或 browser MCP 行为。
- 为所有 skill 入口重新发明一套独立等待预算系统。

## 需求（Requirements）

### MUST

- shared contract 必须定义 `active long task`，至少覆盖 exec session、浏览器自动化、测试/构建、远端 job 与 `active review proof`。
- shared contract 必须定义 `ownership promise`：只要 assistant 已表达“我继续盯着 / 正在跑 / 我等它收口 / 我继续 relay-poll / 我不切走”或等价语义，就视为已接管该 live task。
- 若当前 live task 的唯一下一动作仍是继续 poll / relay / wait / 同路径重试，且不存在终态、新 blocker、主人决策/授权，或对应短规约允许的 `等待预算耗尽`，则不得结束当前 turn。
- 主人不得被迫通过“继续 / 盯着 / 别停 / 你自己处理”这类无信息消息来恢复本应自动继续的 live task。
- `等待预算耗尽` 只能在对应短规约允许的等待态里作为合法停靠原因；`active review proof` 达到 `startup_success` 后不得借此伪装停靠。
- `$flow-continue` 必须把 `ownership promise` 绑定的 live task 纳入恢复优先级；generic `继续` 只能先续接该 live task，不得重开新路径或改路由。
- focused replay checker 至少支持 finding：`LONG_TASK_OWNERSHIP_LEAK`。
- focused replay checker 必须至少覆盖两类负例：
  - `019d681b` 型：`active review proof` 仍 live，assistant 说“继续 relay/poll”，但仍提前停下；
  - `019d686e` 型：普通 live exec/task 仍 live，assistant 说“继续盯着 / 等它收口”，但仍提前停下。

### SHOULD

- 关键 consumer 文件的前 120-150 行就能看到 shared contract 引用和 stop prohibition。
- focused replay fixtures 应以 cited sessions 的最小化提炼片段为主，而不是依赖超大原始 session 文件。

## 功能与行为规格（Functional / Behavior Spec）

### Shared active-long-task contract

- 新 contract 统一承担六类判断：
  - `active long task` 定义
  - `ownership promise` 识别
  - generic stop prohibition
  - 合法停靠原因
  - 默认轮询节奏
  - generic continuation 的恢复语义
- PR `外部门禁等待态` 与 `active review proof` 继续沿用各自专用 contract / budget；shared long-task contract 只做上层 ownership guard，不推翻专用生命周期规则。

### Consumer integration

- `AGENTS.md`
  - 前置 repo 级硬规则，禁止把“继续等待同一 live task”的责任泄给主人。
- `skills/README.md`
  - 顶部共享摘要增加一条 generic guardrail，避免 partial-read 只读到 Step 5 旧语义。
- `$project-engineering-workflow`
  - 新增 shared long-task contract 引用，并在流程恢复语义与 `外部门禁等待态` 章节明确：generic live-task ownership 与 PR 专用 wait-state/budget 是分层关系。
- `$flow-continue`
  - 恢复顺序显式覆盖 `ownership promise` 绑定的 live task。
  - generic `继续 / 盯着 / 你自己处理` 若只是在补一个 no-op 恢复，不得被解释成新的路由或新的授权。
- `$codex-review-loop`
  - live proof 进入 relay/poll 后，不能再用“我继续盯着”当成合法收口语句；只能继续轮询，或按 shared / proof contract 命中合法停靠原因。

### Focused replay checker

- checker 读取最小化 replay JSONL，至少提取：
  - assistant / user message 文本
  - `Process running with session ID <n>` 这类 live exec 证据
  - `Process exited with code` / `Unknown process id` / `stdin closed` 等 terminal evidence
  - assistant 是否输出 `ownership promise`
  - user 是否发出 generic `继续 / 盯着 / 你自己处理`
- 负例判定：若 assistant 已形成 `ownership promise`，live task 仍未终态，且没有新 blocker / 主人决策 / `等待预算耗尽`，随后却需要 user 的 generic continue 才恢复，则报 `LONG_TASK_OWNERSHIP_LEAK`。
- 正例判定：若在 user generic continue 之前，task 已终态，或 assistant 已明确按契约说明 `等待预算耗尽` / 需要主人决策，则不得误报。

## 验收标准（Acceptance Criteria）

- Given 最小化 replay `negative-019d681b-active-proof-owner-leak.jsonl` When 跑 focused replay checker Then 必须报出 `LONG_TASK_OWNERSHIP_LEAK`。

- Given 最小化 replay `negative-019d686e-live-exec-owner-leak.jsonl` When 跑 focused replay checker Then 必须报出 `LONG_TASK_OWNERSHIP_LEAK`。

- Given assistant 只说“正在跑”这类 contract 已列明的 ownership promise When 随后仍需要 user 发 generic continue 才恢复 Then 也必须报出 `LONG_TASK_OWNERSHIP_LEAK`。

- Given assistant 在多 live session 下对“当前焦点 session”作出继续承诺 When 那个焦点 session 仍 live 且随后需要 user generic continue 才恢复 Then checker 也必须报出 `LONG_TASK_OWNERSHIP_LEAK`。

- Given 最小化 replay `positive-terminal-before-user-nudge.jsonl` When 跑 focused replay checker Then 不得误报 `LONG_TASK_OWNERSHIP_LEAK`。

- Given promise 绑定的原 live session 已终态，但另一个无关 session 仍在运行 When user 发送 generic continue Then 不得误报 `LONG_TASK_OWNERSHIP_LEAK`。

- Given user 的后续消息包含新的授权或改路由输入，而不只是 no-op 续推 When 跑 focused replay checker Then 不得把这条消息误判成泄漏触发器。

- Given user 的后续消息虽然含有“继续”，但同时追加了新的具体请求 When 跑 focused replay checker Then 不得把它误判成 generic no-op nudge。

- Given assistant 承诺继续的是 review proof，而另一条无关 exec session 同时 live When 该 proof 已终态、只剩无关 session 仍在运行 Then checker 不得把无关 session 误绑定到原 promise 上。

- Given assistant 承诺继续的是当前焦点 proof，且另一个 proof 同时 live When 当前焦点 proof 已终态、只剩另一条 proof 仍在运行 Then checker 不得把 promise 漂移到另一条 proof 上。

- Given `AGENTS.md`、`$flow-continue`、`$project-engineering-workflow`、`$codex-review-loop` 的顶部片段 When 只读前 120-150 行 Then 应能看到 shared long-task contract 引用或等价硬规则，并明确禁止“口头承诺继续、实际提前停下”。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `python3 -m py_compile bin/active_long_task_replay_check.py`
- `python3 bin/active_long_task_replay_check.py --cases docs/specs/active-long-task-ownership-wait-guard/replay/cases.txt`
- `python3 bin/review_proof_replay_check.py --cases docs/specs/review-proof-dedupe-wait-guard/replay/cases.txt`
- `python3 bin/flow_continue_replay_check.py --cases docs/specs/flow-continue-lock-guard/replay/cases.txt`
- `git diff --check`

### Quality checks

- 目标 consumer 的前 120-150 行人工 spot-check
- grep 交叉检查：`ownership promise`、`等待预算耗尽`、`active long task` 的口径一致

## 风险 / 假设

- 风险：focused checker 依赖 replay 中可观测的 message / exec-session 证据，因此它是 focused guard，不是 runtime 全量真相源。
- 风险：未来若新增新的长任务 consumer 但不引用 shared contract，partial-read 漂移仍可能复发。
- 假设：本次最值得防回归的是“ownership promise 泄漏 + 需要主人补 no-op 继续”，因此 focused replay 只覆盖这两条 cited sessions 对应的事故族即可。

## 参考（References）

- Session `019d686e-a52e-7f30-8efa-d88fd784f327`
- Session `019d681b-85d0-7541-bf8e-ccc81816cdaf`
- `docs/specs/pr-wait-state-closeout/SPEC.md`
- `docs/specs/review-proof-ownership/SPEC.md`
- `docs/specs/review-proof-dedupe-wait-guard/SPEC.md`
- `docs/specs/fast-track-merge-intent-closeout/SPEC.md`
