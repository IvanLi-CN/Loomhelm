# 演进历史

## Current

将 review profile 从 reviewer 自报和 fallback resolution 改为父流程 requested profile；将实际 effective profile 保持为未知；将内容 evidence 与 profile request 分开记录。

## Compatibility

Schema 6 记录保持只读兼容。旧记录中的 `review_model`、`review_effort`、`resolved_model`、`resolved_effort` 和 `profile_proof_status` 继续用于历史解释，但不参与新候选的 profile authorization 或 clear 判定。

Schema 7 的 unavailable attempt 使用父流程 `review-attempt-id` 作为幂等 identity；相同 id 的结果回放复用原记录，不同 id 的相同 requested pair 保留独立失败记录。旧 active wave 只可被运行时退休并由 fresh wave 恢复，历史 receipt 不重写。

后续兼容收紧要求旧 active wave 的 lane 形状、receipt pointer 与当前 wave/lane/base/head 全部可核验；malformed profile 或跨 wave receipt 不会被自动修复，退休时保留 active epoch 与 repair budget。

Repair Batch 补充了父流程 formal pair 的 record/integrity 双重校验，以及同候选 legacy recovery 的 fresh wave identity；旧 receipt 和 retired wave 保持历史只读，不会被 fresh wave 覆盖或复用。

后续完整性收紧补充 scope 与 attempt identity 绑定，并拒绝带有任一 malformed lane profile 的 mixed legacy wave；单一合法 schema 6 receipt 不再足以退休损坏的 active wave。

当前实现进一步要求 completed receipt 也必须有父流程 attempt ID，绑定并重算 required lane topology 与 wave scope identity，并通过 CLI replay、缺失 lane、成对 scope 篡改和 mixed schema 7 恢复测试固定失败边界。
