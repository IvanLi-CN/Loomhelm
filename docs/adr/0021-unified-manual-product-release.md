# ADR 0021：统一产品版本与可恢复发布身份

## 状态

已接受；依据 owner 已批准的统一发布需求和实现计划。

## 背景

服务端候选和 Go 客户端曾由独立入口交付，TS 客户端没有共同发布完成判定。独立 workflow 成功不能证明整个产品可获取，短期 Actions artifact 也不足以承担恢复真相。

## 决策

服务端、Go 客户端、TypeScript 客户端和 Web/PWA 属于同一产品发布单元，共用人工 target、canonical version 和最终 source SHA，保留不同产物 digest。Go 客户端现有 connector 源码标识保留，不形成第四个产品端，也不是废弃或迁移依据。

采用受保护、签名且追加的 release-ledger Git 分支，以精确 ref CAS 完成 reservation 和状态推进。产品一次只允许一个未结束身份。正常 PR 保护 main；版本准备 PR 固定源码边界，最终绑定精确合并身份，不能在重试时替换源码或重新分配版本。

GitHub draft Release 持久保存冻结产物。全部下载复核完成后才公开，并追加 completion；只有公开状态、完整 digest 和 completion 一致时才作为正式 baseline。公开成功但回执写入失败，恢复通过查询原身份补记。生产部署独立消费冻结产物，不参与版本分配。

## 取舍

Git ledger 复用 GitHub 授权与签名审计，避免新增状态服务；代价是必须管理专用 ref 的权限、签名和并发 CAS。短命 workflow artifact 只用于传输，不提供长期完整性保证。数据库或外部对象存储可作为未来替代，但需要另行迁移持久身份合同，不能隐式切换。

跨仓库服务无法提供物理上同时可见的事务，因此以完整准备、统一公开与可验证完成判定实现产品级共同发布。禁止覆盖 tag、覆盖不同内容资产或用重建伪装原件恢复；丢失原件需要显式故障处理。

## 关系

- [统一发布合同](../specs/manual-version-release-delivery/SPEC.md)
- [发布操作手册](../runbooks/manual-product-release.md)
