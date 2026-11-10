# Multi-task Flow Skill Runtime 发布历史

## Origin

本主题从现有客户端 Skills 迁入合同、Bun source runtime、共享 viewer service 和统一产品 release 约束中拆出一个独立的 Skill runtime 发布边界。

原有文档分别覆盖 29 套 Skills 的资源迁入、客户端直接运行、viewer 兼容生命周期和产品组件统一版本；它们仍然是各自主题的权威来源，本主题不取代或重写这些合同。

## Compatibility Decisions

ADR 0021 继续约束 Bun 1.4.4 直接运行和资源隔离；ADR 0026 viewer compatibility lifecycle 继续约束最新 reader 双读、旧 reader 隔离只读 fallback、机械迁移和历史保留。

ADR 0028 继续约束独立版本 envelope、source/build identity、generation/PID/service ensure 和安全迁移；本主题把这些已有边界映射到独立包、compatibility line 和发布恢复合同。

历史格式、fallback、迁移、拒绝路径和兼容代码不得因为创建本主题而自动删除；任何兼容代码清理仍需要独立的 release-level owner 决策。

## Publication History

本主题目前没有记录独立 @loomhelm/multi-task-flow npm 包发布、multi-task-flow-vX.Y.Z tag、compatibility line promotion 或用户服务升级。

本文件不把仓库现有 viewer/service bundle、客户端 toolkit artifact 或产品 release 记录解释为本主题的 npm 发布事实。

后续发布记录必须同时保存 package version、compatibility line、Skill version、merge SHA、build ID、tarball digest、Git tag、registry metadata 和验证证据；缺少任一身份字段时不得声称发布完成。

## Related Documents

- [Topic specification](SPEC.md)
- [Implementation coverage](IMPLEMENTATION.md)
- [Viewer compatibility lifecycle](../../adr/0026-viewer-compatibility-lifecycle.md)
- [Version propagation and safe migration](../../adr/0028-multi-task-flow-version-propagation-and-safe-migration.md)
- [Skill runtime release and service boundary](../../adr/0029-skill-runtime-release-and-service-boundary.md)
