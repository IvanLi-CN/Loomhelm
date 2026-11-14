# 客户端 Skills 资源索引

本目录包含本地运行所需的 29 套 Skill 资源；逐文件摘要和资源索引见 `resource-manifest.json`，依赖与脚本发现见 `catalog.json`。资源索引只描述当前仓库文件，不声明外部来源。

生产仅支持 Bun 1.4.4；`bun clients/typescript/src/cli.ts skills list/check/run` 直接执行 TS。`skills run <资源相对路径>` 不改写脚本后缀；`LOOMHELM_TOOLKIT_ROOT` 指向包内 `toolkit/` 或本仓库资源根。vendor 仅检出 `skills/` 后，使用 Bun 和锁文件准备声明依赖即可运行脚本；浏览器资产单独构建，不要求本机 TS 编译、Node 或项目原生模块。专项操作仍需要原授权、外部工具和宿主能力。

This directory contains the Skill resources required by this Loomhelm runtime and its owner-facing workflow integration.

The local resource index describes only the files present in this repository. It does not declare an external source repository.

Run the local index check after changing this directory:

```bash
bun skills/bin/skills_index_check.ts
bun test skills/bin/test_skills_index_check.ts
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
