# Loomhelm core implementation coverage

## Current Status

The repository contains the Go process-lifecycle skeleton, platform persistence adapters and the Bun/React frontend foundation. Server and Worker require a database URL, open PostgreSQL and apply application and River migrations before completing startup. Connector remains database-independent. Server startup also requires `LOOMHELM_DRAIN_TOKEN`; its readiness endpoint checks the database without changing process liveness. Worker exposes readiness only after its queue runner starts and revokes readiness before stopping it. The frontend provides neutral verification routes, shared providers, initial workspace packages, Storybook component states and PWA build/registration wiring. Business schemas/APIs, the deployed environment and approved product UI are not implemented.

## Implementation Coverage

| Requirements | Implementation | Verification |
| - | - | - |
| F01 slice of REQ-LH-007 | Server/Worker/Connector lifecycle skeleton, Server health/version/drain endpoints, loopback-plus-Bearer drain authorization, process-local Worker generation control and signal exits | Go unit, race and shuffled tests; `go vet`; native and `linux/amd64` cross-builds |
| F02 foundation supporting REQ-LH-006 | Bun workspaces, React/Vite/TypeScript, Router/Query providers, client/content/protocol package boundaries, neutral routes, Storybook and PWA build/registration wiring | Frozen dependency install, typecheck, Vite/PWA and Storybook builds in a session VM; observed route navigation, manifest/SW responses, narrow-screen overflow and component semantics |
| F03 infrastructure supporting REQ-LH-007 | pgx pool, embedded Goose schema, domain-local sqlc output, River short-job adapter and application composition; serialized migration window, bounded startup/drain and worktree bootstrap | Session VM Go test/vet, adapter race, sqlc/tidy drift and image build; real PostgreSQL/jobs, concurrent empty-database startup with a one-connection pool, outage/recovery, process drain and exact persisted rows across database restart; linked-worktree setup, failure aggregation, local-state preservation and Compose isolation |
| REQ-LH-001 through REQ-LH-006, REQ-LH-008 through REQ-LH-012 | Product implementation absent; business APIs, persistence, Connector connectivity/authentication and product UI are not established by these foundations | Product verification not run |

## Development and Validation

The baseline and F01 skeleton are checked with the topic Spec structural checker, Git whitespace checks, `go test`, `go test -race`, shuffled tests, `go vet`, native builds, `linux/amd64` cross-builds and inspection of Policy package/lock consistency. These checks do not establish product acceptance, durable cross-process fencing or deployment cutover evidence.

The persistence composition uses `sqlc.yaml` to generate the platform query package from `db/migrations` and `internal/platform/database/queries`. Goose owns application migration history and River owns queue migration history; startup holds one database session advisory lock across both. A dedicated lock connection avoids consuming the only pool connection when its maximum is one. Session-owned VM observations exercised concurrent Server/Worker startup against an empty database with that pool limit, actual short-job completion, byte-for-byte result snapshots across database restart, and Server/Worker signal drain. Database outage returned HTTP 503 from readiness while liveness remained HTTP 200; recovery restored readiness. Real process tests explicitly skip without `LOOMHELM_DATABASE_URL`, so a service-free suite pass remains separate from these observed process and database paths.

The canonical `scripts/setup` entrypoint checks pinned tool readiness, prepares Markdown and frontend dependencies, and aggregates failures before returning nonzero. Actual linked worktrees with an external Git common directory passed first and repeat runs while preserving existing environment and common-hook contents. Directory and dangling-symlink environment targets were rejected without touching an external target. A controlled Bun version mismatch and unreadable sqlc command produced two aggregated failures. `scripts/dev` derives separate Compose projects, networks and volumes from canonical worktree paths, validates explicit project overrides and leaves host-port assignment to each worktree. These observations establish development bootstrap behavior, not deployment cutover or production isolation.

Application tests inject resource factories for deterministic lifecycle and failure checks. Production constructors always select the actual database/queue factory. Worker startup has a separate budget from its queue lifetime: caller cancellation revokes readiness and requests a bounded graceful stop; a graceful-stop timeout cancels runner execution and requests a bounded forced stop. Generation cancellation and pool closure follow the runner's actual stopped signal. If forced stop also expires, Run returns an error with the lifecycle still draining and retains the runtime until that signal permits cleanup; ordinary shutdown does not invalidate the generation of an interrupted job. Focused tests cover this delayed ownership release. These are process-local controls and do not provide durable Worker fencing.

Worker configuration rejects generations outside the signed positive BIGINT range before startup. When the development Compose port is explicitly supplied, Server and Worker validate that the database URL resolves to the same port before opening a connection. These corrections preserve the existing durable result and worktree-isolation contracts; their complete-candidate VM observations and refreshed formal review remain required.

The frontend foundation is checked using pinned Bun 1.4.3 with `bun install --frozen-lockfile` and `bun run check`. VM production responses include the generated manifest, service worker and Workbox files; browser checks cover the home/Status routes, brand-link return navigation, route-current semantics, a 393x852 CSS viewport without horizontal overflow, and Default/Compact Storybook states without duplicate IDs. Runtime navigation matches the root route exactly: `/` has only Runtime marked current, and `/status` has only Status marked current. This route-only correction passed targeted TypeScript and browser checks, retaining the unaffected VM build, registration and component observations. The VM browser observations used an insecure HTTP IP origin: successful manifest and service-worker fetches do not establish browser service-worker registration. A separate secure localhost production-preview observation of the repaired source confirmed an activated root-scoped service worker, with no waiting or installing worker. A controlled preview returning HTTP 503 only for `/sw.js` produced the registration-error diagnostic and no registration. PWA installation, controlled updates, offline product behavior and real backend integration require their own product observations.

## Visual Evidence

These neutral engineering surfaces document the frontend foundation. The page images use source `724107721164d60b23e7a75f21991ec659a81806`; the unchanged isolated Storybook component retains its image from source `121100ef6c3ed35edaa90bb6e59d5dd9bd7619a2`. The owner authorized Agent checking and archival in place of manual screenshot confirmation for this foundation only. This exception does not approve product styling, the complete UI design or later product visual changes. The actual source captures were compared with their exact destination paths at parent baseline `079d3d85318c365056cd29a238aafdf732581421`; all three paths are absent there, so the results are current-only, without baseline images or heatmaps. The desktop page uses trim-only normalization, the mobile page retains its 393x852 CSS viewport, and the Storybook component retains source-managed margins with only DOM-geometry tightening. Source and validation references are recorded in [History](HISTORY.md#frontend-foundation-evidence).

### Desktop verification route

![Neutral frontend verification route on desktop](assets/f02-runtime-desktop.png)

### Mobile verification route

![Neutral frontend verification route at a mobile viewport](assets/f02-runtime-mobile.png)

### Storybook component

![VerificationPanel component evidence](assets/f02-verification-panel.png)

## Rollout and Compatibility

The initial application schema retains platform short-job results; River retains queue state separately. There is no previously deployed application schema or production compatibility claim. Re-entering startup may apply pending migrations but must not reverse them, and a migration failure prevents readiness. Empty-database migration, startup re-entry and persistence after restart have VM observations; a backend image was built and identified by its local content hash. Immutable publication/promotion, supported blue-green compatibility windows and cross-process Worker fencing still require their deployment implementation and observations. The planned release channel is an isolated parent-branch preview; production configuration is not established here.

## Remaining Gaps

All product requirements still require implementation and the observations described by their VER entries. In particular, durable cross-process Worker fencing, Connector enrollment/authentication/recovery, business-state persistence, authenticated business APIs and deployment cutover remain unimplemented; existing active desktop-session control has not been proven, and the complete product UI awaits owner participation and confirmation. Platform short-job infrastructure is not evidence of those business capabilities.

The approved product boundaries require a single configured execution environment, top-level Workbench/Tasks entries, a projectless Conversations group and project/conversation tree, conversation-context files, shared drafts and task relationships. All Conversations remains accessible from Workbench. Their presence in the specification is not evidence of backend support. Structural prototype checks do not establish real Codex, persistence, cross-client synchronization or PWA acceptance.

The complete [product requirements](../../PRD.md) await explicit owner confirmation. Its business suggestions are not approved defaults. Business implementation and public business contract finalization wait for that confirmation and resolution of the affected decisions; product UI additionally waits for complete design approval. Skeleton, infrastructure, capability research and the existing design discussion remain permitted.

Standalone creation with optional project selection and later task association is established product intent, including actual execution before a task exists. The task-mandatory Run definition has been corrected; existing adapter capability and authorization support are not thereby proven. The owner confirmed at most one Task per Session as well as one main Session per Task, fixed phase-one bindings, creator-private projectless conversations and explicit consent before project sharing of historical messages/execution/files, with private unsent drafts. Draft conflicts automatically use the last modification; sending preserves later input and restoration does not send. Task business states include Blocked as well as To do, In progress, Done and Cancelled.

Both task parent/child relationships and prerequisite dependencies may cross projects while retaining each task's project and Session ownership. Their implementation must enforce endpoint authorization and avoid disclosing protected task content through relationships. Cycle handling, editing and protected-deletion behavior, and the small-team permission matrix still require decisions before affected implementation. The shared-draft protocol must define consistent modification ordering, deduplication and recovery. Product decisions are collected in the PRD rather than inferred from prototypes or implementation defaults.

System-following theme with manual light/dark override and independently retained client preferences is established product intent. Neither implemented theme parity nor browser evidence is established by that decision, and it does not select a preference-storage technology.

Client-local, identity/workspace-scoped view preferences are the implementation default; they do not introduce a server preference service or move another client's active view.

## References

- [Requirements](SPEC.md)
- [History](HISTORY.md)
