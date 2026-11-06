# HTTP API

每个 endpoint 一个小节；保持短小但可实现、可测试。

## <端点名称>（<METHOD> <PATH>）

- 范围（Scope）: <external|internal>
- 变更（Change）: <New|Modify|Delete>
- 鉴权（Auth）: <none|api key|session|jwt|oauth|...>（+ 权限范围）

### 请求（Request）

- Headers: ...
- Query: ...
- Body: ...

### 响应（Response）

- Success: <schema>
- Error: <schema>

### 错误（Errors）

- <status/code>: <message>（可重试 retryable: <yes|no>）

### 示例（Examples）

- Request（请求）:
  - ...
- Response（响应）:
  - ...

### 兼容性与迁移（Compatibility / migration）

- ...
