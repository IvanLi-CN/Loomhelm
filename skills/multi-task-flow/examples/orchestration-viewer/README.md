# 编排展示与交互验收

稳定编排 ID：`orchestration-viewer`；计划 ID：`viewer-validation-plan`。

- `index.ts`：具名示例入口，生成当前契约的运行账本。
- `ledger.ts`：执行历史与纯计划两种场景的数据定义，使用相对于参考时间的时间戳。
- `requirements/`：交付单元和贡献任务的 Markdown 需求内容，预览启动时复制到隔离运行目录。
- `link-verification.json`：历史原生对话链接验证记录；这些 ID 只用于链接展示，不代表示例拥有对应对话。仓库和 PR 数据是非操作性的合成数据。

在 `skills/multi-task-flow` 运行 `bun run preview:source`，打开输出的一次性登录入口。页面通过正式服务实现读取临时生成的账本；生成数据不回写本目录。

`bun run demo:static` 生成 `dist/preview.html`，仅供静态快照检查，不作为开发服务预览。`ledger.ts` 同时导出无执行历史的计划场景，供 UI 测试复用。

## Agent 空闲与归档示例

在 `skills/multi-task-flow` 运行 `bun run preview:idle-archive`，通过输出的一次性登录入口进入独立编排 `agent-idle-archive`。它使用与 `preview:source` 相同的正式开发服务、隔离账本、HTTP API、SSE 和源码重建流程，不依赖静态 fetch shim。

- `deploy` 展示执行中，`dashboard-ui` 展示正式的 `agent_idle` 状态、棕榈树状态图标和聊天气泡入口。
- `model` 展示归档失败，`ledger` 展示归档结果未知；在详情点击“重新归档”分别执行模拟成功回执和正向对账，资源变为 closed，任务终态不改变。
- 所有绑定对话都替换为合成标识，观察器和归档 provider 仅在隔离开发 profile 注入，不连接真实 Codex、不归档真实对话。

此命令需要由可持续持有进程的宿主后台会话或用户自己的终端运行。静态 HTML 仅用于快照，不能替代该开发服务。
