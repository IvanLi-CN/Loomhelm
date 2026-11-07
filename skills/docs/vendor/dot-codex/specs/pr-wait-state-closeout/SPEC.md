# PR wait-state closeout

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 在已授权 PR convergence 的 run 里，agent 仍可能把“当前只剩外部门禁在运行”误判成一个可汇报停靠点，先输出结论和 `流程锚点`，再结束当前 turn。
- session `019ce60d-8cc3-7623-a02a-e54290c9e52c` 已给出明确回放样例：agent 在最新 `head_sha=49ba093bef373079617fcf4a9404e1898adc4e1d` 的 fresh merge-proof 仍未拿到终态、PR `mergeable_state` 仍为 `unstable` 时，先给出“下一门禁=latest head 的 fresh merge-proof 完成”并停止；对应 JSONL 证据位于 `sessions/2026/03/13/rollout-2026-03-13T15-16-13-019ce60d-8cc3-7623-a02a-e54290c9e52c.jsonl` 约第 `3295` 行。
- 该问题的本质不是“agent 不知道下一步做什么”，而是“当前 running gate 的完成”被错误包装成 `流程锚点.下一门禁`，导致纯等待态提前收尾。

## 目标 / 非目标

### Goals

- 明确“当前 running checks/workflows/fresh merge-proof/mergeable 重算的完成”不是新的 `下一门禁`。
- 明确在已授权 PR convergence 的 flow 里，纯 `外部门禁等待态` 不是合法停靠点；除非共享等待预算耗尽，否则必须留在当前 turn 继续轮询。
- 让共享 workflow、`$flow-continue`、`$fast-flow`、`workflow PR publication procedure`、`workflow PR merge procedure` 与 prompt 顶部都能在 partial read 场景下先看到同样的 stop prohibition。
- 规定当确实因等待预算耗尽而停下时，`流程锚点.下一门禁` 必须表示“重入共享等待态继续轮询”，而不是把当前 running gate 的完成伪装成下一动作。

### Non-goals

- 不修改 Codex 引擎级 `task_complete` 机制。
- 不改写 `$codex-review-loop` 的 profile 体系或执行模型。
- 不引入新的自动化测试框架或新的 GitHub 状态模型。

## 范围（Scope）

### In scope

- 更新 `docs/specs/README.md` 与本规格文档。
- 更新 `$project-engineering-workflow` 的共享 PR 等待态契约与锚点语义。
- 更新 `$flow-continue` 的恢复归一化规则。
- 更新 `$fast-flow`、`workflow PR publication procedure`、`workflow PR merge procedure` 的提前停机约束。
- 更新 `/prompts:advance-flow` 与 workflow PR merge procedure 的顶部 stop prohibition。

### Out of scope

- 变更任何 `gh CLI` 远端操作契约。
- 修改非仓库内的 agent runtime。
- 对现有 flow 增加新的状态字段。

## 需求（Requirements）

### MUST

- 纯 `外部门禁等待态` 只能有两种合法行为：在同一 turn 内继续轮询，或在共享等待预算耗尽后以明确的“等待预算耗尽”收尾。
- `流程锚点.下一门禁` 不得写成“最新 head 的 fresh merge-proof 完成”“checks 全绿”“mergeable_state 变 clear”这类当前 running gate 的完成条件。
- 若本轮因共享等待预算耗尽而停下，`流程锚点.下一门禁` 必须表示“重入共享等待态继续轮询”或等价表述，而不是虚构一个尚未开始的新 gate。
- `$flow-continue` 在恢复时，若发现锚点里的 `下一门禁` 其实只是当前 running gate 的完成条件，必须把它归一化回共享 `外部门禁等待态`，而不是把该文本当作真实下一动作。
- `partial read` 场景下最先可见的规则也必须足以阻止“先汇报再等待”的误停。

### SHOULD

- 用 session `019ce60d-8cc3-7623-a02a-e54290c9e52c` 作为回放样例，确保新契约能把该类输出判为不合格收尾。
- 共享 workflow、具体 skill 与 prompt 的措辞保持一致，避免不同入口给出不同恢复语义。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 当 PR merge/create path 只剩运行中的 checks/workflows、mergeable 重算、branch update 可见状态，或当前 `head_sha` 的 fresh proof 仍在运行时：
  - 若当前 flow 已授权 PR convergence，则必须继续轮询共享等待预算。
  - 若预算内任一门禁变成 clear 或 actionable blocker，必须在同一 turn 内继续后续门禁。
  - 若预算耗尽，允许停下，但结论必须显式写出“等待预算耗尽”，并把恢复锚点指回共享等待态本身。
- 当恢复层读到旧锚点中的“下一门禁=checks 全绿 / fresh merge-proof 完成”时，若当前事实显示这些门禁只是 still running，就要把它解释成“继续轮询共享等待态”，而不是“已知下一步所以可以停”。

### Edge cases / errors

- 若 fresh proof 尚未启动且启动它需要新的授权，这不是纯等待态；仍按授权阻断处理。
- 若轮询期间 `PR.head.sha`、`PR.base.sha`、`mergeable_state` 事实变化，等待态立即失效，必须返回 freshness/mergeability gate，旧 proof 与旧 checks verdict 失效。

## 验收标准（Acceptance Criteria）

- Given agent 已授权 PR convergence，且唯一缺口是运行中的 checks/workflows/fresh merge-proof When agent 评估当前 stop condition Then 它不得把这类状态当作可直接收尾的“已知下一门禁”。

- Given 当前 run 只因共享等待预算耗尽而停下 When agent 输出结论与 `流程锚点` Then 结论必须显式写出“等待预算耗尽”，且 `下一门禁` 只能指向“继续轮询当前外部门禁等待态”或等价共享等待处理。

- Given `流程锚点.下一门禁` 文字只是当前 running gate 的完成条件 When `$flow-continue` 恢复流程 Then 必须把恢复点归一化回共享等待态，而不是把该文字当作新的可停靠 gate。

- Given session `019ce60d-8cc3-7623-a02a-e54290c9e52c` 中约第 `3295` 行的输出 When 按新契约回放 Then 该输出应被判定为不合格收尾；合法行为只能是继续轮询，或在预算耗尽后明确标注“等待预算耗尽”。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: N/A
- Integration tests: 通过静态契约审阅、session 回放与文本一致性检查验证
- E2E tests (if applicable): N/A

### Quality checks

- `git diff --check`
- 目标文件中的 `等待预算耗尽 / 外部门禁等待态 / 下一门禁` 文案交叉检查

## 方案概述（Approach, high-level）

- 把“纯等待态不能提前停机”前移到共享 workflow、具体 PR skill 和 prompt 的顶部可见区域。
- 把“当前 running gate completion”与“下一门禁”语义拆开：前者属于继续轮询当前等待态，后者只用于真正尚未开始的下一个硬门禁。
- 在恢复层增加归一化规则，避免旧锚点把 wait state 再次误恢复成可停靠点。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：如果后续再新增 PR skill/prompt 入口但没有同步复制 stop prohibition，仍可能在新入口复发。
- 需要决策的问题：None
- 假设：已授权 PR convergence 的 flow 允许在共享等待预算内保持同一 turn 继续轮询。

## 参考（References）

- Session `019ce60d-8cc3-7623-a02a-e54290c9e52c`
- `sessions/2026/03/13/rollout-2026-03-13T15-16-13-019ce60d-8cc3-7623-a02a-e54290c9e52c.jsonl`
