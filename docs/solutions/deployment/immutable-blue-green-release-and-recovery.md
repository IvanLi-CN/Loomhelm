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

# Resolution

把候选 manifest 作为所有阶段的唯一输入，至少绑定 source SHA、candidate/artifact digest、Web tree digest、Server image digest、Worker image digest 和 state compatibility。重试复用同一候选身份，不重新构建或覆盖已发布内容。

统一 Web 发布目录契约，例如 `<web-root>/candidates/<candidate_id>`，并在 register、preflight 和 Caddy 配置校验中使用同一 candidate ID。source SHA 可以作为版本信息，但不能替代运行时发布目录身份。

在 preflight 中实际执行控制器容器内的 Docker、Compose、Caddy、Docker socket、网络和 profile 检查；同时为每个 Caddy 子命令分别生成参数，`validate` 只验证配置文件，`reload` 才连接私有 admin address。

在 stage 和 promote 中对 Server/Worker readiness 使用有界重试，例如固定超时和短间隔轮询。超时必须返回带最后一次错误的 failed 或 unknown 结果，不能因重试而无限占用控制器。

Promote 按可审计顺序提交：先确认新槽位 identity、readiness、traffic 和 Worker capacity，再更新 active route 和 durable lease，最后执行旧槽位 drain。旧槽位 drain 超时但新 active 状态已经被控制器证明时，结果应为 `degraded`；若 active 状态或外部副作用无法证明，则保持 `unknown` 并先 reconcile。

发布完成后保留旧槽位、旧候选和持久化数据，回滚通过认证 API、Idempotency-Key 和 expected fingerprint 执行。禁止用直接 SQL 修改 active slot、lease generation 或 operation status 来“修复”发布结果。

# Guardrails / Reuse Notes

候选身份必须在所有阶段保持不可变；镜像和静态资源使用 digest 或等价的内容指纹，禁止用未验证的 `latest` 覆盖已运行槽位。

控制器的执行路径应有独立测试覆盖：Caddy `validate` 与 `reload` 参数、容器内 allowlist 路径、首次 readiness 失败后的重试、readiness 超时，以及 drain 超时后的状态转换。

Worker generation 只能单调递增。旧 lease、旧 crash-loop 实例和新 Worker 接管之间的关系必须进入操作记录，不能通过清库、降级或复用 generation 绕过 fencing。

蓝绿切换前必须验证新槽位的 `/readyz`、运行身份、流量观察和 Worker capacity；切换后必须再次验证公网 `/version`、`/readyz`、关键静态资源和控制器查询结果。

`degraded` 表示核心切换已被证明，但非关键收尾步骤失败；`unknown` 表示无法证明外部状态。两者都不能被自动改写为 succeeded，后续动作应由 reconcile 或明确的人工运行手册处理。

CI、静态 Compose 校验和运行时演练是不同门禁。CI 通过不能替代容器内命令路径、Docker socket、网络、真实 readiness、drain 和公网路由证据。

# References

- [Deployment Control](../../deployment.md)
- [ADR 0014: Deployment Control Plane and Blue-Green](../../adr/0014-deployment-control-plane-and-blue-green.md)
- `internal/deployment/executor.go`
- `internal/deployment/executor_test.go`
- `deploy/production/compose.yaml`
