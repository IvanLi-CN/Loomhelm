# Review proof ownership

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 最近的 review 失败链路里，真正的问题不是 `codex review` 本身一定卡死，而是外层 flow 把一个已经启动并开始产生可观测 proof-side 输出的 review proof，当成了共享 `外部门禁等待态` 的一部分。
- session `019cf1f6-91b2-7893-ad95-80830ce62973`、`019cf1fc-c964-7e31-a392-78d8e4934121`、`019cf209-cfbf-7e32-97a9-8b1a050d5cbf`、`019cf215-42d3-7883-b991-fa1f824ec42f` 共同说明：上层会因为轮询预算或“先停掉卡住 proof”的主观判断，提前向运行中的 review proof 发送 `Ctrl-C`。
- 这与后续 `Missing environment variable: CVM_API_KEY` 属于不同故障：前者是生命周期 ownership 错了，后者是子进程启动环境缺失。

## 目标 / 非目标

### Goals

- 明确 `codex review` 一旦成功启动并出现首条可观测 proof-side 输出，生命周期就归 review proof 自身管理，而不是归共享等待预算管理。
- 把初始化阶段的“是否成功启动”与运行阶段的“是否超时”拆开，避免短暂无输出就被上层误判并主动中断。
- 明确 `--sandbox read-only` 只表示请求形状；proof 的实际 sandbox 真相必须以 runtime banner / 会话输出为准。
- 把允许的自动介入条件收窄到：初始化失败、初始化超时后的一次重启、运行超时、主人显式要求停止。
- 让共享 workflow、PR 短规约、下游 skills 与 prompts 在 partial read 下都先看到同一条 ownership 规则。
- 在修复契约的同时压缩重复文案，避免 skill 越修越长。

### Non-goals

- 不修改 Codex runtime 或 CLI 的底层进程管理实现。
- 不解决 `CVM_API_KEY` 继承链路；该问题继续单独归类为“启动失败”。
- 不新增新的统一状态字段。

## 范围（Scope）

### In scope

- 更新 `docs/specs/README.md` 与本规格文档。
- 更新 `$codex-review-loop` 的启动成功判定、初始化重启边界、运行超时与 stale-proof 处理契约。
- 更新 `$project-engineering-workflow` 与 `pr-diagnosis-short-contract.md`，把 active review proof 从共享等待预算中剥离出来。
- 瘦身 `$fast-flow`、`$pr-create`、`$pr-merge` 与相关 prompts 的重复 stop 规则。

### Out of scope

- 修改 `gh CLI` 远端操作语义。
- 引入新的回放测试框架或会话重放脚本。
- 更改 Step 1-4 的普通工程流程。

## 需求（Requirements）

### MUST

- `startup_success` 必须定义为：review proof 出现首条真正审查进展输出；`thinking`、`exec`、findings 或最终结论都算，banner/header、prompt 回显、空轮询、外层包装器噪音与无关 shell chatter 不算。
- `INIT_STALL_TIMEOUT_SEC=300` 必须成为真实的“未出现首条真正审查进展输出”的启动失败判定阈值，而不再只是 warning。
- 初始化阶段自动重启最多 `1` 次；运行阶段不得再有自动重启预算。
- 一旦 proof 已达到 `startup_success`，外层除了“主人显式要求停止”或“运行阶段超时”外，不得主动发送 `Ctrl-C` / kill / 其他 stop 信号。
- 运行阶段超时保持为“连续 `15` 分钟无新业务输出”。
- 若 proof 运行过程中 `HEAD` / `PR.head.sha` / `PR.base.sha` 变化导致该 proof 结果过期，不得主动杀掉现有 proof；只能在其终态后把结果判为 stale，并决定是否对最新事实补新的 proof。
- `Missing environment variable: CVM_API_KEY`、命令缺失、会话启动失败等情况必须继续归类为“启动失败/硬失败”，而不是“误终止”。
- 若 direct launch 命令请求了 `--sandbox read-only`，agent 仍必须以 runtime banner / 会话输出判断 proof 的实际 sandbox mode，不得只凭 CLI 参数断言已经处于真正的 read-only。
- 对 pre-PR / direct proof 而言，若 runtime 事实表明该 proof 实际不是 read-only，则这次 direct proof 不能充当合格的 direct read-only gate；调用方必须阻断或升级到受治理的 writable review-loop 路径，不能把这次 writable fallback 当作“同一个 direct proof 继续有效”。
- 所有 direct-proof caller（包括 final merge-proof / merge-path caller）都必须继承同一条 runtime sandbox 真相规则；不得只在部分入口修正，而让其他 caller 继续把 writable fallback 当作 read-only evidence。

### SHOULD

- 共享等待预算只覆盖 GitHub 可见的外部门禁等待，不覆盖已经成功启动的本地 review proof。
- 下游 skills 与 prompts 应只保留薄 guardrail，并引用共享短规约，而不是各自重复整段 ownership 逻辑。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 初始化阶段：
  - 从 review 进程启动开始，到出现首条真正审查进展输出之前，都属于 init。
  - `thinking`、`exec`、findings 或最终结论都算 `startup_success`；banner/header、prompt 回显（例如 `user current changes`）、空轮询、纯 shell echo、外层 provider/bootstrap 噪音都不算。
  - 若 `300s` 内仍未出现首条真正审查进展输出，则本次 proof 视为“未成功启动”；最多允许自动重启 `1` 次。
- 运行阶段：
  - 一旦看到首条真正审查进展输出，立即进入 `phase=running`。
  - 此后共享 wait budget 只能继续轮询与转述，不再拥有 stop 权限。
  - 若先看到 banner、随后只出现 prompt 回显而没有进一步审查进展，这仍属于 init；只有出现真正审查进展输出后，后续沉默才按运行阶段规则处理。
  - 若连续 `15min` 无新业务输出且会话仍存活，才允许按 timeout 终止并记为 `stalled/timeout`。
- stale-proof：
  - 如果 proof 运行期间出现新的 `HEAD` / `PR.head.sha` / `PR.base.sha`，现有 proof 只是“未来可能 stale”，不是立即可杀对象。
  - 该 proof 自然结束后，若它绑定的事实已过期，则结果只可用作诊断证据，不可作为最新 fresh proof。
  - 若 direct requested-read-only proof 的 runtime 实际可写，并在此过程中改变了本地 `HEAD`，则旧 direct proof 立即失去“直通 gate”资格；后续只能先刷新事实到最新 `HEAD`，再走受治理的 writable review-loop / validation 路径。

### Edge cases / errors

- 若会话在 init 阶段直接报环境缺失、命令错误或 session 中断，按 init hard failure 处理，可用掉仅有的一次 init restart。
- 若 proof 已经进入 running，但随后 session 异常断开，按运行阶段硬失败/超时路径处理，不得写成“共享等待预算耗尽”。
- 若 proof 尚未真正启动成功，只是“准备启动 fresh proof”，那仍可被共享外层流程视为尚未进入 active proof ownership。

## 验收标准（Acceptance Criteria）

- Given 一个 review proof 已出现首条真正审查进展输出 When 外层 flow 继续轮询 Then 外层不得因为共享等待预算、轮询次数或主观“先停掉卡住 proof”而主动中断它。

- Given 一个 review proof 在 `300s` 内没有任何首条真正审查进展输出 When 外层判定启动状态 Then 该 proof 必须被视为 init failure / init timeout，且最多只允许自动重启一次。

- Given 一个 review proof 已经输出 prompt 回显，但尚未出现任何真正审查进展输出 When 外层继续等待后续审查内容 Then 该 proof 仍停留在 init；若后续一直没有真正审查进展输出，必须继续按 init timeout / restart 规则处理，而不是提前转成运行阶段 stall。

- Given 一个 review proof 已进入 running，随后 `HEAD` / `PR.head.sha` / `PR.base.sha` 变化 When 外层收到新鲜度变化事实 Then 不得立刻杀掉当前 proof；只能等它终态后把旧结果判 stale，并在需要时为最新事实补 proof。

- Given session `019cf209-cfbf-7e32-97a9-8b1a050d5cbf` 与 `019cf215-42d3-7883-b991-fa1f824ec42f` When 按新契约回放 Then 这些在已产生业务输出后被上层 `Ctrl-C` 中断的行为应被判定为不合格。

- Given session 中出现 `Missing environment variable: CVM_API_KEY` When 归类故障 Then 必须继续判为启动失败/环境失败，而不是误终止。

- Given 一个 pre-PR direct proof 以 `--sandbox read-only` 形状启动 When runtime banner / 会话输出表明它实际不是 read-only Then 调用方不得把它当作合格的 direct read-only proof 继续推进；若后续仍要允许写入，必须切换到受治理的 writable review-loop 路径，并对最新 `HEAD` 重新绑定事实。

- Given 一个 final merge-proof / merge-path direct proof 以 `--sandbox read-only` 形状启动 When runtime banner / 会话输出表明它实际不是 read-only Then 该 caller 同样不得把它当作合格的 direct read-only merge-proof evidence；必须阻断或切到受治理的 writable 路径，并对最新 PR/HEAD 事实重新绑定。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: N/A
- Integration tests: 通过文档契约审阅与已知 session 回放样例交叉验证
- E2E tests (if applicable): N/A

### Quality checks

- `git diff --check`
- 目标文件中的 `startup_success` / `INIT_STALL_TIMEOUT_SEC=300` / `runtime banner` / `外部门禁等待态` / `等待预算耗尽` / `Ctrl-C` 文案一致性检查

## 方案概述（Approach, high-level）

- 先在共享短规约里明确“谁拥有运行中的 proof”，再让 `codex-review-loop` 把 init 与 running 的边界写实。
- 把共享等待预算重新限定为 GitHub 可见外部门禁；已经启动成功的本地 proof 不再纳入这类 stop 预算。
- 下游技能只保留必要的 thin wrapper，统一引用共享主源，减少未来再次漂移的机会。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：如果未来新增新的 PR/merge skill 入口但不复用共享短规约，仍可能在新入口复发。
- 需要决策的问题：None
- 假设：只要 proof 已产生业务输出，主人希望它默认跑完，除非超时或显式要求停止。

## 参考（References）

- Session `019cf1f6-91b2-7893-ad95-80830ce62973`
- Session `019cf1fc-c964-7e31-a392-78d8e4934121`
- Session `019cf209-cfbf-7e32-97a9-8b1a050d5cbf`
- Session `019cf215-42d3-7883-b991-fa1f824ec42f`
- Session `019cf251-17e9-7cb0-81e0-854a426d9725`
