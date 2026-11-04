---
title: 单安装实例的不可变蓝绿部署与控制器故障恢复
module: deployment
problem_type: deployment
component: deployment-controller
tags:
  - blue-green
  - immutable-release
  - worker-fencing
  - caddy
  - docker-compose
  - single-installation
status: active
related_specs:
  - docs/deployment.md
  - docs/adr/0014-deployment-control-plane-and-blue-green.md
---

# Context

当一个已有单槽 Docker Compose 安装需要迁移到双 Server/Worker 槽位时，目标不是简单复制一份 Compose 文件，而是先把现有运行身份纳入控制器的状态模型，再用同一个不可变候选完成预检、stage 和 promote。

本次 101 安装原本运行 source SHA `f2b8bd1d3113d851822c4904517557734ae727b5`，Worker durable generation 为 `2`，数据库只完成到 migration `00020`，公开流量由旧的单槽 Caddy 提供；目标候选 source SHA 为 `a4e7b0c4afd6434221a08e1d3305393488a2ef92`，candidate digest 为 `96d9694a46331609c0643f109c156bfd93f66bf24f5f52167e3f968db4cd7924`。

# Symptoms

生产模板已经存在，但 101 上仍是单槽部署，数据库没有 deployment control 表，不能直接从浏览器执行标准蓝绿操作。

旧 Worker 使用 generation `2` 反复启动失败，日志报告 durable lease 已经处于 generation `2`；重置 lease 或降低 generation 都会破坏 fencing 语义。

第一次 preflight 失败的原因是候选 Web 树使用了 source SHA 目录名，而控制器按照 candidate digest 查找 `/candidates/<candidate_id>`；第二次 preflight 失败的原因是控制器镜像中没有 `/usr/bin/docker`，只有 `/usr/local/bin/docker`。

修复镜像路径后，preflight 仍因 Caddy `validate` 子命令收到不支持的 `--address` 参数而失败；stage 又暴露出控制器只探测一次 `/readyz`，会在新 Server 启动完成前误判失败。

旧单槽 Worker 在首次 promote 时无法完成 drain，因此 promote 的终态是 `degraded`，而不是把 drain 失败伪装成 `succeeded`；active route 和数据库状态仍然已经切换到 green。

# Root Cause

单槽迁移缺少显式 adoption 步骤，控制器不知道当前线上 source、artifact、Web、镜像和 Worker generation 属于哪个 slot；没有 adoption 就无法安全计算 CAS fingerprint，也无法判断 green 是否真的是 inactive slot。

候选身份、Web 目录名和 Compose 镜像引用使用了不同的命名约定：候选文件按 source SHA 保存，控制器的运行时 Web 校验按 candidate digest 保存，导致静态文件存在但控制器无法证明它属于注册候选。

控制器的命令 allowlist 与 Caddy CLI 的子命令参数没有分开建模，`--address` 只适用于通过 admin API 执行的 `reload`，不适用于 `validate`。

stage 与 promote 的启动路径把 readiness 当成一次性请求处理，而 Docker 容器启动、数据库连接和应用迁移完成需要一个有界的等待窗口。

旧 Worker 已经处于 stale generation restart loop，不能通过提升新 Worker 前的普通 drain 恢复；正确处理是让新 Worker 使用严格更大的 generation 接管 lease，并把旧 Worker 的 drain 失败记录为 degraded，之后停止明确的 legacy 容器。

# Resolution

先通过 CI artifact 和 `scripts/promote-candidate` 校验候选 manifest、source SHA、candidate digest、Web digest、二进制 checksum 和 tarball checksum，没有在 101 上重新构建候选 Server/Worker。

在 101 上保留 PostgreSQL、`loomhelm-artifacts`、旧 release、Traefik 和原始备份，新增安装专用的双槽 Compose、私有 Caddy admin network、candidate Web 树和独立 deployment controller；控制器镜像使用固定的 Docker/Caddy 基础镜像摘要和本地镜像配置摘要。

控制器启动后应用 migration `00021` 及后续迁移，以旧 release 的精确身份建立 blue adoption：旧 candidate digest、source SHA、artifact digest、Web digest、旧镜像摘要和 Worker generation `2` 都进入数据库，`next_worker_generation` 从 `3` 开始。

通过真实 OIDC owner 会话注册 deployment envelope，然后按 `preflight -> stage -> promote` 顺序执行；candidate Web 树同时以旧 candidate digest 和新 candidate digest 发布，Caddy 只读挂载同一份 Web root。

控制器修复包含两项行为：Caddy `validate` 不再附带 admin address，Server/Worker readiness 在固定的 2 分钟窗口内以 100ms 间隔重试；控制器镜像另外提供 `/usr/bin/docker` 到 `/usr/local/bin/docker` 的兼容入口。

最终 active slot 为 `green`，active candidate 为 `96d9694a46331609c0643f109c156bfd93f66bf24f5f52167e3f968db4cd7924`，Worker durable generation 为 `4`，公开 `/version`、`/readyz` 和首页 asset 均返回新候选身份；旧单槽 Web、Server、Worker 容器已停止，PostgreSQL 和 artifact volume 未停止或删除。

# Guardrails / Reuse Notes

候选的可重试身份必须至少绑定 source SHA、candidate/artifact digest、Web tree digest、Server image `@sha256`、Worker image `@sha256`、state compatibility 和 migration mode；重试使用同一个身份，不重新构建或覆盖已发布候选。

Web 树路径统一使用 candidate digest：`<web-root>/candidates/<candidate_id>`；source SHA 只能作为 manifest 中的运行时身份，不能替代 Web 发布目录名。

安装级 adoption 是一次性的 bootstrap 边界，应该单独备份、记录 fingerprint 和旧 Worker generation；候选注册、preflight、stage、promote、rollback 和 reconcile 仍然必须经过认证 API、Idempotency-Key 和 expected fingerprint。

控制器镜像必须在容器内实际验证 `/usr/bin/docker`、`/usr/local/bin/caddy`、Docker socket 权限、Compose profile 和外部网络；只验证 Dockerfile 能构建不能证明 allowlist 路径可执行。

Caddy CLI 参数按子命令测试：`validate` 只验证配置文件，`reload` 才通过私有 admin address 连接运行中的 Caddy；不要把所有全局参数无条件附加到每个子命令。

Server 和 Worker 的 readiness 必须使用有界重试，避免把正常启动延迟误判为 stage 失败，也避免在进程永久失败时无限等待；超时应留下可审计的 failed 或 unknown 结果。

Worker generation 只能单调递增，旧 lease 不能通过清库、降级或复用 generation 修复；新 Worker 接管后再停止明确的 legacy crash-loop 容器，保留旧 release 供 rollback 证据使用。

首次从单槽切换时，稳定 Caddy 可以先以旧 blue 身份接管 Traefik，再由控制器完成 green route 切换；旧 Web fallback、数据库、artifact volume 和 Traefik labels 必须在验证完成前保留。

Promote 的 `degraded` 与 `unknown` 语义不同：本次 active route、slot 状态和新 Worker lease 都已被控制器证明，但旧 Worker drain 因既有 crash loop 失败，所以记录 `degraded`；若外部结果无法证明，则必须保持 `unknown` 并先 reconcile。

Agent VM 运行时演练是独立门禁。本次因宿主 Incus storage capacity verification 失败未执行 runtime rehearsal，不能用 CI 成功或静态 Compose config 代替该证据；101 的 live deployment 证据必须单独记录。

# References

- [Deployment Control](../../deployment.md)
- [ADR 0014: Deployment Control Plane and Blue-Green](../../adr/0014-deployment-control-plane-and-blue-green.md)
- `internal/deployment/executor.go`
- `internal/deployment/executor_test.go`
- `deploy/production/compose.yaml`
