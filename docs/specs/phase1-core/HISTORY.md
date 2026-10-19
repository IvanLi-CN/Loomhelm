# Loomhelm core topic history

## Lifecycle / Compatibility

The active topic was established on 2026-10-18 from the approved initial product scope. It does not replace an earlier repository topic. There is no previously deployed state or public interface compatibility promise.

## Background

The product combines self-hosted project management with supervised remote Codex execution. Initial scope includes both new sessions and live desktop-session control; unproven control capability remains an acceptance blocker. Autonomous three-level Agent orchestration and interactive plugin view hosting are separate future capabilities.

The owner participates in one complete UI design task, and approved product UI implementation follows that confirmation. Blue-green infrastructure is established and exercised before business iteration, then verified again with the complete business paths.

## Product Boundaries

The owner clarified that the product uses one configured execution environment and has no host-management concept. The existing control-plane ADR continues to describe Server, Worker and Connector separation, execution-machine locality and credential retention; it does not require a fleet-management product. Connector authentication and revocation remain deployment responsibilities.

The owner's initial design direction established cross-project Workbench, Tasks and Conversations entries with separate project-context navigation, list/board/graph views, distinct task hierarchy and dependency relations, shared unsent conversation drafts and independent client navigation. Each task has at most one directly associated conversation; supporting sub-agent activity is presented within that conversation when actual events support it. Files remain in conversation context, without an independent artifacts module or remote file browser.

These product constraints do not constitute approval of the complete UI design. No existing desktop-session control acceptance, deployed schema or public API compatibility evidence is established by the structural prototype.

The owner's design answers permit standalone conversations, optional project selection and later task association without losing conversation identity. Projectless conversations join the target task's project. This corrected the earlier engineering definition that required every Run to have a Task; that checkpoint did not settle reverse association, reassignment or historical visibility. The verified design checkpoint is `1bdbc53f027c7a5575bc267c14ed2d18a38c4bad`.

The complete product requirements were consolidated into `docs/PRD.md` after the owner identified the missing product-definition responsibility. The coordinator owns that document. PRD confirmation and resolution of affected business decisions precede feature implementation and public business contract finalization; complete UI design confirmation remains an additional UI gate. Suggested business rules are collected for owner decision and do not constitute approval or implemented coverage.

The owner further specified a collapsible Projects group with concrete projects and conversation leaves, without a task-navigation level. Project-associated taskless conversations and projectless conversations both need direct access, and project workspaces include task and conversation panels. This navigation clarification is recorded by design checkpoint `0499ba8144200e84b32dd46e8aea5720a9a86999`; it does not establish a nested-project model or completed browser/visual acceptance.

The owner subsequently removed the top-level Conversations button, leaving Workbench and Tasks. The projectless group is named Conversations, and the cross-project All Conversations list remains available from Workbench. Project/conversation trees and project panels remain. This clarification is recorded by design checkpoint `dd3fe9b65cde3c813699ff17f18cb65939a1b142`; old navigation screenshots do not establish acceptance of this layout.

The owner directly confirmed one task per conversation, fixed bindings without replacement/detachment/cross-project migration, private projectless conversations with explicit confirmation before project sharing of historical messages/execution/files, and private same-user drafts. The owner chose automatic last-modification-wins draft reconciliation rather than manual conflict-copy selection, and chose a task status set including Blocked. These answers refine product contracts, not implementation coverage or approval of the entire PRD/design. Business-rule confirmation is consolidated in the parent conversation rather than duplicated in the UI task.

The owner explicitly permitted both task parent/child relationships and prerequisite dependencies across project boundaries. Task relationships preserve the endpoint tasks' project ownership and do not widen project permissions. This decision concerns task relationships and does not change the fixed task/Session binding rule. The design discussion also established system-following theme by default, manual light/dark override and independently remembered choices per client, without selecting a storage technology. Neither clarification establishes implementation coverage or complete product/design approval.

## Frontend Foundation Evidence

The frontend foundation is developed in [PR #2](https://github.com/IvanLi-CN/Loomhelm/pull/2). Its source candidate `5f1a273797d73b7ee39e91b68bdd96b75a229d08`, based on `079d3d85318c365056cd29a238aafdf732581421`, passed the pinned dependency install and frontend build/check commands in a session-owned Linux VM. Route, responsive and component observations accompany that run; the HTTP IP origin did not provide browser service-worker registration evidence. A separate localhost production-preview record establishes active registration with equivalent frontend inputs. These results establish the technical foundation rather than full product/PWA acceptance.

The initial engineering images originated from `be74653dc09b203bf0e7c14cf87aadb89e3b7d68`; comparison against that validated source candidate found no changes in the frontend manifests, lockfile, TypeScript configuration, `web/` or `packages/` inputs. The owner explicitly exempted only this initial neutral engineering surface from manual screenshot confirmation, retaining Agent checks and archival. Product design and subsequent visual acceptance retain their normal gates.

Source `121100ef6c3ed35edaa90bb6e59d5dd9bd7619a2` adds the registration-error diagnostic callback and changes the brand link to a plain home anchor, leaving current-route semantics to the technical navigation. Its two-file implementation delta passed frozen install, typecheck, Vite/PWA and Storybook builds in the task's Linux VM. Secure localhost browser observations confirmed an activated root-scoped service worker, and a dedicated preview returning HTTP 503 for `/sw.js` observed the callback's diagnostic with no registration. Home/Status/brand navigation and narrow-screen checks accompanied the repair. These observations cover the framework wiring rather than final PWA product acceptance.

The canonical three-image set was refreshed from this repaired source: a 1280x900 desktop page normalized to 1280x861, a 393x852 mobile page, and an 864x659 Storybook canvas tightened to 864x651 using declared component/surface geometry. The source-managed component surface is opaque, unframed and contains the target; the bottom margin was reduced from 56px to 48px, with other margins preserved. Each actual new normalized capture was compared at its exact destination against parent `079d3d85318c365056cd29a238aafdf732581421`, yielding current-only because those paths do not exist at that baseline. This refreshed set supersedes the earlier assets and the invalid old-image self-comparisons; it does not claim pixel equality. Agent inspection, immutable chat display and archival use the existing foundation-only manual-confirmation exception.

Source `724107721164d60b23e7a75f21991ec659a81806` limits Runtime navigation to an exact root-route match, correcting prefix-active behavior on `/status`. Its one-line router change passed targeted TypeScript and browser checks: only Runtime is current on `/`, only Status is current on `/status`, and the brand anchor returns home. Unaffected VM build, service-worker activation/failure and isolated Storybook observations are retained without claiming a new full build. The desktop and mobile page assets were refreshed from actual current-source captures at 1280x861 and 393x852, with trim-only normalization; their exact-path comparisons against the same parent baseline remain current-only. The isolated component asset is unchanged because this router option does not affect its source. These observations and images cover the neutral foundation only.

## Persistence Foundation

The persistence foundation pins pgx v5.11.0, Goose v3.28.0, River v0.49.0 and sqlc v1.31.1. Parent preparation commit `f3f065f5274a718e18c5b04bcf250de47293f44b` records module dependencies and official database-tool release URLs and SHA256 values. Application composition adds required database configuration for Server/Worker, leaving Connector configuration independent. This extends an undeployed engineering skeleton; it does not promise compatibility with an existing production installation.

The platform application migration and River queue migrations use separate histories under a common startup serialization boundary. Platform short-job results are durable infrastructure state, distinct from task business status or a Codex Run. Focused application tests use resource factories to check failure, readiness and shutdown ordering; real PostgreSQL, process restart and complete candidate observations remain separate gates. No migration rollback, cross-process Worker fencing or production release is established by this foundation.

## Branch Preview Runtime

RD02 adds the isolated branch-preview deployment surface under `deploy/preview` and `scripts/preview`. Candidate manifests carry exact source SHA, artifact digest, immutable Server/Worker image references, Web assets and a two-way durable-state compatibility range. The controller selects the inactive slot, records promotion history, renders Caddy, updates `web/current` and `web/retained` atomically, and never reverses a deployed migration.

The runtime adds migration `00002_worker_leases` and a Worker health/drain surface. A higher durable generation fences an older Worker across processes; the older Worker loses readiness, stops River scheduling and cannot enqueue after the lease check observes the fence. Transient PostgreSQL failure pauses scheduling and readiness, while successful heartbeat recovery rebuilds the River client. Orderly stop releases only the matching lease identity, allowing a clean same-generation restart without weakening higher-generation fencing.

The session-owned Agent VM rehearsal built the existing Server/Worker image surface, ran real PostgreSQL and Caddy containers, promoted blue, staged and promoted green, verified that old Web assets remained available through the retained fallback, fenced the old Worker before traffic cutover, drained and stopped the old slot, switched back within the compatibility window, and recovered Worker readiness after stopping and restarting PostgreSQL. The full Go test suite, targeted race tests, `go vet`, preview controller tests and the release-check Worker image passed. This evidence is limited to the isolated branch preview; it is not a production deployment or publication receipt.

## Public Protocol Foundation

F05 adds the versioned `contracts/loomhelm-v1.json` source and deterministic Go/TypeScript generation for the REST/MCP operation catalog, command ACKs, event cursors, Codex fixture envelopes and typed client boundary. The HostGateway and CodexAdapter contract keeps R01 new-session startup separate from explicit active-session attachment, while RunController and ArtifactStore define reconciliation and authorized byte-retention boundaries. This is a compile-time and codec foundation; authenticated business handlers, durable business storage and current Desktop hot attachment remain unimplemented or blocked by their existing acceptance gates.

Observed source `006f1d627f38bb38bbd0e72f45edd1a28d21ac36` combines the database/job adapters, application composition and worktree readiness changes. Its session-owned Linux VM evidence includes Go test/vet, focused race tests, unchanged sqlc output and module tidy, a backend image build, actual PostgreSQL/job round trips, concurrent empty-database Server/Worker startup with a one-connection pool, health loss/recovery and signal drain. The sorted durable result rows matched exactly before and after a PostgreSQL container restart. The built Server image has local content identity `sha256:4313fa67f04dcac20200c157e6e3cb3d08ddb8fb10029d34699914856b9276b4`; this is not a registry publication or a promotion receipt.

The same source passed first and repeat setup in real linked worktrees using an external Git common directory, preserving existing environment and hook contents without depending on a historical helper. Evidence also covers protected environment paths, two aggregated tool-readiness failures, distinct path-derived Compose projects and validated explicit overrides. Go `1.27.2`, Bun `1.4.3` and sqlc `1.31.1` were observed, with actual setup/dev and tool-manifest bytes matched to the candidate. Earlier harness failures are excluded from the passing observations; unavailable historical raw records were replaced by current-source runs. These observations establish infrastructure and bootstrap behavior, without completing product, blue-green or production acceptance.

Review of documentation-complete candidate `f4af488dc029625d6e28457a7208e23e20120f2d` demonstrated gaps in shutdown ownership and retryability, signed generation bounds, worktree database targets, configured queue routing, pool-specific migration-lock DSNs and selected sqlc invocation. The corrections preserve the existing infrastructure contracts. The earlier passing observations remain historical evidence for their source; changed runtime paths require fresh candidate-bound validation before delivery.

## References

- [Requirements](SPEC.md)
- [Implementation coverage](IMPLEMENTATION.md)
- [Control plane decision](../../adr/0001-control-plane-and-host-execution.md)
- [Deployment decision](../../adr/0002-immutable-candidates-and-blue-green.md)
- [Public protocol decision](../../adr/0003-public-protocol-and-reconciliation.md)
