# Multi-task Flow Skill Runtime 发布 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；本文件记录已有实现覆盖、待实现缺口和验证入口，不把设计合同误报为已发布能力。

## Current Status

- Implementation: 合同已建立，独立 npm package、gateway/worker 服务边界与发布流水线尚未实现。
- Lifecycle: active
- Catalog note: 本主题由 `client-skills`、ADR 0021、0026 和 0028 的既有合同拆出独立包、viewer 服务和可恢复发布边界。

## Implementation Coverage

| Requirement | Current coverage | Gap or boundary |
| - | - | - |
| `REQ-SRR-001` | `skills/multi-task-flow/package.json` 与 `clients/typescript/package.json` 是 private source packages；`build-service.ts` 已能复制部分 Skill/runtime 资源。 | 尚无独立 `@loomhelm/multi-task-flow` tarball、统一 Skill CLI、预构建 viewer 资产闭包和安装后无 checkout 依赖的验证。 |
| `REQ-SRR-002` | 仓库固定 Bun 1.4.4；`build-service.ts` 和客户端 package 已校验 Bun 版本。 | 尚无干净临时目录中区分 Bun 外部前置、缺依赖、缺资源和摘要错误的独立安装矩阵。 |
| `REQ-SRR-003` | `service-contract.ts`、`service-release.ts` 和 `build-service.ts` 已覆盖部分 contract fields、`build_id`、`source_sha`、runtime/platform 与文件摘要。 | 尚无 package、Skill、ledger、viewer、merge、tag 和 tarball identity 的统一交叉校验，也无严格重复/回退/占用检查。 |
| `REQ-SRR-004` | ADR 0028 已定义独立版本信封；现有 service manifest 有部分 contract version 字段。 | 尚无显式 package SemVer 与 `compat-vN` runtime line 的发布实现、breaking line policy 和 dist-tag 不推断校验。 |
| `REQ-SRR-005` | `clients/typescript/src/cli/flow.ts` 已保留 direct `flow COMMAND --input - [--socket PATH]`；ledger store/engine 已有锁、owner、revision、幂等和未知结果边界。 | 尚无独立包中的 `multi-task-flow` unified CLI，也无完整 CLI 不经 viewer HTTP 的隔离安装验收。 |
| `REQ-SRR-006` | `skills/multi-task-flow/scripts/service.ts`、`service-http.ts` 和 `service-state.ts` 已提供 loopback/service state/socket 配置基础。 | 尚无单一共享 gateway、owner-only Unix socket worker、HTTP/SSE/resource 路由和多 run/release isolation 的完整实现。 |
| `REQ-SRR-007` | `service-state.ts`、`service-lifecycle.ts` 和 `service-http.ts` 已提供部分 PID/generation/lease 及 Agent/browser TTL。 | 尚无完整 fencing、grace、worker lease、gateway restart、crash recovery 和多 run 独立清理合同。 |
| `REQ-SRR-008` | `service-compatibility.ts` 已实现 target reader、previous reader read-only fallback、release window 和 migration guide checks；ADR 0026/0028 已定义长期边界。 | 尚无完整升级前全 run reader proof、fallback mutation rejection、SSE/read-only route 和错误分类证据。 |
| `REQ-SRR-009` | `store-migration.ts` 与 ADR 0026 已覆盖备份、digest、revision、request identity、机械迁移和历史保留原则。 | 尚无本主题要求的完整中断/重放/权限失败 fixture 和长期测试保留门禁。 |
| `REQ-SRR-010` | `manual-version-release-delivery` 已定义 owner release target 与发布门禁方向。 | 尚无恰好一个 `release:skill`/`release:skip` label、范围检查、label/base 漂移重检、版本占用和 projection 检查。 |
| `REQ-SRR-011` | `build-service.ts` 要求 clean source 并记录 source SHA；现有发布文档要求 provider evidence。 | 尚无 protected merge receipt、merge SHA 与 source SHA 绑定、候选固定和 manifest 反向证明。 |
| `REQ-SRR-012` | 当前 build 逻辑能生成 release manifest 和文件摘要。 | 尚无单次 tarball、同一 bytes/digest 的验证与上传、promotion 不重建和未知 registry 结果对账。 |
| `REQ-SRR-013` | 手动发布主题已有 `vX.Y.Z`/provider receipt 方向，ADR 0028 保留版本链分离。 | 尚无 `multi-task-flow-vX.Y.Z` immutable tag、`compat-vN`/`latest` 顺序 promotion、stable 策略、并发和中断恢复实现。 |
| `REQ-SRR-014` | 本 topic 的 SPEC/IMPLEMENTATION/HISTORY 与 ADR 0029 已建立合同文档；现有 client-skills 文档保留 Bun/compatibility 背景。 | 尚无对应 CLI README、发布 workflow 说明、内部版本矩阵和完整 viewer/TTL/migration/rollback/failure-recovery 运维文档。 |

## Verification Commands

- `bun --no-install skills/bin/spec_contract_check.ts --path docs/specs/skill-runtime-release/SPEC.md`
- `python3 tools/markdown.py check`
- `bun test ./skills/bin/tests/docs`
- 实现完成后补充干净安装、缺依赖、固定兼容线、新旧 CLI、latest reader 历史双读、旧 worker 只读拒绝、gateway/worker、lease/grace/crash、多 run/SSE、label eligibility、same-tarball、registry/dist-tag 和 recoverable-tag fixtures；当前不宣称这些运行时验收已通过。

## Rollout Facts

- 当前源码仍通过仓库内 private packages 和 Bun 1.4.4 运行；本主题不改变现有安装、用户级服务或历史 ledger。
- 当前 release manifest 能验证部分 build/source/runtime/file identity，但不能单独证明 npm publication identity、protected merge provenance、同一 tarball 或不可变 tag。
- viewer compatibility 的双读、旧 reader 只读 fallback、机械迁移和拒绝路径继续由 `client-skills` 与 ADR 0026/0028 维护；本主题只增加 package/service/release boundary。
- npm 首次 scope、registry、automation token/认证、Bun 1.4.4 和宿主服务权限属于外部前置；本主题不创建或写入这些凭据和用户服务。

## Remaining Gaps

- 建立 `@loomhelm/multi-task-flow` standalone package、统一 Skill CLI、预构建 viewer 资产和无 checkout 的隔离 tarball。
- 定义并实现 package SemVer、`compat-vN`、contract dimensions、build/source/merge identity 的统一 manifest 与 receipt。
- 实现单一 loopback gateway、私有 Unix-socket release workers、HTTP/SSE/resource routing、generation/PID/socket identity 和 lease/TTL/grace/crash recovery。
- 接入 `release:skill`/`release:skip` label eligibility、精确 merge SHA、一次构建同一 tarball digest、registry/dist-tag 顺序、immutable tag、provider/npm recoverability 和冲突拒绝。
- 补齐 CLI、发布 workflow、版本矩阵与 viewer/TTL/迁移/回滚/失败恢复运维文档；发布动作仍需独立批准和 provider receipt。

## Related Changes

- [客户端 Skills 与工程执行支持](../client-skills/SPEC.md)
- [统一手动版本发布](../manual-version-release-delivery/SPEC.md)
- [Bun 直接运行客户端与 Skills](../../adr/0021-bun-source-runtime.md)
- [Viewer 兼容生命周期与历史状态处置](../../adr/0026-viewer-compatibility-lifecycle.md)
- [Multi-task Flow version propagation and safe migration](../../adr/0028-multi-task-flow-version-propagation-and-safe-migration.md)

## References

- `./SPEC.md`
- `./HISTORY.md`
