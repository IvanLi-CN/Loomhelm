# 开发预览

本页记录 Loomhelm 各模块的源码预览入口。Agent 的主动交付时机、宿主后台托管、端口与浏览器交付流程统一见[项目开发预览 Skill](../.agents/skills/development-preview/SKILL.md)。预览页面展示目标行为，构建与测试结果承担各自的验证责任。

## 入口选择

| 开发对象或验证目的 | 入口与场景 |
| - | - |
| multi-task-flow 页面 | 在当前工作树的 `skills/multi-task-flow-runtime/` 运行下节源码预览；使用示例编排展示交互 |
| Loomhelm 产品整页 | 仓库根目录 `VITE_DEMO=true bun run dev`，选择覆盖目标页面的 login-free `ui_demo` 路由；真实认证集成另行验证 |
| Loomhelm 可复用组件与状态 | 仓库根目录 `bun run storybook`，打开相应 story；整页变化还需覆盖对应页面 |
| 候选部署、蓝绿切换与恢复 | 按[开发说明](development.md)及[候选构建](candidates.md)使用 `scripts/preview` 与会话 Agent VM |

Web 与 Storybook 启动时将实际监听端口设为当前任务租约获配端口；Storybook 脚本中的默认 6006 不代表端口使用权。核对实际监听结果，避免框架自动换端口导致租约失配。

查看正式编排属于已安装 `multi-task-flow` 的使用流程。开发中的页面使用当前工作树构建的隔离服务；浏览器中已打开的正式 viewer 不会因源码修改自动更新。`scripts/preview` 是部署控制入口，不承担普通页面开发预览。

## multi-task-flow 源码服务

先按模块 `package.json` 和锁文件准备依赖；命令均在当前工作树的 `skills/multi-task-flow-runtime/` 执行。默认使用能覆盖本次改动的示例，主人已指定示例时遵循其选择。

| 示例 | 命令 | 用途 |
| - | - | - |
| 编排展示与交互验收 | `bun --no-install run preview:source` | 多交付单元、依赖、等待与阻塞、动态切割 |
| 单交付单元 | `bun --no-install run preview:single-delivery-unit` | 文档检索服务示例、复杂依赖汇聚与默认任务网格 |
| Agent 空闲与归档 | `bun --no-install run preview:idle-archive` | Agent 空闲和对话归档的专门场景 |

入口复用正式 shared viewer 实现，从本工作树构建 Web 源码，在新的临时目录使用 development profile 与示例账本，自动申请并维护独立端口租约。它不安装或升级正式服务，也不导入真实运行账本。默认编排示例包含仓库 PR 查询入口；示例账本隔离不代表页面完全离线，验证时保留查询失败的真实状态。

服务输出包含 `root`、`pid`、`port`、`scope`、`run_id`、`source_commit` 和单次登录 `url`。用这些字段核对临时服务与租约身份；宿主后台会话由 Agent 另行取得和验证。`source_commit` 仅表示 HEAD，未提交修改也会参与构建，需一并记录。

直接在内置浏览器消费服务输出的登录入口，打开示例编排并进入本次修改的交互状态。登录票据有效期为 60 秒，既有浏览器会话继续有效；票据过期可在该临时 profile 下运行模块的 `scripts/service.ts login`，显式设置 `MULTI_TASK_FLOW_PROFILE=development` 与输出中的 `MULTI_TASK_FLOW_ROOT`，按实际 `run_id` 获取新入口，避免误用正式服务。

`web/` 源码变化会自动构建并在成功后刷新页面；构建失败保留上次成功资源，此时页面不是最新修改的证明。后端源码、示例数据和其他未监听输入变化后重启命令。需要结束时向精确拥有的预览进程发送 Ctrl+C 或 SIGTERM，由入口完成服务和租约释放；主人查看期间保持服务与浏览器标签页。

静态导出适合独立静态产物检查；开发期间需要示例编排与交互验收时使用上述 HTTP 源码服务。
