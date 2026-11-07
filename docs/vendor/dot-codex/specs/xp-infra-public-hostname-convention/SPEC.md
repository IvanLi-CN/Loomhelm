# XP Infra 公网 hostname 规范

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，主题局部演进见 `./HISTORY.md`，决策取舍见关联 ADR。

## 背景 / 问题陈述

公网节点的 API hostname 可能与同一节点的 endpoint hostname 使用不同的节点标识，造成控制面身份漂移。`xp-infra` 需要把标准公网节点的两个 hostname 作为可验证的持久合同，而不是把任意已配置 hostname 视为合规。

## 目标 / 非目标

### Goals

- 为标准公网节点固定两种 hostname 形式。
- 让只读审计以节点运行时的 `XP_NODE_NAME` 验证 API 与 endpoint hostname。
- 让冲突和存量 drift 显式失败，而不是生成后缀或自动迁移。

### Non-goals

- 不修改线上节点、DNS、Cloudflare Tunnel 或 Raft 元数据。
- 不为 owner-approved private Docker exception 强加公网 hostname。
- 不改变 `xp` 应用的部署实现。

## 范围（Scope）

### In scope

- `xp-infra` policy、runbook、审计脚本和 fixture 的公网 hostname 合同。
- 标准公网节点 hostname drift 的只读检测。

### Out of scope

- 存量 drift 的实际迁移与别名清理。
- 私有 Docker exception 的公网入口配置。

## Related ADRs

- [XP Infra 公网 hostname 采用成对严格命名](../../adr/0002-xp-infra-public-hostname-convention.md)

## 需求（Requirements）

### MUST

- 标准公网节点的 API / Cloudflare Tunnel hostname 必须为 `<node>-xp.707979.xyz`。
- 标准公网节点的 managed endpoint ingress hostname 必须为 `<node>-ep.707979.xyz`。
- `<node>` 必须等于运行时 `XP_NODE_NAME`，且为未经改写、最多 60 个字符的小写 DNS label。
- host-managed 审计必须从运行中 `xp` 进程的环境读取三项 hostname 输入，并在收集前后确认该进程 PID 与启动时间未变化。
- DNS 或 Tunnel ownership 冲突必须交给操作员处理；不得生成后缀或覆写记录。
- `xp-infra audit` 必须对非私有例外节点比较 `XP_NODE_NAME`、API host 和 access host，并在任一不匹配时失败。
- owner-approved private Docker exception 必须跳过该公网 hostname 检查。
- 审计不得自动修复任何 hostname drift。

### SHOULD

- inventory 应将已知公网 hostname drift 标明为待单独授权迁移的运维事实。

### COULD

- 后续可在已授权的迁移任务中加入 DNS/Tunnel inventory 级别的别名清理验证。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

1. `xp-infra policy check` 验证唯一公共 Zone。
2. `xp-infra audit <alias>` 收集 `XP_NODE_NAME`、`XP_API_BASE_URL` 和 `XP_ACCESS_HOST`。
3. 标准公网节点只有在两种 hostname 都由相同 `<node>` 推导时通过 `public_hostname_convention` 检查。

### Edge cases / errors

- 无效、非小写或超过 60 个字符的节点名，以及 API 或 access hostname 必须使审计失败。
- 私有 Docker exception 输出明确的 skip，不能被误报为通过公网合同。
- 配置冲突、缺失值或存量非 canonical hostname 必须失败并等待操作员处理。
- host-managed 配置文件与运行中 `xp` 进程环境不一致时，审计必须以运行时环境为准；审计期间进程或三项 hostname 输入漂移必须失败。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口 | 类型 | 范围 | 变更 | 契约文档 | 负责人 | 使用方 | 备注 |
| - | - | - | - | - | - | - | - |
| `xp-infra audit` | CLI output | internal | Modify | None | xp-infra | operators | 新增 `public_hostname_convention` 结果 |
| `public_hostname` policy | YAML | internal | New | None | xp-infra | audit | 固定公共 Zone |

## 验收标准（Acceptance Criteria）

- Given 标准公网节点的 API 与 access hostname 由相同节点名推导，When 运行 audit，Then 输出 `PASS public_hostname_convention`。
- Given API 或 access hostname 含有额外后缀，When 运行 audit，Then 输出 `FAIL public_hostname_convention` 并返回失败。
- Given owner-approved private Docker exception，When 运行 audit，Then 仅跳过公网 hostname 检查。

## 验收清单

- [x] 两种 hostname 的长期形式已定义。
- [x] drift 和私有例外的边界已定义。
- [x] CLI 与 policy 合同已列出。
- [x] 验收条件可由 fixture 测试覆盖。

## 非功能性验收 / 质量门槛

### Testing

- `bash skills/xp-infra/tests/test-xp-infra.sh`

### Quality checks

- `skills/xp-infra/scripts/xp-infra policy check`
- `git diff --check`

## Visual Evidence

None

## Related PRs

- None

## 风险 / 开放问题 / 假设

- 假设：标准公网节点的 `XP_NODE_NAME` 是稳定、受管理的节点身份。
- 风险：现网 legacy hostname 的实际迁移需要单独授权，不能由 audit 自动执行。

## 参考

- [agent-toolkit `xp-infra` Skill](https://github.com/IvanLi-CN/agent-toolkit/tree/main/skills/xp-infra)
- [agent-toolkit deployment policy template](https://github.com/IvanLi-CN/agent-toolkit/blob/main/skills/xp-infra/references/deployment-policy.yaml.example)
- [agent-toolkit `xp-infra` runbook](https://github.com/IvanLi-CN/agent-toolkit/blob/main/skills/xp-infra/references/runbook.md)
