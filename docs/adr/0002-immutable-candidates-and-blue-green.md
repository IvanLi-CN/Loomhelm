# ADR 0002: Immutable candidates and state-compatible blue-green

Status: Accepted

## Context

Frequent Agent-assisted iteration needs a repeatable deployment route before business features grow. A traffic switch alone cannot protect running Codex work, persisted queue state, artifacts or installed PWA clients.

## Decision

Build candidates from exact source SHAs and retain artifact digests. Promotion reuses those artifacts. Use Caddy to switch HTTP between two ready slots, drain retiring connections and retain compatible old Web assets. Hand over Worker execution ownership through explicit generations and reject obsolete scheduling authority. Connector reconnect and reconciliation remain independent from HTTP switching.

Keep database and artifact state outside the retiring application slot. Use immutable ordered migrations and an explicit supported state compatibility window. Program switchback is permitted only when the previous candidate is proven to read current state. Outside that window, repair forward; restore-from-backup is a separate recovery operation.

Establish the mechanism in an isolated branch-preview environment before business iteration and repeat verification with real execution and product clients. Production deployment, final versions and branch-rule changes require their own applicable authorization.

## Consequences

Candidates need readiness, drain and version identity contracts, and deployment evidence must include Worker fencing, durable state and client recovery. Shared state prevents treating container replacement as a database rollback. This costs more than replacing a single container but creates the reusable release path required by the product.
