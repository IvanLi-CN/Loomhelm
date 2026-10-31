# ADR 0015: Host Ownership and Explicit Sharing

## Status

Accepted for the phase-one Host authorization and Connector routing implementation.

## Context

The initial Connector design treated the installation as one singleton execution host. That model cannot safely support multiple users or more than one registered execution endpoint: project membership could be mistaken for machine access, host credentials could be administered outside their owner's authority, and a session could silently route through an unrelated host.

The browser product still does not need a Host-management page or a Host selector. The authenticated REST and MCP surfaces do need an explicit resource boundary so session routing, Connector enrollment, credential revocation and sharing have one auditable authorization rule.

## Decision

Each registered Host has one user owner. A Host owner may list and revoke that Host's Connector credentials and may grant or revoke use access for an existing user. A shared user may use the Host for authorized session and Run work, but cannot list or mutate its credentials or share grants. Project membership and project-scoped credentials never imply Host access.

Every user has a durable default Host selection when they own or explicitly receive access to a Host. Session creation and Run routing resolve through that default; public session/run operations do not accept an arbitrary machine selector. Legacy singleton rows without an owner remain quarantined from user routing until explicitly repaired by an owner-facing migration or administrative operation.

Default routing preserves a currently authorized selection. When that selection becomes unavailable, the service removes it and deterministically chooses the oldest owned Host, then the oldest explicitly shared Host, ordering ties by Host ID. If no authorized Host remains, routing fails closed until a new Host is registered or shared.

Host-use authorization is evaluated at operation admission. Admission locks the Host row, and share or credential revocation uses the same transaction boundary. A request that commits admission before revocation may finish under that admission; no later admission can pass after the revocation is committed. This is the phase-one linearization point and does not claim retroactive cancellation of already admitted work.

Connector device approval creates a new Host owned by the approving user unless the request names an existing Host owned by that same user. A shared user cannot bind enrollment to another user's Host. The authorization code stores the approving identity and requested Host binding, and completion happens only after the owner-scoped enrollment succeeds.

Each device authorization is also the idempotency key for its Connector enrollment. Migration 00020 binds at most one newly created Host and one credential to that authorization. Retries after a claim lease expires reuse those rows and derive the same opaque token from the in-memory authorization code and durable identities; neither the raw code nor the token is stored in the database. A local cache publication failure remains an operational credential-recovery condition and must be handled through owner-authorized revocation and browser recovery.

Host inventory, credential and share operations are available through authenticated REST and MCP with the same application authorization. Host administration requires an unrestricted user principal; project-scoped bearers and project membership cannot be used as an installation-management substitute. No browser Host-management surface is introduced by this decision.

## Alternatives Rejected

- Keep one global configured Host: rejected because ownership, credential revocation and multi-user routing remain ambiguous.
- Infer Host access from Project membership: rejected because project organization and execution-machine authority are separate boundaries.
- Let shared users administer credentials or shares: rejected because delegation would allow a non-owner to create or revoke deployment authority.
- Accept a caller-selected Host on every session request: rejected because it widens the routing surface and makes default authorization easy to bypass.
- Automatically assign legacy singleton rows to the first user: rejected because migration cannot infer ownership without disclosing or transferring deployment authority.

## Compatibility

Migrations 00019 and 00020 add nullable Host ownership, explicit share grants, per-user defaults, requested-Host device binding and Connector enrollment idempotency. Existing singleton rows are retained but are not implicitly assigned to a user. The public REST/MCP additions and Connector routing change are `public_api=minor`; the durable schema change is `persistent_state=minor`. Down-migration is not an automatic rollback strategy; forward repair is required for any legacy Host adoption.

## Verification

Focused Host integration tests cover owner-only administration, explicit share use, project-membership isolation, default routing and revoked shares. Device-flow tests cover approving-user/requested-Host propagation and claim release after enrollment failure. Session access tests cover project membership without Host sharing, explicit sharing after project membership removal and revocation. Real PostgreSQL migration and process-boundary Connector recovery remain candidate validation gates.
