# 实现说明

父流程在 review wave lane state 中保存 `requested_profile`，由 `review-wave-open.ts` 写入并由 `review-record.ts` 和 `review-receipt-integrity.ts` 校验。Review receipt schema 7 保存请求 profile、`profile_verification`、空的 `effective_profile` 和可选 `reported_profile`。

`review-result.ts` 继续验证结构化内容、findings、行号和候选绑定；`reported_profile` 不参与结果 hash、clear 判定或 lane authorization。旧 CLI 的 `--review-model` 和 `--review-effort` 仅作为可选 reported 字段读取；`--review-attempt-id` 由父流程提供，用于 unavailable attempt 的独立身份和幂等重放，缺失时明确阻塞。

`review.ts` 使用通用 policy allowlist 校验可用请求 pair，并为本仓库的四个固定 lane 统一使用 `gpt-6-luna + max`。旧四项 ladder 和自动 fallback 已移除；runtime 拒绝保持 unavailable，不自动替换请求 pair。

验证覆盖 flow receipt、lane topology、完整 required lane、无 reviewer 自报结果、不同 reviewer 自报、malformed/stale/unavailable、schema 6/7 读取、仅对可正向识别的旧 active wave 退休、对损坏 schema 7 active wave 保持阻塞、同 pair 独立 retry attempt 和历史 fresh-wave 恢复。Provider 内部实际 routing 不作测试承诺。
