---
name: gui-escalation-gate
description: "Choose the browser for local previews or formal browser work, and gate DevTools or Computer Use."
---

# Browser and GUI Routing Gate

Use the task-specific browser route first when one is defined, such as for a `multi-task-flow` dashboard. Use this skill for default browser selection and for DevTools or Computer Use escalation.

## Decision Ladder

Evaluate lower-intrusion paths first:

1. Files, source, logs, configs, manifests, local caches.
2. Shell commands, project-native scripts, tests, builds, linters, formatters.
3. MCP/API/source-of-truth tools for the target service.
4. The host built-in browser for ordinary isolated Web Demo previews.
5. `$ego-browser` for complex rendered browser state or interaction.
6. `chrome-devtools` only through its explicit exception gate.
7. `Computer Use`.

## Open a Local Preview

To open and inspect an isolated, login-free, read-only local preview, select the built-in browser from the current host's browser inventory and open the page there. This preview route takes precedence over the general Ego preference. If the host does not expose a suitable built-in browser, follow `$ego-browser`.

Confirm the selected browser renders the preview. A failed open warrants diagnosis; it does not establish that the browser is unavailable.

## Ego Browser Standard

For general browser work beyond opening and inspecting a local preview, use `$ego-browser` once the lower-intrusion paths cannot provide the required rendered state or interaction. This includes non-local pages, authentication, form input, data extraction, debugging, formal verification, and evidence capture.

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

## Computer Use Gate

`Computer Use` is allowed only when at least one condition is true:

- The user explicitly asked to control a desktop app.
- The required target is a desktop app with no sufficient CLI, MCP, API, file, or browser-specific surface.
- A lower-intrusion path has failed and the remaining task cannot be completed without desktop GUI control.

For browser work, use `chrome-devtools` only with the explicit exception rationale above. Generic statements such as “当前线程里没有可调用的 ego-browser” do not authorize a DevTools fallback.

If the browser routes cannot satisfy the task, report the blocker or evaluate Computer Use through this gate.

## Required Pre-Use Disclosure

Before using Computer Use, disclose this one-line gate result unless the user's current request explicitly named that exact tool:

```text
GUI escalation: tool=computer-use; reason=<why ego-browser and browser exceptions are insufficient>; target_scope=<page/app/window/capture scope>; risk=<none|click|input|submit|delete|permission|login-state|real-screenshot>
```

If `risk` includes `submit`, `delete`, `permission`, `login-state`, or `real-screenshot`, wait for explicit user approval before acting.

## Hard Blocks

- Do not use Computer Use just because it is visible or enabled.
- Do not use Computer Use only because the prompt says "open", "test", "view", "check", or "screenshot"; first determine whether the built-in browser or `$ego-browser` satisfies the task.
- Do not offer `chrome-devtools` as the next step for an ordinary page-open task after `$ego-browser` fails.
- Do not use `Computer Use` as a browser fallback while `$ego-browser` remains viable.
- Do not treat a freshly launched Chrome/Chromium/`9222` debugging instance as valid evidence that the repo-owned DevTools Surface was available all along; that is `Synthetic DevTools Bootstrap`, and it is blocked by default.
- Do not treat generic user wording like “在浏览器打开”“继续验证”“你自己看一下” as authorization to launch a fresh debugging browser instance.
- Do not modify bundled plugin cache skill files to enforce this policy; they can be overwritten by plugin updates.
- Do not capture fullscreen desktop or unrelated windows.

## Output Contract

When escalation is blocked, report which lower-intrusion path is still viable or which required browser blocker evidence is still missing, and continue with the safest viable path.

When escalation is allowed, keep the target scope narrow and return to non-GUI tooling as soon as the GUI-only evidence or action is complete.
