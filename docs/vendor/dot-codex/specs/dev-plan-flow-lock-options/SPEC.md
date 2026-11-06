# Dev plan flow lock option guidance cleanup

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 之前曾把 `flow_type` 的完整选项列表写成硬约束，并一度把“缺失显式选项”接进 checker，导致 agent 在计划阶段为了自证合规而反复补问或解释 UI 限制。
- 主人要求的实际目标更简单：在 skill 中强烈建议尽量给出完整 flow 列表，但不得把这件事升级成阻断性契约。
- 现有 checker 对 `local-merge` 的中文别名支持已经补齐，后续只需保留这一兼容性事实，不再围绕选项完备性增加门禁。
- 后续 `docs/specs/dev-plan-default-fast-track-auto-lock/SPEC.md` 已接管显式 `$dev-plan` 路径的“无显式 flow 时默认 auto-lock `fast-track`”语义；本 spec 现在只 owner interactive flow 问题本身的选项指导，不再 owner happy-path 默认选路。

## 目标 / 非目标

### Goals

- 把 `dev-plan` 中关于完整 flow 列表的表述收敛成非阻断性建议。
- 明确 repo 内不再因 `flow_type` 选项数量或展示形式附加额外校验。
- 保留 checker 对 `本地合主干` / `本地合主干流程` / `local-merge` 的识别。

### Non-goals

- 不修改 `normal-flow`、`fast-flow`、`local-merge-flow` 的业务执行语义。
- 不改 Codex 内置 `request_user_input` 工具本身。
- 不新增新的 plan sections 或输出格式要求。

## 范围（Scope）

### In scope

- `docs/specs/README.md`
- `docs/specs/dev-plan-flow-lock-options/SPEC.md`
- `skills/dev-plan/SKILL.md`
- `bin/plan_contract_check.ts`
- `skills/dev-plan/references/replay-cases/*`

### Out of scope

- 其他 skill 的 wording 清洗
- 远端 CI / GitHub 流程调整

## 需求（Requirements）

### MUST

- checker 必须把 `本地合主干` 视为 `local-merge` 的合法中文别名。
- 当显式 `$dev-plan` 确实需要 interactive flow 锁定问题时，必须继续使用 `request_user_input(flow_type)`，但不得因选项数量或 UI 展示形式额外判 invalid；无显式 flow 的 happy-path 默认 auto-lock 由 `docs/specs/dev-plan-default-fast-track-auto-lock/SPEC.md` 单独 owner。

### SHOULD

- `request_user_input(flow_type)` 在条件允许时应尽量覆盖 `implement-only / normal / fast-track / local-merge / multi-task-flow`；其中 `multi-task-flow` 是显式多任务协调的顶层选项。
- skill 文案应把这件事表达成强烈建议，而不是硬门禁。

## 验收标准（Acceptance Criteria）

- Given `request_user_input(flow_type)` 因歧义/冲突而被触发，且选项标签使用 `本地合主干` When checker 解析问题和回答 Then 必须识别为 `local-merge`。

- Given 更新后的 repo 文案与 checker When agent 读取显式 `$dev-plan` 相关真相源 Then 不应再把完整 flow 列表解释成阻断性要求。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `bun run /Users/ivan/.codex/bin/plan_contract_check.ts /Users/ivan/.codex/skills/dev-plan/references/replay-cases/positive-flow-lock-rui.jsonl`
- `bun run /Users/ivan/.codex/bin/plan_contract_check.ts /Users/ivan/.codex/skills/dev-plan/references/replay-cases/flow-decision-mismatch-lock.jsonl`
- `bun run /Users/ivan/.codex/bin/plan_contract_check.ts --cases /Users/ivan/.codex/skills/dev-plan/references/replay-cases/CASES.txt`
- `git diff --check`

## 风险 / 假设

- 假设：当前 repo 把 `plan_contract_check.ts` 与 replay fixtures 视为 `dev-plan` 契约真相源的一部分。

## Related ADRs

- [0037: Dev-plan Multi-task Flow Routing](../../adr/0037-dev-plan-multi-task-flow-routing.md)
