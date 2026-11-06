---
name: dot-codex-development
description: Safely develop and maintain the IvanLi-CN/dot-codex repository and Codex global configuration surfaces such as config.toml, agents, skills, hooks, and runtime helpers. Use when a task changes or diagnoses dot-codex, especially from a Codex-managed linked worktree where the source checkout and the active CODEX_HOME can otherwise be confused.
---

# dot-codex development

Keep two paths distinct:

- **Candidate worktree**: the linked dot-codex worktree that owns edits and commits.
- **Runtime home**: the `CODEX_HOME` used to start the current Codex process. Treat it as read-only.

## Resolve context

Run the bundled helper before reading or changing dot-codex state:

```bash
bun <loaded-skill-dir>/scripts/context.ts inspect --cwd <current-directory> --mode read
```

Use `--mode write` before any edit. Continue only when `write_allowed` is true. If it is false, do not edit the runtime home or an unrelated repository; use the active engineering flow and Git worktree skills to enter a linked dot-codex worktree, then inspect again.

Read-only diagnosis may compare the reported runtime home with the candidate. Never copy, deploy, or synchronize files between them from this skill.

## Develop and validate

1. Make every source or configuration edit inside `candidate_root`.
2. Keep branch, commit, PR, and merge handling in the selected engineering flow.
3. Run task-specific tests from the candidate worktree.
4. Run the fixed current-candidate checks:

```bash
bun <loaded-skill-dir>/scripts/context.ts validate --cwd <candidate-root>
```

`validate` starts only repository-owned offline checks against the current candidate. It does not redirect `CODEX_HOME`, create synthetic Git repositories or worktrees, accept arbitrary commands, invoke a model, access the network, deploy configuration, or replace task-specific validation.

## Plan contract changes

When changing `$dev-plan`, `$dot-codex-development`, a plan parser/checker, or their fixtures, keep the entire change inside the linked candidate Worktree. Run the context helper with `--mode write` before editing, then validate in this order: candidate context inspection, focused plan-contract and historical replay tests, and the fixed candidate checks through `context.ts validate`. For plan-contract compatibility changes, the focused gate includes the canonical raw-plan check and the historical JSONL replay set. Do not point any validation command at a runtime `CODEX_HOME`, copy candidate files into the runtime home, or use runtime state as a fixture source. A passing candidate check does not authorize runtime deployment; the selected delivery flow owns branch, commit, PR, and merge steps.

For `$dev-plan` contract or owner-review projection changes, keep the candidate pipeline explicit.

Inspect the candidate context in write mode, validate the canonical raw-plan, run focused parser/projection tests and historical replay, then run the fixed candidate checks, including the plan-contract test group.

The projection must be derived only after canonical validation, must remain stdout-only, and must not become a second execution manifest.

This repository change does not grant permission to modify, copy, synchronize, or deploy anything under the runtime `CODEX_HOME`.
