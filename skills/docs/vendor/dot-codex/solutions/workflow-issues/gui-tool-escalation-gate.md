---
title: GUI tool escalation gate
module: codex-global-config
problem_type: workflow_issue
component: agent-tool-routing
tags:
  - gui-automation
  - bundled-plugins
  - tool-routing
status: active
related_specs:
  - docs/specs/gui-escalation-gate/SPEC.md
---

# GUI Tool Escalation Gate

## Context

Codex may expose multiple GUI-capable tools at the same time. Bundled plugin skills can have broad trigger descriptions, so leaving the plugins enabled may cause agents to use GUI automation earlier than intended.

## Root Cause

Bundled plugin cache files are not a stable policy layer. Editing those files can be overwritten by plugin updates or cache refreshes, while disabling the plugins removes legitimate fallback capability.

Another recurring failure mode is fallback drift: an agent sees an `$ego-browser` setup or command failure and treats it as permission to switch to Chrome control, although the requested task has no Chrome-specific requirement.

A second failure mode is `Synthetic DevTools Bootstrap`: the agent launches a fresh Chrome/Chromium/`9222` debugging instance and then treats that synthetic browser as if the repo-owned DevTools Surface had been available all along.

## Resolution

Keep GUI-capable plugins enabled, but enforce routing through repo-controlled policy:

- Put the hard rule in `AGENTS.md`.
- Add a repo-owned skill that governs browser exceptions and GUI escalation.
- Preserve the lower-intrusion ladder: files/shell/project scripts/MCP/API/`ego-browser` before explicit Chrome / DevTools exceptions or `Computer Use`.
- Require a short pre-use disclosure that names the tool, reason, target scope, and risk.
- Require Chrome / DevTools exceptions to state their concrete task-specific reason; an `$ego-browser` failure alone is not enough.
- Use one `$ego-browser` TaskSpace for each user goal.
- Keep `$ego-browser` as the default browser route. Chrome control and `chrome-devtools` remain explicit exception paths, and `Synthetic DevTools Bootstrap` remains disallowed as a normal recovery path.
- Keep the fix in the current repo-owned policy layer only; do not try to “solve” this by editing bundled plugin cache files.

## Guardrails

- Do not edit OpenAI bundled plugin cache files for long-term policy.
- Do not disable GUI plugins solely to prevent accidental use.
- Treat `Computer Use` as the highest escalation, not as a browser fallback.
- Require explicit approval before state-changing or privacy-sensitive GUI actions.
- For browser validation, prefer `$ego-browser`; use Chrome control only when the owner explicitly requests it or the existing Chrome session is required.
- Do not treat `$ego-browser` unavailability as authorization to offer a Chrome or DevTools fallback.
- Do not treat generic wording like “在浏览器打开” or “继续验证” as authorization to launch a fresh debugging browser instance; that authorization must be explicit and task-scoped in the same thread.

## References

- docs/specs/gui-escalation-gate/SPEC.md
- skills/gui-escalation-gate/SKILL.md
