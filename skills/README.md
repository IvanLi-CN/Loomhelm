# 客户端 Skills 资源索引

本目录完整迁入批准的 29 套 dot-codex 自有源包；固定源提交、逐文件摘要和迁移适配见 `source-manifest.json`，依赖与脚本发现见 `catalog.json`。独立可复用的外部 Skills 仍由宿主提供，不复制其源包。上游合同归档在 `docs/vendor/dot-codex/`，不覆盖项目 Policy。

构建后，Node.js 或 Bun 均可执行 `clients/typescript/dist/cli.js skills list/check/run`；原 `.ts` 脚本通过 `skills run <资源相对路径>` 执行编译入口。文档中的 `LOOMHELM_TOOLKIT_ROOT` 指向包内 `dist/toolkit/` 或本仓库资源根。保留的 Bun 构建/原始测试命令属于开发工具链，不构成 Node 生产命令的兜底路径。专项操作仍需要其原授权、外部工具和宿主能力。

This directory contains only Skills whose contracts are coupled to this Codex configuration, its workflow state, native task lifecycle, owner-facing evidence, or private service layout. These Skills are intentionally not part of the public `agent-toolkit` source.

Standalone reusable Skills are maintained in [agent-toolkit](https://github.com/IvanLi-CN/agent-toolkit) and consumed from its direct checkout or per-Skill symlinks. Do not copy public Skill files into this directory.

Run the local index check after changing this directory:

```bash
bun bin/skills_index_check.ts
bun test bin/test_skills_index_check.ts
```

| Skill | Private reason | Path |
| - | - | - |
| `cn-ecommerce-data-collection` | Uses the configured browser/task-space tool route. | `skills/cn-ecommerce-data-collection/` |
| `dev-plan` | Codex Plan Mode contract and flow lock. | `skills/dev-plan/` |
| `docs-migrate` | Consumer-specific docs/worktree lifecycle. | `skills/docs-migrate/` |
| `dot-codex-development` | Manages this dot-codex runtime home and worktrees. | `skills/dot-codex-development/` |
| `fast-flow` | Codex delivery flow and PR convergence. | `skills/fast-flow/` |
| `find-next-plan` | Reads this consumer's local planning layout. | `skills/find-next-plan/` |
| `flow-continue` | Restores Codex flow state and hard gates. | `skills/flow-continue/` |
| `fresh-thread-dispatch` | Creates and moves Codex tasks. | `skills/fresh-thread-dispatch/` |
| `git-branch` | Applies the Codex branch/workspace policy. | `skills/git-branch/` |
| `git-cleanup` | Protects Codex-managed worktrees and runtime state. | `skills/git-cleanup/` |
| `git-worktree` | Integrates with the Codex native worktree lifecycle. | `skills/git-worktree/` |
| `global-port-manager` | Tracks Codex background sessions and owner-facing leases. | `skills/global-port-manager/` |
| `gui-escalation-gate` | Routes Codex browser and GUI surfaces. | `skills/gui-escalation-gate/` |
| `hardware-doc-ingest` | Uses the configured document MCP/tool route. | `skills/hardware-doc-ingest/` |
| `implement-only-flow` | Codex Plan Mode implementation-only contract. | `skills/implement-only-flow/` |
| `kaisoumail-deployment-inventory` | Reads this operator's private deployment inventory. | `skills/kaisoumail-deployment-inventory/` |
| `local-merge-flow` | Codex local delivery and merge gate. | `skills/local-merge-flow/` |
| `normal-flow` | Codex delivery flow and local PR stop. | `skills/normal-flow/` |
| `project-doc-promote` | Uses this consumer's project documentation taxonomy. | `skills/project-doc-promote/` |
| `project-engineering-workflow` | Shared Codex delivery module and receipts. | `skills/project-engineering-workflow/` |
| `rust-crate-release` | Contains this owner's release conventions. | `skills/rust-crate-release/` |
| `solution-sync` | Uses this consumer's solutions taxonomy. | `skills/solution-sync/` |
| `spec-sync` | Uses this consumer's topic-spec taxonomy. | `skills/spec-sync/` |
| `srv-101-ops` | Targets this operator's private remote service layout. | `skills/srv-101-ops/` |
| `storybook-screenshots` | Codex owner-facing visual evidence contract. | `skills/storybook-screenshots/` |
| `storybook-stories` | Codex visual gate and background-session contract. | `skills/storybook-stories/` |
| `multi-task-flow` | Coordinates Codex task conversations, native identities, and a local ledger dashboard. | `skills/multi-task-flow/` |
| `topic-spec` | Maintains this consumer's durable spec taxonomy. | `skills/topic-spec/` |
| `ui-visual-evidence` | Codex owner-facing image and evidence paths. | `skills/ui-visual-evidence/` |

The public `agent-toolkit` index is the source of truth for the standalone set; this file is the source of truth only for the private Codex integration set.
