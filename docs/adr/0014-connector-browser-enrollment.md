# ADR 0014: Connector Browser Enrollment

## Status

Accepted for the phase-one Connector enrollment implementation.

## Context

The Connector runs on the execution computer and needs an independent deployment credential for the Host Gateway. The existing browser login is an HttpOnly session cookie, while user API credentials are account-level delegated credentials. Neither is an appropriate bearer credential for a long-running Connector process, and requiring operators to copy Host ID, Host Token, journal path or app-server command exposes internal deployment details.

The execution computer also owns the Codex app-server process. The supported capability is starting and controlling that local process; an already-open ChatGPT Desktop conversation remains a separate, unproven integration boundary.

## Decision

The Connector accepts `LOOMHELM_CONNECTOR_BASE_URL`, defaulting to `https://loomhelm.ivanli.cc`, and optional `LOOMHELM_CONNECTOR_API_KEY`. Local journal and credential-cache paths, plus the `codex` app-server command, have private safe defaults and are not required user-facing inputs. These are the complete public Connector configuration inputs; legacy Host ID, Host token, journal and app-server environment aliases are not compatibility inputs.

When no usable opaque deployment key or private local cache exists, the Connector binds an ephemeral IPv4 loopback listener, generates a state value, and asks the Server for a short-lived device authorization. The Server stores only hashes for the human verification code and one-time authorization code. The browser either uses its existing OIDC HttpOnly session or completes OIDC login, then explicitly approves the displayed Connector device. The Server redirects only the one-time code and the original state to the loopback callback. The Connector verifies the state and exchanges the code for one opaque API key containing the host identity and raw host credential internally.

The Server creates a new user-owned Host and issues a new revocable Host credential on every successful device exchange. A device request may name an existing Host only when the approving user owns that Host; a shared user cannot bind enrollment to another user's Host. Migration 00020 binds a device authorization to the resulting Host and credential so a retry after a claim lease expires is idempotent. The credential is cached on the execution computer in a mode-0600 file bound to the configured Server BaseURL. Raw Host credentials are excluded from logs, browser responses and Connector journal records. User API credentials remain scoped to users and projects and are not accepted by this flow.

The Connector starts the host-owned `codex` app-server command through its existing process gateway. This design does not attach to or control an already-open ChatGPT Desktop conversation and does not represent such attachment as supported.

## Alternatives Rejected

- Reuse the browser HttpOnly cookie as a Connector bearer: rejected because browser session state and process credentials have different lifetimes, transport boundaries and revocation semantics.
- Reuse a user API credential: rejected because the Connector represents deployment administration and host execution, not a user's project-scoped API authority.
- Require Host ID and Host Token configuration: rejected because it makes internal credential material and deployment paths part of the ordinary installation contract.
- Put a host token or reusable authorization secret in the browser redirect: rejected because the loopback redirect carries only a state-bound, one-time code.

## Compatibility

The new REST endpoints are additive within the current public API major. Migration 00018 adds the short-lived device authorization table and expiry index; migration 00019 adds nullable Host ownership, explicit share grants, per-user Host defaults and requested-Host binding; migration 00020 adds nullable authorization bindings for idempotent Connector enrollment without reassigning legacy singleton rows. Device start, verify and token routes are deployment HTTP endpoints, not entries in the canonical REST/MCP operation catalog, so generated REST/MCP clients do not expose them as ordinary application operations. Older candidates continue to read existing Host and user state. The local credential cache is a new private artifact and is ignored by older Connector binaries. The compatibility classification is `public_api=minor` and `persistent_state=minor`; down-migration is not an automatic rollback strategy.

## Verification

Focused in-process tests cover loopback redirect validation, state binding, one-time code replay rejection, cache mode/server binding and browser bootstrap. Real PostgreSQL migration, configured OIDC browser login, release publication and production deployment require candidate-bound evidence before promotion.
