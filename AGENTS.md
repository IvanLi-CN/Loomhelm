# Loomhelm engineering guide

## Product and scope

Loomhelm is a self-hosted project management Web/PWA and remote Codex workspace for individuals and small teams. Read `docs/specs/phase1-core/SPEC.md` before changing product behavior, and read its companions for implemented coverage and compatibility history. These documents hold durable product truth; task scheduling and coordination stay outside the repository.

The backend is Go with chi, PostgreSQL, pgx/sqlc, goose and River. Server, Worker and Connector are separate processes. React/Vite/TypeScript, Bun workspaces, TanStack Router/Query, shadcn/Tailwind and Storybook form the frontend. Bun is not the business backend runtime.

Until the owner approves the complete UI design, frontend work is limited to the technical framework and neutral verification surfaces. There is exactly one complete UI design task; information architecture, prototype, visual design and handoff are internal steps of that task. Do not invent a product visual direction or split design into extra tasks. Implement only the approved design afterward.

## Working conventions

- Communicate with the owner in Chinese; use English code, identifiers and conventional commit subjects. Every commit requires `--signoff`; never bypass hooks.
- Read actual files and current Git state first. Preserve unrelated user changes and local configuration. Shared manifests, lockfiles and composition roots have one integration owner; sibling work must remain in its declared paths.
- All delegated implementation, research, design and runtime review must use `gpt-5.6-luna` with `max`. Do not upgrade models because of task difficulty, risk, duration or a failed attempt. If this exact profile is unavailable, report a blocker rather than substituting another profile.
- Use the existing shared engineering workflow for PR publication, review, checks and merge. Child PRs target the designated parent branch directly; the owner controls the final parent PR merge. GitHub operations use `gh`; do not change remotes, upstreams, credentials or branch rules without explicit authorization.
- Keep new topic requirements in `docs/specs/<topic>/SPEC.md` with `IMPLEMENTATION.md` and `HISTORY.md`. Record hard-to-reverse architecture decisions in `docs/adr/`. Do not commit orchestration manifests, task boards, conversation state or temporary implementation plans.
- Keep each Markdown prose paragraph on one source line. Formatting uses the installed markdown-style Policy, pinned dprint and the canonical Lefthook path; do not infer a paragraph width from formatter settings.

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
