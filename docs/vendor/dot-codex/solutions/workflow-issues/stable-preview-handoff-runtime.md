---
title: Native background preview handoff guard
module: codex-global-workflow
problem_type: workflow_issue
component: local-preview-handoff
tags:
  - preview
  - localhost
  - native-background
  - port-registry
status: active
related_specs:
  - docs/specs/stable-preview-runtime/SPEC.md
  - docs/specs/retire-legacy-service-manager/SPEC.md
  - docs/specs/global-port-preview-governance/SPEC.md
symptoms:
  - localhost preview URL worked during the current exec session but died before the user could revisit it
  - port leases remained after the backing process had already disappeared
root_cause: The workflow distinguished port ownership, but not strongly enough between a foreground live preview and a preview still owned by a Codex native background session.
resolution_type: guardrail
---

# Native background preview handoff guard

## Context

- Scope: global Codex workflow for local preview URLs, Storybook review surfaces, and other owner-facing localhost handoffs.
- Trigger: a session handed off `http://localhost:30060` while that preview still depended on a foreground exec session; later the exec was interrupted and the URL died.
- Constraint: `global-port-manager` is still the source of truth for port ownership, but owner-facing handoff must continue to rely on Codex native background capability instead of reintroducing a repo-local service manager.
- Responsibility boundary: the Agent/host creates and retains the native background session; repo Skills manage only their own service process and port lease. A Skill must not infer a hidden session from a PID or visible terminal.

## Symptoms

- A localhost preview is valid during the current browser validation, then disappears after the owning foreground exec exits.
- The agent can prove the port lease exists, but cannot prove the preview is still held by a Codex native background session.
- `leases.tsv` keeps recent rows whose `pid` is gone or whose port is no longer listening.

## Root cause

- After retiring the legacy `devctl/zellij` path, the workflow correctly moved back to Codex native background terminals, but the handoff rules did not draw a hard enough line between:
  - `live exec preview`: tied to the current foreground exec and suitable only for same-turn validation.
  - `native background handoff preview`: still owned by a Codex native background session and therefore eligible for owner-facing localhost handoff.
- Port leasing without pid-backed cleanup also left stale rows behind, which blurred provenance further.

## Resolution

- Keep owner-facing localhost handoff on Codex native background capability; do not add a repo-local detached runtime.
- Keep the existing dashboard wrapper responsible for its own PID, lease heartbeat and service-only release; this is service lifecycle bookkeeping, not a replacement for host-native session management.
- Require owner-facing localhost handoff to prove both facts:
  - the port belongs to the current scope/service lease;
  - the service is still owned by the current workspace's Codex native background session, with `agent_session` recorded when available.
- Treat any preview still dependent on a foreground live exec as non-handoffable, even if the lease is correct.
- Keep `skills/global-port-manager/scripts/port_registry.ts` as the implementation that self-heals pid-backed leases immediately when:
  - the stored `pid` is dead; or
  - the leased port is no longer listening.
- Require dashboard wrappers to atomically claim an empty-PID lease under the registry lock, bind the listener while that claim is held, and write their PID only after the listener is confirmed; an existing PID or already-listening port is a duplicate-startup blocker, not an invitation to transfer ownership.
- Capture the listener cleanup handle before post-bind verification or lease persistence, and stop it on any startup failure so a rejected handoff cannot leave an unmanaged local service.
- Keep the old `24h + port-not-listening` TTL only for historical pid-less rows.

## Guardrails / Reuse notes

- Always resolve a lease first via `$global-port-manager`; native background ownership does not replace lease ownership.
- Use `live exec preview` only for current-turn browser validation. If the user may revisit the URL later, the service must be moved under a Codex native background session first.
- If the runtime exposes an `agent_session`, write it into the lease so later turns have a concrete provenance breadcrumb.
- Pass `agent_session` only when the Codex host supplied the real identifier. If no supported native background route exists, keep the URL live-preview-only and report the handoff blocker.
- Do not hand off a localhost URL and then stop the owning background session in the same run.
- Do not kill foreign port owners to “fix” handoff; allocate a new lease instead.

## References

- `docs/specs/stable-preview-runtime/SPEC.md`
- `docs/specs/retire-legacy-service-manager/SPEC.md`
- `docs/specs/global-port-preview-governance/SPEC.md`
- `sessions/2026/04/12/rollout-2026-04-12T15-22-00-019d8091-9ee8-7882-b386-17304fca9830.jsonl`
