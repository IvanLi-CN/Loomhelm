# Multi-task Flow CLI 人类体验审计与设计

## 范围与状态

本文记录源码审计发现及主人已确认的 CLI 体验设计，供后续实现与审核使用；具体源码实现映射见既有主题 IMPLEMENTATION；不表示已经发布，不授权安装升级、正式运行变更或远端操作。公开命令名为 `multi-task-flow`。

## 审计发现

| 问题 | 仓库证据 | 用户影响 |
| - | - | - |
| 标准帮助入口不一致 | `clients/typescript/src/cli.ts` 仅处理 `help` 或无命令；`cli/service.ts` 仅处理 `help` 或无参数 | 顶层 `--help` 和 `service --help` 实测返回错误 |
| 命令帮助直接展示 Schema | `clients/typescript/src/cli/flow-contract.ts` 的 `flowHelp`；实测 `flow show --help` | 缺少简明用途、请求示例及恢复指引 |
| 默认输出面向协议 | 顶层入口和 runtime 多处直接 `JSON.stringify`，未建立统一输出选择层 | 人类需要从完整对象中寻找状态和阻塞原因 |
| 常用查询需要协议输入 | `clients/typescript/src/cli/flow.ts` 和 `cli/service.ts` 要求 `COMMAND --input -` | 人类必须编写 stdin JSON 才能查询 |
| 错误形状与通道不统一 | 顶层 catch 向 stderr 输出 `{code,error}`；`scripts/orchestrate.ts` 向 stdout 输出 `{ok,code,revision,message,details}` | 难以统一理解和解析错误 |
| 输出责任分散 | 顶层、flow、service、upgrade 各自写 stdout/stderr | 全局风格容易漏掉部分命令或失败路径 |

以上基于当前工作区源码和无副作用的帮助调用，不代表已验证用户全局安装包。现有 `flow schema --format json` 是有价值的机器接口，应保留。

## 已确认设计

### 输出选择

提供全局 `--output auto|human|json`，环境变量为 `MULTI_TASK_FLOW_OUTPUT`。显式参数优先于环境变量，均未指定时采用 `auto`；显式选择 `auto` 时不再采用环境变量指定的固定风格。

```text
resolveOutput(argv, env, stdout)
  selected = argv.output ?? env.MULTI_TASK_FLOW_OUTPUT ?? auto
  if selected != auto
    return selected
  if declaredAgentCall or CI or !stdout.isTTY
    return json
  return human
```

自动检测只提供启发式默认值，不能作为身份认证或权限判断。具体 CI 与 Agent 环境信号应在实现中采用可测试的明确集合，不扫描父进程或猜测程序名称；项目维护的 Agent 调用必须显式传递 `--output json`。stdin 是否为 TTY 不参与受众判断，因为人类也会通过管道提交请求。Agent 与其他机器调用共用完整 JSON，不增加可能丢失字段的专用 Agent 文本格式。

### 全局参数解析

`--output` 可放在子命令前后；重复指定或非法取值在副作用发生前报错。`--` 是透传边界，其后的同名参数不得由全局解析器消费。参数解析应覆盖帮助、版本、普通命令及失败路径，同时尊重现有透传子命令的参数所有权。

```text
multi-task-flow --output human flow show --input -
multi-task-flow flow show --output human --input -
```

### 人类展示与帮助

人类模式默认展示业务状态、关键身份、revision、阻塞原因及安全的下一步；`--verbose` 展示更多细节，完整原始字段通过 JSON 获取。摘要必须区分业务结果、输出交付和调用静止，不把 `unknown` 当作失败，不把成功退出等同于运行已静止，不隐藏影响下一步判断的未确认事实。

所有公开命令层级支持一致的 `--help`，按用途分组，提供必填参数、复制即用示例和常见恢复说明；专用 Schema 入口继续输出机器 Schema。`--color auto|always|never` 独立控制颜色并支持 `NO_COLOR`；非终端的人类输出默认保持普通文本。颜色冲突规则、具体摘要字段和长字段布局作为实现细节保持确定性并补充测试。

人类错误写入 stderr，展示错误码、原因及安全的下一步。JSON 模式保留各现有命令的字段、输出通道和退出码，本轮不借展示重构迁移旧错误合同。对新增参数错误应定义稳定的机器错误表现；后续统一旧错误合同需独立兼容性评估。

### 常用查询输入

常用只读查询同时提供普通命令行参数，复杂写操作先保留现有 JSON envelope。新增参数只负责构造同一个底层请求，继续执行相同的版本、actor、owner 和权限校验；不得因为面向人类而隐式冒充 main actor。

以下为目标形状示例，实际必填身份参数以现有权限合同为准，不能把示例当作绕过 actor 的最终语法：

```text
multi-task-flow --output human service status
multi-task-flow flow show --run-id demo --section summary
multi-task-flow --output json flow show --input -
```

## 实现建议与兼容边界

在公开 CLI 边界统一解析输出设置，以共享展示模块格式化各命令结果；runtime 继续提供结构化业务结果，避免业务处理器依赖终端风格。命令语义、批准、幂等、revision、重试和停止证明均不随输出模式变化。

优先完成统一输出选择与帮助，再增加常用只读参数。维护 Skill 中的 Agent 调用示例时显式加入 JSON 风格，同时保持 exact-version 约束；不能将帮助示例简化为未锁定版本的正式 Agent 调用。

Flow 已有流式转发、背压、输出失败和独立停止通道合同，详见 [编排输出与调用停止对账](../specs/multi-task-flow-unified-atomic-orchestration/OUTPUT_AND_INVOCATION.md)。展示层不得无限缓存完整响应，不得截断 JSON 后宣称成功，不得在已输出部分结果后追加另一份成功或错误 JSON，也不能因展示失败重新执行业务。人类渲染应使用有界解析和有界展示状态，保留原有停止路径。

## 后续验收要求

- 覆盖输出参数、环境变量、自动模式的优先级；包含 TTY、非 TTY、CI、Agent 声明以及人类管道输入场景。
- 覆盖全局参数前后位置、重复值、非法值及 `--` 透传，确保错误发生在业务副作用之前。
- 顶层及公开子命令帮助可发现、可读，专用 Schema 仍可被机器解析。
- JSON 模式回归现有字段、输出通道和退出码；项目维护的 Agent 调用显式选择 JSON。
- 人类摘要覆盖成功、阻塞、unknown、revision 冲突及调用未静止，不建议盲目重试。
- 普通查询参数与 JSON 输入经过相同授权与版本校验，拒绝身份缺失、冲突和歧义输入。
- 覆盖颜色关闭、非终端文本、长字段、大响应、慢消费者与 EPIPE，验证有界内存、背压及停止语义。

本文为体验设计与审计记录，不代替既有 CLI、Schema 和 invocation 合同；实现时同步相应工程合同和实现覆盖记录，不把尚未实现的行为描述为已可用。
