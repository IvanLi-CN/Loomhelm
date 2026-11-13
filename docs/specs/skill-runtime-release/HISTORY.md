# Multi-task Flow Skill Runtime 发布历史

## Origin

本主题从现有客户端 Skills 迁入合同、Bun source runtime、共享 viewer service 和统一产品 release 约束中拆出一个独立的 Skill runtime 发布边界。

原有文档分别覆盖 29 套 Skills 的资源迁入、客户端直接运行、viewer 兼容生命周期和产品组件统一版本；它们仍然是各自主题的权威来源，本主题不取代或重写这些合同。

## Compatibility Decisions

ADR 0021 继续约束 Bun 1.4.4 直接运行和资源隔离；ADR 0026 viewer compatibility lifecycle 继续约束最新 reader 双读、旧 reader 隔离只读 fallback、机械迁移和历史保留。

ADR 0028 继续约束独立版本 envelope、source/build identity、generation/PID/service ensure 和安全迁移；本主题把这些已有边界映射到独立包、compatibility line 和发布恢复合同。

ADR 0030 将 registry 对账和消费者依赖边界收敛为当前实现：新 artifact 使用 schema v3 与 `path-byte-v2`，production dependencies 由消费者安装，schema v2 与现有 `0.2.7` 只做 legacy read-only 对账；0.2.7 exact-visible 只写 `legacy-reconciled` receipt，不触发上传、tag 或 dist-tag promotion；publish outcome 必须通过 release receipt 区分 `published` 与 `completed`。

历史格式、fallback、迁移、拒绝路径和兼容代码不得因为创建本主题而自动删除；任何兼容代码清理仍需要独立的 release-level owner 决策。

## Publication History

本主题目前没有记录独立 @loomhelm/multi-task-flow npm 包发布、multi-task-flow-vX.Y.Z tag、compatibility line promotion 或用户服务升级。

本文件不把仓库现有 viewer/service bundle、客户端 toolkit artifact 或产品 release 记录解释为本主题的 npm 发布事实。

后续发布记录必须同时保存 package version、compatibility line、Skill version、merge SHA、build ID、tarball digest、Git tag、registry metadata 和验证证据；缺少任一身份字段时不得声称发布完成。

## Documentation Baseline

当前源码合同已同步到客户端 README、Multi-task Flow Skill 和 workflow README，覆盖精确 package/Bun 入口、`compat-vN` 与内部版本矩阵、direct ledger CLI、gateway/worker 边界、agent/browser TTL、latest reader 双读、旧 reader 只读 fallback、maintenance migration、rollback、label gate、exact merge SHA、single tarball、immutable tag、dist-tag promotion 和失败恢复。

当前实现还同步记录 consumer-install dependencies、tarball 无 production `node_modules`、UTF-8 path-byte digest、legacy integrity authority、processing/409/timeout reconcile、dist-tag逐个 read-back、release receipt 和 `github-issue` failure sidecar 的边界。

后续实现收口补充了候选构建阶段的初始 receipt、缺失 dist-tag 的空值 promotion 规则，以及在 verify 阶段上传独立 release identity artifact 的失败对账入口；这些变化只强化已有 identity-first 合同，不代表发生了外部 publication、tag promotion 或 merge。

native product smoke 也已接受当前 schema 3 artifact，同时继续校验 schema 2 legacy bundled projection，并在当前格式下拒绝 toolkit 内的 production `node_modules`；这只修复了既有 Candidate CI 验证器与新 artifact 合同之间的实现漂移。

发布边界进一步收紧为受保护 workflow 独占：客户端 package 不再提供 `publish:exact`/`publish:compat` 脚本，CLI 的 `release publish` 也 fail closed；exact 查询的非 404 错误、registry tarball identity validation failure 和 legacy integrity mismatch 都会先写 receipt 再停止。

这次文档同步只记录已经存在的源码合同和可执行 workflow，不创建 npm 凭据、不安装或升级用户 service，也不把本地 build、PR gate 或候选 tarball 视为 registry publication。后续真实发布仍须由 owner-approved workflow 产生完整 identity 和 provider receipt。

## Related Documents

- [Topic specification](SPEC.md)
- [Implementation coverage](IMPLEMENTATION.md)
- [Viewer compatibility lifecycle](../../adr/0026-viewer-compatibility-lifecycle.md)
- [Version propagation and safe migration](../../adr/0028-multi-task-flow-version-propagation-and-safe-migration.md)
- [Skill runtime release and service boundary](../../adr/0029-skill-runtime-release-and-service-boundary.md)
- [Skill runtime registry reconciliation and consumer dependencies](../../adr/0030-skill-runtime-registry-reconciliation-and-consumer-dependencies.md)
