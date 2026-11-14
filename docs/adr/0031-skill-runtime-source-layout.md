# ADR 0031：Skill 源包与内部 runtime 的目录边界

## 状态

Accepted。

## 背景

根 `skills/` 同时承载可发布 Skill 资源和 `multi-task-flow` 的内部 runtime、viewer/service、构建脚本与测试，导致安装面、构建面和发布面混在同一目录。该布局会让 vendor sparse checkout、源清单、运行时完整性检查和用户侧构建边界互相误导，也容易让 Agent 误把 npm CLI 或源目录当作 viewer bundle。

## 决策

`skills/` 只保存可发布 Skill 安装面：Skill 文档、references、上游合同归档、共享安装支持和其源清单。`packages/multi-task-flow-runtime/` 保存 Multi-task Flow 的内部 TypeScript runtime、viewer/service、构建脚本、测试、示例和开发依赖。

`skills/source-manifest.json` 的 `path` 表示 npm 包内的稳定资源路径，`sourcePath` 可以指向 `packages/multi-task-flow-runtime/`。受保护的 package/service 构建在生成包或 bundle 时完成 sourcePath 到 `skills/multi-task-flow/` 的映射，并对运行时内部导入执行确定性的发布路径适配。消费者只使用生成后的 npm 包或受保护发布的完整 bundle，不 checkout、安装或构建 `packages/multi-task-flow-runtime/`。

构建与测试命令、CI、发布 gate 和文档必须引用 `packages/multi-task-flow-runtime/`。用户侧的 `install`、`upgrade` 和 viewer 使用路径只接受受保护发布流程产出的、平台匹配且已验证的 bundle；任何用户侧 source build 都必须 fail closed。

## 后果

源包目录可以单独作为安装面审查，内部 runtime 可以独立运行 Bun 依赖和测试；发布构建需要维护 sourcePath 映射及发布路径适配，source manifest 必须同时校验源文件摘要和生成资源摘要。历史 npm 包内的 `skills/multi-task-flow/` 路径保持不变，避免改变消费者运行合同。

## 验证

- `skills/multi-task-flow/` 不包含 runtime 的 `lib`、`scripts`、`tests`、`web`、依赖或构建输出。
- `packages/multi-task-flow-runtime/` 可以独立运行 runtime tests、browser build 和 protected service bundle build。
- package source checks reject missing sourcePath resources and preserve package output paths.
- source policy、source manifest、candidate CI 和 Skill release workflow 均覆盖新目录。
