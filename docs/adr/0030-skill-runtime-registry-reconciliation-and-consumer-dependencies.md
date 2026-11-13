# ADR 0030：Skill runtime registry 对账与消费者依赖边界

## Status

Accepted as the successor release-contract decision for the registry and dependency boundaries of `@loomhelm/multi-task-flow`; this ADR does not authorize an npm publication, GitHub tag write, PR merge, Trusted Publisher change or credential change.

## Context

现有 Skill runtime release 已能从 protected merge SHA 构建 package projection，但 npm registry 的 processing、已知 409、超时和 partial promotion 仍可能被误判为可重传，且旧的 artifact projection 将 production dependencies 复制到 toolkit 内，导致发布包边界、消费者安装和 runtime fail-closed 语义不一致。

现有 `0.2.7` artifact 使用 schema v2 和历史 canonical digest 语义；它已经是 registry 中的外部事实，不能因为当前 verifier 改进而重建、覆盖或重新上传。新的 release contract 需要同时支持 legacy read-only reconciliation 与新的稳定 digest，而不伪造未发生的 registry receipt。

## Decision

发布 workflow 使用 identity-first registry state machine。protected main 的 merge receipt、immutable Git tag、唯一可上传 candidate tarball 和 release receipt 绑定同一 package/version、compatibility line、merge SHA、build ID、tag、canonical digest 与 raw npm integrity；Direct OIDC 只允许一次 `npm publish` 尝试，成功、已知 409 或未知结果都必须进入 exact registry reconcile，不能重建或盲目重传。

registry exact identity 只有在 exact-visible、registry tarball 可下载、npm `dist.integrity` 与下载 bytes 的 raw SHA-512 一致、package identity 与 candidate 一致后才标记为 `published`；immutable tag 的创建或复用也后置到这一身份检查之后。之后只按 compatibility line、`latest`、显式 `stable` 的顺序单调 promotion，并逐个 read-back；全部 read-back 成功才标记为 `completed`。404、processing、known-409、timeout、registry error 和 identity mismatch 保留为可操作 receipt state。

新 artifact 使用 `schemaVersion=3`、`canonicalDigestAlgorithm=path-byte-v2` 和 UTF-8 path-byte 排序；schema v3 的 dependencies 只记录 `consumer-install` 声明，tarball 禁止 `toolkit/**/node_modules`。根 package 只声明 `playwright`、`sharp`、`zod`，消费者的 Bun install 解析它们；runtime 只检查包根的精确 dependency manifest 和 `node_modules`，缺失时 fail closed，不联网安装、不搜索 checkout 或全局 Skill。

schema v2 reader/release tool 保留 legacy verifier。缺少 current algorithm 的历史 artifact 只验证 raw integrity、manifest identity 和可读形状，canonical digest 标记为未验证；`0.2.7` 只能只读对账，不能通过新 workflow 重新上传或覆盖。

失败通知继续使用 `github-issue` transport。default-branch metadata-only sidecar 只信任 workflow name/path、workflow_dispatch、protected main repository 和失败结论，消费 release identity artifact，幂等创建或更新带 run marker 的 Issue；通知失败不覆盖原 workflow failure，且 Issue 不会把 candidate、published 或 completed 伪装成外部事实。

## Consequences

未知 npm 写入结果的恢复从“重新发布”变成“读取 receipt、exact package metadata、raw integrity、canonical identity、tag 和 dist-tags 后继续或停止”，因此不会因为网络延迟产生第二份候选或覆盖不可变版本。

消费者安装会承担 `playwright`、`sharp`、`zod` 及其平台 optional dependencies 的解析成本；package tarball 更小，runtime 不能再依赖构建机或 workspace 的隐藏依赖。viewer 的 React、ELK、vis 等继续作为 workspace build inputs，不成为 Skill runtime 的 production dependencies。

`published` 与 `completed` 分离后，partial promotion 可被准确恢复和告警，但 operator 必须保留 receipt、确认 owner-approved stable 意图，并遵守 monotonic dist-tag policy。该决策不改变用户服务、历史 ledger、viewer compatibility fallback 或 Go product release。

## Compatibility and Recovery

当 exact package 不可见、registry 仍 processing、publish 返回 409/timeout、下载 bytes 与 metadata integrity 不同、legacy identity 不匹配或 dist-tag read-back 失败时，流程停止在对应 receipt state；不得删除版本、移动 tag、使用新构建替换候选或执行 staged approve/reject。

resume workflow 只能下载指定旧 run 的 candidate artifact 和 receipt context，重新校验相同 merge SHA、build ID、tag、digest 和 package version 后继续 reconcile；没有 exact identity 或 owner release decision 时不能推进 promotion。现有 `0.2.7` 仅记录 legacy identity 与 raw integrity 对账结果，不重新发布。

## Verification

验证映射由 [skill runtime release SPEC](../specs/skill-runtime-release/SPEC.md) 的 `VER-SRR-001`、`VER-SRR-002`、`VER-SRR-021` 至 `VER-SRR-026` 提供；实现测试必须覆盖 schema v3 dependency projection、tarball 无 `node_modules`、path-byte digest、schema v2 legacy read-only、registry state machine、same-candidate resume、monotonic read-back、`published/completed` receipt 和幂等失败 Issue。

## References

- [Skill runtime release specification](../specs/skill-runtime-release/SPEC.md)
- [Skill runtime release and service boundary](0029-skill-runtime-release-and-service-boundary.md)
- [Skill runtime workflow README](../../.github/workflows/README.md)
