# Development

Run `scripts/setup` from the repository root to verify the required Git, Go `1.27.2`, Bun `1.4.3`, Python 3.9+, and sqlc `1.31.1` toolchain, prepare the pinned Markdown tools, copy `.env.example` only when `.env.local` is missing, and install frontend dependencies. `SQLC_BIN=/path/to/sqlc scripts/setup` supports a repo-local or user-selected verified binary without changing global PATH; the official URL and SHA256 come from `tools/database-toolchain.json`. Docker and Compose are optional setup dependencies for the PostgreSQL workflow, while `scripts/dev` requires them when used; Goose and River are Go module dependencies rather than standalone setup binaries.

Setup aggregates missing tools, version mismatches, manifest errors, environment-file conflicts, Markdown setup failures, and Bun install failures before exiting nonzero with a recovery hint. A regular `.env.local` or a valid symlink to a regular file is preserved; directories and dangling symlinks are rejected without following or overwriting external targets. Setup never installs hooks or changes global PATH, proxy, or authentication settings; install Lefthook explicitly when the local workflow calls for it.

The local PostgreSQL service is defined in `deploy/dev/compose.yaml`. Run `scripts/dev up -d` to start it, `scripts/dev ps` to inspect health, `scripts/dev logs -f postgres` to follow logs, and `scripts/dev down` to stop the service while retaining its named volume. By default `scripts/dev` derives a stable Compose project name from the canonical Git worktree path, so linked worktrees receive separate networks and volumes; set `LOOMHELM_DEV_PROJECT_NAME` only when an explicit resource owner is intended.

The example database URL points at `127.0.0.1:55432` and is intended only for local development. `LOOMHELM_STARTUP_TIMEOUT` defaults to `30s`; `LOOMHELM_DATABASE_MIN_CONNS=0` delegates the minimum to pgx, and `LOOMHELM_DATABASE_MAX_CONNS=4` caps the pool by default. Set a distinct `LOOMHELM_POSTGRES_PORT` in each worktree's `.env.local` when the global port lease requires it; `scripts/dev` never kills or adopts an unrelated listener.

Run `LOOMHELM_DATABASE_URL=... scripts/db migrate` to apply the embedded Goose application migrations and the River queue migrations under one PostgreSQL session advisory lock. The application schema lives in `db/migrations`; River owns its queue tables separately and is migrated by the same command.

Run `LOOMHELM_DATABASE_URL=... scripts/db test` for the focused database and job tests. Tests that need PostgreSQL skip when `LOOMHELM_DATABASE_URL` is unset, while configuration and serialization tests remain runnable without services.

The checked-in sqlc configuration is `sqlc.yaml`. After the parent integration adds the aggregate entry, generate code with the pinned sqlc `1.31.1` binary from `tools/database-toolchain.json`; the F03 database entry reads schema from `db/migrations`, reads queries from `internal/platform/database/queries`, and writes Go code to `internal/platform/database/generated` with `sql_package: pgx/v5`.

The backend image is built with `docker build -f build/Dockerfile --build-arg LOOMHELM_COMPONENT=server .`. The image is a build surface for the separate Server, Worker and Connector processes; process composition remains in the application entrypoints.

Markdown checks use `python3 tools/markdown.py check`; the Lefthook configuration runs the staged Markdown formatter without auto-installing hooks or tools.

The canonical bootstrap entrypoint is `scripts/setup`; it does not depend on historical setup helpers, so a linked worktree from an older revision can recover by running the current repository entrypoint after the files are present. The bootstrap contract is copy-missing and repeatable: it preserves existing environment files and hooks, supports linked worktrees whose `.git` is a gitdir file, and never writes to the shared Git common directory unless an explicit hook installation command is run.
