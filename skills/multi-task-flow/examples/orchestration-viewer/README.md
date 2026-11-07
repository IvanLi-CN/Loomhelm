# 编排展示与交互验收

稳定编排 ID：`orchestration-viewer`；计划 ID：`viewer-validation-plan`。

- `index.ts`：具名示例入口，生成当前契约的运行账本。
- `ledger.ts`：执行历史与纯计划两种场景的数据定义，使用相对于参考时间的时间戳。
- `requirements/`：交付单元和贡献任务的 Markdown 需求内容，预览启动时复制到隔离运行目录。
- `link-verification.json`：历史原生对话链接验证记录；这些 ID 只用于链接展示，不代表示例拥有对应对话。仓库和 PR 数据是非操作性的合成数据。

在 `skills/multi-task-flow` 运行 `bun run preview:source`，打开输出的一次性登录入口。页面通过正式服务实现读取临时生成的账本；生成数据不回写本目录。

`bun run demo:static` 生成 `dist/preview.html`，仅供静态快照检查，不作为开发服务预览。`ledger.ts` 同时导出无执行历史的计划场景，供 UI 测试复用。
