# GUI Escalation Gate

## Related ADRs

None

## Context and Scope

This topic governs repository-owned browser routing: `$ego-browser` is the normal rendered-browser route, Chrome and DevTools are narrow exceptions, and Computer Use is the highest GUI escalation. It covers `AGENTS.md`, the routing skill, policy replay checks, and their compatibility fixtures; it does not modify bundled plugin caches or runtime interception.

## Requirements

### REQ-EGO-BROWSER-DEFAULT

- Browser tasks that require rendered state or interaction MUST use `$ego-browser` after lower-intrusion sources are insufficient.
- Each `$ego-browser` task MUST use one TaskSpace for the user goal.

### REQ-BROWSER-EXCEPTIONS

- `chrome:control-chrome` MUST be used only when the owner explicitly requests it or the task requires the user's existing Chrome session.
- `chrome-devtools` MUST be limited to its documented narrow purposes. An `$ego-browser` failure or generic unavailability claim MUST NOT authorize either exception.

### REQ-GUI-SAFETY

- Computer Use MUST remain an explicit escalation. Login, CAPTCHA, permission, state-changing input, submission, deletion, and real-program screenshots require the task-specific owner approval.
- Synthetic DevTools bootstrap MUST NOT be used without same-thread, task-scoped authorization.

## Verification

### VER-BROWSER-ROUTING covers: REQ-EGO-BROWSER-DEFAULT, REQ-BROWSER-EXCEPTIONS, REQ-GUI-SAFETY

- `python3 bin/browser_policy_replay_check.py --policy` verifies the active default route and exception boundaries.
- The canonical replay cases verify that an unavailable or failed `$ego-browser` does not normalize a Chrome fallback, while an ego-browser-first path passes.

## Context

Codex can expose multiple GUI-capable surfaces at once, including bundled `Computer Use`, `chrome:control-chrome`, `chrome-devtools`, and third-party browser automation skills. Some bundled plugin skills use broad trigger language. If those tools remain enabled, an agent may reach for GUI automation earlier than desired.

Disabling the bundled plugins is not acceptable because a future task may legitimately require them. Editing bundled plugin cache files is also not reliable because plugin updates or cache refreshes can overwrite those files.

## Goals

- Make `$ego-browser` the default browser automation path.
- Keep `Computer Use` as an explicit escalation path rather than the default path.
- Prefer lower-intrusion tooling whenever it can satisfy the task.
- Require a short, auditable pre-use disclosure before GUI automation unless the user explicitly requested the exact GUI tool.
- Preserve screenshot privacy contracts and the `ego-browser` default browser route.
- Block Chrome and DevTools exceptions unless their narrow justification is explicit.
- Block browser-task recovery paths that try to synthesize a fresh DevTools Surface by launching a new Chrome/Chromium/`9222` debugging instance without explicit same-thread owner authorization for that exact browser task.
- Keep `AGENTS.md` as a short entrypoint and move detailed DevTools exception and isolated-context policy into the gate skill/spec.

## Non-Goals

- Do not disable bundled plugins by default.
- Do not edit OpenAI bundled plugin cache files.
- Do not block the repo-owned `$ego-browser` browser route.
- Do not add runtime-level tool interception beyond prompt and skill governance.
- Do not redefine the bundled `chrome:control-chrome` skill itself inside plugin cache files.

## Contract

The global route for task execution is:

1. Files, source, logs, configs, manifests, local caches.
2. Shell commands, project-native scripts, tests, builds, linters, formatters.
3. MCP/API/source-of-truth tools for the target service.
4. `$ego-browser` for rendered browser state.
5. `chrome:control-chrome` or `chrome-devtools` only through their explicit exception gates.
6. `Computer Use` only as the highest GUI escalation.

Before the first `$ego-browser` command in a task, the agent must load and follow its selected skill. Before using Computer Use, the agent must apply `skills/gui-escalation-gate/SKILL.md`.

For browser tasks, `chrome:control-chrome` is allowed only when the owner explicitly asks for it or the task genuinely requires the user's existing Chrome session. `chrome-devtools` remains a narrow exception for structured inspection, network/performance debugging, viewport emulation, or element-first capture. An `$ego-browser` failure or generic tool-unavailability claim does not authorize either exception.

Launching a new Chrome/Chromium/`9222` debugging instance merely to make `chrome-devtools` appear available is `Synthetic DevTools Bootstrap` and is blocked by default. It is allowed only when the owner already gave explicit, task-scoped authorization in the same thread for that exact browser task / target scope.

Ordinary page opening, local preview verification, and generic “open in browser” requests must use `$ego-browser`; they must not offer Chrome control or DevTools as fallbacks after `$ego-browser` fails.

If the user did not explicitly request the exact GUI tool, the agent must disclose:

```text
GUI escalation: tool=computer-use; reason=<why ego-browser and browser exceptions are insufficient>; target_scope=<page/app/window/capture scope>; risk=<none|click|input|submit|delete|permission|login-state|real-screenshot>
```

If the risk includes state-changing or privacy-sensitive actions, the agent must wait for explicit approval before acting.

For a Chrome or DevTools exception, the agent must state the narrowly applicable reason before acting.

## Acceptance

- `AGENTS.md` defines a global GUI escalation gate.
- `skills/gui-escalation-gate/SKILL.md` exists and documents the decision ladder, allowed escalation cases, required disclosure, and hard blocks.
- The policy keeps bundled plugins enabled but does not rely on editing bundled plugin cache files.
- `$ego-browser` remains the default formal browser entrypoint for normal browser validation.
- Each `$ego-browser` task uses one TaskSpace for its user goal.
- Chrome control and DevTools are blocked as generic fallbacks; each requires its own explicit exception rationale.
- `Synthetic DevTools Bootstrap` is explicitly disallowed by default and cannot be justified by generic browser wording such as “在浏览器打开” or “继续验证”.
- `AGENTS.md` contains no long DevTools isolated-context policy and has no more than two literal `chrome-devtools` references.
- Replay/policy checks catch the regression where an agent reports `$ego-browser` unavailable and then asks to fall back to Chrome control for a normal page-open request.
