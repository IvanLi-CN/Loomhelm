# Review proof 去重与等待语义守卫

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- session `019cf2d3-8b9f-78a0-8c0e-81b3b59d082f` 暴露出两个编排层面的真问题：
  - 外层把 `exec_command(... tty=true)` 返回的 review `session_id` 当成 agent id 去 `wait`，直接打出 `invalid agent id 43198`；
  - review proof 生命周期没有被统一收口，导致外层既可能在 live proof 存在时再次发起新的 `codex review`，也可能用 `sleep && codex review` 这类延迟包装重启 proof。
- `docs/specs/review-proof-ownership/SPEC.md` 已经解决了“达到 `startup_success` 后，active review proof 不再属于共享等待预算”的 ownership 问题，但它没有把 proof identity、exec-session waiting 语义、retry/dedupe 规则做成单一共享真相源。
- 当前相关规则分散在 `$codex-review-loop`、`$flow-continue`、`$project-engineering-workflow`、PR 短规约和 prompts 之间。partial-read 场景下，agent 很容易只读到局部规则，继续复发“错误等待语义”或“重复起 review”的问题。

## 目标 / 非目标

### Goals

- 明确 review proof 的最小共享契约：proof identity、live-proof dedupe、exec-session waiting、restart gate、dead-session classification。
- 禁止把 `exec_command` 返回的 review `session_id` 当成 agent id 去 `wait` / `wait_agent`。
- 禁止在同一 live proof 仍未终态时，再次启动同义 `codex review` proof。
- 把这套规则收敛成一份短规约，供 `$codex-review-loop`、`$flow-continue`、shared workflow 与相关 prompts 统一引用，顺手瘦身重复文案。
- 新增 focused replay checker，至少覆盖真实 session 的等待误用，以及 synthetic live-proof duplicate launch 负例。

### Non-goals

- 不修改 Codex runtime 或 CLI 的底层进程管理实现。
- 不把“主流程等待期间是否继续做别的事”单独定义为缺陷。
- 不重写全部 flow/PR skills；只定向收紧本次事故相关的 review-proof 契约。

## 范围（Scope）

### In scope

- 更新 `docs/specs/README.md` 与本规格。
- 新增共享 review-proof 短规约。
- 更新 `$codex-review-loop`、`$flow-continue`、`$project-engineering-workflow`、PR 诊断短规约与相关 prompts，使其引用同一套 review-proof 生命周期规则。
- 新增 replay checker 与 replay fixtures / cases。

### Out of scope

- 修改 `gh CLI` 远端操作语义。
- 修改 `config.toml` 或其他与本问题无关的本地配置。
- 为所有历史 session 建立通用的大而全回放框架。

## 需求（Requirements）

### MUST

- review proof 的共享身份必须收紧为 `proof_key = <repo_root>:<head_sha>:<base_ref>:<review_profile>`。
- raw replay / JSONL 无法直接稳定读取 `head_sha` 时，focused checker 可以退化为更保守的可观测代理键（如 `workdir + --base + effort/profile`），但文档契约本身不能退回 branch 级粗粒度去重。
- live proof 的最小定义必须包含：proof 已启动且尚未进入 terminal state；达到 `startup_success` 后，它还自动成为 `active review proof`。
- shared review-proof contract 必须把 `startup_success` 绑定到“首条真正审查进展输出”；`thinking` / `exec` / findings / 最终结论都能满足该条件，但 banner/header 与 prompt 回显单独出现不能提前耗尽 init timeout / restart 语义。
- 在 review wave 中，同一 `proof_key + wave_id + lane` 存在 live proof 时，任何入口都只能复用并轮询；不同 lane 可以并行，不得为同一 lane 再次启动新的 `codex review` proof。
- `exec_command(... tty=true)` 返回的 review `session_id` 只能用于 exec-session 轮询（如 `write_stdin(session_id=...)`）；禁止把它送进 agent 等待接口。
- `Unknown process id`、session missing、stdin closed、明确退出码，都必须先进入 dead-session / terminal-state classification；只有 proof 已被归类为可重启终态，才允许重启。
- `sleep && codex review`、`nohup codex review`、外层 wrapper 托管 review 生命周期等非 direct launch 形式，必须继续判为不合格。
- direct launch 即使请求了 `--sandbox read-only`，runtime sandbox 真相也必须来自 proof banner / 会话输出，而不是命令字面值本身。
- `$codex-review-loop`、`$flow-continue`、shared workflow、相关 prompts 不得各自复制一大段 review-proof 生命周期正文；应引用单一短规约，只保留入口独有职责。

### SHOULD

- 相关入口文件前 100-150 行就能看到“exec session 不是 agent”“live proof 不得重开”的关键 guardrail。
- focused checker 输出应给出具体行号与最小证据，便于把真实 session 当回归样例长期保留。

## 功能与行为规格（Functional/Behavior Spec）

### Shared review-proof contract

- 共享短规约只承担五类判断：
  - proof identity / live-proof dedupe
  - direct launch / exec-session waiting 语义
  - `startup_success` 之后的 ownership
  - restart gate / dead-session classification
  - stale-proof 与 freshness/base 变化后的处理
- `startup_success` 的共享判据必须只接受真正审查进展输出；banner/preamble 与 prompt 回显都不能被视为“成功启动”，但它们也不能被误当成真实审查内容本身。
- shared PR diagnosis contract 继续拥有 PR freshness / approval / wait-state / convergence drag blocker 诊断，但 active review proof 的生命周期细节改为引用新的 review-proof contract。

### Thin entry skills / prompts

- `$codex-review-loop`
  - 负责 proof 的启动、findings 收敛、输出字段与当前 invocation 的修复循环。
  - proof identity、exec-session wait 语义、restart gate、禁止 deferred launch 的规则统一引用共享短规约。
- `$flow-continue`
  - 负责恢复顺序与路由。
  - 一旦恢复出的当前 gate 是 live review proof，只能 relay / poll；不得 route 成 agent wait，也不得因为 generic continue 再次拉起同义 proof。
- shared workflow / prompts
  - 只保留“何时需要 proof”“proof 对 merge / local-merge 的门禁意义”，不再自己重写 lifecycle。

### Focused replay checker

- checker 读取 replay JSONL，至少提取：
  - review `exec_command` 启动参数与 `tty=true`
  - `Process running with session ID <n>` 这类 exec-session 证据
  - `wait` / `wait_agent` / `write_stdin` 的调用目标
  - 非 direct launch（如 `sleep && codex review`）
  - live proof 尚未终态时的 duplicate launch
- checker 必须至少支持以下 finding：
  - `EXEC_SESSION_WAIT_MISUSE`
  - `NON_DIRECT_REVIEW_LAUNCH`
  - `DUPLICATE_LIVE_REVIEW_LAUNCH`

## 验收标准（Acceptance Criteria）

- Given session `019cf2d3-8b9f-78a0-8c0e-81b3b59d082f` When 跑 focused replay checker Then 必须至少报出 `EXEC_SESSION_WAIT_MISUSE`。

- Given session `019cf2d3-8b9f-78a0-8c0e-81b3b59d082f` When 跑 focused replay checker Then 应额外报出 `NON_DIRECT_REVIEW_LAUNCH`，因为存在 `sleep && codex review` 式 deferred launch。

- Given replay 中已有一个 live review proof 尚未终态 When assistant 再次启动同义 `codex review` Then checker 必须报 `DUPLICATE_LIVE_REVIEW_LAUNCH`。

- Given replay 中只有单个 review proof 被正常轮询并明确退出 When 跑 checker Then 不得误报 duplicate launch 或 wait misuse。

- Given `$codex-review-loop`、`$flow-continue`、shared workflow、相关 prompts 的顶部片段 When 只读前 100-150 行 Then 应能看到共享 review-proof contract 引用、`exec session != agent`、以及 live proof 不得重开的关键约束。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `python3 -m py_compile bin/review_proof_replay_check.py`
- `python3 bin/review_proof_replay_check.py --cases docs/specs/review-proof-dedupe-wait-guard/replay/cases.txt`
- `git diff --check`

### Quality checks

- 目标 skill / prompt 的前 150 行人工 spot-check
- 重复规则 grep：确认 review-proof 生命周期规则已集中到共享短规约

## 风险 / 假设

- 风险：若未来新增新的 review-proof 入口但不引用共享短规约，partial-read 漂移仍可能复发。
- 风险：focused checker 只看到 JSONL 中可观测事实，因此 duplicate launch 的自动判定采用保守代理键；这适合回归守卫，但不是 runtime 级唯一真相源。
- 假设：当前最值得防回归的是真实 session 的等待误用和 deferred launch，再配一个 synthetic duplicate-live case 即可覆盖这次事故族。

## 参考（References）

- Session `019cf2d3-8b9f-78a0-8c0e-81b3b59d082f`
- `docs/specs/review-proof-ownership/SPEC.md`
- `docs/specs/pr-skill-diagnosis-thinning/SPEC.md`
- `skills/project-engineering-workflow/references/pr-diagnosis-short-contract.md`
