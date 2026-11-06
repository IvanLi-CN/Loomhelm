---
title: 不可变蓝绿发布的控制器门禁与故障恢复
module: deployment
problem_type: deployment
component: deployment-controller
tags:
  - blue-green
  - immutable-release
  - worker-fencing
  - readiness
  - drain
  - caddy
  - docker-compose
status: active
related_specs:
  - docs/deployment.md
  - docs/adr/0014-deployment-control-plane-and-blue-green.md
---

# Context

蓝绿部署的核心是让同一个不可变候选依次通过 `register -> preflight -> stage -> promote`，由控制器证明候选身份、运行状态和流量切换结果，而不是依赖人工修改 Compose 环境或直接操作数据库。

本文适用于已经具备 blue/green 槽位、稳定入口和 deployment controller 的项目，重点记录发布控制面在真实部署中容易暴露的边界条件，以及如何让失败可重试、可审计、可回滚。

# Symptoms

候选的 Web 静态文件已经发布，但 preflight 按 candidate ID 查找时找不到，通常是发布目录使用了 source SHA 或构建目录名，而运行时契约要求使用 candidate digest。

控制器镜像能够构建，但运行时 allowlist 指向的 `/usr/bin/docker`、`/usr/local/bin/caddy` 或 Compose profile 不存在，导致预检在执行阶段失败。

Caddy 配置本身有效，但控制器把 reload 专用的 admin address 无条件传给 `validate`，使配置验证命令因不支持的参数失败。

新 Server 或 Worker 只是在启动窗口内暂时返回非 2xx，控制器的一次性 readiness 请求却把它判定为 stage 失败。

Promote 已经完成 active route、slot 和新 Worker lease 的提交，但旧 Worker 在 drain 窗口内没有退出；如果把这个结果标成 succeeded，会掩盖旧实例仍可能处理任务的事实。

# Root Cause

候选身份没有形成单一、可比较的发布契约。source SHA、candidate/artifact digest、Web tree digest、Server/Worker image digest 和 state compatibility 分散在不同配置中，控制器无法证明所有运行组件属于同一个候选。

命令 allowlist、Caddy 子命令参数和 Compose 运行环境没有一起做运行时验证。Dockerfile 构建成功只说明文件存在于构建上下文，不说明控制器容器内的实际路径、socket 权限、网络别名和 profile 可执行。

启动就绪被错误建模为瞬时事件。容器启动、数据库连接、迁移检查和 HTTP 服务监听存在正常延迟，因此 readiness 需要有限时长内的重试，而不是单次采样或无限等待。

Worker lease 的 generation 是 fencing 机制的一部分。旧 Worker drain 失败不能通过降低 generation、清空 lease 或复用旧 generation 修复；必须让新 Worker 使用严格递增的 generation，并把旧实例的退出结果单独记录。

旧 Worker 可能在收到 drain 请求前就因 generation fencing 退出。此时控制器若把 Worker 的连接拒绝、连接重置、EOF 或内部 DNS 解析失败当成普通 drain 失败，就会把已经停止的旧槽位长期留在 degraded 状态。

# Resolution

把候选 manifest 作为所有阶段的唯一输入，至少绑定 source SHA、candidate/artifact digest、Web tree digest、Server image digest、Worker image digest 和 state compatibility。重试复用同一候选身份，不重新构建或覆盖已发布内容。

将 CI 产出的候选包与安装侧的运行时交付分层处理：候选包证明构建产物及其 manifest，安装流程还必须为 Server/Worker 生成不可变镜像引用、按 candidate ID 发布 Web tree，并生成绑定这些身份和兼容性范围的 deployment envelope。只有这组身份全部可验证后，候选才具备进入控制器注册和切换流程的条件。

统一 Web 发布目录契约，例如 `<web-root>/candidates/<candidate_id>`，并在 register、preflight 和 Caddy 配置校验中使用同一 candidate ID。source SHA 可以作为版本信息，但不能替代运行时发布目录身份。

在 preflight 中实际执行控制器容器内的 Docker、Compose、Caddy、Docker socket、网络和 profile 检查；同时为每个 Caddy 子命令分别生成参数，`validate` 只验证配置文件，`reload` 才连接私有 admin address。

在 stage 和 promote 中对 Server/Worker readiness 使用有界重试，例如固定超时和短间隔轮询。超时必须返回带最后一次错误的 failed 或 unknown 结果，不能因重试而无限占用控制器。

Promote 按可审计顺序提交：先确认新槽位 identity、readiness 和 Worker generation，再更新 active route 和 durable lease，随后执行旧槽位 drain。traffic share、Worker capacity 和公网探测属于独立的运行时观测与切换后验证；首次接入安装前必须在运行时演练中证明这些观测，而不能把单次采样当作同步 promote 前门禁。旧槽位 drain 超时但新 active 状态已经被控制器证明时，结果应为 `degraded`；若 active 状态或外部副作用无法证明，则保持 `unknown` 并先 reconcile。

Drain 应按“Server 先、Worker 后”的顺序执行。Server 已接受 drain 后，若 Worker 端点明确返回连接关闭、连接拒绝、连接重置、EOF 或内部 DNS 解析失败，说明 Worker 已经不再监听，控制器应将其视为幂等完成并继续等待 Server 进入非就绪状态；HTTP 错误、超时和其他无法证明 Worker 已停止的错误仍必须失败，不能一概吞掉。控制面允许对已经记录为 `retained` 的非活动槽位再次发起 drain，用于清理上次 promote 的降级收尾，但不允许借此绕过 active slot 的切换或恢复校验。

发布完成后保留旧槽位、旧候选和持久化数据，回滚通过认证 API、Idempotency-Key 和 expected fingerprint 执行。禁止用直接 SQL 修改 active slot、lease generation 或 operation status 来“修复”发布结果。

为控制面划分独立的内部网络：Caddy admin 只绑定管理网络地址，部署控制器同时加入管理网络和专用 drain control 网络，候选 Server/Worker 不加入管理网络。候选流量网络、控制器的排空网络和 Caddy admin 网络要使用不重叠的子网；这样候选代码即使能访问应用网络，也不能直接调用 Caddy reload 或修改稳定入口。控制器访问槽位时使用带末尾点的绝对内部 DNS 名称，例如 `server-green.`，避免已停止的 Compose 服务因宿主机 DNS search domain 被解析到公网同名主机。

Reconcile 必须是幂等的。先以不重建的方式确保目标 Server 存在，再用有界 readiness 探测和精确运行身份探测判断是否已经满足目标；只有明确证明目标处于 draining 或身份不匹配时才 force-recreate。网络超时、临时 5xx、仍在启动或身份字段不完整的状态只能返回“无法证明”，不能停止一个可能已经承接流量的 Server。Worker 的启动、generation 校验和失败清理随后执行；Worker 的观测失败、未 ready 或缺失 generation 也只能保留当前实例并返回 `unknown`，等待后续 reconcile，只有明确 generation 不匹配才清理并恢复旧 Worker。回滚恢复 Server 时也要先恢复并证明 Server，再恢复 Worker，避免把半恢复槽位当作可服务状态。

观测健康度应以当前 active 槽为硬门槛。旧槽完成排空后进入 `draining` 或 `retained` 状态并停止容器是正常清理结果；旧槽的 `/-/observe` 不可达时，可以保留该槽的不可观测明细，但不能仅因此把整套安装标记为 degraded。公网 `/version` 必须仍与 active 槽身份匹配，active Server/Worker 的 readiness、generation 和错误率仍必须持续核对。

浏览器端跨路由或跨版本共享的创建意图至少包含逻辑 `commandId`、请求 fingerprint 和本次 `attemptId`。兼容键应一次性写入，并在部分写入失败时尽力恢复原值；晚到的旧页面只能更新或清理仍匹配同一 attempt 的记录。相同逻辑命令但不同 attempt 的兼容键应按冲突处理并失败关闭，不能猜测哪个页面更新，也不能让旧版本清理新版本的恢复身份。

# Guardrails / Reuse Notes

候选身份必须在所有阶段保持不可变；镜像和静态资源使用 digest 或等价的内容指纹，禁止用未验证的 `latest` 覆盖已运行槽位。

控制器的执行路径应有独立测试覆盖：Caddy `validate` 与 `reload` 参数、容器内 allowlist 路径、首次 readiness 失败后的重试、readiness 超时，以及 drain 超时后的状态转换。

Drain 测试还必须覆盖 Worker 已因 fencing 退出后端口关闭的重试场景，并确认 Server readiness 仍是完成条件；不能只测试 Server 和 Worker 同时在线的理想路径。

控制面网络拓扑应有静态检查，覆盖 Caddy admin 绑定地址、控制器双网络身份、控制器固定 drain 来源地址、动态 IP 池排除固定地址和候选服务不加入 admin 网络；reconcile 测试应同时覆盖已就绪目标不被重建、明确 draining 目标先恢复、瞬时探测失败不重建，以及直接回滚的 Server-before-Worker 顺序。浏览器创建恢复测试应覆盖部分兼容键写入失败、不同 attempt 冲突、旧回调无法清理新 attempt，以及兼容键删除失败时仍保留恢复状态。

Worker generation 只能单调递增。旧 lease、旧 crash-loop 实例和新 Worker 接管之间的关系必须进入操作记录，不能通过清库、降级或复用 generation 绕过 fencing。

蓝绿切换前必须验证新槽位的 `/readyz`、运行身份和 Worker generation；切换后必须验证公网 `/version`、`/readyz`、关键静态资源和控制器查询结果，并在连续观测中核对 traffic share、Worker capacity 与负载。首次运行时演练还必须证明这些观测可用且与实际路由一致。

`degraded` 表示核心切换已被证明，但非关键收尾步骤失败；`unknown` 表示无法证明外部状态。两者都不能被自动改写为 succeeded，后续动作应由 reconcile 或明确的人工运行手册处理。

CI、静态 Compose 校验和运行时演练是不同门禁。CI 通过不能替代容器内命令路径、Docker socket、网络、真实 readiness、drain 和公网路由证据。

# References

- [Deployment Control](../../deployment.md)
- [ADR 0014: Deployment Control Plane and Blue-Green](../../adr/0014-deployment-control-plane-and-blue-green.md)
- `internal/deployment/executor.go`
- `internal/deployment/executor_test.go`
- `deploy/production/compose.yaml`
