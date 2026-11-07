# Git skill convergence

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 本仓曾同时存在 git/local repo prompts、旧 git skills 与 PR/flow skills 中内嵌的 branch/worktree/rebase/cleanup 细节。
- 这些入口让同一类本地 git 操作存在多份合同，容易在 prompt 清退、flow 恢复、PR 合并收尾时产生不一致。
- 需要把纯 `git/local repo` 能力收敛成稳定 skill 面，让 PR/flow/design 入口只承担 orchestration 职责。

## 目标 / 非目标

### Goals

- 固定新的 canonical git skill 面：`git-branch`、`git-worktree`、`git-sync`、`git-cleanup`，并保留 `git-remote-troubleshoot`。
- 让 `pr-create`、`pr-merge`、`flow-continue`、`normal-flow`、`fast-flow`、`local-merge-flow` 与共享 workflow 只引用 git skill 名称，不再复制通用 branch/worktree/rebase/cleanup 细节。
- 删除已退场的 git/PR/flow prompts 与旧 git skills，不提供 stub、alias 或 redirect。
- 将 `work-branch-and-design` 保留为纯设计入口，不再创建分支、stash 或跳转旧 prompt。

### Non-goals

- 不批量迁移 `docs/specs/**`、replay、fixtures 中的历史名称。
- 不改变 GitHub/PR convergence 业务语义。
- 不改变 remote 通信方案、认证路径、upstream 或 push 目标。

## 范围（Scope）

### In scope

- `skills/git-branch/**`
- `skills/git-worktree/**`
- `skills/git-sync/**`
- `skills/git-cleanup/**`
- `skills/pr-create/SKILL.md`
- `skills/pr-merge/SKILL.md`
- `skills/flow-continue/SKILL.md`
- `skills/project-engineering-workflow/SKILL.md`
- `skills/normal-flow/SKILL.md`
- `skills/fast-flow/SKILL.md`
- `skills/local-merge-flow/SKILL.md`
- `skills/global-port-manager/SKILL.md`
- `skills/docs-migrate/SKILL.md`
- `skills/README.md`
- `AGENTS.md`
- `prompts/work-branch-and-design.md`
- Deleted prompt files explicitly listed in this spec's acceptance criteria.

### Out of scope

- `docs/specs/**/replay/**`
- dev-plan replay fixtures
- historical implementation logs
- unrelated prompts and skills

## 需求（Requirements）

### MUST

- The only pure git/local repo skills are `git-branch`, `git-worktree`, `git-sync`, `git-cleanup`, and the existing `git-remote-troubleshoot`.
- `create-worktree`, `remove-worktree`, `update-baseline`, and `pr-post-merge-cleanup` must be removed.
- `goto-new-branch`, `goto-impl-branch`, `worktree-workspace`, `repo-cleanup`, `pr-create`, `pr-merge`, `pr-merged`, and `advance-flow` prompts must be removed.
- `work-branch-and-design` must not contain `git switch`, `git stash`, old `/prompts:*` implementation handoffs, or a “create branch first” contract.
- `git-cleanup` owns post-merge PR local closeout and local merge cleanup proof generation.
- `git-sync` owns confirmed-base local sync, including direct detached `HEAD` alignment for clean maintenance worktrees, and replaces the old update-baseline role.
- `git-worktree` owns manually managed worktree create/remove lifecycle and port lease release integration; native Codex Ticket Worktrees are created and archived only by native task lifecycle.
- `git-branch` owns local branch create/switch/delete contracts.

### SHOULD

- Orchestration skills should describe when they call the git skills, not re-specify every low-level branch/worktree command.
- Active reference checks should ignore historical `docs/specs/**`, replay, and fixtures unless they affect runtime entry behavior.

### COULD

- Future replay checkers may add focused cases for the new git skill routing surface.

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- PR merge with `merge+cleanup` calls `$git-cleanup` after `$pr-merge` finishes merge-scope work.
- Local merge cleanup calls `$git-cleanup MODE=local-merge` after `$local-merge-flow` completes the local merge and cleanup is explicitly requested.
- Branch setup tasks route to `$git-branch`.
- Worktree lifecycle tasks route to `$git-worktree`.
- `$wave-thread-flow` Ticket parallelism routes to native Codex task Worktrees; it must not fall back to `$git-worktree ACTION=create`, and `$git-cleanup` must not remove native task internals.
- Confirmed local base synchronization routes to `$git-sync`.
- A clean detached maintenance worktree may use `$git-sync ACTION=align-detached-base` to fetch a confirmed base and remain detached at its exact commit. A bare mainline-sync request rebases only when `HEAD` is attached to a topic branch; shared topic-branch `BASE_REF` + `REMOTE` rebase calls keep their existing meaning.
- Remote/auth/transport troubleshooting stays in `$git-remote-troubleshoot`.

### Edge cases / errors

- If a deleted prompt or old git skill name remains in active runtime docs, the migration is incomplete.
- If a historical reference remains only in `docs/specs/**`, replay, or fixtures, it is not a blocker for this spec.
- If cleanup cannot prove completion with live facts, it must report partial cleanup rather than hand-written success text.
- Detached alignment must stop for dirty worktrees, ambiguous bases, unavailable old-commit recovery, or explicit rebase/fast-forward actions; it must not stash, create a backup branch, or alter remote configuration.

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| `git-branch` | skill | internal | New | None | main-agent | flow/design/git tasks | local branch operations |
| `git-worktree` | skill | internal | New | None | main-agent | flow/parallel/dev tasks | worktree lifecycle |
| `git-sync` | skill | internal | New | None | main-agent | flow/PR/maintenance tasks | confirmed local sync and detached alignment |
| `git-cleanup` | skill | internal | New | None | main-agent | PR/local-merge cleanup | local closeout and proof |

### 契约文档（按 Kind 拆分）

- None

## 验收标准（Acceptance Criteria）

- Given the active runtime surface is searched outside `docs/specs/**`, replay, and fixtures When references are checked for deleted prompt names and old git skill names Then none of the deleted names remain as recommended runtime entries.

- Given the skills directory is listed When git-themed skills are inspected Then `git-branch`, `git-worktree`, `git-sync`, `git-cleanup`, and `git-remote-troubleshoot` exist, while old git skills do not.

- Given `work-branch-and-design` is inspected When its body is searched Then it contains only design-stage duties and no branch/stash/old prompt handoff contract.

- Given cleanup scripts are tested When the closeout tests run from `skills/git-cleanup/scripts` Then post-merge closeout gate behavior remains covered.

- Given a path is declared or detected as a native Codex task Worktree When cleanup context or gate evaluates it Then it is excluded from manual removal and returns the native archive handoff instead of `git worktree remove`.

- Given a clean detached worktree and a confirmed remote base When `ACTION=align-detached-base` is used Then it fetches and switches to the exact base commit while remaining detached, without creating local backup branches or changing remote configuration.

- Given a dirty detached worktree, or an explicit detached rebase/fast-forward request When `$git-sync` is invoked Then it stops before moving `HEAD`.

- Given a detached commit that is not retained by the target or another ref and is absent from the HEAD reflog When `ACTION=align-detached-base` is used Then it stops before moving `HEAD` because no owner-authorized recovery path exists.

## 验收清单（Acceptance checklist）

- [x] 核心路径的长期行为已被明确描述。
- [x] 关键边界/错误场景已被覆盖。
- [x] 涉及的接口/契约已写清楚或明确为 `None`。
- [x] 相关验收条件已经可以用于实现与 review 对齐。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: `python3 skills/git-cleanup/scripts/test_closeout_context.py`
- Unit tests: `python3 skills/git-cleanup/scripts/test_closeout_gate.py`
- Unit tests: `python3 skills/git-cleanup/scripts/test_local_merge_closeout_context.py`
- Unit tests: `python3 skills/git-cleanup/scripts/test_local_merge_closeout_gate.py`
- Integration tests: `python3 skills/git-sync/scripts/test_detached_alignment_contract.py`

### UI / Storybook (if applicable)

- Not applicable.

### Quality checks

- `git diff --check`
- Active reference grep for deleted prompt and old git skill names.

## Visual Evidence

PR: none

- Not applicable: this spec changes text contracts and local scripts only.

## Related PRs

- None

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：历史 specs/replay 继续保留旧名称，搜索时需要明确区分历史材料与活跃入口。
- 假设：GitHub PR 业务语义不随本地 git skill 收敛改变。

## 参考（References）

- `skills/git-branch/SKILL.md`
- `skills/git-worktree/SKILL.md`
- `skills/git-sync/SKILL.md`
- `skills/git-cleanup/SKILL.md`
