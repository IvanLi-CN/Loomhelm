# Example Compose deployment

This directory provides a generic single-slot bootstrap Compose reference plus an env template for the existing candidate-bound blue-green controller. It contains no 101 hostnames, credentials, Traefik object names or identity-provider secrets; copy the relevant example env file to a private deployment-host file and supply those values there.

The single-slot example builds a Web image containing Caddy and the production Web bundle, plus separate Server and Worker images from `build/Dockerfile`. PostgreSQL is the only stateful service in that Compose file. Connector is intentionally outside this platform stack because it owns Codex credentials and the local app-server process on the configured execution machine. The single-slot file is a bootstrap and smoke-test surface, not the 101 final deployment path; final service promotion uses `deploy/preview/compose.yaml` and `scripts/preview`.

## Components

| Service | Default image or build | Container endpoint | Persistent data |
| - | - | - | - |
| `web` | `loomhelm-web:example`, built from `deploy/example/Dockerfile.web` | Caddy `:80` | none; the Web bundle is immutable in the image |
| `server` | `loomhelm-server:example`, built with `LOOMHELM_COMPONENT=server` | HTTP `:8080` on `app` | `loomhelm-artifacts` at `/var/lib/loomhelm/artifacts` |
| `worker` | `loomhelm-worker:example`, built with `LOOMHELM_COMPONENT=worker` | health/drain HTTP `:8081` on `app` | none; leases and jobs are in PostgreSQL |
| `postgres` | `postgres:17-alpine` | PostgreSQL `:5432` on `app` and `database` | `loomhelm-postgres` at `/var/lib/postgresql/data` |

The Compose build files are a source-build example, not a registry publication contract. A deployment can replace `LOOMHELM_SERVER_IMAGE`, `LOOMHELM_WORKER_IMAGE` and `LOOMHELM_WEB_IMAGE` with immutable registry references and use `--no-build`; the source SHA and artifact digest should then be recorded in the deployment card.

## Networks and ports

The `app` network is an explicit private network for Server, Worker, Web and PostgreSQL. The `database` network is the stable cross-Compose PostgreSQL DNS boundary; `postgres` is published there as `postgres:5432`, and the blue-green Server/Worker slots join it without exposing database ports publicly. The `proxy` network is parameterized and is external only when `LOOMHELM_PROXY_NETWORK_EXTERNAL=true`; that is the hook for an existing Traefik network. Web publishes `127.0.0.1:${LOOMHELM_HTTP_PORT}` to container port 80 by default for direct health checks, while Traefik reaches the same port over `proxy` when enabled. Server, Worker and PostgreSQL do not publish host ports.

The Web container carries parameterized Traefik labels for the host rule, entrypoint, TLS and an optional existing middleware. The example does not create or modify Traefik or Authelia objects; any middleware name belongs in the private deployment `.env` and must be validated by the deployment owner.

## Configuration and OIDC

Copy the example environment and validate the rendered Compose model before starting services:

```sh
cp deploy/example/.env.example deploy/example/.env
docker compose --env-file deploy/example/.env -f deploy/example/compose.yaml config >/dev/null
docker compose --env-file deploy/example/.env -f deploy/example/compose.yaml up -d --build
curl --fail http://127.0.0.1:18080/livez
curl --fail http://127.0.0.1:18080/readyz
```

For the final blue-green deployment, use this file only for the persistent PostgreSQL service and do not start its single-slot Server, Worker or Web services. Keep this bootstrap env separate from the preview env: it creates the shared database network, while the preview env joins that network as external:

```sh
cp deploy/example/.env.example /secure/path/loomhelm-database.env
# Set the real database password and stable database volume/network names in the private file.
docker compose --env-file /secure/path/loomhelm-database.env -f deploy/example/compose.yaml config >/dev/null
docker compose --env-file /secure/path/loomhelm-database.env -f deploy/example/compose.yaml up -d postgres
docker compose --env-file /secure/path/loomhelm-database.env -f deploy/example/compose.yaml ps postgres
```

The bootstrap file keeps `LOOMHELM_DATABASE_NETWORK_EXTERNAL=false`, so this Compose command creates the exact network named by `LOOMHELM_DATABASE_NETWORK` (default `loomhelm-example-database`) and registers the DNS name `postgres`. Prepare `.env.blue-green.example` as a separate private preview file with the same network name, `LOOMHELM_DATABASE_NETWORK_EXTERNAL=true` and `LOOMHELM_DATABASE_URL=postgres://<user>:<password>@postgres:5432/<database>?sslmode=disable`; preview Compose then connects every Server/Worker slot to that network while Caddy remains outside it.

Set `LOOMHELM_OIDC_ISSUER_URL`, `LOOMHELM_OIDC_CLIENT_ID` and `LOOMHELM_OIDC_REDIRECT_URL` together to enable browser login. If the issuer requires a confidential client, also set `LOOMHELM_OIDC_CLIENT_SECRET`; the application only passes these identity-provider values to Server. The redirect must be the public HTTPS origin followed by `/api/v1/auth/oidc/callback`, and `LOOMHELM_SESSION_COOKIE_SECURE` must remain `true` behind Traefik TLS. Leaving the OIDC values empty deliberately keeps login unavailable and does not enable anonymous access.

For the 101 deployment card, the private values are the public host, the existing Traefik network name and middleware name, the OIDC client registration at the configured issuer, a database/drain secret set, the stable state volume names, the four preview port leases and the immutable Server/Worker/Web image references. The repository examples must remain parameterized; do not copy those private values back into Git.

## Persistence and backup

The database volume stores all PostgreSQL business, execution, River and migration state. The artifact volume stores original conversation file bytes and must be backed up together with the database at a consistent point. The Web image is immutable and does not need a data volume; Connector journal persistence belongs to the execution-machine deployment, not this stack.

Keep the named volume values from `.env` stable across restarts and upgrades. `docker compose down` keeps them; `docker compose down -v` removes them and is destructive. Do not delete or recreate either volume as part of an application upgrade.

Stop writes before taking a coordinated backup, then use the volume names from the private `.env`:

```sh
set -a
. deploy/example/.env
set +a
mkdir -p backups
docker compose --env-file deploy/example/.env -f deploy/example/compose.yaml stop server worker web
docker compose --env-file deploy/example/.env -f deploy/example/compose.yaml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "backups/loomhelm.sql"
docker run --rm -v "${LOOMHELM_ARTIFACT_VOLUME_NAME}:/source:ro" -v "$PWD/backups:/backup" alpine:3.21 sh -c 'tar -C /source -czf /backup/loomhelm-artifacts.tar.gz .'
docker compose --env-file deploy/example/.env -f deploy/example/compose.yaml start server worker web
```

Restore is a separate recovery operation: stop Server, Worker and Web, restore the PostgreSQL dump into the intended database, restore the artifact archive into the matching artifact volume, and only then start the application. Database and artifact backups must come from the same recovery point; restoring one without the other can leave metadata and bytes inconsistent.

## Upgrade

Before an upgrade, take the coordinated backup, record the current image references and candidate identity, and check the new images with `docker compose ... config`. For source-built images run `docker compose ... build --pull server worker web`; for already-published images run `docker compose ... pull server worker web` and set the immutable image references in `.env`. Apply the change with `docker compose ... up -d server worker web` and wait for both Server and Worker readiness before treating the upgrade as complete.

Startup applies pending Goose and River migrations under the application's cross-process migration lock. Migrations are forward-only: an application rollback must not reverse deployed database state. If the candidate cannot read the current state, stop at readiness failure and use the blue-green compatibility path or restore from a coordinated backup rather than forcing a downgrade. The final path does not require a single-slot application rollout: start only this Compose file's `postgres` service, retain the PostgreSQL and artifact volume names, and point the preview env at the same database network, `postgres:5432` DNS target and artifact volume before staging the first candidate; do not run application stacks against different durable state or expose both traffic routes at once.

## Blue-green releases

The 101 final path is `Traefik -> Caddy stable entry -> active Server/Worker slot`. The Caddy service is the only Compose service attached to the parameterized proxy network; its generated config points at `server-blue` or `server-green`, serves the active Web tree and retains compatible old Web trees. Server and Worker slots remain private on the Compose `preview` network and join the stable `database` network at `postgres:5432`; PostgreSQL and the artifact volume remain outside the retiring application slots.

The existing `deploy/preview` Compose and `scripts/preview` controller are the executable blue-green path: they keep two immutable Server/Worker slots, retain compatible Web trees, gate promotion on candidate identity and readiness, drain the retiring slot and fence old Worker generations. `deploy/preview/compose.yaml` accepts the parameterized database network and Traefik network without creating or modifying Traefik; only Server/Worker slots join the database network, while only Caddy joins the proxy network. Use the exact candidate manifest and durable PostgreSQL/artifact state for that path; do not turn the single-slot file into a second blue-green implementation.

Prepare a private blue-green env file from `.env.blue-green.example`, extract an already-promoted candidate handoff so the manifest's relative Web root remains beside it, and run the controller from the exact source checkout:

```sh
cp deploy/example/.env.blue-green.example /secure/path/loomhelm-preview.env
export LOOMHELM_PREVIEW_ENV_FILE=/secure/path/loomhelm-preview.env
# The database bootstrap above must already be healthy on the same named network.
mkdir -p /secure/path/candidate
tar -xzf /secure/path/loomhelm-release-handoff.tar.gz -C /secure/path/candidate
scripts/preview init
scripts/preview check /secure/path/candidate/candidate-manifest.json
scripts/preview stage /secure/path/candidate/candidate-manifest.json
scripts/preview promote
scripts/preview status
```

Before `promote`, the candidate Server and Worker image digests in the manifest must be available to the same Docker engine and the Caddy/Web handoff must be complete. Traefik continues to target only Caddy throughout the operation, so the external route stays stable while `scripts/preview` stages the inactive slot, verifies `/readyz`, `/version`, image digests and Web tree identity, then reloads Caddy and drains the old slot.

Worker fencing is database-backed: each promotion admits a higher Worker generation for the shared lease key, and the old generation loses readiness and scheduling authority after the fence. A failed stage leaves the active slot serving and restores its Worker. `scripts/preview rollback <retained-key>` restages a retained compatible candidate and performs the same readiness, fencing and Caddy switch sequence; it never reverses a deployed migration.

## Deployment card

Fill this card from the private deployment environment and the immutable candidate manifest before starting or promoting the 101 stack:

- [ ] Candidate source SHA, artifact digest, state compatibility range and release handoff digest recorded.
- [ ] Caddy image reference and digest recorded for the stable entry.
- [ ] Server-blue and Server-green image references and repository digests recorded.
- [ ] Worker-blue and Worker-green image references and repository digests recorded.
- [ ] Active Web tree digest and retained Web tree policy recorded.
- [ ] PostgreSQL image reference, database volume name and artifact volume name recorded; both volumes are retained across upgrades.
- [ ] Preview state directory and Compose project name recorded.
- [ ] Private `preview` network, shared PostgreSQL `database` network and existing Traefik proxy network names recorded; only Caddy joins the proxy network and only Server/Worker slots join the database network.
- [ ] Registered loopback ports recorded for preview HTTP, Caddy admin, Server-blue and Server-green.
- [ ] Traefik host rule, entrypoint, TLS mode and existing Authelia middleware name recorded.
- [ ] OIDC issuer URL, client ID, client secret handling, HTTPS redirect URL and secure-cookie setting recorded; these values are passed to Server only.
- [ ] Database URL, drain token, Worker lease key and backup/restore point recorded without placing secrets in Git.
- [ ] Current active slot, previous retained key, rollback compatibility and failed-candidate recovery owner recorded.

Application switchback is allowed only inside the declared compatibility window and never reverses a database migration; backup restore remains a separate recovery procedure.

Connector reconnect and reconciliation are independent of HTTP traffic switching. After a blue-green promotion, verify the Connector's host-local journal, credential scope and gateway reconnect separately on the configured execution machine.
