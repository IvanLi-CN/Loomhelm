# 实现说明

父流程在 review wave lane state 中保存 `requested_profile`，由 `review-wave-open.ts` 写入并由 `review-record.ts` 和 `review-receipt-integrity.ts` 校验。Review receipt schema 7 保存请求 profile、`profile_verification`、空的 `effective_profile` 和可选 `reported_profile`。

`review-result.ts` 继续验证结构化内容、findings、行号和候选绑定；`reported_profile` 不参与结果 hash、clear 判定或 lane authorization。旧 CLI 的 `--review-model` 和 `--review-effort` 仅作为可选 reported 字段读取；`--review-attempt-id` 由父流程提供，用于 unavailable attempt 的独立身份和幂等重放，缺失时明确阻塞。

`review.ts` 使用通用 policy allowlist 校验可用请求 pair，并为本仓库的四个固定 lane 统一使用 `gpt-6-luna + max`。旧四项 ladder 和自动 fallback 已移除；runtime 拒绝保持 unavailable，不自动替换请求 pair。

验证覆盖 flow receipt、lane topology、完整 required lane、无 reviewer 自报结果、不同 reviewer 自报、malformed/stale/unavailable、schema 6/7 读取、仅对当前 wave/lane/base/head 有明确绑定的旧 active wave 退休、对损坏 schema 7 active wave 保持阻塞、同 pair 独立 retry attempt、历史 fresh-wave 恢复和既有 epoch repair budget 保留。Provider 内部实际 routing 不作测试承诺。

Schema 6 active wave 的恢复按保守条件执行：只有缺少 `requested_profile` 的旧 lane 形状，并且 receipt pointer 明确绑定当前 wave、lane、base 和 head 时，运行时才会退休旧 wave；malformed profile、stale/cross-wave receipt 或未绑定 receipt 保持阻塞。退休会保留既有 active epoch 与 repair budget，fresh schema 7 wave 不能重复启动仍在活动中的 lane。

正式请求 pair 在 record 和 receipt integrity 两条路径独立复核；即使同时篡改持久化 lane 的 `model`、`effort` 和 `requested_profile`，非 `gpt-6-luna + max` 也不能写入或验收 schema 7 receipt。Legacy recovery 在保留 epoch 的情况下对已存在的 wave ID 使用 fresh generation hash，避免覆盖 retired wave、重复 epoch 历史或复用 schema 6 receipt。

Schema 7 receipt 记录 `scope_class`，wave identity 纳入 scope，完整性校验同时绑定 scope 和 parent `attempt_key`；completed receipt 的 identity 重算包含 attempt，unavailable attempt 保持独立幂等。Legacy retirement 要求所有 lane 都没有 `requested_profile` 且各自状态合法，不能由单一 schema 6 receipt 放过混合 malformed wave。

新的 schema 7 completed/unavailable receipt 都必须由父流程提供非空 attempt ID，并写入跨 terminal state 共用的 `attempt_identity`；同一 attempt 不能从 unavailable 转成 completed，也不能用不同结果复用。Wave identity 对 lane specs 做稳定排序，因而落盘排序不会改变 identity；wave 持久化 required lane topology，并在 finalize、clear 和 receipt integrity 路径重新计算 wave identity，成对篡改 scope 或删除 required lane 都会阻塞。Legacy recovery 同时识别 flow ledger schema 7 搭配 schema 6 receipts 的历史形态，对 pending/null receipt pointer、schema 7 mixed pointer 和不完整 topology 采取 fail-closed，只有全量合法 schema 6 completed pointer 才能退休旧 wave。
