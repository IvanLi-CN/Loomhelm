---
name: worktree-bootstrap
description: "Make a fresh Git linked worktree recoverable through a single, safe, repo-owned bootstrap contract."
schema_version: 1
kind: policy-skill
slug: worktree-bootstrap
primary_topic: worktree-bootstrap
policy_dependencies: []
visibility: public
public_url_hosts: []
---

# Worktree bootstrap

Use this project policy when a repository promises that a fresh linked worktree can become ready through a documented recovery path. Keep the entrypoint repo-owned, repeatable, and safe for existing local state.

## Workflow

1. Identify the canonical setup entrypoint and its readiness manifest: dependencies, hooks, local resources, generated state, and optional browser/device runtimes.
2. Prefer copy-missing behavior for `.env.local`, ledgers, and other local overrides. Preserve existing values and make repeated runs no-ops when the revision is already ready.
3. Keep automatic checkout hooks best-effort and safe for the main worktree; expose aggregate failures through an explicit setup command.
4. Test a real linked-worktree first run, repeat run, missing historical script, custom Git layout, and preservation of existing local files.

Do not absorb service ports, Docker, browser automation, or release gates unless the repository's own bootstrap contract explicitly includes them.

## Adoption preview

Before applying this policy to a target project, preview the writes to `.agents/skills/worktree-bootstrap/` and `skills-lock.json`, then wait for explicit owner approval. Install it with `npx skills add IvanLi-CN/style-playbook-skills --skill worktree-bootstrap --yes`; the CLI detects the Agent and project layout.

## Package resources

This package has no additional assets; the instructions above are self-contained.
