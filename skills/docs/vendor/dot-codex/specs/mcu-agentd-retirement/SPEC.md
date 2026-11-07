# mcu-agentd 集成清退

## Context and Scope

`mcu-agentd` 已停止使用。本主题约束我们维护的 Skill 与配置如何撤除旧能力，避免它继续被发现、推荐或作为操作前提。

- In scope: dot-codex 的私有硬件操作 Skill、相关发现索引与源配置；agent-toolkit 的公共项目接入 Skill 与公共索引；style-playbook 中仍会推荐旧方案的现行知识及其发现数据。
- Out of scope: 各消费项目的工具选择、调查与迁移；`mcu-agentd` 工具仓库本身的归档或删除；机器上的 daemon、二进制、状态、日志、设备操作与部署清理。

## Terms and Interfaces

- Skill 清退与现行推荐使用[项目词汇表](../../../GLOSSARY.md)中的定义。
- 旧集成包括 `mcu-agentd-hardware-ops`、`mcu-agentd-project-integration` 及其对 `mcu-managerd` 的配套接入要求。
- 历史事实可以解释过去的实施或项目快照，但不能通过当前推荐、索引或操作规则重新使旧方案成为现行能力。
- 本主题不定义新的硬件工具接口或迁移接口。

## Requirements

### REQ-MCURETIRE-001

dot-codex 与 agent-toolkit 必须移除上述两个旧 Skill 及其发现元数据；相关私有索引、公共成员清单、Git 跟踪白名单和现行边界文档必须与移除后的 Skill 集合一致。受维护的能力发现入口不得继续提供旧 Skill。

### REQ-MCURETIRE-002

我们维护的现行内容必须撤除对 `mcu-agentd`／`mcu-managerd` 的推荐、接入步骤、安装或启动要求、操作路由及工具使用限制；style-playbook 的现行主题、参考实现与发现数据同样适用。不得用兼容壳、重定向 Skill 或常驻的禁用提示继续保留旧入口。

### REQ-MCURETIRE-003

清退不得引入新的通用替代工具或规定各消费项目后续使用什么；不得把调查、迁移、验证各项目工具链作为本主题的完成条件。各项目自己选择和维护工具。

### REQ-MCURETIRE-004

dot-codex 源配置必须撤除旧 `mcu-agentd` 项目的专属 trusted 登记。源头变更与已安装环境是否生效必须分别报告；只删除消费端链接不得被认定为源头清退完成，源头变更也不得被表述为已完成运行环境部署。

### REQ-MCURETIRE-005

必要的历史事实、Git 历史和本退役主题文档可以保留旧名称；这些内容不得继续表达现行推荐或要求旧 Skill 存在。现行规范中引用旧 Skill 的要求必须撤除；清退不得删除仍服务于其他主题的通用内容。

### REQ-MCURETIRE-006

清退验收必须同时覆盖源头能力集合、现行推荐与消费端发现状态，并明确各自已经验证的范围。验收不得启动旧 daemon、执行旧工具操作、接触真实设备，或以检查各消费项目来扩大范围。

## Verification

### VER-MCURETIRE-001

- Method: 核对两个源仓库的 Skill 目录、发现元数据、私有索引、公共成员清单、Git 白名单、现行边界文档与配置；使用各仓库已有的索引及边界检查。
- covers: `REQ-MCURETIRE-001`, `REQ-MCURETIRE-004`
- Pass condition: 旧 Skill 不再属于受维护的能力集合，关联索引与配置没有陈旧条目；源头结果与安装生效结果清楚分开。

### VER-MCURETIRE-002

- Method: 对授权源头与现行发现入口搜索旧工具名、两个 Skill 名、环境变量及显示名变体，并逐项判定命中用途；同时核对 style-playbook 的主题、项目参考、结构化数据和路由。
- covers: `REQ-MCURETIRE-002`, `REQ-MCURETIRE-005`
- Pass condition: 没有仍能形成现行推荐、接入或操作规则的命中；保留项仅为必要历史事实、退役文档或不产生推荐的离线验收内容；其他通用能力保持完整。不得通过排除整个文档或知识库目录掩盖现行引用。

### VER-MCURETIRE-003

- Method: 检查变更范围及验收记录。
- covers: `REQ-MCURETIRE-003`, `REQ-MCURETIRE-006`
- Pass condition: 没有新增替代工具、项目工具选择政策、项目迁移或机器部署清理；验证仅覆盖获准的维护面，并准确区分源头与安装状态。

## Related ADRs

None

## References

- [实现覆盖与源头清单](./IMPLEMENTATION.md)
- [主题边界与决策来源](./HISTORY.md)
