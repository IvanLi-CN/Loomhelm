---
title: Converge pure git operations into a local skill layer
module: codex-global-workflow
problem_type: workflow_issue
component: git-skill-routing
tags:
  - git
  - skills
  - prompts
  - workflow
status: active
related_specs:
  - docs/specs/git-skill-convergence/SPEC.md
  - docs/specs/initiative-flow/SPEC.md
resolution_type: migration
---

# Converge Pure Git Operations Into A Local Skill Layer

## Context

Codex workflow repos can accumulate prompt shortcuts and flow-specific prose for the same local Git operations: branch creation, worktree lifecycle, base sync, and cleanup. When those contracts live in many places, prompt retirement becomes brittle and PR/flow skills keep repeating low-level Git rules.

## Symptoms

- Multiple prompts or skills recommend different branch/worktree cleanup paths.
- PR merge skills own local branch/worktree cleanup details in addition to GitHub merge semantics.
- Flow recovery references deleted prompts instead of stable skills.
- Design prompts create branches or stash changes even though they should only shape a design.
- A replacement sync skill stalls on ordinary "sync mainline" requests because it only accepts pre-resolved `BASE_REF` / `REMOTE`.
- A planner says "default to mainline" but emits only an abstract phrase, while execution continues from a detached `HEAD` or a stale topic branch.
- A moved helper script is documented with a global home path even though the new file only exists in the checked-out repository.
- A flow resume route calls a generic cleanup skill without carrying the PR identity that the old prompt/skill path had in context.
- A new closeout gate requires explicit absence evidence, but the orchestration handoff only passes existence paths.
- A resumed cleanup flow reports a branch status without the branch identity needed to re-run the proof helper.
- A handoff says a resource was required but omits the required resource identities needed to verify removal.
- A cleanup flow accidentally treats a native Codex Ticket Worktree as a disposable manual Git Worktree.

## Root cause

Pure `git/local repo` operations and orchestration semantics were mixed together. The orchestration layer needs to decide when a branch, worktree, sync, or cleanup action is needed; the local Git layer should own how to do it safely.

## Resolution

- Create a small canonical local Git skill surface:
  - `git-branch` for local branch create/switch/delete.
  - `git-worktree` for worktree lifecycle and lease cleanup integration.
  - `git-sync` for confirmed-base fetch / detached alignment / fast-forward / rebase sync.
  - `git-cleanup` for local branch/worktree/lease cleanup and closeout proof.
  - keep remote/auth/transport troubleshooting separate as `git-remote-troubleshoot`.
- Delete retired prompts and old local Git skills instead of keeping stubs.
- Update flow and PR skills to reference the canonical Git skills by name.
- Keep historical specs and replay fixtures unchanged unless they are loaded as current runtime policy.
- Preserve user-facing defaults when deleting a narrow skill: `git-sync` still resolves remote default branches for bare mainline-sync requests instead of forcing callers to provide parameters.
- Treat a clean detached maintenance worktree as a separate `git-sync` path: after resolving and fetching a confirmed base, direct checkout to its exact commit without creating a branch, backup ref, or stash. First prove that the old commit remains reachable through target ancestry, an existing ref, or a HEAD reflog entry for that exact commit; otherwise stop because no backup ref was authorized. Bare owner mainline-sync requests select this path only while `HEAD` is detached; keep rebase for attached topic branches and reserve the shared `BASE_REF` + `REMOTE` contract for topic-branch rebase.
- Separate "default baseline policy" from the final concrete value: owner-facing plans may explain that the default is the target repo mainline, but the final development baseline must still be emitted as a concrete branch/ref or commit.
- Keep merge-scope primary-base alignment helpers with `pr-merge`, not `git-sync` or cleanup. That logic depends on merged PR base/head facts plus Git primary-worktree ownership, so a local helper should auto-apply only safe ff/tracking-ref updates and leave dirty/ahead/diverged primary-base states on the existing owner-decision path. Once the owner explicitly selects `安全对齐`, the same helper can own the backup-branch/stash/rebase/apply sequence and emit a structured recoverable-conflict state instead of falling back to ad-hoc shell composition.
- Treat topic-branch freshness as a shared workflow concern, not just a git helper concern: if no topic branch exists, create one from the resolved baseline; if a topic branch already exists, sync it before implementation and re-check it again at closeout.
- Invoke moved helper scripts relative to the loaded skill directory, not a hardcoded global installation path.
- When an orchestration skill hands off to a generic local Git skill, include the mode and identity fields that used to be implicit in the old entrypoint.
- Pass explicit "not required" facts into gates that distinguish unknown from absent state.
- Status surfaces used for recovery must include object identity, not just three-state existence.
- When passing a requirement flag into cleanup, pass the corresponding required object paths in the same handoff.
- Keep native Codex Ticket Worktrees outside `$git-worktree` create/remove and `$git-cleanup` removal. Their archive lifecycle belongs to the native task; cleanup may record the path and release a task-owned service lease only when the task lifecycle resolves it.

## Guardrails / Reuse notes

- Do not let cleanup skills perform PR merge, remote protocol changes, or upstream/push target rewrites.
- Do not move GitHub PR semantics into local Git skills.
- Do not hardcode the default baseline to `origin/main` as a universal truth source. Use the target repo mainline as the default policy, but preserve stronger Git facts such as unique open PR base or explicit upstream integration branch.
- Run an active-reference grep over `AGENTS.md`, current `skills/**`, retained `prompts/**`, README/index docs, and runtime helpers; exclude historical `docs/specs/**`, replay, and fixtures when the migration explicitly scopes them out.
- Move executable closeout scripts and tests with the canonical skill that owns their proof contract.
- When replacing a retired baseline-sync entry, include both explicit confirmed-base calls and bare owner requests in the new contract; otherwise routing becomes cleaner but day-to-day sync regressions appear.
- Detached alignment must be a positive, narrowly named action. Do not silently use it to evade a blocked rebase or fast-forward request, and block on a dirty worktree before moving `HEAD`.
- When tightening a plan contract around "baseline", update both the plan checker and the shared Step 1/Step 4 execution path. Otherwise the plan can look correct while the actual branch context stays stale.
- Baseline text heuristics should prefer concrete git-ref validation before classifying a value as "abstract" or "placeholder". Otherwise legitimate refs like `feature/default-mainline-baseline-cleanup` or `todo-cleanup` get blocked by wording-only guards.
- The inverse guard matters too: a value that merely _looks_ like a git ref to `git check-ref-format` is not automatically a valid development baseline. Remote symbolic aliases such as `origin/HEAD`, and combined abstract phrases like `目标仓库主干基线`, still need explicit rejection so the contract only accepts stable concrete refs or commits.
- Owner-baseline extraction must treat replacement clauses such as `开发基线从 A 改为 B` as an override to `B`, not as evidence that `A` remains the active baseline.
- Plain-text replacement-clause heuristics must not treat the `to` inside a concrete ref like `topic/foo` or `todo-cleanup` as the replacement keyword; otherwise valid explicit baselines are truncated and falsely rejected.
- If a request clearly opens a fresh planning window (`重新规划这个任务`, `re-plan this task`), that reset must win over continuation words in the same sentence such as `改为 merge-ready`; otherwise prior owner baselines leak into a new plan session.
- Treat short owner baseline spellings the same as the longer forms owners actually use. Chinese shorthand like `开发基线用 upstream/release-2026q3` should participate in the same explicit-baseline mismatch guard as `开发基线使用 ...`.
- Do not require verbose branch names before owner-baseline extraction kicks in. Short plain-text refs like `qa` or `rc` can still be legitimate baselines and should be validated as refs instead of being dropped before comparison.
- Preserve legal trailing git-ref characters during owner-baseline normalization. Plain-text baselines that end with `,` or `;` are ambiguous but valid refs, so only strip them when they clearly introduce a follow-up clause such as `, 并继续`.
- Directional owner-baseline extraction needs a second guard beyond the leading verb. Phrases like `基于 new plan file upload API 规划这个任务` describe product scope, not a git baseline, so plain directional extraction should only survive when the value is explicitly labeled (`branch/ref/commit`) or already looks like a concrete ref/commit.
- Treat backtick-wrapped spec/doc inputs as planning context by default, not as plain directional baselines. A phrase like ``基于 \``docs/specs/.../SPEC.md\` 规划这个任务``should stay a spec-input hint unless the owner also adds stronger Git semantics such as``开发基线``, ``BASE_REF``, or ``基于 ... 开发`.
- If `flow_type` clarification is still pending, a natural-language reply such as `请按 normal 继续出计划` is still part of the same planning session and must preserve any earlier explicit baseline.
- New-plan detection should not fire on any bare `计划` token. Product compounds like `计划页面上传 API` or `planning UI` need a request-shaped phrase (`给我计划`, `继续出计划`, `按 normal 流程计划`) before they can reset the planning session.
- A plain-language request such as `请帮我规划这个任务：...` is a fresh planning window, not a continuation. Otherwise stale `flow_locked` / `owner_explicit_baseline` state leaks into unrelated plans.
- Support the short explicit-baseline spellings owners actually use (`base=...`, `base:...`), not only verbose `baseline` / `base ref` / `BASE_REF` forms.
- Continuation heuristics should not classify a new task request as follow-up only because the task name contains `merge`; explicit plan requests like `$dev-plan merge queue API` must still reset prior planning-session state.
- Give fresh-request signals higher priority than continuation wording when the owner explicitly reopens `$dev-plan`. Phrases like `请用 $dev-plan 继续给我一份新的可执行计划` are new plan requests, not permission to leak the previous session's flow/baseline lock.
- Path-like wording guards should only reject true filesystem-path baselines, not every legal git ref that happens to resemble a doc path. A branch like `feature/README.md` is still a valid explicit baseline; `./docs/specs/foo/SPEC.md` is not.
- Placeholder-word heuristics must not block concrete refs like `todo`, `pending`, or `default`, but truly explicit placeholder tokens such as `TBD` should still be rejected even if `git check-ref-format` happens to accept them.
- Reject common bare remote symbolic aliases like `origin/HEAD` / `upstream/HEAD`, plus any fully-qualified `refs/remotes/*/HEAD`, by stable syntax rather than by the current repository's configured remotes. At the same time, avoid broad `*/HEAD` rejection that would incorrectly block valid topic refs like `feature/HEAD`.
- Check resumed-flow routes for lost implicit context. A generic skill name is not enough when the old path selected a specific operation mode.
- After tightening a proof gate, add or retain at least one same-worktree/no-dedicated-resource test so absence evidence stays executable.
- Recovery routes must preserve both requirement booleans and path lists; either one alone can still make a gate non-recoverable.

## References

- `docs/specs/git-skill-convergence/SPEC.md`
- `skills/git-branch/SKILL.md`
- `skills/git-worktree/SKILL.md`
- `skills/git-sync/SKILL.md`
- `skills/git-cleanup/SKILL.md`
