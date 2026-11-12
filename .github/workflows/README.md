# Skill Runtime Release Workflows

本文是 `.github/workflows/skill-release-gate.yml` 与 `.github/workflows/skill-release-publish.yml` 的操作说明；发布合同的权威来源仍是 [`docs/specs/skill-runtime-release/SPEC.md`](../../docs/specs/skill-runtime-release/SPEC.md) 与 [`docs/adr/0029-skill-runtime-release-and-service-boundary.md`](../../docs/adr/0029-skill-runtime-release-and-service-boundary.md)。

## Release boundary

Skill release boundary 包含 `.github/workflows/`、`clients/typescript/`、`skills/` 和 `tools/skill-release/`；边界外的变更不应借用 Skill release 结论。当前源码投影如下，候选构建还必须记录精确 `source_sha`、受保护 `merge_sha`、`build_id` 和 `tarball_digest`。

| Dimension | Current projection |
| - | - |
| package | `@loomhelm/multi-task-flow@0.2.2` |
| compatibility line | `compat-v1` |
| Skill | `2.7.2` |
| ledger contract | `3` |
| API | `1` |
| frontend | `1` |
| viewer | `5` |
| service | `1` |

相关 PR 必须且只能有一个 `release:skill` 或 `release:skip` label。`release:skip` 必须在 PR body 提供 `<!-- release-skip: ... -->` 或等价的显式 skip reason，并且不能改变上述 canonical identity；`release:skill` 要求 package version 使用接受的 exact SemVer 且严格高于 base projection，compatibility line 不能回退。缺少 label、重复 label、版本占用、projection 不一致或 base/head 漂移都应由 gate 拒绝。

## Workflow responsibilities

| Workflow | Trigger or entry | Responsibility |
| - | - | - |
| `skill-release-gate.yml` | PR opened/synchronize/reopened/ready-for-review/labeled/unlabeled；merge queue checks | checkout exact PR or merge-group head，运行 `release.py gate`，校验 label、base/head projection、版本和 compatibility line |
| `skill-release-publish.yml` | owner-approved `workflow_dispatch` | 校验已合并 main PR、构建并验证候选 tarball、记录 skip receipt，或发布并单调提升 dist-tags |

PR gate 使用 PR 的 exact base SHA 和 head SHA；merge queue 会重新解析唯一的 main PR 并以 queue base/head 再跑一次 gate。不要以工作区当前分支、PR title、历史 workflow 结果或本地 package version 代替 provider 传入的 SHA 和 label 证据。

发布 workflow 的输入是 `pr_number`、`merge_sha`、`publish` 和 `stable`。`merge_sha` 必须是 protected main 的实际 merge commit；`publish=false` 只验证候选并上传验证 artifact，`publish=true` 才进入 npm 写入；`stable=true` 仅在 exact、compatibility line 和 latest 都验证成功后提升 stable。

## Candidate and publish sequence

1. `verify` checkout exact `merge_sha`，确认 PR 已 closed/merged、merge receipt 与 SHA 相同、base 为 `main` 且非 draft。
2. `release.py gate` 重新检查唯一 release label、package projection、Skill frontmatter、`lib/contract.ts` 与 `lib/service-contract.ts` 的 contract fields。
3. `release:skill` 路径先用 `verify-tag --allow-missing` 检查 `multi-task-flow-v<version>`，再以同一个 merge SHA 和 Bun `1.4.4` 构建一个 draft tarball，计算 digest，将 digest 写入 manifest 后重新生成最终 tarball，并用 `validate-tarball` 验证版本、merge SHA、compatibility line 和 digest。
4. 候选包必须把运行时 Skill 依赖（当前包括 `zod` 与 `sharp`）完整封装在 tarball 内；发布前必须在全新临时目录执行隔离安装后的 `orchestrate init`/`show` smoke test，禁止依赖发布包外的 workspace `node_modules`。
5. 最终只上传这一份验证过的 tarball；promotion 阶段下载它，不重新 build，不从另一个 checkout 生成替代 bytes。
6. publish 先用 `npm view @loomhelm/multi-task-flow@<version>` 对账 exact package；不存在时发布相同 tarball，随后下载 registry tarball 并比较 `tarballDigest`。
7. exact package 对账成功后，以 `dist-tag-policy` 单调提升 `compat-vN` 和 `latest`，必要时再提升 `stable`；任何更高版本占用、digest 不同或 tag 回退都会停止流程。
8. `release:skip` 路径不生成发布包，只上传包含 PR、merge SHA、当前 package version、compatibility line 和 skip reason 的 skip receipt。

npm 写入需要 `https://registry.npmjs.org/`、`@loomhelm` scope 配置和 `NPM_TOKEN` secret；这些是 workflow 外部前置，不写入仓库或 PR。owner approval、GitHub token 权限和 registry token 必须在受控 workflow environment 中提供；本地 `bun pm pack` 或 gate 通过不代表完成 npm publication。

## Ledger and viewer compatibility

最新 viewer 支持以下读取/写入矩阵；`schema-2/contract-2` 的历史写入仍受 task execution policy 和显式维护门禁约束，新 development baseline synchronization 使用 `schema-2/contract-3`。

| Ledger shape | Latest reader | Ordinary writer |
| - | - | - |
| `schema-1/legacy` | read | reject |
| `schema-1/contract-1` | read | reject |
| `schema-2/contract-1` | read | reject |
| `schema-2/contract-2` | read | allowed after policy compatibility checks |
| `schema-2/contract-3` | read | allowed |

最新 reader 对所有受支持历史 shape 双读；旧 viewer 只在最新 reader 无法安全解释时作为隔离 read-only fallback，不能取得 writer lease、修改 revision、写入 ledger 或伪装成当前 release。损坏、未声明或无法证明兼容的 run 必须单独 fail closed，不能因为其他 run 可读就放宽门禁。

## Operator recovery

Gate 失败时先读取 exact job output 和 `release.py gate` JSON，修正 label、skip reason、projection 或 version，再让 provider 重新触发 gate；不要手工改 release receipt 或绕过 required check。若 base/head 已变化，重新校验当前 PR identity 和 merge base，不能沿用旧结果。

Immutable tag 冲突时运行 `verify-tag` 对账现有 tag 的目标 SHA；目标不是候选 `merge_sha` 时停止并升级处理，不 force-move、删除或重建 tag。package version 已存在时先用 `npm view` 和 registry tarball 校验它是否就是同一 merge SHA、compatibility line 和 digest；不一致时停止，不覆盖已发布版本。

`npm publish` 返回未知结果时不得立即重试；先查询 exact package、registry metadata 和 tarball digest，只有明确不存在且候选身份仍未被占用时才允许由 owner-approved workflow 重试。dist-tag policy 返回 regression 或 registry 元数据无法解析时停止，不手工把 tag 指向旧版本。

viewer upgrade 先执行 `status`/`doctor`、`compatibility-check` 和 health identity 检查；候选不可读时保留当前 release，若当前 reader 可读则按报告使用隔离只读 fallback。只有明确兼容的 candidate 才能 `upgrade`；rollback 也必须先对账 `rollback=true` 的 compatibility report 和 generation/PID。历史 ledger 迁移只能使用 `ledger-maintenance-check` / `ledger-maintenance-apply`，保留 source SHA-256、owner、revision、operation digest 和 backup，不自动补造历史事实。

agent lease 为 60 分钟，browser lease 为 5 分钟，页面每 60 秒续租；租约过期会停止当前 generation 但不删除 data、logs、release 或 ledger。恢复时先按 run/build/source/merge identity、generation、PID、port 和 provider receipt 对账，再调用 `ensure`；不得抢占未知 listener、删除 runtime 文件或杀死不属于当前 generation 的进程。

发布成功必须同时具备 exact package version、compatibility line、Skill version、merge SHA、build ID、tarball digest、immutable tag、registry metadata 和 workflow receipt。缺少任何一项时只能报告候选验证或部分恢复状态，不能报告为已发布。
