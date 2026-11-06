---
title: Browser isolated context reuse guard
module: codex-global-workflow
problem_type: workflow_issue
component: chrome-devtools-policy
tags:
  - chrome-devtools
  - isolated-context
  - browser-context
  - task-scope
status: active
related_specs:
  - docs/specs/global-port-preview-governance/SPEC.md
symptoms:
  - one browser task opened many isolated browser windows that did not share cookies or storage
  - repeated browser verification created more isolated contexts instead of reusing the first one
root_cause: The caller kept introducing fresh `isolatedContext` names, while `chrome-devtools-mcp` creates a new browser context per new name and does not automatically dispose those isolated contexts for the caller.
resolution_type: guardrail
---

# Browser isolated context reuse guard

## Context

- Scope: the non-default `chrome-devtools` exception path governed from `AGENTS.md` against the shared `localhost:9222` browser.
- Trigger: a single browser validation task kept opening many isolated windows that did not share cookies, storage, or login state with the original browser context.
- Constraint: the fix must stay in repo-owned policy (`specs + skill contracts`), not in `chrome-devtools-mcp` upstream, runtime hooks, or bundled plugin cache edits.

## Symptoms

- One task opens multiple browser windows that look like separate profiles even though they are attached to the same Chrome process.
- The task loses shared cookies, `localStorage`, or `sessionStorage` on each new isolated window.
- Re-running the same browser task keeps creating more isolated containers instead of returning to the first isolated state.

## Root cause

- In `chrome-devtools-mcp`, `isolatedContext` maps to a distinct browser context, not just a JavaScript execution world.
- Reusing the same `isolatedContext` name reuses the same isolated browser context.
- Supplying a different `isolatedContext` name creates another isolated browser context.
- The MCP layer intentionally keeps isolated contexts alive for the attached browser session instead of disposing them automatically, so repeated fresh names accumulate.
- The real failure, therefore, is not “isolation exists”; it is “one task kept generating new isolated context identities without a reuse contract.”

## Resolution

- Keep shared browser context as the default path whenever `chrome-devtools` is used as an explicit exception.
- Allow `isolatedContext` only when shared state would distort the verification result or create unacceptable auth/storage side effects.
- Require each isolated browser task to declare:
  - `task_scope_id`
  - `isolation_reason.hazard`
  - `isolation_reason.shared_context_failure`
- Permit at most one isolated browser context per `task_scope_id`.
- Require every later isolated page creation in that same task to reuse the first isolated context.
- If the caller asks for a second isolated context in the same task, block and report it instead of silently rewriting the request.

## Why block instead of auto-rewrite

- Auto-rewrite would hide the real bug: the caller modeled one task as many unrelated isolated contexts.
- Silent rewriting weakens auditability because the request log would no longer describe the actual contract breach.
- Some callers may truly need a second isolated container, but that must be expressed as a new task boundary with a new `task_scope_id`, not guessed by the skill.

## Guardrails / Reuse notes

- Do not treat “fresh page”, “retry”, or “new tab” as sufficient reason to allocate a new isolated browser context.
- If shared browser state is safe, do not use `isolatedContext` at all.
- If isolation is required, keep the isolated context identity stable for the full task lifetime.
- If a second isolated container is truly necessary, split the work into a new browser task and give it a new `task_scope_id`.
- This guard currently applies only to the repo's explicit `chrome-devtools` exception path; unrelated direct `chrome-devtools` consumers still need their own policy surface.

## References

- `docs/specs/global-port-preview-governance/SPEC.md`
- `AGENTS.md`
