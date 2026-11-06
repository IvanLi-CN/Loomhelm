# ADR 0014: Connector Browser Enrollment

## Status

Accepted for the phase-one Connector enrollment implementation.

## Context

The Connector runs on the execution computer and needs an independent Host credential for the Host Gateway. The existing browser login is an HttpOnly session cookie, while user API credentials are account-level delegated credentials. Neither is an appropriate bearer credential for a long-running Connector process, and requiring users to copy Host ID, Host Token, journal path or app-server command exposes internal Host details.

The execution computer also owns the Codex app-server process. The supported capability is starting and controlling that local process; an already-open ChatGPT Desktop conversation remains a separate, unproven integration boundary.

## Decision

The Connector accepts `LOOMHELM_CONNECTOR_BASE_URL`, defaulting to `https://loomhelm.ivanli.cc`, and optional `LOOMHELM_CONNECTOR_API_KEY`. Local journal and credential-cache paths, plus the `codex` app-server command, have private safe defaults and are not required user-facing inputs. These are the complete public Connector configuration inputs; legacy Host ID, Host token, journal and app-server environment aliases are not compatibility inputs.

When no usable opaque Host credential or private local cache exists, the Connector binds an ephemeral IPv4 loopback listener, generates a state value, and asks the Server for a short-lived device authorization. The Server stores only hashes for the human verification code and authorization code. The browser either uses its existing OIDC HttpOnly session or completes OIDC login, then explicitly approves the displayed Connector device. The Server redirects only the authorization code and the original state to the loopback callback. The Connector verifies the state and exchanges the code for one opaque API key containing the host identity and raw host credential internally. A completed authorization is a one-time enrollment side effect, but the same code may replay that idempotent enrollment during the bounded cleanup grace period after the nominal device lifetime so a lost response can be recovered; uncompleted authorization codes still expire at the nominal lifetime.

The Server creates a new user-owned Host and issues a new revocable Host credential on every first successful device exchange. A device request may name an existing Host only when the approving user owns that Host; a shared user cannot bind enrollment to another user's Host. Migration 00020 binds a device authorization to the resulting Host and credential so claim expiry, a committed completion with a lost response and process restart are idempotent. Before token exchange, the Connector stores a short-lived pending authorization record containing the raw code in a private state file bound to the configured Server BaseURL; Unix state files use mode-0600 and Windows state files use a protected owner-only ACL. It removes that file after credential-cache publication. Connector bootstrap and recovery are serialized across processes by an adjacent private lock file with the same platform-specific protection. An active exchange or ambiguous completion is retryable: the bootstrap call retries transient exchange conflicts with context-bounded backoff and leaves the pending record intact. A revoked enrollment credential is a definitive rejection and starts fresh browser recovery by clearing that pending record; only definitive rejection may clear it. State-file rename and pending removal sync the parent directory after the file contents are durable. Raw Host credentials remain excluded from logs, browser responses and Connector journal records, and the raw authorization code is never stored in PostgreSQL. User API credentials remain scoped to users and projects and are not accepted by this flow.

The Connector starts the host-owned `codex` app-server command through its existing process gateway. This design does not attach to or control an already-open ChatGPT Desktop conversation and does not represent such attachment as supported.

## Alternatives Rejected

- Reuse the browser HttpOnly cookie as a Connector bearer: rejected because browser session state and process credentials have different lifetimes, transport boundaries and revocation semantics.
- Reuse a user API credential: rejected because the Connector represents user-authorized execution on a Host, not a user's project-scoped API authority.
- Require Host ID and Host Token configuration: rejected because it makes internal credential material and Host details part of the ordinary Connector configuration.
- Put a host token or reusable authorization secret in the browser redirect: rejected because the loopback redirect carries only a state-bound authorization code and the Connector stores any crash-recovery copy only in a private, short-lived local file.

## Compatibility

The new REST endpoints are additive within the current public API major. Migration 00018 adds the short-lived device authorization table and expiry index; migration 00019 adds nullable Host ownership, explicit share grants, per-user Host defaults and requested-Host binding; migration 00020 adds nullable authorization bindings for idempotent Connector enrollment without reassigning legacy singleton rows. Device start, verify and token routes are deployment HTTP endpoints, not entries in the canonical REST/MCP operation catalog, so generated REST/MCP clients do not expose them as ordinary application operations. Older candidates are not a safe rollback target after the ownership or enrollment state is written; recovery is forward-only. The local credential and pending-authorization files are private artifacts and are ignored by older Connector binaries. The compatibility classification is `public_api=minor` and `persistent_state=minor`; down-migration is not an automatic rollback strategy.

## Verification

Focused in-process tests cover loopback redirect validation, state binding, bounded idempotent code replay, cache mode/server binding, pending-authorization recovery, active-exchange retry and retention, revoked-enrollment recovery, cross-process bootstrap locking and browser bootstrap. Real PostgreSQL migration, configured OIDC browser login, release publication and production deployment require candidate-bound evidence before promotion.
