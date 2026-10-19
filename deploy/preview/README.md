# Branch preview deployment

The preview bundle implements the phase-one blue-green contract with two immutable Server/Worker slots, a Caddy traffic switch, durable Worker generation fencing and retained Web assets.

The candidate manifest is the deployment identity. It must contain the exact source SHA, the server and Worker image digests, the built Web directory and a two-way state compatibility range. The deployment controller records those values in a local state file and never rebuilds an image during promotion.

The state directory is intentionally outside Git by default at `.loomhelm-preview/`; set `LOOMHELM_PREVIEW_STATE_DIR` when the deployment state belongs elsewhere. It contains the slot metadata, Caddy files, compose environment and copied Web trees. Do not commit it or place credentials in the manifest.

## Workflow

```sh
scripts/preview init
scripts/preview stage path/to/candidate-manifest.json
scripts/preview check
scripts/preview promote
scripts/preview status
```

`stage` selects the inactive slot, checks the candidate against the active state's read range, copies the Web assets into that slot and starts both the Server and Worker. It does not change Caddy traffic.

`promote` requires both slot readiness endpoints, validates and reloads the candidate Caddy configuration, atomically updates the traceable state and Web symlinks, then drains and stops the old Server and Worker. An unhealthy candidate therefore cannot receive traffic.

`rollback` restages the retained slot with a new Worker generation before switching traffic. It is allowed only when the retained candidate can read the current state and the current candidate can read the retained candidate's declared state version; deployed migrations are never reversed.

`web/current` points at the active Web tree and `web/retained` points at the previous tree. Caddy tries the current tree first and the retained tree second, so old hashed assets remain available while installed clients update.

The Worker lease row is monotonic per `LOOMHELM_WORKER_LEASE_KEY`. A newer generation replaces the durable lease; an older generation loses readiness, stops River scheduling and cannot enqueue or complete a short job after the lease check observes the fence. A database outage pauses scheduling and heartbeat renewal; successful reconnection rebuilds the River client without reusing a lower generation.

This is an isolated branch-preview mechanism. It does not deploy production, publish versions, modify the candidate build pipeline or silently down-migrate durable state. The real rehearsal requires the session-owned Agent VM and a port lease for the preview HTTP, Caddy admin and PostgreSQL endpoints.
