# Loomhelm core implementation coverage

## Current Status

The repository contains the Go process-lifecycle skeleton and the Bun/React frontend foundation. Server, Worker and Connector entrypoints provide configuration validation, local lifecycle state, Server health/version/drain control and process signal handling. Server startup requires `LOOMHELM_DRAIN_TOKEN`. The frontend provides neutral verification routes, shared providers, initial workspace packages, Storybook component states and PWA build/registration wiring. Product APIs, persistence, the deployed environment and approved product UI are not implemented.

## Implementation Coverage

| Requirements | Implementation | Verification |
| - | - | - |
| F01 slice of REQ-LH-007 | Server/Worker/Connector lifecycle skeleton, Server health/version/drain endpoints, loopback-plus-Bearer drain authorization, process-local Worker generation control and signal exits | Go unit, race and shuffled tests; `go vet`; native and `linux/amd64` cross-builds |
| F02 foundation supporting REQ-LH-006 | Bun workspaces, React/Vite/TypeScript, Router/Query providers, client/content/protocol package boundaries, neutral routes, Storybook and PWA build/registration wiring | Frozen dependency install, typecheck, Vite/PWA and Storybook builds in a session VM; observed route navigation, manifest/SW responses, narrow-screen overflow and component semantics |
| REQ-LH-001 through REQ-LH-006, REQ-LH-008 through REQ-LH-012 | Product implementation absent; business APIs, persistence, Connector connectivity/authentication and product UI are not established by these foundations | Product verification not run |

## Development and Validation

The baseline and F01 skeleton are checked with the topic Spec structural checker, Git whitespace checks, `go test`, `go test -race`, shuffled tests, `go vet`, native builds, `linux/amd64` cross-builds and inspection of Policy package/lock consistency. These checks do not establish product acceptance, durable cross-process fencing or deployment cutover evidence.

The frontend foundation is checked using pinned Bun 1.4.3 with `bun install --frozen-lockfile` and `bun run check`. VM production responses include the generated manifest, service worker and Workbox files; browser checks cover the home/Status routes, a 393x852 CSS viewport without horizontal overflow, and Default/Compact Storybook states without duplicate IDs. The VM browser observations used an insecure HTTP IP origin: successful manifest and service-worker fetches do not establish browser service-worker registration. A separate localhost production-preview observation with equivalent frontend inputs reported an active service worker at the application's root scope. PWA installation, controlled updates, offline product behavior and real backend integration require their own product observations.

## Visual Evidence

These initial neutral engineering surfaces document the frontend foundation. The owner authorized Agent checking and archival in place of manual screenshot confirmation for this foundation only. This exception does not approve product styling, the complete UI design or later product visual changes. The images were captured from frontend inputs identical to the VM-validated candidate; exact source references are recorded in [History](HISTORY.md#frontend-foundation-evidence).

### Desktop verification route

![Neutral frontend verification route on desktop](assets/f02-runtime-desktop.png)

### Mobile verification route

![Neutral frontend verification route at a mobile viewport](assets/f02-runtime-mobile.png)

### Storybook component

![VerificationPanel component evidence](assets/f02-verification-panel.png)

## Rollout and Compatibility

No database schema or runtime state format is deployed. Candidate identity, migration evidence and supported compatibility windows must be recorded with their actual implementations. The release channel used for initial acceptance is an isolated parent-branch preview; production configuration is not established here.

## Remaining Gaps

All product requirements still require implementation and the observations described by their VER entries. In particular, durable cross-process Worker fencing, Connector enrollment/authentication/recovery, persistence, authenticated business APIs and deployment cutover remain unimplemented; existing active desktop-session control has not been proven, and the complete product UI awaits owner participation and confirmation.

The approved product boundaries require a single configured execution environment, top-level Workbench/Tasks entries, a projectless Conversations group and project/conversation tree, conversation-context files, shared drafts and task relationships. All Conversations remains accessible from Workbench. Their presence in the specification is not evidence of backend support. Structural prototype checks do not establish real Codex, persistence, cross-client synchronization or PWA acceptance.

The complete [product requirements](../../PRD.md) await explicit owner confirmation. Its business suggestions are not approved defaults. Business implementation and public business contract finalization wait for that confirmation and resolution of the affected decisions; product UI additionally waits for complete design approval. Skeleton, infrastructure, capability research and the existing design discussion remain permitted.

Standalone creation with optional project selection and later task association is established product intent, including actual execution before a task exists. The task-mandatory Run definition has been corrected; existing adapter capability and authorization support are not thereby proven. The owner confirmed at most one Task per Session as well as one main Session per Task, fixed phase-one bindings, creator-private projectless conversations and explicit consent before project sharing of historical messages/execution/files, with private unsent drafts. Draft conflicts automatically use the last modification; sending preserves later input and restoration does not send. Task business states include Blocked as well as To do, In progress, Done and Cancelled.

Both task parent/child relationships and prerequisite dependencies may cross projects while retaining each task's project and Session ownership. Their implementation must enforce endpoint authorization and avoid disclosing protected task content through relationships. Cycle handling, editing and protected-deletion behavior, and the small-team permission matrix still require decisions before affected implementation. The shared-draft protocol must define consistent modification ordering, deduplication and recovery. Product decisions are collected in the PRD rather than inferred from prototypes or implementation defaults.

System-following theme with manual light/dark override and independently retained client preferences is established product intent. Neither implemented theme parity nor browser evidence is established by that decision, and it does not select a preference-storage technology.

Client-local, identity/workspace-scoped view preferences are the implementation default; they do not introduce a server preference service or move another client's active view.

## References

- [Requirements](SPEC.md)
- [History](HISTORY.md)
