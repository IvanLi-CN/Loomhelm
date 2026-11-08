# ADR 0023：复用现有发布认证与平台签名

## 状态

已接受；owner 明确要求删除额外 App、私钥和没有需求依据的前置任务，继续修正统一发布实现。

## 背景

ADR 0022 规定统一产品身份、签名追加 Git ledger 与版本准备 PR。先前实现把额外认证、私钥导入和特定 Rulesets 组合当作必需条件，并把 main 已有的原生 Branch protection 错判为缺失。这些实现限制不能替代需求依据。

## 决策

保留 ADR 0022 的发布身份、CAS、公开意图、完整资产、共同完成和原件恢复语义。仅接续其认证、签名和平台核验适配：Actions 使用现有短期令牌，owner/agent 使用现有 gh 登录；通过 GitHub 原生 createCommitOnBranch 的平台签名和 expectedHeadOid 原子提交维护发布记录及版本投影，不配置额外签名私钥。

main 保护按现有原生分支保护核验 PR、签名、管理员执行、禁止强推/删除和 strict required checks，不要求为了通过审计新增 Rulesets。完整配置审计使用 owner 已有 gh 身份；CI 内置令牌只核验公开的 protected 与 required contexts，其余标为待 owner 审计。发布执行另验实际源码的签名、精确 merged main PR 与 required checks，不把平台详情不可读伪装成通过。仓库现有访问控制保留，发布程序只能追加记录、创建不存在的版本 tag，不能覆盖 tag 或修改保护配置。

首次 ledger 分支以已验证 main 为种子，原子占用 ref 后再精确 CAS 追加首条记录。空种子可恢复；若已有产品发布或版本准备分支但 ledger 丢失，则阻断并恢复历史。读取验证平台签名、发布 author、单 parent 和追加 JSON；不将签名身份更换为任意新密钥。

保持仓库禁止 Actions 创建 PR 的设置；工作流输出版本准备分支与比较链接，由 owner 或已获授权的 agent 使用现有 gh 身份创建普通 PR。CI、review 与 owner 合并门禁继续适用；不为无人值守而新增凭据或平台权限。

## 取舍

平台负责签名，避免维护额外私钥；代价是签名与原子提交依赖 GitHub 原生 API。接口拒绝签名、权限不可用、CAS 冲突或结果未知时必须停止并先对账。原生 API 并不证明真实发布已成功，真实签名、写权限及恢复仍由 A6 验证。

保留人工创建准备 PR 的一步，以复用已有认证和仓库设置。它不改变 target、版本、源码边界或完成判定。

## 依据

- [createCommitOnBranch](https://docs.github.com/en/enterprise-cloud@latest/graphql/reference/commits)
- [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)
- [统一发布合同](../specs/manual-version-release-delivery/SPEC.md)
