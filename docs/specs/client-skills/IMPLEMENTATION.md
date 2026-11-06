# 客户端 Skills 实现说明

本主题覆盖完整 Skill 源包与脚本迁入；此前客户端的本地验证模块与简化任务图不满足该合同。源包存在、脚本可执行、生产双运行时、旧运行兼容与受控原生闭环需要分别验证，不能将模块测试通过解释为整个迁移完成。

来源固定为 dot-codex `505961771a0d2496155d23132a8c0bd8beac0a24`。源码清单和迁移差异由项目拥有的资源清单保存；当前候选验收证据保存在工作流证据中，不写入本文件冒充长期实现事实。

## 模块边界

根 `skills/` 保存源 Skill、references、测试及模板，根 `bin/` 保存共享执行模块；上游合同归档在 `docs/vendor/dot-codex/`。`skills/source-manifest.json` 保存源提交、逐文件源摘要和安装摘要，`skills/catalog.json` 提供入口、脚本和条件性外部依赖。资源校验不执行专项外部操作，不将源包存在视为宿主能力可用。

生产构建保留模块目录，并将 TypeScript 入口转换为 Node 兼容 JavaScript，避免 bundle 改变相对资源路径。计划 finalizer 单独封装，继续通过校验过的入口描述符运行。POSIX 操作由最小 Node-API 层承接；生产 JavaScript 绑定原生模块摘要，经非跟随打开和描述符检查后加载，保留原子不覆盖重命名与原 flock 互斥。

`SkillsRuntime` 使用包内资源；CLI 的 `skills list/check/run` 和 `flow COMMAND --input -` 分别承担发现、能力/完整性报告、脚本执行及原任务流委托。socket 选择遵守显式参数/配置、Loomhelm 环境变量、Codex 环境变量及原默认路径的顺序。构建产物包含网页资源，不要求服务端或来源 checkout。

## 错误实现处置

| 原入口或模块 | 处置 | 状态保护 |
| - | - | - |
| `TaskGraph` / `TaskOrchestrator` | 移除实现和公共导出，使用原 Multi-task Flow | 保留已有 `orchestration.json`、`tasks.json` |
| 旧 `flow init` 数组及 schedule/start/finish/recover | 明确兼容错误，不静默转换 | 不读取后自动改写旧状态 |
| `LocalWorkflow` / `can-open-pr` / `workflow verify` | 改为 `LocalValidation`、`locally-validated` 和 local-verify，仅证明局部验证 | 不将局部收据解释为正式交付完成 |
| 核心 Ledger、进程与 Dispatch | 保留，承担独立任务事实、进程收据、Codex 子进程身份与未知结果对账 | 不改变既有状态格式、请求身份或目录 |
| 服务端、Go 客户端、Worker、Web App | 保持原工程边界 | 本迁移不代表 Connected mode 完成 |

## 验证边界

原共享脚本回归、原 Multi-task Flow 与网页回归、原生安全回归、客户端双运行时测试及来源隔离测试分别运行。macOS 本地结果不能代替 Linux CI，模拟 socket 不能代替真实宿主接力，已有旧运行的测试副本不能授权写入真实账本。当前候选的精确提交、经验验收和正式审查证据由交付流程保管；没有完整证据时不宣称合并就绪。

## 上游缺陷与本项目适配

真实宿主验收发现，上游通知代码在新连接中直接调用 `turn/start`，已完成 bootstrap 的会话卸载后会返回 `thread not found`。本项目在发送前以原身份调用 `thread/resume`，不覆盖配置、不创建替代会话；恢复失败停止发送。接收回合在真实宿主上会因最后一个订阅连接关闭而中断，因此发送端取得真实接收回执后及时登记 sent，使收件会话可以确认通知，同时由宿主执行进程保持订阅直到该精确回合终止；接收前超时或身份不明时先对账，不重复派发。长回合发送应由宿主执行会话持有，接收回执仅代表接受输入，不代表任务完成。提供方程序保持不变。该适配的模拟回归与真实接力证据分开记录。

上游通知入口还存在发送先于持久记录的故障窗口：并发发送或 provider 接受后进程退出会保留 pending，重试可能重复发送。本项目在原锁下以既有 contract2 的 unknown 投递记录持久化请求身份，再发起外部调用；结果通过既有 reconciliation 命令落账。进程中断保持 unknown，重复调用必须先对账；明确未提交输入的连接或恢复失败记为 failed，不把它误判为未知。该适配不引入新账本格式，也不改写真实旧运行。

能力清单保留外部 Skill、专项 CLI 与原生宿主能力的适用条件。`skills check` 检查全部已声明场景；无宿主能力声明时保守报告未核实，不以源文件、socket 路径或资源存在冒充真实工具支持。Web 类型检查显式限制环境类型的自动引入，避免构建工具的 Bun 全局类型污染既有浏览器 fetch 合同。

通知发送还保留调用者的原始请求身份：持久化占用在账本锁内核对 expected_revision，同一 request_id 只重放该次尝试的不可变结果，明确失败后的新尝试必须使用新身份。缓存预检只读，被拒绝的过期请求不得规范化写回历史账本或恢复快照。在外部发送整个生命周期持有独立的通知文件锁，显式对账与发送互斥；进程退出后文件锁由操作系统释放，unknown 仍须先对账。此行为沿用 schema2/contract2，不新增状态格式。端口管理脚本通过构建产物支持 Node.js 与 Bun；源文件示例中的 Bun 不构成生产硬依赖。
