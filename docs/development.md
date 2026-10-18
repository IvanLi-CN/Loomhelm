# Development

Run `scripts/setup` from the repository root to create `.env.local` only when it is missing and install the pinned frontend dependencies when Bun is available. The command is repeatable and preserves existing local configuration.

The local PostgreSQL service is defined in `deploy/dev/compose.yaml`. Run `scripts/dev up -d` to start it, `scripts/dev ps` to inspect health, `scripts/dev logs -f postgres` to follow logs, and `scripts/dev down` to stop the service while retaining its named volume.

The example database URL points at `127.0.0.1:55432` and is intended only for local development. `LOOMHELM_STARTUP_TIMEOUT` defaults to `30s`; `LOOMHELM_DATABASE_MIN_CONNS=0` delegates the minimum to pgx, and `LOOMHELM_DATABASE_MAX_CONNS=4` caps the pool by default. Keep real credentials in `.env.local` or an external secret store; do not commit them.

Run `LOOMHELM_DATABASE_URL=... scripts/db migrate` to apply the embedded Goose application migrations and the River queue migrations under one PostgreSQL session advisory lock. The application schema lives in `db/migrations`; River owns its queue tables separately and is migrated by the same command.

Run `LOOMHELM_DATABASE_URL=... scripts/db test` for the focused database and job tests. Tests that need PostgreSQL skip when `LOOMHELM_DATABASE_URL` is unset, while configuration and serialization tests remain runnable without services.

The checked-in sqlc configuration is `sqlc.yaml`. After the parent integration adds the aggregate entry, generate code with the pinned sqlc `1.31.1` binary from `tools/database-toolchain.json`; the F03 database entry reads schema from `db/migrations`, reads queries from `internal/platform/database/queries`, and writes Go code to `internal/platform/database/generated` with `sql_package: pgx/v5`.

The backend image is built with `docker build -f build/Dockerfile --build-arg LOOMHELM_COMPONENT=server .`. The image is a build surface for the separate Server, Worker and Connector processes; process composition remains in the application entrypoints.

Markdown checks use `python3 tools/markdown.py check`; the Lefthook configuration runs the staged Markdown formatter without auto-installing hooks or tools.
