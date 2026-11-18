# 主题设计规格

`docs/specs/<topic>/` 按长期主题组织需求、系统设计和接口契约。`SPEC.md` 定义需求与验收，配套设计文档说明角色交互、数据模型、状态机及 CLI/API 契约；`IMPLEMENTATION.md` 单独记录实现映射、验证覆盖与已知偏差，`HISTORY.md` 记录演进与兼容历史。术语见 [术语表](../GLOSSARY.md)，架构决策位于 `docs/adr/`。Skill 是 Agent 执行指引，可以引用项目设计或携带校验过的契约副本，不替代项目设计文档。

| Topic | Lifecycle | Implementation | Spec | Successor |
| - | - | - | - | - |
| Loomhelm 完整工程 | active | 现有服务端、Go 客户端、Web App 与工程交付；完整产品验收以实现说明为准 | [phase1-core](phase1-core/SPEC.md) | - |
| TypeScript 客户端独立核心 | active | 独立 TypeScript 实现，与 Go 客户端并存；Local mode 核心已实现，Connected mode 未实现 | [client-core](client-core/SPEC.md) | - |
| 客户端 Skills 与工程执行支持 | active | 以完整源包、双运行时和旧运行兼容合同约束迁移，不以旧局部模块代替验收 | [client-skills](client-skills/SPEC.md) | - |
| Multi-task Flow Agent 空闲与对话归档 | proposed | 记录 Codex 对话空闲观察、子任务终态归档和归档异常恢复合同 | [multi-task-flow-agent-idle-archive](multi-task-flow-agent-idle-archive/SPEC.md) | - |
| 统一手动版本发布 | active | 统一发版实现及故障验证已接入，平台对齐与真实首发仍需对应证据 | [manual-version-release-delivery](manual-version-release-delivery/SPEC.md) | - |
| 任务流上下文菜单与任务直达链接 | active | 已实现并通过局部验证；视觉证据已确认 | [multi-task-flow-task-links](multi-task-flow-task-links/SPEC.md) | - |
| 统一原子编排 | active | 需求、角色交互、数据模型、状态机与 CLI 契约已分层；实现偏差与验证缺口见主题实现说明 | [multi-task-flow-unified-atomic-orchestration](multi-task-flow-unified-atomic-orchestration/SPEC.md) | - |
| Formal review 请求参数与结果证据 | active | 父流程请求 profile，review 结果只证明候选内容和绑定关系；provider 实际路由保持未知 | [formal-review-request-evidence](formal-review-request-evidence/SPEC.md) | - |

## 文件命名

`docs/specs/<topic>/` 的主题目录使用稳定的小写 kebab-case；主题固定入口 `SPEC.md`、`IMPLEMENTATION.md`、`HISTORY.md`、`README.md`、`DECISIONS.md`、`AGENTS.md` 和其他单一全大写词的固定文件名保持原名。项目自有规格层中由多个全大写词组成的补充文档使用下划线连接，例如 `CLI_CONTRACT.md`、`DATA_MODEL.md`、`STATE_MACHINES.md` 和 `CLIENT_CODEX_DAEMON.md`；普通描述性文档继续使用小写 kebab-case。

本规则适用于当前基线中的项目自有 `docs/specs/**` 文档和随 Skill 分发的 `skills/docs/vendor/**` 规格快照；vendored 内容也必须同步其内部引用和资源清单。未合并分支中的文件不属于当前基线，只有进入主线后才按本规则处理。

## Multi-task Flow 设计入口

- [长期需求与验收](multi-task-flow-unified-atomic-orchestration/SPEC.md)
- [Agent 角色与交互设计](multi-task-flow-unified-atomic-orchestration/AGENT_INTERACTIONS.md)
- [数据模型](multi-task-flow-unified-atomic-orchestration/DATA_MODEL.md)
- [状态机与恢复](multi-task-flow-unified-atomic-orchestration/STATE_MACHINES.md)
- [CLI 命令契约](multi-task-flow-unified-atomic-orchestration/CLI_CONTRACT.md)
- [编排输出、纯查询与调用停止对账](multi-task-flow-unified-atomic-orchestration/OUTPUT_AND_INVOCATION.md)
- [实现、测试覆盖与已知偏差](multi-task-flow-unified-atomic-orchestration/IMPLEMENTATION.md)
