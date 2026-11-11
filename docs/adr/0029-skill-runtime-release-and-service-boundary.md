# ADR 0029：Skill runtime 发布与服务边界

## Status

Accepted as the architecture contract for the standalone @loomhelm/multi-task-flow runtime; this ADR does not authorize an npm publication, user-service upgrade or production deployment.

## Context

现有仓库已经有 29 套迁入 Skills、Bun source runtime、直接账本 CLI、共享 loopback viewer、service manifest、generation/PID/lease 和历史 viewer compatibility 机制，但这些能力目前分散在私有 monorepo package、客户端 toolkit 和 viewer/service bundle 中。

本主题需要一个可独立安装、可精确追溯、可恢复发布的 Skill runtime，同时要保持本地账本写入、viewer 读取、历史兼容和产品统一发布之间的授权边界。

如果把 package version、compatibility line、Skill version、ledger/API/viewer/service contracts、source/merge SHA、build ID、tag 和 tarball digest 合并成单一版本，或者让 gateway 直接承担账本 mutation，就无法判断旧 reader 是否安全、发布候选是否来自受保护合并、重试是否重复副作用以及不同 run/release 是否越界。

## Decision

Skill runtime 以独立的 @loomhelm/multi-task-flow npm package identity 发布；包必须携带完整 Skill、CLI、viewer 和生产依赖闭包，并显式记录 package version、compatibility line、Skill version、source SHA、merge SHA、ledger/API/frontend/viewer/service contract versions、build ID 和 tarball digest。

package version 使用完整 SemVer，compatibility line 使用正整数 compat-vN；两者、Skill version、合同版本、source/merge SHA、build ID、tag 和 digest 互不推断。破坏 CLI、账本、viewer/service API、权限或迁移安全的变化创建新的 compatibility line，旧 line 的读取或维护策略必须保留并显式记录。

正式 CLI 直接操作本地账本，并保留现有 owner、revision、operation identity、锁、幂等、冲突拒绝和未知副作用对账合同；viewer gateway 不承接账本 mutation，也不新增通用 HTTP mutation handshake。

用户服务只有一个 loopback viewer gateway；gateway 负责鉴权、SSE 和 run 路由，每个活动 release 由带 release identity 的 worker 提供内部服务，gateway 仅通过 owner-only service root 下的私有 Unix socket 连接 worker，worker 不监听公开 TCP 端口。

worker、gateway、run 和 release 之间的请求必须带有可验证的 release identity、owner、generation 和 PID 边界；服务状态保留真实 PID、generation、phase 和 lease expiration。Agent lease 与 browser lease 独立续租和过期，过期、停止或崩溃恢复不得删除账本、历史 run 或其他 lease 的状态。

最新 reader 遵循 viewer compatibility lifecycle：对当前和支持的历史格式双读，无法证明安全时阻止升级或使用明确绑定的旧 reader 隔离只读 fallback；fallback 不能写 owner、revision、receipt、ledger、run 状态、租约或任何业务副作用。

自动迁移只允许机械、确定性、幂等、可恢复且有备份、digest、revision fence 的转换；历史内容不自动清理，兼容代码删除属于独立 release-level 决策。本决定引用 [ADR 0026 viewer compatibility lifecycle](0026-viewer-compatibility-lifecycle.md) 和 [ADR 0028 version propagation and safe migration](0028-multi-task-flow-version-propagation-and-safe-migration.md)，不重复替换它们的详细合同。

Skill 发布必须从受保护分支的 merge receipt 开始，并以实际 merge_sha 构建；PR 必须恰有一个 release:skill 或 release:skip label，构建后必须重新验证 label、目标基线、合并状态和版本资格。

每个 package version 绑定不可移动的 Git tag multi-task-flow-vX.Y.Z；已有 tag 只有在精确 merge SHA、package identity、compatibility line 和 tarball digest 全部相同的情况下才能复用。流程只构建一个 tarball，验证和上传使用同一字节；exact SemVer 成功后才按声明移动 compat-vN、latest，stable 只有在显式声明时才移动。

## Consequences

独立 package projection、viewer/service worker boundary 和产品统一 release 会保留不同的身份与生命周期，发布工具必须携带更完整的 receipt 和 manifest，而不能只读取仓库 version 或最近 Git tag。

单 gateway 加私有 worker socket 为多 run、多 release 和旧 reader fallback 提供清晰隔离，但需要额外的 socket 权限、worker health、generation fencing、崩溃恢复和跨进程测试。

直接账本 CLI 保留本地 owner/revision 语义并避免 viewer mutation 绕行；viewer 只能观察和控制被明确授权的服务边界，不能成为第二个账本写入入口。

保留旧 reader 和机械迁移路径会增加测试和文档成本，但允许升级在历史内容不可读时可证明地停止或安全降级，不以自动删除历史换取短期简化。

独立 package、兼容线、不可移动 tag 和单 tarball 会使并发/中断发布需要 identity-first 对账，但能够防止错误重建、tag 覆盖、dist-tag 漂移和不明网络响应造成重复发布。

## Compatibility and Recovery

当 package、tag、registry metadata、tarball digest、merge SHA 或 release manifest 不一致时，恢复流程必须停止写入，读取所有身份来源并等待 owner 决定；不得 force 移动 tag、删除历史、盲目重新上传或使用新构建替换候选。

当最新 reader 无法证明某个 retained run 安全时，升级必须阻止，或者只使用该旧 release 已证明安全的隔离只读 fallback；fallback 不能被用来绕过账本 owner、revision、权限或发布门禁。

当 worker 崩溃、PID/generation 不匹配、lease 过期或 gateway 重启时，服务必须保留账本和历史数据，标记可观察的 interrupted/expired/recovery 状态，并在确认当前 release identity 后重新建立服务临时资源。

## Verification

本 ADR 的验收映射由 [docs/specs/skill-runtime-release/SPEC.md](../specs/skill-runtime-release/SPEC.md) 的 VER-SRR-001 至 VER-SRR-026 提供；实现时必须保留独立安装、CLI 幂等、gateway/worker socket、lease/TTL、reader fallback、label gate、exact merge SHA、single tarball、tag 保护和中断恢复证据。

现有 Bun、viewer compatibility、service lifecycle 和 product release 测试只能证明其各自已有边界；不能在没有独立 package projection、worker boundary 和发布身份验证的情况下被解释为本 ADR 全部通过。

## References

- [Bun 直接运行客户端与 Skills](0021-bun-source-runtime.md)
- [Multi-task Flow proposal quality gates and execution boundary](0026-multi-task-flow-proposal-quality-gates.md)
- [Viewer compatibility lifecycle](0026-viewer-compatibility-lifecycle.md)
- [Multi-task Flow version propagation and safe migration](0028-multi-task-flow-version-propagation-and-safe-migration.md)
- [Skill runtime release specification](../specs/skill-runtime-release/SPEC.md)
