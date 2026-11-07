# 单交付单元：文档检索服务

完全虚构的独立示例，展示一个交付单元中多分支并行、交叉依赖、集成汇聚、父 PR 合并及发布、部署、验证链。包含 14 个任务、2 个里程碑和 31 条原始依赖。保留复杂编排的结构特征，重新编写领域、任务、标识与固定时间，不复制真实运行账本。

数据入口为 `ledger.ts` 的 `createSingleDeliveryUnitLedger()`，直接通过正式 schema 校验，不依赖其他示例。仓库使用 `example/document-search-demo` 占位，对话统一使用 `mock-thread-*`，PR 链接使用 `example.invalid`，分支、SHA、事件和回执均为合成数据；这些引用不要求真实存在，不触发调度或外部操作。`outputs.ts` 提供任务进展和源码预览的内存对话适配器，不连接真实 Codex 对话。

当前快照：交付单元父分支和父 PR 已创建（2/5 步骤完成），协调者等待剩余贡献；6 个贡献已集成，容器配置正在执行，索引切换已就绪但尚未派发，其余任务等待前驱。已启动任务拥有 mock 对话及子 PR，未派发任务没有对话或 PR；已完成输出为 final，执行中输出为 commentary。固定时间、事件、回执、生命周期和依赖条件一致，父 PR 尚未合并，发布链尚未开始。

在 `skills/multi-task-flow` 运行：

- `bun run preview:single-delivery-unit`：通过正式 shared viewer 在隔离数据目录启动源码预览。
- `bun run demo:single-delivery-unit`：生成静态 `dist/single-delivery-unit.html`，适合无需运行服务的展示。加 `?tab=graph` 查看默认横向依赖图。

任务视图在只有一个交付单元时默认采用网格布局；多个交付单元默认采用看板。显式 `layout=board` 或 `layout=grid` 优先，切换后的选择可通过 URL 保留。
