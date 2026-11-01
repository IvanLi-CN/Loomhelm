# ADR 0014: Stable deployment control plane and blue-green promotion

Status: Accepted

## Context

Loomhelm runs Server, Worker and Connector as independently restartable processes, but the current 101 installation still uses one Server and one Worker slot. The repository already has immutable candidate builds, Worker lease fencing, Caddy preview switching and Connector connection-generation recovery, but those pieces are not yet one authenticated deployment contract.

Deployment control must not become a project-membership feature or expose Docker, Compose or shell execution to a browser. It must also distinguish an accepted command, an observed traffic switch and an unknown result after a controller or proxy failure.

## Decision

Add a stable deployment controller outside the normal Server/Worker/Connector/Web candidate. It owns the allowlisted runtime executor, deployment lock, persistent operation state, audit events and reconciliation. The browser and REST/MCP adapters never receive arbitrary command arguments or host paths.

Use one configured installation environment. The active HTTP slot is selected by stable Caddy; Caddy proxies `/api`, `/mcp`, `/gateway`, health and version routes to the active Server and serves the current or retained Web tree. Caddy admin binds only to a dedicated private control-network address and is controlled by the deployment controller through a control-network-only alias.

Stage starts the inactive Server and validates candidate identity, readiness, Web digest and state compatibility without admitting a production Worker generation. Promote renders and validates the complete candidate Caddy configuration before admitting the next Worker generation, then starts that generation, verifies readiness, reloads Caddy, observes the public identity and drains the retiring Server. If a response is lost after fencing, reconciliation completes the already-admitted generation; it never reuses a lower Worker generation.

Persist deployment candidates, slots, operations, idempotency keys and append-only audit events in PostgreSQL. A PostgreSQL advisory lock and an expected-current fingerprint provide single-installation serialization and stale-browser protection. Every external side effect has an intent and an observed result; a lost response becomes `unknown` and requires reconciliation before retry. Accepted operations and their first audit event commit atomically.

The current candidate schema 2 remains the immutable build contract. Deployment adds a separate envelope containing the candidate digest, source SHA, component digests, Web tree digest, compatibility range and migration mode. Candidate registration compares the complete stored envelope JSON on repeated IDs, so compatibility changes cannot be silently accepted. The deployment controller is versioned separately and is not replaced by ordinary candidate promotion.

Installation deployment roles are separate from project roles: observer, operator, releaser, recovery and installation owner. Phase one exposes read-only deployment information through MCP; REST is the sole public mutating deployment adapter.

## Consequences

The first single-slot-to-dual-slot migration needs a controlled maintenance window to adopt the current service as blue, enable the dedicated private Caddy admin address and add the inactive slot. PostgreSQL and artifact volumes remain shared and are never removed by the template.

Blue-green protects HTTP traffic and preserves old Web assets, but it does not reverse database migrations or guarantee zero WebSocket interruption. Connector reconnect, host connection generation and durable command reconciliation remain separate observable outcomes. Production Worker services are Compose-profiled and are started only by the controller's fixed service command; the controller uses Compose exec to invoke the loopback-only drain endpoint inside each retiring container.

## Compatibility and recovery

Deployment state migrations are additive and forward-only. The allowed initial migration modes are `none` and a proven backward-compatible `expand`; down-migration is forbidden. A stopped release is repaired forward, while backup restore remains a separate disaster-recovery procedure.

## References

- [Deployment design and runbook](../deployment.md)
- [Immutable candidates](../candidates.md)
- [Lease-fenced Worker recovery](0010-lease-fenced-run-worker-recovery.md)
- [Public protocol and reconciliation](0003-public-protocol-and-reconciliation.md)
