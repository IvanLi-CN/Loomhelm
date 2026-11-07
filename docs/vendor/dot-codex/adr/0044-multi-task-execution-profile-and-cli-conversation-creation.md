# ADR 0044：Multi-task Flow 执行配置与 CLI 对话创建

- Status: accepted
- Date: 2026-11-05
- Related: `docs/specs/multi-task-flow/SPEC.md`, `docs/adr/0032-flow-scoped-model-profile-allowlists.md`, `docs/adr/0035-task-orchestration-ledger.md`

## 背景

编排需要在创建交付单元和任务对话前确定模型与思考强度。Agent 内置创建工具的模型限制与编排需要不一致；网页需要支持创建前调整，同时保证调度安全与审计事实完整。

## 决定

- 将模型和思考强度表示为完整 `execution_profile`。对象配置必须整体为空（使用运行默认值），或同时包含两个字段。
- 每个运行只有一个全局默认值。交付单元和任务独立覆盖，互不继承。
- 正式创建通过 multi-task-flow CLI 领域命令调用 Codex app-server 控制面。CLI 负责能力校验、native request identity、实际创建和 dispatch resolve 证据。
- 取得 native request ID 后冻结对象配置；明确失败经过对账后可以修正配置并重新 claim。unknown 保留占用，禁止直接重试。
- 创建前修改配置必须终止旧的未提交 claim，记录旧配置和原因，并要求重新 claim。
- 对话创建后的内部模型或思考等级调整属于会话本身，不回写编排账本、不触发计划修订；编排不得主动重设已创建对话的配置。

## 备选方案

- 直接使用 Agent 内置工具：模型限制不符合编排需要，拒绝。
- 由交付单元提供任务默认值：会在平级对象之间引入隐式耦合，拒绝。
- 创建后主动调整配置：会修改已运行会话并导致创建证据失真，拒绝。

## 影响

账本与网页需要表达配置来源、编辑和冻结状态。旧运行必须显式迁移，缺少默认值时只读。CLI 成为正式创建边界，并须在重试前对账不确定结果；会话内部后续配置变化不属于本功能的追踪范围。
