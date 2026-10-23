# Blue-Green Baseline Rehearsal

`RD03` is the G0 admission rehearsal for the branch-preview runtime. It proves the deployment controller's failure and recovery contract before project and Codex business work is dispatched. The rehearsal is bound to one parent source SHA and never rebuilds or promotes a different candidate during a retry.

## Deterministic checks

Run the control-only path from a clean checkout:

```sh
scripts/rehearse-blue-green --control-only --evidence-dir /tmp/loomhelm-blue-green
```

This runs the preview state-machine tests, Python compilation and shell syntax checks. It deliberately reports runtime as skipped; a passing control-only run is not G0 approval.

## Agent VM rehearsal

Run the runtime path in the session-owned Agent VM. The VM must have Docker/Compose and a unique project name. Register four ports with `$global-port-manager` for the Caddy HTTP/admin endpoints and the blue/green Server listeners, then export the values consumed by `scripts/preview`:

```sh
export LOOMHELM_PREVIEW_PROJECT_NAME=loomhelm-rd03
export LOOMHELM_PREVIEW_HTTP_PORT=<lease>
export LOOMHELM_PREVIEW_ADMIN_PORT=<lease>
export LOOMHELM_BLUE_SERVER_PORT=<lease>
export LOOMHELM_GREEN_SERVER_PORT=<lease>
export LOOMHELM_DATABASE_URL=postgres://loomhelm:loomhelm_dev_only@postgres:5432/loomhelm?sslmode=disable
export LOOMHELM_DRAIN_TOKEN=rd03-rehearsal-token
```

Prepare three manifests from the same parent build contract: a healthy baseline, a healthy candidate with a different digest, and a deliberately unhealthy candidate whose Server cannot pass `/readyz`. The healthy manifests must have compatible state ranges. Run:

```sh
scripts/rehearse-blue-green \
  --evidence-dir /workspace/evidence/loomhelm-rd03 \
  --baseline-manifest /workspace/manifests/baseline.json \
  --candidate-manifest /workspace/manifests/candidate.json \
  --bad-manifest /workspace/manifests/unhealthy.json
```

The command records the source SHA, command log, final deployment state and retained Web keys. It verifies that an unhealthy candidate is rejected while the active generation remains ready, a healthy candidate is promoted and the old slot is drained/stopped, the retained Web tree remains available, readiness recovers through the Caddy path, and a compatible rollback creates a new Worker generation. The final state must include `stage_failed`, `promote`, and `stage_retained` events and a monotonic generation of at least three.

## G0 evidence

Attach the evidence directory to the parent task with the exact parent SHA, candidate source SHAs, image repository digests, port lease IDs, VM session ID, and the runtime attempt. A failed candidate or failed readiness check must remain visible in the log. Do not convert a control-only pass into runtime evidence, and do not run this against production.

The GitHub [Blue-Green Baseline workflow](../.github/workflows/blue-green-baseline.yml) runs the deterministic path on pull requests. The runtime path stays in Agent VM because this repository does not permit Docker on the developer host and the workflow runner cannot provide the required persistent preview state and port lease evidence.
