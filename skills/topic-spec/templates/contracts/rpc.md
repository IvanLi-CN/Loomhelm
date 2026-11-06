# RPC（含 gRPC）

用于 RPC/gRPC 风格的服务契约。如果仓库使用 `.proto`，请在此处链接并补充“行为口径 + 错误语义”摘要（不要只丢一个链接）。

## <Service>.<Method>

- 范围（Scope）: <external|internal>
- 变更（Change）: <New|Modify|Delete>
- 鉴权（Auth）: <none|...>（+ 权限范围）
- 超时（Timeout）: <...>
- 幂等性（Idempotency）: <idempotent|not idempotent>（key: <...> 如适用）

### 请求（Request）

- Schema: ...
- Validation: ...

### 响应（Response）

- Schema: ...

### 错误（Errors）

- <code>: <message>（可重试 retryable: <yes|no>）

### 示例（Examples）

- Request（请求）:
  - ...
- Response（响应）:
  - ...

### 兼容性与迁移（Compatibility / migration）

- ...
