# 演进历史

## Current

取消 reviewer profile claim 和 fallback resolution，改为由父流程保存 requested profile；将实际 effective profile 保持为未知；将内容 evidence 与 profile request 分开记录，并以父流程 attempt ID 区分失败重试。

## Compatibility

Schema 6 记录保持只读兼容。旧记录中的 `review_model`、`review_effort`、`resolved_model`、`resolved_effort` 和 `profile_proof_status` 继续用于历史解释，但不参与新候选的 profile authorization 或 clear 判定。
