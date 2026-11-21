# Port registry CLI

Run through Bun 1.4.5 only. Define one wrapper per shell so every command shares the same invocation:

```bash
port_registry() {
  bun --no-install "${LOOMHELM_TOOLKIT_ROOT:?set packaged toolkit root}/skills/global-port-manager/scripts/port_registry.ts" --json "$@"
}
```

## Common flags

- `--registry-dir` (optional): override registry root; default `${CODEX_HOME}/state/port-registry` when `CODEX_HOME` is set, otherwise `~/.codex/state/port-registry`
- `--lock-timeout-sec` (default `10`)
- `--ttl-hours` (default `24`)
- `--json` for machine-readable output
- Compatibility: `--workspace-id` is accepted as an alias of `--scope-id`

## Allocate (recommended for new worktree/service)

```bash
port_registry \
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

## Register (explicit port)

```bash
port_registry \
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

## Heartbeat

```bash
port_registry \
  heartbeat --scope-id <id> --service <service> [--port <port>] [--pid <pid>] [--expected-pid <pid>] [--agent-session <session-id>]
```

## Inspect

```bash
port_registry inspect
port_registry inspect --scope-id <id>
port_registry inspect --port <port>
```

## Release

```bash
port_registry \
  release-service --scope-id <id> --service <service>

port_registry \
  release-scope --scope-id <id>
```

Compatibility:

- `release-worktree` is accepted as an alias of `release-scope`.

## GC

```bash
port_registry gc
```
