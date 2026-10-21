# Branch preview deployment

The preview bundle implements the phase-one blue-green contract with two immutable Server/Worker slots, a Caddy traffic switch, durable Worker generation fencing and retained Web assets.

The candidate manifest is the deployment identity. It must contain the exact source SHA, the server and Worker image digests, the built Web directory and its deterministic tree digest, and a two-way state compatibility range. The deployment controller records those values in a local state file and never rebuilds an image during promotion.

The state directory is intentionally outside Git by default at `.loomhelm-preview/`; set `LOOMHELM_PREVIEW_STATE_DIR` when the deployment state belongs elsewhere. It contains the slot metadata, Caddy files, compose environment and copied Web trees. Do not commit it or place credentials in the manifest.

To enable browser login, export `LOOMHELM_OIDC_ISSUER_URL`, `LOOMHELM_OIDC_CLIENT_ID`, `LOOMHELM_OIDC_REDIRECT_URL` and, when required by the issuer, `LOOMHELM_OIDC_CLIENT_SECRET` before staging. The controller writes them into its mode-0600 Compose environment file and passes them only to both Server slots; Workers receive no browser identity-provider credentials. The redirect must use the public Web origin and `/api/v1/auth/oidc/callback`. `LOOMHELM_SESSION_COOKIE_SECURE` defaults to `true`; explicitly set `false` only for an isolated plain-HTTP test endpoint. Empty OIDC settings keep login unavailable and do not grant anonymous access. Protect the runtime state directory and do not publish the rendered environment or Compose configuration, which may contain secrets.

## Workflow

```sh
# Use a unique project name and four ports allocated for this worktree.
export LOOMHELM_PREVIEW_PROJECT_NAME=loomhelm-preview-<worktree-scope>
export LOOMHELM_PREVIEW_HTTP_PORT=<registered-port>
export LOOMHELM_PREVIEW_ADMIN_PORT=<registered-port>
export LOOMHELM_BLUE_SERVER_PORT=<registered-port>
export LOOMHELM_GREEN_SERVER_PORT=<registered-port>

scripts/preview init
scripts/preview stage path/to/candidate-manifest.json
scripts/preview check
scripts/preview promote
scripts/preview status
```

`stage` selects the inactive slot, checks the candidate against the active state's read range and Web tree digest, copies the Web assets into that slot, validates the Server image and `/version` identity, then starts the Worker only after the Server is ready. A failed candidate is stopped, removed from pending state and followed by an active Worker restart so the old generation remains admitted.

`promote` requires both slot readiness endpoints, validates the declared image references against the running containers and both `/version` identity responses, validates and reloads the candidate Caddy configuration, atomically updates the traceable state and Web symlinks, then drains and stops the old Server and Worker. An unhealthy or identity-mismatched candidate therefore cannot receive traffic.

`rollback` restages the retained slot with a new Worker generation before switching traffic. It is allowed only when the retained candidate can read the current state and the current candidate can read the retained candidate's declared state version; deployed migrations are never reversed.

`web/current` points at the active Web tree and `web/retained/<source-sha>-<generation>` stores each retained candidate within the compatibility window. Caddy tries the current tree first and retained candidates from newest to oldest, so old hashed assets remain available across more than one promotion while installed clients update. `rollback [retained-key]` can restage a specific retained candidate after compatibility validation.

The Worker lease row is monotonic per `LOOMHELM_WORKER_LEASE_KEY`. River client creation and startup happen before lease admission; a startup failure therefore cannot fence the active Worker. Once admitted, a newer generation replaces the durable lease; an older generation loses readiness, stops River scheduling and cannot enqueue or complete a short job after the lease check observes the fence. A database outage pauses scheduling and heartbeat renewal; successful reconnection rebuilds the River client without reusing a lower generation. Any post-admission startup failure releases the exact matching lease.

This is an isolated branch-preview mechanism. It does not deploy production, publish versions, modify the candidate build pipeline or silently down-migrate durable state. Compose has no shared project or fixed port defaults: the real rehearsal requires the session-owned Agent VM, a unique project name and registered per-worktree ports for preview HTTP, Caddy admin and both slot listeners.
