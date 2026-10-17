# Loomhelm

Loomhelm 是面向个人与小型团队的自部署项目管理与 Agent 工作台。

项目将提供 Web/PWA、API 与 MCP 入口，把项目、任务层级与依赖、单一执行环境中的 Codex 对话、审批和对话文件连接起来。全局入口为工作台、任务和对话；任务提供列表、看板与图谱，并支持多端连续工作与共享草稿。

当前仓库处于工程初始化阶段，尚未提供可运行的产品。

## Architecture

- Go + chi 提供 HTTP 入口；Server、Worker、Connector 分进程运行。
- PostgreSQL 保存业务与执行事实，pgx/sqlc 负责访问，goose 管理迁移，River 承担短派发与对账作业。
- Go Connector 从预配置的单一执行环境主动连接平台，并在执行机器内连接 Codex app-server；Codex 登录凭据保留在该机器。执行机器可以与平台分开部署，连接认证与撤销由部署管理负责。
- React/Vite/TypeScript 构建 Web/PWA，Bun workspaces 管理前端工程；产品界面在完整设计确认后实现。
- 非生产候选采用固定源码 SHA 和产物 digest，通过 Caddy 蓝绿切流；Worker 交接与共享状态兼容分别验证。

## Development

工具版本见 [tools/versions.env](tools/versions.env)。统一开发、检查、构建和工作树初始化入口将在工程骨架与开发环境落地时提供；目前不提供占位成功命令。

Markdown 工具已提供固定版本入口：首次运行 `python3 tools/markdown.py setup`，检查使用 `python3 tools/markdown.py check`，格式修复使用 `python3 tools/markdown.py fix`。Lefthook 的统一检查配置将在开发环境中接入；当前命令不会自行安装提交钩子。

完整产品需求与一期验收见 [PRD](docs/PRD.md)，已确定的工程合同见 [项目规范](docs/specs/phase1-core/SPEC.md)，工程边界见 [AGENTS.md](AGENTS.md)。PRD 及相关业务规则须经主人明确确认后才能实施功能，产品 UI 还需完整设计确认；工程骨架、基础设施、能力验证和现有设计讨论可以并行。源码目录按职责组织为 `cmd/`、`internal/`、`web/`、`packages/`、`api/`、`protocol/`、`deploy/` 和 `tests/`；各目录在对应实现加入时创建。
