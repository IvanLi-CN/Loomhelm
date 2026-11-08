# Loomhelm engineering guide

## Product and scope

Loomhelm is a self-hosted project management Web/PWA and remote Codex workspace for individuals and small teams. Read `docs/PRD.md` for the complete product scope, user journeys, business decisions and acceptance, then `docs/specs/phase1-core/SPEC.md` for established engineering contracts. Read its companions for implementation coverage and compatibility history. The main coordinator maintains the PRD and synchronizes confirmed product decisions into the engineering contracts; design context is supporting material. Resolve contradictions before implementation. Task scheduling and coordination stay outside the repository.

The backend is Go with chi, PostgreSQL, pgx/sqlc, goose and River. Server, Worker and Connector are separate processes. React/Vite/TypeScript, Bun workspaces, TanStack Router/Query, shadcn/Tailwind and Storybook form the frontend. Bun is not the business backend runtime. The independent TypeScript client lives in `clients/typescript/`, requires Bun 1.4.4 and runs TypeScript source directly, and does not replace the Go Connector. The default integration branch is `main`; begin work from a freshly verified complete mainline rather than a partial or historical topic branch.

Business feature implementation and public business contract finalization require the owner's explicit confirmation of the phase-one PRD and resolution of the affected business decisions. Proposed defaults in the PRD are not approval. Engineering skeletons, infrastructure, capability research and the existing design discussion may proceed independently. Product UI implementation additionally requires the owner's approval of the complete UI design. There is exactly one complete UI design task; information architecture, prototype, visual design and handoff are internal steps of that task. Before UI approval, frontend work remains limited to the technical framework, neutral verification surfaces and that design task's prototypes.

## Working conventions

- Communicate with the owner in Chinese; use English code, identifiers and conventional commit subjects. Every commit requires `--signoff`; never bypass hooks.
- Read actual files and current Git state first. Preserve unrelated user changes and local configuration. Shared manifests, lockfiles and composition roots have one integration owner; sibling work must remain in its declared paths.
- Delegated implementation, research, design and advisory review must use `gpt-5.6-luna` with `max`. Formal runtime review must use `gpt-6-luna` with `max`. Select the profile by role; task difficulty, risk, duration or a failed attempt does not authorize a different profile. If the required profile is unavailable, report a blocker rather than substituting another profile.
- Use the existing shared engineering workflow for PR publication, review, checks and merge. Child PRs target the designated parent branch directly; the owner controls the final parent PR merge. GitHub operations use `gh`; do not change remotes, upstreams, credentials or branch rules without explicit authorization.
- Keep new topic requirements in `docs/specs/<topic>/SPEC.md` with `IMPLEMENTATION.md` and `HISTORY.md`. Record hard-to-reverse architecture decisions in `docs/adr/`. Do not commit orchestration manifests, task boards, conversation state or temporary implementation plans.
- Keep each Markdown prose paragraph on one source line. Formatting uses the installed markdown-style Policy, pinned dprint and the canonical Lefthook path; do not infer a paragraph width from formatter settings.

## Skill 源码维护

- 在本仓库中请求优化、修复或补充本项目提供的 Skill 时，默认维护目标是当前工作区内的源码。用户通过 `$skill-name`、Skill 链接或绝对路径引用全局安装版本，只表示要处理的 Skill 身份；即使 Agent 自动加载了全局 `SKILL.md`，也不代表授权编辑该安装副本。例如，引用全局 `fast-flow/SKILL.md` 请求优化时，应定位本仓库 `skills/fast-flow/`。
- 写入前先按 Skill 名称、`skills/README.md`、`skills/catalog.json`、`skills/source-manifest.json` 和实际内容核实源码映射，再读取仓库内对应 `SKILL.md` 及受影响的关联资源。全局版本可用于识别和比较；若版本有差异，以仓库当前合同为修改基线，不能把安装副本整份覆盖回仓库，也不能仅凭全局文档中的相对路径或运行根目录决定编辑位置。
- 修改应落在 `skills/<skill-name>/` 及确有影响的 `skills/bin/`、模板、references、资源清单或检查入口，并遵循仓库已有的资源登记、摘要更新和验证要求。修改前解析符号链接并确认实际写入路径位于当前仓库工作区；不得通过链接意外写入全局安装目录、vendor checkout 或其他工作区。
- 区分根 `skills/` 的自有源包、`.agents/skills/` 的项目 Policy 安装面，以及由其他仓库维护的外部 Skill；同名不等于同源。若本仓库没有对应维护源或映射存在歧义，先报告已确认的来源与缺失信息，再由主人确认目标，不得猜测路径或直接改全局版本。
- 源码优化与安装升级是独立操作。更新、重装全局 Skill，或同步用户级脚本、服务和运行资源，须有覆盖该操作的主人明确授权。交付时说明实际修改的仓库路径、验证结果，以及全局安装版本是否已更新；只完成源码修改时，不得声称用户正在使用的全局版本已经生效。

## Policy routing

- Markdown edits and hooks: `.agents/skills/markdown-style/SKILL.md`.
- Fresh worktrees, setup and local resource recovery: `.agents/skills/worktree-bootstrap/SKILL.md`.
- CI, required checks, waivers and delivery gates: `.agents/skills/quality-gates/SKILL.md`.
- Durable database, journal, queue or artifact state: `.agents/skills/persistent-state-migrations/SKILL.md`.
- Public interface or persistent-state compatibility changes: `.agents/skills/semver-change-governance/SKILL.md`.
- Expected-success workflow failures: `.agents/skills/release-failure-notification/SKILL.md`; installing this Policy does not select a notification provider, destination or credential.

## Verification and runtime

- Use a session-owned Agent VM for Linux, Docker/Compose, image builds, integration/E2E and heavy validation. Local Docker is disabled. Follow the installed agent-vm protocol and lease contract; each task session owns its own VM.
- Lease and register ports before starting long-lived local services. Never reuse or stop an unrelated listener.
- UI components and reusable states require Storybook coverage; full-page evidence prefers a deterministic, login-free `ui_demo`. Follow ui-visual-evidence for controlled capture, immutable chat snapshots and owner confirmation. Real-program screenshots require explicit target and scope authorization.
- Codex verification uses disposable test directories and sessions. Keep Codex credentials on the host. Do not equate reading history, resuming a copy or opening another process with controlling an existing active desktop session.
- REST and MCP share application behavior, project permissions, command identity and approval semantics. Persist commands and events; reconcile ambiguous delivery instead of blindly repeating side effects.
- Blue-green readiness, HTTP drain, Worker generation/fencing, Connector recovery and durable-state compatibility are separate gates. Candidate identity is the actual source SHA plus digest. Do not rebuild during promotion, automatically reverse deployed migrations or claim safe rollback beyond the demonstrated compatibility window.
