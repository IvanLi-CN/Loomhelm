# Multi-task Flow Skill Runtime 发布 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；本文件记录已有实现覆盖、待实现缺口和验证入口，不把设计合同误报为已发布能力。

## Current Status

- Implementation: 独立 package projection、Bun CLI、gateway/worker 服务边界、兼容检查、机械维护迁移和 release gate/publish workflow 已在源码中实现并有针对性测试覆盖。
- Lifecycle: active
- Publication status: 本仓库没有独立 npm publication、受保护 main merge、immutable tag 或用户服务升级的实际 receipt；源码实现和本地候选验证不能替代这些外部事实。
- Catalog note: 本主题由 `client-skills`、ADR 0021、0026 和 0028 的既有合同拆出独立包、viewer 服务和可恢复发布边界，当前 owner-facing 入口还包括 `clients/typescript/README.md`、`skills/multi-task-flow/SKILL.md` 和 `.github/workflows/README.md`。

## Implementation Coverage

| Requirement | Current coverage | Gap or boundary |
| - | - | - |
| `REQ-SRR-001` | `clients/typescript/package.json`、`package-client-skills.ts` 和 package tests 提供 `@loomhelm/multi-task-flow`、`multi-task-flow` bin、完整 toolkit 资源和依赖打包路径。 | 真实 registry publication 与干净外部安装仍需受保护 release workflow 的 artifact/registry receipt。 |
| `REQ-SRR-002` | 仓库和 package 固定 Bun 1.4.4；build、manifest 和 CLI 会拒绝运行时或资源身份不匹配。 | 跨平台干净临时目录矩阵仍属于 CI/发布环境，不能由本地 source check 单独证明。 |
| `REQ-SRR-003` | `build-info.ts`、`runtime-identity.ts`、`service-release.ts` 和 `release.py` 交叉校验 package、Skill、ledger、viewer、source/merge、tag 和 tarball identity。 | registry/provider 的实际发布 receipt 仍未在本仓库产生。 |
| `REQ-SRR-004` | package metadata 明确 SemVer 与 `compat-vN`，`release.py gate` 校验 projection、严格版本推进和 compatibility line 不回退。 | 兼容线历史清理和 breaking line 的实际发布仍需 owner-approved release decision。 |
| `REQ-SRR-005` | `clients/typescript/src/cli/flow.ts` 提供 direct `flow COMMAND --input - [--socket PATH]`；ledger store/engine 覆盖锁、owner、revision、幂等和未知结果。 | 外部隔离安装与无 checkout 的 registry package 验收仍需真实 tarball/registry 流程。 |
| `REQ-SRR-006` | `service.ts`、`service-http.ts`、`viewer-gateway.ts`、`viewer-worker.ts` 和 socket modules 实现单一 loopback gateway、owner-only worker、HTTP/SSE/resource 路由及多 run 资源边界。 | 用户主机的实际 launchd 安装和跨平台部署仍是外部运维前置。 |
| `REQ-SRR-007` | `service-state.ts`、`service-lifecycle.ts` 和 service tests 覆盖 generation/PID fencing、agent/browser lease、TTL、stopping grace、restart 和 crash recovery。 | 真实用户服务故障演练与跨进程环境 receipt 仍待受控验证。 |
| `REQ-SRR-008` | `service-compatibility.ts`、`service-contract.ts` 和 compatibility tests 覆盖全 run reader check、latest dual-read、old reader read-only fallback、SSE/read-only route 和错误分类。 | 候选 release 在真实长期保留数据上的证明仍需 workflow/运维环境证据。 |
| `REQ-SRR-009` | `store-migration.ts`、`ledger-maintenance.ts` 和 migration tests 覆盖 backup、digest、revision、request identity、机械迁移、重放与历史保留边界。 | 长期 fixture 保留和真实权限/中断演练仍属于 release quality gate。 |
| `REQ-SRR-010` | `skill-release-gate.yml`、`skill-release-publish.yml` 和 `release.py` 强制恰好一个 `release:skill`/`release:skip` label、范围检查、base/head 重检、SemVer、compatibility line 和 projection。 | 真实 PR/merge queue 的 provider check receipt 尚未在本主题中记录。 |
| `REQ-SRR-011` | publish workflow checkout exact protected merge SHA，验证 merged PR receipt，并把 merge/source SHA 写入 candidate manifest。 | 只有受保护 main 上的实际 workflow run 才能产生可发布 provenance。 |
| `REQ-SRR-012` | publish workflow 以同一 merge SHA 生成 draft/final 单 tarball，注入并验证 digest，上传后再比较 registry bytes，promotion 不重建。 | 实际 npm registry 发布与未知结果恢复仍未发生。 |
| `REQ-SRR-013` | workflow 和 `release.py` 支持 `multi-task-flow-vX.Y.Z` immutable tag、`compat-vN`/`latest`/可选 `stable` 的单调 promotion、并发隔离和对账入口。 | 真实 tag、dist-tag 和中断恢复 receipt 仍需 owner-approved workflow。 |
| `REQ-SRR-014` | SPEC/IMPLEMENTATION/HISTORY、ADR 0029、客户端 README、Skill 文档和 workflow README 现已覆盖 CLI、版本矩阵、viewer/TTL、迁移、回滚、失败恢复和发布操作。 | npm publication、用户服务升级和 owner/provider 凭据仍是明确的外部前置，不在文档提交中伪造完成。 |

## Verification Commands

- `bun --no-install skills/bin/spec_contract_check.ts --path docs/specs/skill-runtime-release/SPEC.md`
- `python3 tools/markdown.py check`
- `bun test ./skills/bin/tests/docs`
- `python3 -m unittest tools/skill-release/test_release.py`
- `bun --no-install run --cwd clients/typescript check`
- `bun --no-install run --cwd clients/typescript test`
- 上述命令验证源码和本地包行为；干净外部安装、registry publication、受保护 merge、长期 service 故障演练和真实 provider receipt 仍需在对应 CI/workflow 环境中完成，不能由本地检查替代。

## Rollout Facts

- 当前源码通过 `@loomhelm/multi-task-flow` package projection 和 Bun 1.4.4 直接运行；本主题不改变现有用户级服务、安装目录或历史 ledger。
- 当前 artifact manifest、runtime identity、release gate 和 tarball validation 能证明候选源码与内部 identity 的一致性，但不能单独证明 npm publication、protected merge provenance、registry bytes 或不可变 tag 已存在。
- viewer compatibility 的双读、旧 reader 只读 fallback、机械迁移、维护 backup 和拒绝路径由 `client-skills`、ADR 0026/0028/0029 与当前 service tests 共同维护。
- npm scope、registry、automation token/认证、Bun 1.4.4 和宿主服务权限属于外部前置；本主题不创建或写入这些凭据和用户服务。

## Remaining Gaps

- 在受保护 main 上执行 owner-approved release workflow，产生首次真实 merge/tag/tarball/registry/provider receipts，并验证未知 publish 结果的恢复路径。
- 在干净临时目录和支持的平台完成外部安装矩阵，覆盖缺 Bun、缺依赖、资源摘要错误、无 checkout、固定兼容线和 exact package identity。
- 在真实用户服务 scope 完成 launchd 安装、upgrade、rollback、generation/PID fencing、lease expiry、crash recovery、multi-run/SSE 和旧 reader fallback 演练。
- 持续保留中断、重放、权限失败、label eligibility、same-tarball、registry/dist-tag、immutable tag 和 maintenance backup fixtures，并把受保护 CI 结果纳入 release gate。
- 兼容线废弃、历史 viewer fallback 清理和用户服务升级仍需要独立 release-level owner 决策，不由本主题文档提交自动执行。

## Related Changes

- [客户端 Skills 与工程执行支持](../client-skills/SPEC.md)
- [统一手动版本发布](../manual-version-release-delivery/SPEC.md)
- [Bun 直接运行客户端与 Skills](../../adr/0021-bun-source-runtime.md)
- [Viewer 兼容生命周期与历史状态处置](../../adr/0026-viewer-compatibility-lifecycle.md)
- [Multi-task Flow version propagation and safe migration](../../adr/0028-multi-task-flow-version-propagation-and-safe-migration.md)

## References

- `./SPEC.md`
- `./HISTORY.md`
- `../../.github/workflows/README.md`
