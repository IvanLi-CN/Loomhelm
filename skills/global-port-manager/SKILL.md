---
name: global-port-manager
description: "Manage global per-worktree port leases."
---

# Global port manager

Use this skill when you need to allocate, register, inspect, or release ports globally across projects/services, and need traceability for who is occupying which port.

## Why this skill

- One global source of truth for active leases: `${CODEX_HOME:-~/.codex}/state/port-registry/leases.tsv`
- Concurrency-safe writes using file locks + atomic replace
- Immediate cleanup for pid-backed stable leases when the process dies or the port stops LISTENing; legacy pid-less rows still use the `24h + port-not-listening` TTL rule
- Compatible with worktree lifecycle hooks (`git-worktree`, `git-cleanup`)
- Intended to gate all long-lived local services before they start listening on a port

## Data model

`leases.tsv` stores **active leases only** (rows are deleted on release).

Columns (fixed order):

- `scope_id`
- `project`
- `repo_root`
- `branch`
- `worktree_path`
- `service`
- `port`
- `port_base`
- `block_size`
- `claimed_at`
- `last_seen_at`
- `agent_session`
- `pid`

Defaults:

- automatic allocation uses stable scope-random candidate blocks at or above `10000`
- `--start-base` is the lower bound for automatic `allocate` / `suggest` candidates; default is `10000`
- block step is `10`
- block size is `10`
- stale lease TTL is `24h`

`scope_id` rule:

- Must be globally unique across repos/scopes.
- Recommended deterministic format: `<project>--<repo_hash8>--<scope_slug>`.
- `repo_hash8` should be derived from absolute repo root path SHA256 first 8 chars.
- Do not use bare slugs like `pm-a` as `scope_id`.
- A Ticket envelope may provide a resolved `port_scope_id`. Reuse it only when it follows this rule and matches the current task/repo facts; do not derive a new scope from an internal Codex-managed Worktree directory.

## Script

- Path: `skills/global-port-manager/scripts/port_registry.ts`
- Production runtime: Node.js 22/24 or Bun through the packaged client (`skills run skills/global-port-manager/scripts/port_registry.ts <arguments>`). Bun is not required when using the Node.js client.
- The raw TypeScript examples below use Bun for source-development convenience; they do not declare a production dependency on Bun.

Common flags:

- `--registry-dir` (optional): override registry root; default `${CODEX_HOME}/state/port-registry` when `CODEX_HOME` is set, otherwise `~/.codex/state/port-registry`
- `--lock-timeout-sec` (default `10`)
- `--ttl-hours` (default `24`)
- `--json` for machine-readable output
- Compatibility: `--workspace-id` is accepted as an alias of `--scope-id`

### Allocate (recommended for new worktree/service)

```bash
bun "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/global-port-manager/scripts/port_registry.ts" --json \
  allocate \
  --scope-id <id> \
  --project <project> \
  --repo-root <repo_root> \
  --branch <branch> \
  --worktree-path <path> \
  --service <service>
```

Behavior:

- Reuses existing lease for the same `scope_id + service`
- Otherwise picks an available port from a deterministic, scope-randomized block order
- New automatic leases default to ports at or above `10000`; explicit `register --port` keeps caller-provided port semantics
- Runs GC before allocation

### Register (explicit port)

```bash
bun "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/global-port-manager/scripts/port_registry.ts" --json \
  register \
  --scope-id <id> \
  --service <service> \
  --port <port> \
  --project <project> \
  --repo-root <repo_root> \
  --branch <branch> \
  --worktree-path <path> \
  [--pid <pid>] \
  [--expected-pid <pid> | --expect-empty-pid] \
  [--agent-session <session-id>]
```

Dashboard wrappers that own startup must use the registry's atomic claim-and-run path when available: it validates the preallocated empty-PID lease, rejects an existing PID or already-listening duplicate, holds the registry lock while the wrapper binds its listener, and records the wrapper PID only after the listener is confirmed. A wrapper must not emulate this with a separate `inspect` followed by `register`, because that can overwrite an active owner or expose a startup window to GC.

### Heartbeat

```bash
bun "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/global-port-manager/scripts/port_registry.ts" --json \
  heartbeat --scope-id <id> --service <service> [--port <port>] [--pid <pid>] [--expected-pid <pid>] [--agent-session <session-id>]
```

### Inspect

```bash
bun "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/global-port-manager/scripts/port_registry.ts" --json inspect
bun "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/global-port-manager/scripts/port_registry.ts" --json inspect --scope-id <id>
bun "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/global-port-manager/scripts/port_registry.ts" --json inspect --port <port>
```

### Release

```bash
bun "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/global-port-manager/scripts/port_registry.ts" --json \
  release-service --scope-id <id> --service <service>

bun "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/global-port-manager/scripts/port_registry.ts" --json \
  release-scope --scope-id <id>
```

Compatibility:

- `release-worktree` is accepted as an alias of `release-scope`.

### GC

```bash
bun "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/global-port-manager/scripts/port_registry.ts" --json gc
```

## Default contract for long-lived local services

Use this order whenever an agent starts a local service that keeps listening on a port:

1. Resolve a deterministic `scope_id` for the current repo/worktree.
2. Determine whether the command or repo script has an explicit/default port.
3. If a port is already known, run `inspect --port <port>` first to learn ownership before starting anything.
4. If the known port is already leased by another scope or is currently LISTENing for another workspace, do not reuse it:
   - report the owner/path evidence;
   - allocate or register a different port for the current scope;
   - inject that port into the command with env/flags.
5. If no port is predetermined, run `allocate` before starting the service.
6. Start the service only after the chosen port is leased to the current scope.
7. For long-running sessions, refresh the lease with `heartbeat`; whenever the runtime exposes a stable `pid` or `agent_session`, keep those fields populated on the lease.
8. Before sharing a local preview URL with the user, verify that the URL port matches the current lease or a repo-declared stable preview port owned by the current workspace.
9. If the URL will appear in an owner-facing reply, require a Codex native background session to keep owning that service after the current turn, and populate `agent_session` on the lease whenever the runtime exposes it.

The port manager owns lease allocation, atomic startup claim, inspection, heartbeat and release only. A service wrapper must atomically claim its preallocated lease before binding, reject an existing owner instead of treating its PID as transfer authorization, and pass its recorded port and expected PID when heartbeating or releasing so a replaced lease cannot be changed by the old process. `pid` remains the value to record; `expected-pid` is the ownership guard for subsequent lifecycle operations. The registry does not create, attach, retain or prove the liveness of a Codex native background session. The Agent must obtain that session from the host and may pass only the host-provided identifier; an `agent_session` value is provenance metadata, not proof that the host session exists. If the host exposes no supported background route, do not substitute a visible terminal or foreground exec and do not hand off the URL.

## Live vs stable preview contract

- `live exec preview`: current-turn-only validation surface backed by the active exec/native background session for the current scope; acceptable for internal browser verification, not for final localhost handoff.
- `native background handoff preview`: preview runtime backed by the current lease plus an active Codex native background session for the current scope; required before giving the user a localhost URL that should survive past the current foreground exec step.
- If a preview still depends on the lifetime of the current exec session, it is `live`, even if the port is leased correctly.
- If `inspect/register/allocate/heartbeat/gc` discovers a pid-backed lease whose `pid` is dead or whose port is no longer listening, treat it as stale and let the registry self-heal instead of waiting for the 24h TTL.

Repo scripts with built-in defaults do not bypass this contract. The default value is only an input to inspect/register/override, not permission to grab that port blindly.

## Integration contract

- `git-worktree` create: call `allocate` right after worktree creation.
- Worktree-local service flows: call `allocate/register` before starting services and `heartbeat` during long-running sessions.
- Any long-lived local service (`vite`, `next dev`, `storybook`, backend preview server, docs preview, local admin UI, etc.): call `inspect` on any known/default port first, then `allocate/register` before the process starts.
- Local preview handoff: only share a localhost URL after confirming that the URL's port belongs to the current scope lease or to a repo-declared stable preview service started from the current workspace; owner-facing handoff must additionally prove that the service is still held by a Codex native background session rather than a foreground live exec. The host session is an Agent/host responsibility, not a port-manager responsibility.
- `git-worktree` remove: call `release-scope` after successful removal.
- `git-cleanup`: call `release-scope` whenever a PR/Wave/spec worktree is removed.
- Native Codex task Worktrees keep their lease scope in the Ticket envelope. They may release a service lease when the task stops, but archive/removal of the Worktree itself remains with Codex native task lifecycle.

## Guardrails

- Never edit `leases.tsv` directly; always use the script.
- Treat lock timeout or duplicate lease validation as blocking errors.
- If `scope_id` cannot be derived reliably from path naming, ask the user before writing leases.
- If `inspect` shows the port is owned by another scope/worktree, do not kill, reuse, or "take over" that port unless the user explicitly instructs you to do so.
- If the current port owner cannot be mapped back to the current scope, treat the conflict as foreign and allocate another port.

## Installed shared user services

The explicitly installed multi-task-flow viewer uses a user service scope `multi-task-flow--user-<uid>` (isolated profiles append a root digest), without invented repository/worktree or `agent_session` provenance. Its install command selects and saves one high port and resolves the registry directory once. Every runtime registers that fixed port, claims/binds under the registry lock, records its actual PID, heartbeats, and releases with expected PID/port guards. Offline instances hold no active lease; conflict fails without renumbering or process takeover. User-level launchd supplies background ownership; the native Codex session requirement continues to apply to temporary previews.
