# 客户端 Skills 实现说明

本主题覆盖完整 Skill 源包与脚本迁入；此前客户端的本地验证模块与简化任务图不满足该合同。源包存在、脚本可执行、Bun 源码运行时、旧运行兼容与受控原生闭环需要分别验证，不能将模块测试通过解释为整个迁移完成。

来源固定为 dot-codex `505961771a0d2496155d23132a8c0bd8beac0a24`。源码清单和迁移差异由项目拥有的资源清单保存；当前候选验收证据保存在工作流证据中，不写入本文件冒充长期实现事实。

## 模块边界

根 `skills/` 保存源 Skill、references、测试及模板，根 `skills/bin/` 保存共享执行模块；上游合同归档在 `skills/docs/vendor/dot-codex/`。`skills/source-manifest.json` 保存源提交、逐文件源摘要和安装摘要，`skills/catalog.json` 提供入口、脚本和条件性外部依赖。资源校验不执行专项外部操作，不将源包存在视为宿主能力可用。

生产仅使用 Bun 1.4.4 直接运行 TS。源码打包保留模块和完整资源路径，无服务端 JS 编译或导入后缀改写。计划 finalizer 从校验过的 TS 描述符读取私有快照，清理预加载和配置环境；POSIX 操作通过 Bun 内置 FFI 保留原子不覆盖重命名、目录描述符相对操作与原 flock 互斥，不构建 Node-API 模块。

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

vendor 源码安装只需保留 `skills/`。共享执行模块、合同资源、构建和检查支持分别位于 `skills/bin/`、`skills/docs/vendor/dot-codex/` 与 `skills/scripts/`；来源清单拒绝任何安装路径越出 `skills/`。隔离验证仅复制该目录并在其中安装声明依赖，验证原始 Skill 入口和生产脚本，不借用根 `bin/`、源码 checkout 或用户级全局程序。

原共享脚本回归、原 Multi-task Flow 与网页回归、原生安全回归、客户端双运行时测试及来源隔离测试分别运行。macOS 本地结果不能代替 Linux CI，模拟 socket 不能代替真实宿主接力，已有旧运行的测试副本不能授权写入真实账本。当前候选的精确提交、经验验收和正式审查证据由交付流程保管；没有完整证据时不宣称合并就绪。

## 上游缺陷与本项目适配

真实宿主验收发现，上游通知代码在新连接中直接调用 `turn/start`，已完成 bootstrap 的会话卸载后会返回 `thread not found`。本项目在发送前以原身份调用 `thread/resume`，不覆盖配置、不创建替代会话；恢复失败停止发送。接收回合在真实宿主上会因最后一个订阅连接关闭而中断，因此发送端取得真实接收回执后及时登记 sent，使收件会话可以确认通知，同时由宿主执行进程保持订阅直到该精确回合终止；接收前超时或身份不明时先对账，不重复派发。长回合发送应由宿主执行会话持有，接收回执仅代表接受输入，不代表任务完成。提供方程序保持不变。该适配的模拟回归与真实接力证据分开记录。

上游通知入口还存在发送先于持久记录的故障窗口：并发发送或 provider 接受后进程退出会保留 pending，重试可能重复发送。本项目在原锁下以既有 contract2 的 unknown 投递记录持久化请求身份，再发起外部调用；结果通过既有 reconciliation 命令落账。进程中断保持 unknown，重复调用必须先对账；明确未提交输入的连接或恢复失败记为 failed，不把它误判为未知。该适配不引入新账本格式，也不改写真实旧运行。

能力清单保留外部 Skill、专项 CLI 与原生宿主能力的适用条件。`skills check` 检查全部已声明场景；无宿主能力声明时保守报告未核实，不以源文件、socket 路径或资源存在冒充真实工具支持。Web 类型检查显式限制环境类型的自动引入，避免构建工具的 Bun 全局类型污染既有浏览器 fetch 合同。

通知发送还保留调用者的原始请求身份：持久化占用在账本锁内核对 expected_revision，同一 request_id 只重放该次尝试的不可变结果，明确失败后的新尝试必须使用新身份。缓存预检只读，被拒绝的过期请求不得规范化写回历史账本或恢复快照。在外部发送整个生命周期持有独立的通知文件锁，显式对账与发送互斥；进程退出后文件锁由操作系统释放，unknown 仍须先对账。此行为沿用 schema2/contract2，不新增状态格式。端口管理脚本直接由 Bun 执行 TS，Node 生产路径已退出支持。

资源筛选排除提供方 Python→TypeScript 历史迁移的映射、场景见证、基线采集和生成工具，以及该次迁移的专项历史文档；这些内容不属于客户端功能或其行为回归。共享 CLI 的实际命令路由和对应功能测试继续保留。来源清单显式记录排除范围，导入和校验拒绝重新带入，客户端打包重建自身生成目录以清除增量构建残留。

## 编排网页与合成示例

依赖图使用 MIT 许可的 React Flow 与 EPL-2.0 许可的 elkjs，保留现有投影、悬浮预览、详情与可访问节点列表。ELK 同时计算卡片位置与正交连线路径，按 edge container 转换坐标；默认横向，标题字号 15px，卡片按标题长度取 136–184px 宽度，状态更新复用结构布局。任务网格默认值按交付单元数量决定，并通过 URL 保留显式布局选择。

`skills/multi-task-flow/examples/single-delivery-unit/` 提供文档检索服务的独立合成快照。源码预览与静态预览共享该数据，合成输出通过内存适配器投影；正式服务配置拒绝该适配器。示例入口和命令见该目录 README。合成对话只显示 Mock 标识，不生成原生应用链接。控制器回归验证布局计算期间重复刷新、最新状态合并与过期结果丢弃。回归覆盖 `tests/ui/graph-controller.test.tsx`、`graph-layout.test.ts`、`view-state.test.ts`、`single-delivery-unit.test.ts`、`source-preview.test.ts`；执行 `bun run --cwd skills/multi-task-flow verify` 验证。

新增图布局模块、React 卡片渲染器、独立示例与回归文件同时登记在 `skills/support-manifest.json`，由来源校验脚本刷新安装摘要；维护者修改这些资源后需要同步来源摘要，再通过安装闭包检查。

viewer 使用显式 v2 源码资源清单，摘要覆盖 TS、依赖及浏览器资产；启动 shell 绑定 Bun。旧 v1 包保留校验及诊断，不作为新运行入口。安装检查分别报告源码、运行时和实际入口，不以文件存在证明运行就绪。既有账本与用户服务不自动升级。
