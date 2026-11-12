# Multi-task Flow Skill Runtime 发布

## Context and Scope

本主题定义 `@loomhelm/multi-task-flow` 独立 npm 包、`multi-task-flow` Skill 运行时、本地账本 CLI、共享 viewer 服务及其可恢复发布的长期工程合同。

本主题覆盖 Skill 资源闭包、Bun 运行时前置条件、版本与兼容线、CLI 与 viewer 服务边界、运行租约、历史格式读取、npm 发布身份、Git tag、PR label 和失败恢复。

本主题不替代 [客户端 Skills 与工程执行支持](../client-skills/SPEC.md)、[统一手动版本发布](../manual-version-release-delivery/SPEC.md) 或已有 viewer 兼容 ADR；产品端 Go、Server、Worker、Connector、Web/PWA 的统一发布仍由产品发布主题负责。

本主题定义发布和运行合同，但不代表本次任务已经完成 npm 发布、用户服务升级、生产部署、权限变更或任何外部平台写入。

## Terms and Identity

`Skill package` 是可从 npm 独立安装并运行的 `@loomhelm/multi-task-flow` 包，必须携带运行所需的 Skill、CLI、viewer 和依赖闭包。

`package version` 是 npm 使用的完整 SemVer；它标识包内容身份，不从 `compat-vN`、`latest` 或调用者输入推断。

`compatibility line` 是正整数 `N` 标识的 `compat-vN` 兼容线，约束 CLI 输入输出、账本语义、viewer/service API 和迁移边界；它不是 npm 版本，也不是原始 dist-tag。

`Skill version` 是 Skill 合同版本；`source SHA` 是构建使用的精确 Git commit；`merge SHA` 是受保护分支实际合并提交；二者不得以“最近提交”或本地 HEAD 的模糊描述替代。

`ledger contract`、`API version`、`frontend contract`、`viewer contract` 和 `service version` 是相互独立的合同维度；`build ID`、tarball digest 和 Git tag 是具体发布候选的可验证身份。

`gateway` 是唯一对 viewer 提供 loopback HTTP/SSE 的入口；`release worker` 是由已发布包启动、通过私有 Unix socket 接收 gateway 请求的发布实例。

`Agent lease` 与 `browser lease` 是互相独立的运行租约；租约失效只影响其拥有的观察或执行会话，不得删除账本或影响其他 run。

## Goals and Non-goals

目标是让安装者可以在没有源代码 checkout、全局 Skill 源包或父仓库依赖的情况下运行完整 Skill 工具链，并让每一次发布、读取、升级和恢复都能按精确身份重放。

目标是让 CLI 直接维护本地账本，让 viewer 通过单一 loopback gateway 观察多个 run，同时以私有 socket、进程代际和租约边界隔离不同 release 与 run。

目标是让旧 viewer 在明确安全证据下只读读取历史格式，让机械迁移可恢复、可审计且不清理历史内容。

非目标是把本包并入产品统一版本、替换 Go Connector、公开 release worker 端口、引入第二个 owner/授权模型、增加未经批准的数据库迁移，或用 viewer HTTP API 替代本地账本写入合同。

## Requirements

### REQ-SRR-001：独立包与资源闭包

发布包 MUST 是可独立安装的 `@loomhelm/multi-task-flow` npm 包，包含完整 Skill 工具、共享合同、CLI、预构建 viewer 资源、运行时资源和完整生产依赖闭包。

包内任何正式入口 MUST NOT 依赖父仓库 checkout、`~/.agents`、全局 Skill 安装、未打包的相邻 workspace、安装者的源目录或发布机上的偶然依赖；包外依赖只能是明确声明并可检查的运行时前置条件。

发布包 MUST 带有机器可读的内容清单、文件摘要、package version、compatibility line、Skill version、source SHA、merge SHA、build ID、service/viewer/ledger/API/frontend 合同版本和 tarball digest。

- covers: `VER-SRR-001`, `VER-SRR-002`

### REQ-SRR-002：Bun 与独立安装前置条件

生产运行时 MUST 使用 Bun `1.4.4`，并直接执行包内声明的源代码或构建产物；Node、动态安装、缺失依赖时静默回退和父仓库源码回退均 MUST NOT 被视为成功。

干净临时目录中的安装验证 MUST 能区分“包内容完整”与“外部 Bun 前置条件缺失”；缺失、版本不符、文件摘要不符或依赖闭包不完整 MUST fail closed，并给出可行动错误。

- covers: `VER-SRR-001`, `VER-SRR-003`

### REQ-SRR-003：独立版本维度与精确身份

发布合同 MUST 独立记录并校验 package version、compatibility line、Skill version、source SHA、merge SHA、ledger contract、API version、frontend contract、viewer contract、service version、build ID、package tarball digest 和 Git tag。

任何维度 MUST NOT 从另一个维度推断；尤其不得从 npm `latest`、调用者输入的 dist-tag、本地未提交 HEAD、最近 tag 或 package version 推断兼容线、merge SHA 或源身份。

版本重复、回退、缺少源提交、source SHA 与 merge SHA 不一致、不可解析 SemVer、非正整数 compat line、build ID 或 digest 格式错误 MUST 在构建或发布前拒绝。

- covers: `VER-SRR-004`, `VER-SRR-005`

### REQ-SRR-004：SemVer 与 compatibility line

package version MUST 使用完整 SemVer；`compat-vN` MUST 使用正整数 N，并代表一条明确的运行语义兼容线。

改变 CLI 输入输出、账本写入语义、viewer/service API、权限边界、迁移可恢复性或读取安全证明的 breaking change MUST 创建新的 compat line，并保留旧 line 的明确读取或维护策略。

compat line 的选择 MUST 由发布元数据显式声明；MUST NOT 把调用者原始输入、`latest` 或其他 dist-tag 当作兼容线。

- covers: `VER-SRR-004`, `VER-SRR-006`

### REQ-SRR-005：CLI 与本地账本边界

正式 CLI MUST 直接在本地账本上执行任务、run、receipt、owner、revision、operation identity 和恢复操作，并复用账本现有的锁、幂等、冲突拒绝和未知副作用对账合同。

相同 operation identity 的重试 MUST 收敛到同一事实；owner、revision、账本锁或授权冲突 MUST 拒绝写入；重复请求不得创建重复事件或推进错误的 revision。

CLI 账本写入 MUST NOT 经过 viewer gateway、通用 HTTP mutation 或额外的跨进程 handshake；gateway 只负责 viewer 访问和实时观察。

- covers: `VER-SRR-007`, `VER-SRR-008`

### REQ-SRR-006：Gateway 与 release worker 边界

每个用户服务 MUST 只有一个 loopback viewer gateway，负责鉴权、SSE、run 路由和 viewer 资源访问；gateway MUST 能同时服务授权范围内的多个 run。

每个活动 release MUST 由带有 release identity 的 worker 提供内部服务；gateway 到 worker MUST 使用 owner-only service root 下的私有 Unix socket，worker MUST NOT 监听公开 TCP 端口或绕过 gateway 暴露 HTTP。

gateway 路由、socket 路径、worker 进程和 release identity MUST 互相绑定；未知 release、错误 run、错误 owner、失效代际或过期 worker MUST 被拒绝，且不同 run/release 之间不得串读或串写。

- covers: `VER-SRR-009`, `VER-SRR-010`

### REQ-SRR-007：代际、PID、租约与崩溃恢复

服务状态 MUST 记录真实 PID、generation、phase、release identity 和 lease expiration；启动、健康、停止和恢复 MUST 使用代际与 PID fencing，旧进程不得继续写入新代际状态。

Agent lease 与 browser lease MUST 独立续租、独立过期并使用有界 TTL；租约过期、正常停止、worker 崩溃和 gateway 重启 MUST 产生可观测状态，不得假装 run 成功或自动重复副作用。

过期或崩溃恢复 MUST 保留账本、receipt、历史文件、owner、revision 和可恢复的 release 证据；清理只能作用于明确的服务临时资源，不得删除历史 run 或影响其他 lease。

- covers: `VER-SRR-011`, `VER-SRR-012`

### REQ-SRR-008：读取兼容与只读 fallback

最新 reader MUST 同时读取当前格式与已支持的历史格式，并在升级前对保留 run 执行实际读取检查；不能证明安全读取的 run MUST 阻止升级或进入显式 fallback。

旧 reader 只允许在最新 reader 无法证明安全而旧 release 能证明安全时，以隔离、只读、受限的 fallback 读取；fallback MUST NOT 写 owner、revision、receipt、ledger、run 状态或任何业务副作用。

fallback MUST 绑定明确 release、run、owner 和只读证据，禁止执行命令、发布、迁移、删除、租约续写或通用 mutation；读取失败必须可区分为“不支持格式”“数据损坏”“权限失败”或“服务故障”。

- covers: `VER-SRR-013`, `VER-SRR-014`

### REQ-SRR-009：机械迁移与历史保留

自动迁移只允许确定性、机械、幂等、可恢复且不需要语义推断的格式转换；迁移前 MUST 保留备份，迁移后 MUST 校验 digest、revision、格式版本和可逆恢复路径。

迁移中断、重复执行、digest 不匹配、revision 冲突或恢复失败 MUST 停止并保留原始历史；历史内容 MUST NOT 自动清理，兼容代码删除 MUST 作为独立的 release-level owner 决策。

迁移、fallback 和拒绝路径的测试 MUST 持续保留，且 MUST 覆盖最新 reader、旧 reader、损坏输入、未知版本和不可证明安全的输入。

- covers: `VER-SRR-015`, `VER-SRR-016`

### REQ-SRR-010：PR label 与发布资格

技能发布 PR MUST 恰好带有一个 `release:skill`、`release:skill-initial-publication` 或 `release:skip` label；缺少、重复、冲突或在构建后改变 label MUST 使发布资格失效并要求重新验证。

`release:skip` MUST 明确记录跳过原因，不得改变 canonical package version、compatibility line、merge SHA 或发布 tag；`release:skill` MUST 校验 SemVer 单调性、版本未占用、package projection、compat line 和完整包内容；`release:skill-initial-publication` MUST 仅允许 canonical identity 与 protected main 相同、exact npm version 尚未注册且 owner approval 锁定同一 merge SHA、build ID 和 tarball digest 的首次 registry publication。

发布资格检查 MUST 重新确认目标基线、PR 合并状态、实际 merge SHA、label、计划版本和工作区清洁状态，不得把草稿、未合并分支或历史成功结果当作当前发布事实。

- covers: `VER-SRR-017`, `VER-SRR-018`

### REQ-SRR-011：受保护合并与源身份

发布 MUST 只能从已保护分支的实际 merge receipt 开始，并绑定不可变 `merge_sha`；构建输入的 source SHA MUST 等于该精确 merge SHA，不能使用合并前分支 HEAD 或本地相近提交。

包、viewer/service manifest、build ID、tarball digest 和 Git tag MUST 能反向证明它们来自同一个 merge SHA 与 package version；缺少 merge receipt、source 不干净或身份字段不一致 MUST 阻止发布。

构建过程 MUST 固定源快照、运行时版本、依赖解析和生成资源；源 SHA、候选 SHA、工作区 dirty 状态或文件清单变化 MUST 使候选失效。

- covers: `VER-SRR-019`, `VER-SRR-020`

### REQ-SRR-012：单 tarball 发布

发布 MUST 只构建一次完整 tarball，并在发布前计算、记录和校验其字节摘要、文件清单和 package identity；验证与实际 npm 上传 MUST 使用同一 tarball。

发布 promotion、重试或移动 dist-tag MUST NOT 重新构建；tarball 字节、文件数量、摘要、package version、compat line 或 manifest 任一变化 MUST 视为不同候选并停止当前发布。

发布失败或网络响应不明确时 MUST 按 package identity、merge SHA、tag 和 tarball digest 对账后再重试，不得盲目重复上传可能已成功的副作用。

- covers: `VER-SRR-021`, `VER-SRR-022`

### REQ-SRR-013：不可变 tag 与 dist-tag

每个 package version MUST 绑定不可移动、可恢复的 Git tag `multi-task-flow-vX.Y.Z`；已有 tag 只有在其精确指向相同 merge SHA 且 package identity 完全一致时才可复用。

发布流程 MUST NOT 覆盖、移动或删除已存在的 tag；tag 冲突、候选身份不一致或 tag 保护失败 MUST 进入人工对账，不得用 force 操作修复。

npm exact SemVer 发布成功后，流程才可按声明顺序移动 `compat-vN` 和 `latest`；`stable` 只有在发布意图显式声明时才可移动。并发发布和中断恢复 MUST 以 tag、registry metadata、tarball digest 和 merge SHA 的身份对账收敛。

- covers: `VER-SRR-023`, `VER-SRR-024`

### REQ-SRR-014：文档与操作恢复

发布包与仓库文档 MUST 说明 CLI 入口、安装前置条件、外部 npm scope/auth、版本矩阵、compat line、viewer/gateway/worker 边界、lease/TTL、迁移、回滚、tag、label 和失败恢复。

恢复文档 MUST 给出可验证的 identity-first 操作顺序，并明确哪些情况必须停止等待 owner；不得把删除历史、移动 tag、强制重建、重复 mutation 或绕过保护检查作为默认恢复步骤。

运行时和发布日志 MUST 记录足以对账的 package version、compat line、merge SHA、build ID、tag、tarball digest、release identity、generation、PID、run 和 lease，而不得输出凭据或敏感内容。

- covers: `VER-SRR-025`, `VER-SRR-026`

## Verification

### VER-SRR-001

- Method: 在独立临时目录安装生成的 npm tarball，断开父仓库、全局 Skill 和相邻 workspace，并按清单验证入口、资源和导入闭包。
- covers: `REQ-SRR-001`, `REQ-SRR-002`
- Pass condition: 独立目录可以运行正式 CLI 和 viewer 所需入口，缺失 Bun、依赖、资源或摘要时 fail closed，且没有从源 checkout 或全局 Skill 回退。

### VER-SRR-002

- Method: 对包内文件、manifest、源提交、build ID、package version、compat line、合同版本和 tarball digest 做确定性重算与交叉校验。
- covers: `REQ-SRR-001`, `REQ-SRR-003`, `REQ-SRR-011`, `REQ-SRR-012`
- Pass condition: 每个身份字段都有唯一来源，任一字段漂移会使候选或发布验证失败，同一候选可从 tarball 反向证明精确 merge SHA。

### VER-SRR-003

- Method: 使用 Bun `1.4.4`、错误 Bun 版本、缺失依赖、Node-only 环境和含源 checkout 的临时目录执行安装与启动矩阵。
- covers: `REQ-SRR-002`
- Pass condition: 只有明确满足 Bun 与依赖前置条件的独立安装成功，其他场景输出可行动错误且不执行隐式安装或回退。

### VER-SRR-004

- Method: 运行 SemVer、compat line、合同版本、build ID、source SHA、merge SHA 和 digest 的重复、回退、非法格式与交叉身份测试。
- covers: `REQ-SRR-003`, `REQ-SRR-004`
- Pass condition: 版本或来源不一致在构建前被拒绝，兼容线由显式 metadata 决定且不从 dist-tag 或调用者输入推断。

### VER-SRR-005

- Method: 对同一 package version、compat line 和 tag 执行首次、重复、回退、并发和跨 release candidate 的发布资格检查。
- covers: `REQ-SRR-003`, `REQ-SRR-004`, `REQ-SRR-013`
- Pass condition: 相同完整身份可安全重放，不同身份不能复用已有版本、tag 或兼容线。

### VER-SRR-006

- Method: 用固定 compat line 的新旧 CLI、不同输入输出合同和破坏性候选执行并行读写与升级测试。
- covers: `REQ-SRR-004`
- Pass condition: 非 breaking 修复留在原 line，breaking 变化建立新 line，旧 line 的策略明确且旧输入输出不被静默改变。

### VER-SRR-007

- Method: 对 CLI 本地账本执行重复 operation identity、竞争 owner/revision、锁冲突、未知副作用、重启和恢复测试。
- covers: `REQ-SRR-005`
- Pass condition: 相同请求只产生一个事实，冲突拒绝，账本写入不经过 viewer HTTP，未知结果保留并可对账。

### VER-SRR-008

- Method: 检查 CLI、gateway、SSE 和 worker 的进程边界，并注入 gateway 不可用、worker 不可用、错误 owner、错误 run 与错误 release。
- covers: `REQ-SRR-005`, `REQ-SRR-006`
- Pass condition: CLI 仍直接使用账本，gateway 是唯一 viewer HTTP 入口，错误路由和跨边界 mutation 被拒绝。

### VER-SRR-009

- Method: 启动多个 run 与多个 release worker，验证 loopback gateway 路由、SSE 订阅、私有 Unix socket 权限和 worker 端口暴露情况。
- covers: `REQ-SRR-006`
- Pass condition: 单一 gateway 可观察授权 run，worker 仅经私有 socket 服务，任何公开 worker TCP 入口和跨 run/release 数据泄漏均不存在。

### VER-SRR-010

- Method: 以错误 release identity、失效 socket、owner 变化、run 不存在、generation 不匹配和 socket 权限篡改执行请求矩阵。
- covers: `REQ-SRR-006`
- Pass condition: 所有不匹配请求在到达业务副作用前拒绝，并保留可对账的失败证据。

### VER-SRR-011

- Method: 注入真实 PID/generation 变化、旧进程延迟写入、gateway 重启、worker 崩溃、正常 stop 和启动健康超时。
- covers: `REQ-SRR-007`
- Pass condition: 旧代际被 fencing，状态只接受当前 PID/generation，崩溃不伪造成功且恢复路径可重放。

### VER-SRR-012

- Method: 对 Agent lease 与 browser lease 分别续租、过期、停止和并发运行，检查 TTL、宽限期、账本与其他 run 的保留情况。
- covers: `REQ-SRR-007`
- Pass condition: 两类 lease 独立收敛，过期只清理其服务临时状态，不删除账本或影响其他 lease/run。

### VER-SRR-013

- Method: 用当前格式、每个支持的历史格式、未知格式、损坏内容和保留 run 执行最新 reader 的升级前读取检查。
- covers: `REQ-SRR-008`
- Pass condition: 最新 reader 可证明的历史格式双读成功，不能证明安全的 run 阻止升级或进入明确 fallback。

### VER-SRR-014

- Method: 通过旧 reader fallback 执行读取、SSE、命令、迁移、删除、租约续写和 ledger mutation 负向测试。
- covers: `REQ-SRR-008`
- Pass condition: fallback 只能隔离只读，不能改变 owner、revision、receipt、ledger、run 状态或任何业务副作用。

### VER-SRR-015

- Method: 执行机械迁移的首次、重复、中断、digest 不匹配、revision 冲突、备份恢复和权限失败测试。
- covers: `REQ-SRR-009`
- Pass condition: 只有确定性、幂等、可恢复迁移自动执行；失败保留原始历史并提供可验证备份与恢复证据。

### VER-SRR-016

- Method: 检查历史格式、fallback、迁移、拒绝、损坏和兼容代码清理的测试保留策略。
- covers: `REQ-SRR-009`
- Pass condition: 历史内容不自动清理，删除兼容代码需要独立 release-level 决策，所有拒绝路径持续可回归。

### VER-SRR-017

- Method: 对缺少 label、两个 label、错误 label、label 在构建后变化、draft PR、未合并分支和目标基线变化执行 PR gate 测试。
- covers: `REQ-SRR-010`
- Pass condition: PR 恰有一个合法 label 且基线与合并状态重新验证后才具备发布资格，其他情况明确阻断。

### VER-SRR-018

- Method: 对 `release:skip`、`release:skill`、`release:skill-initial-publication`、版本重复/回退、package projection 和 compat line 的发布候选执行资格矩阵。
- covers: `REQ-SRR-010`
- Pass condition: `release:skip` 不改变 canonical identity，`release:skill` 只接受版本未占用、内容完整且身份一致的候选，`release:skill-initial-publication` 只接受 exact npm version 缺失且 canonical identity 与 main 一致的候选。

### VER-SRR-019

- Method: 生成受保护分支 merge receipt，比较 merge SHA、构建 source SHA、候选 SHA、工作区 dirty 状态和包 manifest。
- covers: `REQ-SRR-011`
- Pass condition: 只有精确 merge SHA 的干净快照可构建，任何源漂移或缺少保护合并证据都会阻断。

### VER-SRR-020

- Method: 从 package tarball、viewer/service manifest、build ID、tag 和 registry metadata 反向验证同一 package version 与 merge SHA。
- covers: `REQ-SRR-011`, `REQ-SRR-013`
- Pass condition: 所有身份指向同一候选；不一致时不得发布、移动 tag 或 promotion。

### VER-SRR-021

- Method: 对单次构建的 tarball 执行文件清单、摘要、安装、测试和模拟 npm 上传的字节比对。
- covers: `REQ-SRR-012`
- Pass condition: 验证和上传使用同一 tarball，内容或摘要变化被识别为新候选。

### VER-SRR-022

- Method: 在上传成功、超时、网络断开、registry 响应不明确、promotion 中断和并发发布后按 identity 执行恢复对账。
- covers: `REQ-SRR-012`, `REQ-SRR-013`
- Pass condition: 恢复先读取 tag、registry、digest 和 merge SHA，再决定重试或停止，不重复未知副作用。

### VER-SRR-023

- Method: 对不存在 tag、相同身份已有 tag、不同 merge SHA 同名 tag、tag 被移动或删除的场景执行保护测试。
- covers: `REQ-SRR-013`
- Pass condition: `multi-task-flow-vX.Y.Z` 只可创建或复用相同完整身份，不能移动、覆盖或 force 修复冲突 tag。

### VER-SRR-024

- Method: 按 exact SemVer、`compat-vN`、`latest` 和显式 `stable` 的顺序模拟发布、失败和并发 promotion。
- covers: `REQ-SRR-013`
- Pass condition: exact SemVer 成功后才移动声明的 dist-tag，未声明的 `stable` 不被修改，并发结果按完整 identity 收敛。

### VER-SRR-025

- Method: 从 CLI、README、操作手册和发布日志检查安装前置条件、版本矩阵、服务边界、TTL、迁移、tag、label、回滚和失败恢复的完整性。
- covers: `REQ-SRR-014`
- Pass condition: 新维护者可以根据文档定位正式入口、前置条件和停止边界，不依赖隐含源 checkout 或危险的删除/force 操作。

### VER-SRR-026

- Method: 检查成功、失败、过期、崩溃、fallback、恢复和发布对账日志中的 identity 字段，并执行敏感信息扫描。
- covers: `REQ-SRR-014`
- Pass condition: 日志足以按 package/version/line/merge/build/tag/digest/release/PID/generation/run/lease 对账，且不泄露凭据或敏感内容。

## Related ADRs

- [Bun 直接运行客户端与 Skills](../../adr/0021-bun-source-runtime.md)
- [Multi-task Flow proposal quality gates and execution boundary](../../adr/0026-multi-task-flow-proposal-quality-gates.md)
- [Viewer compatibility lifecycle](../../adr/0026-viewer-compatibility-lifecycle.md)
- [Multi-task Flow version propagation and safe migration](../../adr/0028-multi-task-flow-version-propagation-and-safe-migration.md)
- [Skill runtime release and service boundary](../../adr/0029-skill-runtime-release-and-service-boundary.md)

## References

- [客户端 Skills 与工程执行支持](../client-skills/SPEC.md)
- [统一手动版本发布](../manual-version-release-delivery/SPEC.md)
- [实现说明](IMPLEMENTATION.md)
- [兼容历史](HISTORY.md)

## Owner-facing operation references

- [客户端 package 与 service 运维入口](../../../clients/typescript/README.md)
- [Multi-task Flow Skill runtime 与 viewer 生命周期](../../../skills/multi-task-flow/SKILL.md)
- [Skill release workflow runbook](../../../.github/workflows/README.md)
