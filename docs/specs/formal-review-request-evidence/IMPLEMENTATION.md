# 实现说明

父流程在 review wave lane state 中保存 `requested_profile`，由 `review-wave-open.ts` 写入并由 `review-record.ts` 和 `review-receipt-integrity.ts` 校验。Review receipt schema 7 只保存请求 profile、`profile_verification`、空的 `effective_profile` 和候选内容证据。

`review-result.ts` 继续验证结构化内容、findings、行号和候选绑定；review result 不携带模型身份字段。父流程必须为每次 attempt 提供非空 `--review-attempt-id`，该 ID 纳入 receipt identity。

工具拒绝启动时，schema 7 attempt 使用 parent request 和 startup observation 记录 unavailable；它没有 subagent result，且不能满足 required lane 的 clear 条件。

保留的历史 review-wave adapter `review.ts` 使用通用 policy allowlist 校验可用请求 pair，并为旧四个固定 lane 统一使用 `gpt-6-luna + max`。旧四项 ladder 和自动 fallback 已移除；runtime 拒绝保持 unavailable，不自动替换请求 pair。

验证覆盖 flow receipt、lane topology、完整 required lane、无 profile claim 的结果、malformed/stale/unavailable、schema 6/7 读取和历史 fresh-wave 恢复。Provider 内部实际 routing 不作测试承诺。

当前直接交付通过共享 review-proof 合同启动综合和专项 reviewer，每轮使用全新 `fork_turns=none` 实例，并保持本仓库 `gpt-6-luna + max` 请求策略。历史 adapter 不调度或门禁当前 review，其旧 topology 不约束新合同。
