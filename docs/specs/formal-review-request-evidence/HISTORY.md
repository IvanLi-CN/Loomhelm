# 演进历史

## Current

将 review profile 从 reviewer 自报和 fallback resolution 改为父流程 requested profile；将实际 effective profile 保持为未知；将内容 evidence 与 profile request 分开记录。

## Compatibility

Schema 6 记录保持只读兼容。旧记录中的 `review_model`、`review_effort`、`resolved_model`、`resolved_effort` 和 `profile_proof_status` 继续用于历史解释，但不参与新候选的 profile authorization 或 clear 判定。

Schema 7 的 unavailable attempt 使用父流程 `review-attempt-id` 作为幂等 identity；相同 id 的结果回放复用原记录，不同 id 的相同 requested pair 保留独立失败记录。旧 active wave 只可被运行时退休并由 fresh wave 恢复，历史 receipt 不重写。

后续兼容收紧要求旧 active wave 的 lane 形状、receipt pointer 与当前 wave/lane/base/head 全部可核验；malformed profile 或跨 wave receipt 不会被自动修复，退休时保留 active epoch 与 repair budget。
