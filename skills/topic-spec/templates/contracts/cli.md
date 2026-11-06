# 命令行（CLI）

每个命令一个小节；保持短小但可实现、可测试。

## <命令>

- 范围（Scope）: <external|internal>
- 变更（Change）: <New|Modify|Delete>

### 用法（Usage）

```text
<command> [options] <args>
```

### 参数（Args / options）

- `--flag`: <说明>（default: <...>）
- `<arg>`: <说明>

### 输出（Output）

- Format: <human|json>
- Schema（if json）: ...

### 退出码（Exit codes）

- `0`: 成功
- `<n>`: <含义>

### 兼容性与迁移（Compatibility / migration）

- ...
