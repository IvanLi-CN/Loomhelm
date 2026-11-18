# Formal review 请求参数与结果证据

## Context and Scope

本主题定义 Formal review 的请求参数、native 工具启动事实、结构化结果证据和 schema 6/7 历史兼容边界。它只覆盖父流程与 review receipt 的证据合同，不建设 provider 身份证明、签名 receipt、实际模型识别、业务 UI、部署或发布能力。

## Terms and Interfaces

`requested_profile` 是父流程锁定并传给 native review 工具的 model/effort pair；`reported_profile` 是可选的 reviewer 自报附注；`effective_profile` 保持未知。Review receipt 必须绑定当前候选的 repo、base、head、scope、lane、terminal、clean、findings、locations、摘要和结果完整性。

## Requirements

### REQ-FRPE-001：父流程拥有请求参数

父流程 MUST 为每个 required lane 选择并保存 `requested_profile`，并把相同的 model/effort 原样传给 native review 工具；record 和 receipt integrity 路径 MUST 再次将持久化 lane profile 与本仓库 formal request pair 比较，不能只信任可变 lane state；缺失或替换锁定 pair MUST 被拒绝；工具拒绝启动 MUST 作为 parent-observed unavailable attempt 记录。

### REQ-FRPE-002：仓库 Formal review 请求固定

本仓库正式 runtime review MUST 请求 `gpt-6-luna + max`；通用 direct-review policy MUST 保留六项 allowlist、lane topology、复杂度选择、完整 owner override 和精确转发规则；不得以 provider capability 探测、自动 fallback 或跨模型替换改变请求。

### REQ-FRPE-003：结果不证明实际模型

Review 结果 MUST NOT 授权、否决或覆盖父流程的 requested profile；每个新的 completed 或 unavailable receipt MUST 写入 schema 7、`profile_verification=request_recorded`、`effective_profile=null`、`scope_class` 和可选 `reported_profile`，并要求非空的父流程 `review-attempt-id` 纳入 receipt identity。Receipt integrity MUST 同时重新校验 scope、attempt identity 和 wave/lane topology；Reviewer self-report MUST NOT 被解释为 provider 的 effective model 证明。

### REQ-FRPE-004：内容和完整性门禁保持有效

所有 required lane MUST 产生绑定当前候选的合法 terminal result；持久化 wave 的 required lane topology 不得被删除或缩减；缺失、malformed、stale、unavailable、base/head/scope 不匹配、dirty、错误 findings/locations、摘要或 CI/validation 证据 MUST 阻塞 clear；不得使用 quorum、多数通过或遗漏 required lane。

### REQ-FRPE-005：历史 schema 兼容不升级事实

Schema 6 receipt MUST 保持原始字段并可读取和展示；旧的 self-reported profile MUST NOT 转换为 schema 7 的启动事实，也 MUST NOT 满足新候选 clear gate。新候选 MUST 通过 fresh review wave 恢复，旧 active wave 只有在所有 lane 都仍是旧形状、required lane topology 完整、每个 lane 都有明确绑定当前 wave、lane、base 和 head 的 completed schema 6 receipt 且没有 pending/null pointer 或 schema 7 mixed pointer 时才可由运行时标记 retired；即使另一个 lane 有合法 schema 6 receipt，混合 malformed lane、跨 wave receipt 或未绑定 receipt MUST 继续阻塞。退休过程 MUST 保留既有 active epoch 和 repair budget，并为同一候选重新打开的 fresh wave 分配不重复的 wave identity，确保历史 wave 和 schema 6 receipt 不被覆盖或复用。失败重试 MUST 使用同一 requested pair 和父流程 `review-attempt-id`，保留独立 attempt，且不得重复启动活动 lane。

## Verification

### VER-FRPE-001

- covers: `REQ-FRPE-001`, `REQ-FRPE-002`
- Method: policy 单测、native 参数映射 mock、CLI 回放和固定 lane 负例。
- Pass condition: 六项通用策略和完整 owner override 正确转发；正式 lane 请求固定 pair；省略、替换、旧 ladder 或 fallback 均被拒绝或如实记录。

### VER-FRPE-002

- covers: `REQ-FRPE-003`, `REQ-FRPE-004`
- Method: review record、receipt integrity、wave finalize 和 required-lane 失败路径测试。
- Pass condition: 无 self-report 的完整结果可验收；不同 self-report 不改变 clear；缺失 attempt、malformed 结果、任一未完成或被删除的 required lane、候选绑定错误和不完整内容均阻塞。

### VER-FRPE-003

- covers: `REQ-FRPE-005`
- Method: schema 6/7 fixture、历史读取、fresh-wave 恢复和 unavailable retry 测试。
- Pass condition: schema 6 receipt 原样可读但不能 clear；schema 7 写读完整；同一 pair 使用不同 attempt id 重试形成独立 attempt、相同 id 回放幂等，活动或 pending lane 不重复启动，混合 schema 7/未绑定 pointer 的旧 active wave 不退休，合法旧 wave 可受控退休且历史候选不被重写。

## Related ADRs

- [Formal review 请求 profile 与结果证据边界](../../adr/0042-formal-review-request-profile-evidence.md)

## References

- [实现说明](IMPLEMENTATION.md)
- [合同历史](HISTORY.md)
- [共享 review proof 合同](../../../skills/project-engineering-workflow/references/review-proof-short-contract.md)
