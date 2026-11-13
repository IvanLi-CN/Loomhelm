# 决策说明：统一手动版本发布

## Context

交付物是统一产品发布合同，运行于 GitHub Actions 并供独立部署流程消费。核心风险是版本割裂、部分发布误报成功和恢复时身份漂移。

## Evidence

规范依据为 style-playbook 的 `manual-version-release-delivery/TOPIC.md`；`blog-26` 项目快照提供多个产物共享身份的参考，其仍待平台验收的部分不当作本项目已验证事实。

本仓库证据包括 `.github/workflows/release-candidate.yml`、`scripts/build-candidate`、`clients/typescript/package.json` 和 `.github/quality-gates.json`。

## Recommendation

Go 与 TypeScript 客户端是两种并存实现，均纳入统一交付；不引入独立 Connector 产品端。采用统一 SemVer 产品版本、单一人工 target、可信完成记录 baseline、durable reservation、受保护 PR 与 exact-head merge、全组件冻结产物及 same-identity recovery。GitHub Release 提供统一下载；Deploy 独立消费原产物。

根 `VERSION` 与组件字段投影作为推荐适配；是否采用专用版本准备 PR 以及具体文件集合属于工程设计，不是 Topic 的通用硬性规定。任何适配都不能绕过 PR、签名与质量门禁。使用受保护 Git refs／追加记录保存 reservation 与 completion 是候选实现，必须证明原子争抢、权限保护及恢复，不把 workflow concurrency 当作持久存储。

## Alternatives

独立组件版本可降低无变更组件的发版成本，但违反已确认的统一版本要求，不采用。仅上传 Actions artifact 复用现状较简单，但短期保留和缺少完整产品完成记录不足以满足正式发布，也不采用。

## 项目适配结论

- 已确认发布平台：服务端、Go 客户端和 TypeScript 客户端均为 Linux amd64；全部为必需门禁。
- 已确认通知 transport：独立流程按 release identity 创建或更新 GitHub Issue；不新增外部通知凭据，本轮不实际创建 Issue。
- 已确认保留策略：正式产物及元数据长期保留；未完成身份的冻结产物保留至恢复完成或维护者显式终止，不以重建替代丢失原件。
- 两种客户端分别验证安装、运行和版本身份；Go 源码的 connector 标识不构成废弃依据。删除或迁移客户端能力不属于本次统一发版需求。
- 已确认跨版本规则：首批保证同版本组合；跨版本连接必须有明确兼容声明与验证，否则提示受控升级。覆盖 Go 客户端、TypeScript 客户端联网能力及 Web/PWA；TypeScript 独立本地能力继续可用。

本轮产品需求已确认。Version Policy schema、受保护持久记录的具体格式、版本投影和工作流接线属于后续工程设计，必须满足 SPEC，不作为新增产品待决项。平台权限、分支规则与真实发布历史尚待核验；本轮不授权生产发布或平台权限变更。
