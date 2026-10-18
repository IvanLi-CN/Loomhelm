# Loomhelm

Loomhelm 是面向个人与小型团队的自部署项目管理与 Agent 工作台。

项目将提供 Web/PWA、API 与 MCP 入口，把项目、任务层级与依赖、单一执行环境中的 Codex 对话、审批和对话文件连接起来。顶部入口为工作台、任务，下方“对话”分组列无项目对话，项目树直接列各项目对话；工作台可进入全部对话。任务提供列表、看板与图谱，并支持多端连续工作与共享草稿。

当前仓库处于工程初始化阶段，尚未提供可运行的产品。

## Architecture

- Go + chi 提供 HTTP 入口；Server、Worker、Connector 分进程运行。
- PostgreSQL 保存业务与执行事实，pgx/sqlc 负责访问，goose 管理迁移，River 承担短派发与对账作业。
- Go Connector 从预配置的单一执行环境主动连接平台，并在执行机器内连接 Codex app-server；Codex 登录凭据保留在该机器。执行机器可以与平台分开部署，连接认证与撤销由部署管理负责。
- React/Vite/TypeScript 构建 Web/PWA，Bun workspaces 管理前端工程；产品界面在完整设计确认后实现。
- 非生产候选采用固定源码 SHA 和产物 digest，通过 Caddy 蓝绿切流；Worker 交接与共享状态兼容分别验证。

## Development

工具版本见 [tools/versions.env](tools/versions.env)。在仓库根目录运行 `scripts/setup` 检查 Git、固定版本的 Go/Bun/sqlc 和 Python 3.9+，准备 Markdown 工具、补齐缺失的 `.env.local` 并安装前端依赖；缺失、版本不匹配或安装失败会汇总后以非零状态退出。重复执行保留已有环境配置和 Git 钩子，linked worktree 与自定义 Git common directory 均受支持。Docker/Compose 在初始化时可选，运行数据库工作流时必需；sqlc 下载与摘要校验方式见 [开发说明](docs/development.md)。

前端使用 Bun 1.4.3：`bun run dev` 启动中性工程验证页，`bun run storybook` 查看基础组件。`bun run typecheck` 检查类型，`bun run build` 构建 Web/PWA，`bun run build:storybook` 构建 Storybook；`bun run check` 顺序执行这三项检查。Agent 的完整构建和运行验证使用会话 Agent VM，本机长驻预览服务先按端口租约约定启动。`scripts/dev` 按实际工作树路径隔离 Compose 项目、网络和数据卷；每个工作树仍须配置自己的获配端口。

开发环境和数据库命令见 [开发说明](docs/development.md)。Server 与 Worker 需要 `LOOMHELM_DATABASE_URL`，启动时连接 PostgreSQL，并在同一个跨进程迁移锁内应用 Goose 和 River 迁移；Connector 不连接数据库。使用开发 Compose 时，修改 `LOOMHELM_POSTGRES_PORT` 必须同步修改 URL 端口，并把同一工作树环境中的两项导出给进程；配置会在连接前拒绝不匹配的端口。`LOOMHELM_STARTUP_TIMEOUT` 默认 30 秒，`LOOMHELM_DATABASE_MIN_CONNS` 默认 0，`LOOMHELM_DATABASE_MAX_CONNS` 默认 4；连接数 0 交由数据库适配器继承。Worker generation 的持久化范围为 `1..9223372036854775807`。固定工具下载地址与 SHA256 见 [数据库工具清单](tools/database-toolchain.json)。

前端页面用于验证路由、providers、组件与 PWA 构建接入。业务 API、项目任务界面、Codex 控制和完整 PWA 安装更新体验仍待实现。基础持久化仅包含平台短作业及结果，不代表项目、对话或真实 Codex 执行已接通。工程截图与验证边界见 [实施覆盖](docs/specs/phase1-core/IMPLEMENTATION.md)。

Markdown 工具已提供固定版本入口：首次运行 `python3 tools/markdown.py setup`，检查使用 `python3 tools/markdown.py check`，格式修复使用 `python3 tools/markdown.py fix`。Lefthook 配置使用相同的固定工具检查暂存 Markdown；安装提交钩子必须显式选择 `python3 tools/markdown.py setup --install-hooks`，并保留已有钩子配置。

完整产品需求与一期验收见 [PRD](docs/PRD.md)，已确定的工程合同见 [项目规范](docs/specs/phase1-core/SPEC.md)，工程边界见 [AGENTS.md](AGENTS.md)。PRD 及相关业务规则须经主人明确确认后才能实施功能，产品 UI 还需完整设计确认；工程骨架、基础设施、能力验证和现有设计讨论可以并行。源码目录按职责组织为 `cmd/`、`internal/`、`web/`、`packages/`、`api/`、`protocol/`、`deploy/` 和 `tests/`；各目录在对应实现加入时创建。
