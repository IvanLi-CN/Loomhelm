---
name: implement-only-flow
description: "Plan implementation without delivery steps."
---

# Implement-only flow（仅实现流程）

当主人明确选择 `implement-only / 仅实现` 时使用本 skill。

## 目标

- 产出“可直接实现”的决策完备规格。
- 不进入交付流水线，不推进分支/提交/PR/合并。

## 核心边界（必须）

- 只做实现规格规划：目标、范围、关键技术决策、接口/数据流、失败场景、验收标准。
- 禁止包含交付流程条款：分支策略、commit 规则、push、PR、checks/workflows、merge、post-merge cleanup。
- 禁止在 `implement-only` 计划中引入 spec 创建/迁移/同步任务（如创建 `docs/specs/**`、`docs/plan -> docs/specs` 迁移、spec 同步工单）。
- 允许说明“未来执行前的前置检查”，但不执行实现动作。

## 实现前门禁（规则声明）

- 任何后续进入实现动作的流程，必须先执行工作区脏区检查：`git status --porcelain`。
- 检查命中脏区时，默认动作为“阻断并询问 1 个关键问题”；不得隐式继续。

## 与 Plan Mode 协作

- 在 Codex 内置 Plan Mode 中，若主人显式引用 `$dev-plan`，则按其输出契约生成 `<proposed_plan>`；若未显式引用，则保持官方原味 Plan Mode 结构，同时仍遵守本 skill 的实现边界。
- 流程绑定时，`flow_type=implement-only` 必须绑定本 skill。

## 最低输出要求

- 通过 `Goals / Non-goals` 明确范围边界，不依赖单独的 `Scope & Boundaries` 模板章节。
- 明确关键接口与数据流。
- 明确异常/边界与回滚思路。
- 明确可验证的验收标准。
- 若需要标记未确认信息，把三态 `存在 / 不存在 / 未检查` 放进假设摘要或状态区；结论与说明部分保持自然中文。
