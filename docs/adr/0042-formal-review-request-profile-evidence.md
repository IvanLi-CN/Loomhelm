# ADR 0042：Formal review 请求 profile 与结果证据分离

## Status

Accepted。

## Context

Review result 不能可靠证明 provider 最终使用的 model/effort。现有 receipt 把 reviewer 自报 pair 当作 lane profile integrity，且旧 fallback ladder 与当前 direct-review policy 不一致。

## Decision

父流程保存并传递 requested profile，review receipt 只记录该请求事实和候选内容证据。`effective_profile` 保持未知；reviewer 自报 profile 只能作为可选审计字段。所有 required lane 仍必须产生完整 terminal result，任何缺失、malformed、stale 或 unavailable 结果都阻塞 clear。Runtime 拒绝不触发自动 fallback 或跨模型替换。

本仓库 formal runtime review 请求 `gpt-6-luna + max`；通用 direct-review policy 的六项 allowlist 仍用于请求策略选择。该边界不声称 provider 内部 routing，也不建设 provider attestation。

## Consequences

审计记录能够准确回答“父流程请求了什么”和“review 结果是否完整有效”，不会错误声称实际 provider 模型。需要实际模型身份证明的场景必须在未来增加独立平台能力，不由当前 review receipt 推断。

Schema 7 新增请求与结果证据分离字段；schema 6 历史记录保持只读兼容，新候选不能使用旧自报字段满足 clear。

每次 schema 7 review attempt 还必须携带父流程提供的非空 attempt ID；该 ID 只用于区分和幂等回放，不代表 provider 身份。
