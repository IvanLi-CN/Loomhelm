# ADR 0034：稳定 Gateway 与按编排绑定版本的 Worker

## Status

Accepted for the package-backed Multi-task Flow viewer; implementation and release remain separate work.

## Context

The viewer must provide public pages and authentication independently from any single orchestration, while different runs must continue using the `@loomhelm/multi-task-flow` version bound to each run. The daemon is the HTTP Gateway and must remain the single public service process; run-specific Workers are the separate processes. The current daemon also hosts Worker servers in-process, so a worker failure can remove the public gateway and a package upgrade can incorrectly make every run use one global version.

## Decision

The architecture is named **Stable Gateway + Per-Run Versioned Workers**. The daemon is the Stable Gateway process and owns the configured loopback HTTP port. It serves the index page, authentication success and failure pages, public assets, generic error pages, diagnostics and the authenticated run entry point. Run-specific Workers are separate processes from this daemon/Gateway process.

The daemon is the **Gateway and Worker Supervisor**. It provides the Gateway HTTP surface and starts, stops, health-checks, upgrades and recovers Worker processes. It does not delegate the public Gateway surface to another process.

Each run carries a version identity containing the package version, build ID, source SHA and data/viewer contracts. After authentication, the gateway resolves that identity and routes the run to a worker process for the matching release. Different runs may use different worker versions concurrently. A worker only serves run-specific view, resource and SSE behavior; it does not serve the index, login or generic error pages.

Workers are selected and reused by immutable version identity and run compatibility, never by the daemon's mutable latest pointer. Missing, unsupported or unavailable identities produce a gateway-owned structured error without starting an unrelated worker.

## Upgrade and recovery

Gateway and Worker updates are separate operations. A Gateway update is a daemon/package upgrade: it stages and verifies a new daemon/Gateway release, drains the current daemon process, restarts the same fixed-port Gateway and health-checks its public API and asset contract. Existing run/version mappings do not change during a Gateway update.

A Worker update stages a new package release alongside existing releases. It does not change a global latest pointer for existing runs. A run version change is an explicit CLI run-scoped operation that records the target package version, build ID, source SHA and compatibility result in the run binding before the gateway routes new requests to the new worker. The old worker remains available until its active requests drain and no run mapping references it.

Gateway rollback restores the previous gateway candidate without changing run version mappings. Worker rollback changes only the explicitly selected run mappings and requires the target release to pass the same compatibility check. A failed candidate never changes the stable gateway port or a run's version identity.

If a worker fails, the gateway remains available for index, authentication and diagnostics and applies the worker recovery contract. If the gateway fails, the daemon restarts it without changing run version bindings. If the daemon fails, the CLI can still update a run binding because that transaction uses the run's own lock and storage; the daemon later discovers the changed binding and reconciles the corresponding worker. Daemon notification is an optimization, not a correctness dependency.

## Command contract

Automatic package discovery belongs to the `multi-task-flow` CLI and is independent of whether the target is a Gateway or an orchestration. The CLI reads a local discovery cache, returns the last known update hint immediately, and schedules a throttled asynchronous registry check when that cache is stale. The daemon and Gateway do not perform package discovery.

The Gateway exposes a shared version/update hint contract to both page types. The contract includes `surface` (`gateway` or `orchestration`), `current` (`package_version`, `build_id`, `source_sha`, `compatibility_line`, `viewer_contract`), `target` when an update is available, `compatible` (`true`, `false` or `unknown`), `reason` and the exact upgrade command. The index consumes the `gateway` surface; a run page consumes the `orchestration` surface for its `run_id`. `unknown` is rendered as an unavailable check with a diagnostic reason and never as “up to date”.

The update hint is available to the caller of the CLI upgrade command and may be forwarded to the Gateway or orchestration page by the caller. The displayed current identity still comes from the Gateway release identity or the run's persisted version binding; package discovery never changes either identity.

The asynchronous CLI checker is throttled by package name and compatibility line. It uses a lock, `checked_at`, `next_check_at`, bounded timeout, failure backoff and a safe error state; concurrent CLI invocations reuse one in-flight check and never create duplicate registry requests. A stale cache is reported as pending while the previous result remains available. The checker is an internal detached CLI task and is not a public command or a daemon feature.

The public maintenance surface has exactly two commands: `multi-task-flow gateway upgrade` and `multi-task-flow orchestration upgrade`. The published exact-version CLI wrapper remains `bunx --bun @loomhelm/multi-task-flow@<cli-version>`, while the command target selects the upgrade boundary.

`multi-task-flow gateway upgrade <version|tag>` upgrades the stable Gateway. `--dry-run <version|tag>` performs release discovery, artifact verification, compatibility checks and the planned fixed-port handoff without changing live state. `--rollback <version|tag>` selects a previously verified Gateway release and restores it through the same health and handoff checks. `--dry-run` and `--rollback` are mutually exclusive, and a rollback target must be an immutable version or an explicitly resolved tag. Neither flag is the update prompt surface.

`multi-task-flow orchestration upgrade --run-id <run-id> <version|tag>` updates the target orchestration's version sidecar through the CLI and run lock; it does not call the daemon to perform the transaction. `--dry-run [version|tag]` checks release availability and run compatibility without changing the sidecar. `--rollback [version|tag]` writes a previously verified compatible target to that orchestration's sidecar. The CLI generates and checks request identity, revision and source digest internally; users do not provide concurrency fences. After a successful write, the CLI may send a best-effort refresh notification to the daemon, but notification failure does not fail the orchestration upgrade. Workers have no update command or self-update capability.

Every mutating command is idempotent by `request_id`, rechecks the expected run revision and source digest while holding the lifecycle/run lock, and returns the resulting gateway identity or run version mapping. A command that targets a missing, incompatible or unverified build fails before changing the stable port or run mapping.

## Verification

Verification must prove that the daemon/Gateway and each Worker have different PIDs, that only the daemon/Gateway owns the HTTP port, that index and authentication pages work with no Worker, that two runs bound to different package versions can be served concurrently, and that stopping the daemon/Gateway or a Worker produces its specified recovery behavior.
