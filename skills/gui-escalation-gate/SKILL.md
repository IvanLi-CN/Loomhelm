---
name: gui-escalation-gate
description: "Route browser work to ego-browser by default and gate Chrome exceptions or Computer Use."
---

# Browser and GUI Routing Gate

Use this skill when a task may need a Chrome exception, `chrome-devtools`, or Computer Use. Ordinary browser work should use `$ego-browser` directly.

This skill keeps browser and GUI automation narrow, auditable, and aligned with the repository's default browser route.

## Decision Ladder

Evaluate lower-intrusion paths first:

1. Files, source, logs, configs, manifests, local caches.
2. Shell commands, project-native scripts, tests, builds, linters, formatters.
3. MCP/API/source-of-truth tools for the target service.
4. `$ego-browser` for rendered browser state.
5. `chrome:control-chrome` or `chrome-devtools` only through their explicit exception gates.
6. `Computer Use`.

## Ego Browser Standard

For ordinary browser work, use `$ego-browser` once the lower-intrusion paths cannot provide the required rendered state or interaction.

1. Read and follow the selected `$ego-browser` skill before its first command.
2. Use one Ego TaskSpace for the user goal, and keep its URL and interaction scope limited to that goal.
3. Ask for explicit owner approval before any login, CAPTCHA, permission, state-changing input, submission, deletion, or real-program screenshot.

An `$ego-browser` execution failure is not, by itself, a reason to fall back to Chrome control. Report the blocker, or use a Chrome exception only when its own gate is satisfied.

## Chrome Control Exception Gate

`chrome:control-chrome` is allowed only when:

- The owner explicitly asks to use Chrome control; or
- The task cannot be completed without the user's existing Chrome tabs, cookies, extensions, or authenticated session.

Do not use Chrome control as a generic fallback after `$ego-browser` fails or is not directly available. When the exception depends on login state or a real screenshot, wait for the owner approval required by the task's risk.

## DevTools Exception Gate

The DevTools surface is a non-default exception path. It is allowed only when the owner explicitly asks for it or when a current-truth skill requires it for a narrow purpose such as structured page inspection, network/performance debugging, viewport emulation, or element-first visual evidence capture.

When the DevTools exception path is used:

- Reuse shared browser context by default.
- Request `isolatedContext` only when shared context would distort results, create unacceptable auth side effects, or create unacceptable storage side effects.
- Before the first isolated request, record `task_scope_id` and `isolation_reason` with `hazard=<result_distortion|auth_side_effect|storage_side_effect>` and `shared_context_failure=<why shared context is not acceptable>`.
- Use at most one isolated context per `task_scope_id`; later pages for the same task must reuse it.
- Block any attempt to create a second isolated context for the same `task_scope_id` unless the caller explicitly starts a new task scope.

For ordinary page opening, local preview verification, or "open this in the browser" requests, use `$ego-browser`. DevTools is not a generic fallback after `$ego-browser` fails.

## Allowed Routes

`ego-browser` is the default route when at least one condition is true:

- The task requires visible browser state or interaction that files, scripts, and source-of-truth tools cannot provide.
- The user asks to open, inspect, test, or interact with a web page.
- The task requires a local preview or a deterministic browser-validation surface.

`Computer Use` is allowed only when at least one condition is true:

- The user explicitly asked to control a desktop app.
- The required target is a desktop app with no sufficient CLI, MCP, API, file, or browser-specific surface.
- A lower-intrusion path has failed and the remaining task cannot be completed without desktop GUI control.

For browser work, use `chrome:control-chrome` or `chrome-devtools` only with the explicit exception rationale above. Generic statements such as “当前线程里没有可调用的 ego-browser” do not authorize a Chrome fallback.

The repo does not maintain a separate project-owned browser fallback. If `$ego-browser` is blocked and no explicit browser exception applies, report the blocker or evaluate Computer Use through this gate.

## Required Pre-Use Disclosure

Before using Computer Use, disclose this one-line gate result unless the user's current request explicitly named that exact tool:

```text
GUI escalation: tool=computer-use; reason=<why ego-browser and browser exceptions are insufficient>; target_scope=<page/app/window/capture scope>; risk=<none|click|input|submit|delete|permission|login-state|real-screenshot>
```

For a Chrome or DevTools exception, state the narrowly applicable reason before acting, for example:

```text
Browser exception: tool=chrome:control-chrome; reason=requires the user's existing authenticated Chrome session
```

If `risk` includes `submit`, `delete`, `permission`, `login-state`, or `real-screenshot`, wait for explicit user approval before acting.

## Hard Blocks

- Do not use Computer Use just because it is visible or enabled.
- Do not use Computer Use only because the prompt says "open", "test", "view", "check", or "screenshot"; first determine whether `$ego-browser` satisfies the task.
- Do not use `chrome:control-chrome` merely because `$ego-browser` is unavailable or has failed.
- Do not offer `chrome-devtools` as the next step for an ordinary page-open task after `$ego-browser` fails.
- Do not use `Computer Use` as a browser fallback while `$ego-browser` remains viable.
- Do not treat a freshly launched Chrome/Chromium/`9222` debugging instance as valid evidence that the repo-owned DevTools Surface was available all along; that is `Synthetic DevTools Bootstrap`, and it is blocked by default.
- Do not treat generic user wording like “在浏览器打开”“继续验证”“你自己看一下” as authorization to launch a fresh debugging browser instance.
- Do not modify bundled plugin cache skill files to enforce this policy; they can be overwritten by plugin updates.
- Do not capture fullscreen desktop or unrelated windows.

## Output Contract

When escalation is blocked, report which lower-intrusion path is still viable or which required browser blocker evidence is still missing, and continue with the safest viable path.

When escalation is allowed, keep the target scope narrow and return to non-GUI tooling as soon as the GUI-only evidence or action is complete.
