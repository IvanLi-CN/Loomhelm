---
name: gui-escalation-gate
description: "Route simple Codex Desktop Web Demo previews and complex browser work to the right surface; gate DevTools or Computer Use."
---

# Browser and GUI Routing Gate

Use this skill when a task may need the Codex Desktop built-in browser, `$ego-browser`, `chrome-devtools`, or Computer Use. Use the built-in browser for ordinary isolated Web Demo previews; use `$ego-browser` for complex browser work.

This skill keeps browser and GUI automation narrow, auditable, and aligned with the repository's default browser route.

## Decision Ladder

Evaluate lower-intrusion paths first:

1. Files, source, logs, configs, manifests, local caches.
2. Shell commands, project-native scripts, tests, builds, linters, formatters.
3. MCP/API/source-of-truth tools for the target service.
4. Codex Desktop's built-in browser for ordinary isolated Web Demo previews.
5. `$ego-browser` for complex rendered browser state or interaction.
6. `chrome-devtools` only through its explicit exception gate.
7. `Computer Use`.

## Codex Desktop Built-in Browser

When running in Codex Desktop and the current host exposes its built-in browser, use it for a one-off, login-free, read-only Web Demo or local preview that only needs to be opened and inspected.

This route is for isolated preview browsing, not complex interaction. Use `$ego-browser` when the task needs multi-step interaction, login or authenticated context, form input, data extraction, debugging, QA, or formal browser validation and capture. If the built-in browser is unavailable, use `$ego-browser` when the task fits its route or report the blocker.

## Ego Browser Standard

For complex browser work, authenticated or stateful interaction, and formal browser validation, use `$ego-browser` once the lower-intrusion paths cannot provide the required rendered state or interaction.

1. Read and follow the selected `$ego-browser` skill before its first command.
2. Use one Ego TaskSpace for the user goal, and keep its URL and interaction scope limited to that goal.
3. Ask for explicit owner approval before any login, CAPTCHA, permission, state-changing input, submission, deletion, or real-program screenshot.

Failure of the built-in preview route or `$ego-browser` is not, by itself, a reason to fall back to DevTools. Report the blocker, or use DevTools only when its own gate is satisfied.

## DevTools Exception Gate

The DevTools surface is a non-default exception path. It is allowed only when the owner explicitly asks for it or when a current-truth skill requires it for a narrow purpose such as structured page inspection, network/performance debugging, viewport emulation, or element-first visual evidence capture.

When the DevTools exception path is used:

- Reuse shared browser context by default.
- Request `isolatedContext` only when shared context would distort results, create unacceptable auth side effects, or create unacceptable storage side effects.
- Before the first isolated request, record `task_scope_id` and `isolation_reason` with `hazard=<result_distortion|auth_side_effect|storage_side_effect>` and `shared_context_failure=<why shared context is not acceptable>`.
- Use at most one isolated context per `task_scope_id`; later pages for the same task must reuse it.
- Block any attempt to create a second isolated context for the same `task_scope_id` unless the caller explicitly starts a new task scope.

For a one-off, login-free local Web Demo preview in Codex Desktop, use the built-in browser. For complex operations or formal browser validation, use `$ego-browser`. DevTools is not a generic fallback after either route fails.

## Allowed Routes

`Codex Desktop's built-in browser` is the preferred route when all conditions are true:

- The task is running in Codex Desktop and the current host exposes the built-in browser.
- The target is a one-off, login-free, read-only local Web Demo or preview.
- The task only needs the rendered preview to be opened and inspected.

`$ego-browser` is the preferred route when at least one condition is true:

- The task requires visible browser state or interaction beyond an isolated preview that files, scripts, and source-of-truth tools cannot provide.
- The user asks to open, inspect, test, or interact with a non-local, authenticated, stateful, or complex web page.
- The task requires a local preview or a deterministic browser-validation surface for formal validation or capture.
- The task needs complex interaction, authentication, state changes, data extraction, debugging, QA, or formal browser validation and capture.

`Computer Use` is allowed only when at least one condition is true:

- The user explicitly asked to control a desktop app.
- The required target is a desktop app with no sufficient CLI, MCP, API, file, or browser-specific surface.
- A lower-intrusion path has failed and the remaining task cannot be completed without desktop GUI control.

For browser work, use `chrome-devtools` only with the explicit exception rationale above. Generic statements such as “当前线程里没有可调用的 ego-browser” do not authorize a DevTools fallback.

If neither the Codex Desktop built-in browser nor `$ego-browser` can satisfy the task, report the blocker or evaluate Computer Use through this gate.

## Required Pre-Use Disclosure

Before using Computer Use, disclose this one-line gate result unless the user's current request explicitly named that exact tool:

```text
GUI escalation: tool=computer-use; reason=<why ego-browser and browser exceptions are insufficient>; target_scope=<page/app/window/capture scope>; risk=<none|click|input|submit|delete|permission|login-state|real-screenshot>
```

If `risk` includes `submit`, `delete`, `permission`, `login-state`, or `real-screenshot`, wait for explicit user approval before acting.

## Hard Blocks

- Do not use Computer Use just because it is visible or enabled.
- Do not use Computer Use only because the prompt says "open", "test", "view", "check", or "screenshot"; first determine whether the built-in browser or `$ego-browser` satisfies the task.
- Use the built-in browser only for one-off, login-free, read-only local Web Demo previews; route complex, authenticated, stateful, or formal validation work to `$ego-browser`.
- Do not offer `chrome-devtools` as the next step for an ordinary page-open task after `$ego-browser` fails.
- Do not use `Computer Use` as a browser fallback while `$ego-browser` remains viable.
- Do not treat a freshly launched Chrome/Chromium/`9222` debugging instance as valid evidence that the repo-owned DevTools Surface was available all along; that is `Synthetic DevTools Bootstrap`, and it is blocked by default.
- Do not treat generic user wording like “在浏览器打开”“继续验证”“你自己看一下” as authorization to launch a fresh debugging browser instance.
- Do not modify bundled plugin cache skill files to enforce this policy; they can be overwritten by plugin updates.
- Do not capture fullscreen desktop or unrelated windows.

## Output Contract

When escalation is blocked, report which lower-intrusion path is still viable or which required browser blocker evidence is still missing, and continue with the safest viable path.

When escalation is allowed, keep the target scope narrow and return to non-GUI tooling as soon as the GUI-only evidence or action is complete.
