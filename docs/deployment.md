# Loomhelm deployment control

Loomhelm deployment control manages one preconfigured execution environment with immutable candidates, two HTTP/Worker slots, stable Caddy routing and durable operation state. It is an installation control surface, not a host-management module and not a project-membership capability.

## Current state

The 101 installation is currently a single-slot Compose stack with `server`, `worker`, `web` and PostgreSQL. The production template in `deploy/production/` is a validation-safe target shape; it does not apply changes to 101 and does not contain secrets.

The candidate builder emits schema 2. The deployment envelope binds the candidate digest, source SHA, component artifact digests, immutable Server/Worker image references, Web tree digest, state compatibility range and migration mode. A candidate is immutable after publication and must be promoted without rebuilding.

## Runtime topology

Traefik continues to expose stable Caddy. Caddy routes `/api`, `/mcp`, `/gateway`, `/livez`, `/readyz`, `/version` and `/-/drain` to the active Server slot and serves the active plus retained immutable Web trees. The private `/-/observe` endpoints stay off the public Caddy route and are reachable only by the controller over the application/control network. The deployment controller serves `/api/v1/deployment/*` through a separate stable route and reaches Caddy admin through the `caddy-control` alias on the private Compose control network; Caddy binds admin only to that control-network IP and the admin port is not published to the host.

The controller is outside the Server/Worker/Connector/Web candidate. It accepts a fixed command vocabulary and calls an allowlisted executor with fixed Docker and Caddy binary paths; it never accepts arbitrary shell text, Compose arguments, container names or filesystem paths from the browser. The production template assigns Caddy and controller distinct fixed addresses on the private control subnet so parallel startup cannot claim the same admin endpoint.

## State model

Candidate states are `discovered`, `preflight_passed`, `staged`, `active`, `retained`, `failed` and `unknown`. Slot states are `empty`, `staging`, `staged`, `active`, `draining`, `retained` and `failed`. Operation states are `accepted`, `running`, `succeeded`, `failed`, `degraded`, `unknown`, `reconciling` and `blocked`.

`active_fingerprint` contains the candidate ID, source SHA, artifact digest, Web digest, compatibility mode, active slot and Worker generation. Mutating operations require the caller to send the fingerprint observed by the UI. A mismatch returns conflict instead of applying a stale browser action.

## Runtime observation

`GET /api/v1/deployment/observations` reports live evidence for both slots without changing deployment state. The controller reads bounded counters and gauges from each private Server/Worker `/-/observe` endpoint and reads the public `/version` response to compare the route that users actually reach with the desired active slot. The response includes `measured`, `warming_up`, `degraded`, `stale` or `unavailable` state, migration state, sample window, total request/error rates, per-slot request rate/share/error rate, HTTP active requests, generation-attributed Worker running jobs/capacity/utilization and the installation-level shared Worker queue depth.

Traffic rate and share are deltas over two consecutive controller samples, not totals divided by process uptime. A first sample or a counter reset does not produce a fabricated percentage; the Web console shows `采样中`, `--` or `不可用` according to the field's evidence state. A complete endpoint outage retains the last successful values with `stale` status, while a first-time outage is `unavailable`. These observations are intentionally not persisted as business state, so a controller restart starts a new warm-up window.

The traffic bar is evidence of requests reaching each Server slot, while the load row is evidence of work currently admitted to that slot. A draining slot can still show nonzero active requests while the public route already points to the new slot. River queue depth is a shared installation metric and appears once above the slot cards; Worker running jobs and capacity are process-local and are attributed only when the reported generation matches the persisted slot generation. A missing observation is shown as unavailable and does not become zero.

## Candidate and preflight

Preflight verifies the candidate envelope, exact source and artifact digests, immutable image references, the same read-only Web bind mounted into Caddy and the controller, candidate-bound Compose configuration, candidate Caddy configuration, database reachability, migration mode and two-way state compatibility. Candidate Server and Worker readiness plus exact runtime identity are verified during stage and promote without changing the active route before the public switch. The production template uses separate non-overlapping controller mounts for installation files and the Web root.

Stage selects the inactive slot, binds the registered immutable image references and Web tree, starts only the candidate Server, and verifies its exact `/version` identity plus `/readyz`. Stage does not start or admit the candidate Worker to the production lease.

## Promotion and rollback

Promote revalidates the expected current fingerprint, renders and validates the candidate Caddy configuration without replacing the live file, then starts the candidate Worker with a strictly larger generation so its durable lease fences the old generation, and waits for the new Worker to report the exact candidate identity. It installs the already validated Caddy file, reloads Caddy through the private admin network, probes the public `/version`, `/readyz`, `/mcp` and `/gateway` paths, then performs a bounded loopback drain inside the retiring Server and Worker containers before recording the observed active identity.

The retiring Server and Worker receive the loopback-only drain request through fixed Compose `exec` commands and the Server is polled until its readiness endpoint reports draining or its process closes after graceful shutdown. A timeout leaves the old slot non-active and marks the operation degraded; emergency termination requires the recovery permission.

Rollback is a new promotion using a retained compatible candidate and a new Worker generation. It never reverses a database migration. If the cutover response is lost, the operation is `unknown`; the controller reconciles Caddy, slot probes, Worker lease and audit state before any retry.

## Connector behavior

Connector is not upgraded by HTTP blue-green. A Caddy switch may close `/gateway`; Connector reconnects, receives a new host connection generation, resumes retained cursors and rejects stale generations. The durable Connector journal deduplicates commands and reconciles unknown outcomes. Connector recovery is recorded separately from HTTP promotion.

## API and authorization

REST resources are `GET /api/v1/deployment`, `GET /api/v1/deployment/observations`, `GET /api/v1/deployment/candidates`, `POST /api/v1/deployment/candidates`, `POST /api/v1/deployment/preflight`, `POST /api/v1/deployment/stage`, `POST /api/v1/deployment/promote`, `POST /api/v1/deployment/rollback`, `POST /api/v1/deployment/drain`, `POST /api/v1/deployment/reconcile`, `GET /api/v1/deployment/operations/{id}` and `GET /api/v1/deployment/events`.

Long operations return `202` and an operation ID. Stage, promote, rollback and drain require `Idempotency-Key` and confirmation; when an active identity exists they also use `expected_current_fingerprint` as a CAS, while the first empty installation may use an empty fingerprint. Preflight and reconcile are also idempotent but do not change the active route. A matching retry returns the original operation and a different request body returns `409`. The controller permits one mutating operation per installation and at most one active preflight.

The installation roles are `deployment_observer` for reads, `deployment_operator` for preflight and stage, `deployment_releaser` for preflight, stage, promote and rollback, `deployment_recovery` for reconcile and emergency drain, and `installation_owner` for all capabilities. Project `viewer`, `operator` and `owner` roles do not grant deployment authority, and project-scoped API credentials cannot be used for installation deployment operations.

MCP exposes only read-only status, observation, candidate, operation and event tools in phase one. The observation tool uses the same application service as REST and carries the same installation scope; it cannot mutate or acknowledge runtime state. If mutating MCP is added later, it must call the same application service and reuse the REST authorization, idempotency and audit semantics.

## Persistence and audit

Deployment state is durable in PostgreSQL. Candidate rows bind immutable identities; slot rows record active, pending and retained assignments; operation rows record request hash, expected current fingerprint and status; event rows are append-only and contain actor, candidate, slot, generation, observed identity and error class without secrets.

The migration is additive and forward-only. `migration_mode=none` is the default. `expand` is allowed only when the candidate and current release can both read the resulting state. No controller path automatically down-migrates or deletes shared PostgreSQL or artifact volumes.

## Operator workflow

1. Publish the immutable Web tree at `/srv/loomhelm/web/candidates/<candidate_id>` (or the configured `LOOMHELM_WEB_ROOT`) and verify its deterministic Web digest; the production template mounts this same host directory read-only into Caddy and the controller.
2. Register the generated deployment envelope through `POST /api/v1/deployment/candidates`; the controller stores the exact manifest, image digests and compatibility window.
3. Open the installation Deployment page and inspect active identity, desired versus observed route, traffic shares, sample freshness, shared Worker queue load, per-slot HTTP active requests, generation-attributed Worker capacity, Connector status and the latest audit events.
4. Select an immutable candidate and run preflight; review compatibility and migration results.
5. Stage the candidate and wait for Server identity, Web digest and readiness checks.
6. Confirm promote; observe Worker fencing, new generation, public route identity, traffic share moving to the new slot, per-slot load, Caddy switch, public probes and old-slot drain.
7. If the operation is degraded or unknown, wait for reconcile rather than repeating the action.
8. Roll back only to a retained compatible candidate and continue to observe Connector recovery separately.

## 101 migration path

First validate the complete dual-slot stack in the Agent VM. Then add the stable controller in read-only mode to 101, adopt the current single slot as blue with its exact source SHA, artifact digest, Web tree and Worker generation, and enable the dedicated private Caddy admin address. Add green Server/Worker services while preserving PostgreSQL, artifact volumes, secrets, Traefik labels and the existing `/mcp` and `/gateway` paths. Keep both Worker services disabled unless explicitly targeted by the controller's deployment profile. Perform the first real promotion only after a controlled rehearsal proves public route identity, traffic-share movement, per-slot load sampling, WebSocket reconnect, Worker fencing, bounded drain, retained Web fallback and compatible rollback.

## Validation

Run `scripts/checks quality` for Markdown, syntax and deployment configuration. Run `scripts/checks generated` after contract or SQL changes, `scripts/checks source` for Go changes and `scripts/checks web` for Web changes. Run `scripts/rehearse-blue-green --control-only --evidence-dir /tmp/loomhelm-blue-green` for deterministic state-machine and observation-contract coverage, and run the runtime mode in the session-owned Agent VM. Runtime evidence is retained under `observations/` with public route identity, two-sample traffic deltas, per-slot HTTP/Worker load and post-cutover samples; stale recovery is covered by controller tests because it requires withholding runtime endpoints. These commands do not authorize or perform a production deployment.
