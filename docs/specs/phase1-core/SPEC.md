# Loomhelm core workspace

## Context and Scope

Loomhelm connects project management with human-supervised Codex conversations in one configured execution environment. Its users are individuals and small teams operating a self-hosted Web/PWA, HTTP interface or MCP client. The primary interface supports one owner working concurrently from desktop and mobile clients.

The [product requirements](../../PRD.md) define the complete phase-one scope, user journeys, acceptance and product decision process. This specification records established engineering constraints; product suggestions require explicit confirmation before becoming implementation contracts.

The topic owns projects, tasks and their relationships, Codex sessions and runs, approvals, conversation-associated original files, shared drafts, recovery and the initial product interface. Autonomous master/project/task Agent orchestration, multiple execution environments, remote filesystem browsing, arbitrary plugin view hosting, rich document conversion and production release operations are outside this topic.

## Terms and Interfaces

- Project: the authorization and organization scope containing tasks and project-associated conversations and execution results. A conversation may initially have no project.
- Task: a durable work item whose business status is independent from the execution status of any Run. Task hierarchy and prerequisite dependencies are distinct relationships, both permitted across projects without changing either task's project ownership; a subtask remains a Task.
- Execution environment: the single configured Codex execution endpoint for an installation. Connector enrollment and credentials are deployment concerns; public product operations do not select or manage hosts. The physical execution machine may be separate from Server and Worker.
- Session: a platform association with an actual Codex thread, presented to the user as a conversation, including an existing active desktop thread when supported by the verified adapter. A Session may exist without a Task or Project. Each Task has at most one directly associated Session, and each Session has at most one associated Task. Established task/session bindings remain fixed in phase one.
- Run: one execution attempt bound to a session and the configured execution environment, with observable state and event history. Task association is optional because standalone conversations can execute. A Session may contain multiple Runs; later task association must not recreate their identities.
- Sub-agent: supporting work delegated within a task conversation's Codex context. Its activity is not automatically another Task or another directly associated task Session.
- Approval: a versioned request requiring an explicit approve or deny response.
- Conversation file: an original file referenced or produced in conversation context, with metadata, session association, an optional task association and controlled access. Artifact and ArtifactStore may remain internal technical names; they do not define an independent product module.
- Shared draft: unsent conversation input shared by the owner's authorized clients. Draft synchronization is separate from explicit command submission.
- Public interfaces: authenticated HTTP under `/api/v1`, browser event streaming, MCP tools/resources and the authenticated outbound Connector link.

## Requirements

### REQ-LH-001

The system MUST persist project and task creation, reading, updates and deletion subject to project permissions. It MUST protect active execution and retained results from becoming unowned through deletion. Web, HTTP and MCP MUST share the same application behavior and authorization.

Project or Task deletion MUST be rejected when the resource contains active execution or associated historical execution/files that must be retained. Rejection MUST preserve ownership, relationships and results. A Task MAY be marked Cancelled while its history remains retained; this business-state change MUST NOT itself delete history or replace an explicit execution interrupt.

Task business states MUST be To do, In progress, Blocked, Done and Cancelled, distinct from Run execution, approval and connection states. A completed Run MUST NOT by itself mark a task Done. Public contracts MUST fix the corresponding machine values consistently.

### REQ-LH-002

The system MUST support creating a Codex session in the installation's configured execution environment and controlling an existing active Codex desktop session in that environment. Public requests MUST NOT select another execution machine. Existing-session acceptance MUST retain the actual thread/turn identity; history-only access, a fork, a copied resume or another independent process MUST NOT satisfy live-session control.

### REQ-LH-003

An authorized user MUST be able to associate at most one direct session with a task, send input, observe streamed execution, approve or deny a pending request and interrupt a run. These conversation operations MUST also work without prior Task or Project association. Supported sub-agent activity MUST be inspectable within the conversation using actual available events. Stale or repeated approval responses MUST NOT authorize additional execution.

### REQ-LH-004

The system MUST persist command identity and ordered events across connection loss and Server, Worker or Connector restart. It MUST distinguish accepted, executing and finished work, deduplicate repeated delivery, and expose an explicit unknown result when an external side effect cannot yet be established. Recovery MUST reconcile before repeating an ambiguous operation.

### REQ-LH-005

The system MUST retain original conversation-related files and metadata associated with sessions and, when applicable, tasks, provide authorized query/download and preserve them across process restart and deployment cutover. Available message references MUST retain their conversation context. The system MUST reject out-of-scope conversation or project access and paths outside the authorized source scope. This contract does not require a standalone files page or access to an arbitrary remote filesystem.

File publication MUST persist a recoverable intent before publishing final bytes, expose only verified ready objects and reconcile incomplete publication across process restart. The same authorized artifact identity and immutable content MUST be safe to retry; conflicting content or association MUST NOT overwrite an existing publication. Database timeouts or lost commit responses MUST NOT trigger deletion of confirmed or potentially committed bytes. Publication and reconciliation MUST coordinate across processes sharing the database and file volume. Missing or corrupt objects MUST remain explicitly unavailable rather than being reported ready. Storage recovery belongs to ArtifactStore; real domain authorization and startup/runtime recovery invocation remain mandatory application integration.

An explicit identical authorized retry MAY repair unavailable state caused solely by missing or corrupt never-ready staging. It MUST verify newly supplied bytes against the retained immutable metadata, confirm that no final object exists under per-identity coordination and durably replace the pending staging intent before publication. Unknown reasons, previously ready publications and conflicting/nonregular final objects MUST NOT use this transition. Background recovery MUST NOT invent replacement content; a concurrent matching ready result MUST be treated as convergence.

Publication input MUST satisfy a close/unblock cancellation contract. ArtifactStore retains its Go method type but MUST reject sources without the required io.ReadCloser capability before staging, take ownership of admitted input and close it exactly once on completion or cancellation. A no-op closer MUST NOT be used to claim cancellability of an arbitrary blocking source. Cancellation cleanup MUST share a five-second total budget, preserve recoverable state and leave no blocked copy goroutine or package-wide input lock.

The configured storage root and its ancestors MUST be protected from untrusted writers, with the private root owned by the Server service identity and mode 0700. The storage volume MUST NOT be an Agent workspace. Input path validation, no-follow final access, integrity and cooperative multi-process publication remain required; isolation from a hostile process already controlling the Server service identity is outside this storage contract. Production storage targets a local Linux filesystem; Windows storage support is not established.

### REQ-LH-006

The product MUST provide a responsive, installable Web/PWA with desktop/mobile capability parity. Top-level global navigation MUST consist of Workbench and Tasks. A separate Conversations group below those entries MUST directly list authorized projectless conversations. There MUST NOT be a separate top-level global Conversations button. The cross-project All Conversations list and creation path MUST remain reachable from Workbench. The workbench MUST prioritize pending decisions and exceptions; approval review MUST expose the full request and relevant context before explicit approve/deny actions. A task MUST open a combined conversation and task-information workspace. Files MUST appear in their conversation context; the product MUST NOT introduce a host-management surface, standalone artifacts navigation/page or task artifacts panel.

Project navigation MUST provide a collapsible Projects group, concrete projects and their conversations as direct leaves, including both task-associated and taskless project conversations without an intervening task-navigation level. The projectless group and its breadcrumb MUST use Conversations rather than Unassigned Project. A project's workspace MUST provide task and conversation panels, and its conversation panel MUST include all authorized conversations in that project. Project-scoped creation MUST preselect that project; global creation MUST allow no project. Navigation placement, selection and breadcrumbs MUST follow actual association changes using the same Session identity. This navigation tree does not establish a nested-project business model.

The interface MUST follow the system theme by default and allow manual light/dark selection and returning to system preference. Each client MUST independently retain its choice across reloads without overwriting another client's preference. Both themes MUST provide the same capabilities and readable content, focus and state indicators.

Business feature implementation and public business contract finalization MUST follow explicit owner confirmation of the phase-one PRD and resolution of the affected business decisions. A single complete UI design task MUST involve the owner and produce the approved information architecture, prototype, desktop/mobile visuals, component states and implementation handoff before product UI implementation. Engineering skeletons, infrastructure, capability research and the existing design discussion MAY proceed before those product approvals. Offline control commands MUST NOT be queued or automatically replayed.

### REQ-LH-007

The deployment system MUST bind candidates to actual source SHA and artifact digest, build once for promotion, prevent an unhealthy candidate from receiving traffic, drain retiring HTTP instances and fence obsolete Worker generations. Durable state and old client assets MUST remain available within the declared compatibility window. Application switchback MUST NOT silently reverse deployed state migrations.

### REQ-LH-008

The configured Connector's enrollment and credentials MUST be authenticated and revocable through deployment administration without introducing a user-facing multi-host resource model. Authorization MUST cover commands, events, drafts, task relationships and original files in both standalone-conversation and project scopes; the absence of a project MUST NOT bypass access control. Unsent drafts MUST remain private to the creating user's authorized clients and MUST NOT become visible to other project members when conversation history is shared. Codex credentials MUST remain on the execution machine. Platform control leases MUST govern platform-issued commands without making one browser or device the owner's sole authorized client. Native desktop actions MUST be observed and reconciled from Codex state.

The project creator MUST manage the project and its member grants. Other human accounts MUST receive either read-only or operator access per project. Read-only access MUST NOT permit task mutation, execution commands or approval responses; operator access MUST permit authorized task mutation, execution commands and approval responses without granting project administration or member management. Agents MUST act through user-authorized API/MCP credentials. Credential authority MUST remain bounded by both the user's current project permissions and the credential's project scope; issuing a derived credential MUST NOT widen that authority, including through an empty or omitted scope. Project membership MUST NOT confer installation administration rights.

The public contract MUST provide membership listing at `GET /api/v1/projects/{project_id}/members`, creator-authorized grants/role updates at `PUT /api/v1/projects/{project_id}/members/{user_id}` and revocation at the same member path using `DELETE`. Listing MUST return an explicit `items` array within the caller's authorized project scope. Grants MUST address an existing user, accept only `viewer` or `operator` and return the resulting `member` with HTTP 200; `owner` MAY appear in listing results but MUST NOT be assignable. Revocation MUST retain the creator's ownership and return HTTP 204 without a body only after successful completion. These operations and their MCP counterparts MUST use the same application authorization and credential-scope checks.

The browser MUST obtain its current authenticated identity from `GET /api/v1/auth/session`, which returns `user_id` and `csrf_protection: same_origin` only when an authenticated browser session and the corresponding server protection are present. An unauthenticated request MUST return HTTP 401; the response MUST NOT be cached. This capability declaration MUST NOT grant project permissions or installation administration. Browser mutations, including `POST /api/v1/auth/logout`, MUST pass the Go `net/http.CrossOriginProtection` boundary with no trusted origins or bypass patterns by default. Web and API MUST share an origin behind the deployment proxy. The client MUST NOT invent a CSRF token or infer enforced protection from configuration alone. OIDC start/callback routes MUST remain under `/api/v1/auth/oidc/`, retain state/nonce verification and use HttpOnly session cookies. Logout MUST destroy the current browser session and return HTTP 204 without a response body. API/MCP authentication and project authorization remain independent mandatory checks.

### REQ-LH-009

The system MUST preserve original Codex event fields and unknown content types. Initial presentation MUST provide readable basic messages, code/tool state and an unknown-content fallback without requiring arbitrary interactive plugin hosting.

Content classification MUST remain a lossless, non-executing codec; repository-fixture sanitization MUST NOT silently become runtime redaction. Runtime authorization and presentation safety MUST be enforced at their respective boundaries, and logs/public errors MUST NOT disclose raw envelopes, credentials or private paths. Decode/Encode MUST enforce a 4 MiB record ceiling. JSONL batches MUST enforce at most 64 MiB of consumed input including whitespace/separators and 10,000 records; oversized input MUST return ErrTooLarge rather than successful truncation. Accepted raw bytes and unknown fields MUST remain unchanged.

The legacy ParseJSONL helper MUST be limited to finite nonblocking fixture/in-memory input. Runtime parsing MUST use a context-aware internal adapter with an io.ReadCloser that satisfies the close/unblock contract and the same record/count/byte budgets. Cancellation and validation failures MUST NOT be treated as a successful partial batch.

### REQ-LH-010

The system MUST persist task hierarchy and prerequisite dependencies as separate relationships and expose them consistently through the shared application services. Both parent/child relationships and prerequisite dependencies MUST support tasks in different projects. Relationship changes MUST preserve each task's project, main Session and execution ownership and enforce authorization at both endpoints. A relationship MUST NOT grant access to an otherwise unauthorized task or project or disclose its protected contents.

Each relationship type MUST reject self-links and cycles within its own graph, including cycles spanning projects. Hierarchy and prerequisite graphs MUST be checked separately. Concurrent mutations MUST NOT admit a cycle. Maintaining a legal relationship MUST NOT automatically start an Agent or execution.

The canonical public contract MUST expose project and task create/list/get/update/delete operations and separate task relationship reads and mutations. Relationship reads MUST return distinct parents, children, prerequisites and dependents arrays, including empty arrays when no authorized edges are available; they MUST filter inaccessible endpoints before exposing their identities. A relation MUST NOT change either Task's project ownership or grant access to an otherwise inaccessible endpoint; Task responses MUST NOT embed unfiltered relationship IDs. For dependency mutations, the path's task is the dependent and the named prerequisite is its prerequisite. Successful deletes and relationship mutations MUST return HTTP 204 without a JSON body; their generated Web client methods MUST resolve only after the declared successful response and preserve shared API failures. Declaring a transport success response MUST NOT bypass role checks, relationship validation or deletion protection.

Global Tasks and each project context MUST support list, board and graph views of the same Task identities. Project views MUST express relationships to authorized external tasks with their actual project identified, without presenting those tasks as members of the selected project. The board MUST group by task business state; the graph MUST distinguish project/task/subtask containment from directed prerequisite dependencies. Changing the presentation MUST NOT change task identity, task business state or Run execution state. Each client MUST remember the selected view separately for global Tasks and each project across reloads, with list as the initial default.

### REQ-LH-011

The owner's authorized Web/PWA clients MUST support concurrent work with synchronized task, conversation and submitted-operation state, without a device takeover step. A conversation MUST provide a live shared unsent draft; synchronizing that draft MUST NOT submit or queue a Codex command. Explicit submission MUST retain the command identity and reconciliation requirements. Each client MUST retain independent navigation, selected conversation and reading position; another client's navigation or view choice MUST NOT move its current view. Each event subscriber MUST be able to recover its own authorized event position.

Concurrent draft edits and reconnection conflicts MUST automatically converge on the last modification using a consistent modification order, without manual selection of conflicting copies. Sending MUST consume only the content actually sent and preserve subsequent input. Draft recovery MUST NOT send a command. The public protocol MUST define ordering, deduplication and recovery consistently across clients.

### REQ-LH-012

The system MUST allow an authorized user to create and operate a standalone conversation without first choosing a Task or Project, and later associate it with a task. A projectless conversation MUST initially be private to its creator. Binding MUST require that creator's explicit confirmation that historical messages, execution and files will follow the target project's permissions. A previously projectless conversation MUST join that task's project; a project-associated conversation MUST bind only within the same project. The binding and visibility change MUST remain consistent, and unsent drafts MUST remain private to the creator's own clients.

Association MUST retain the same Session and the identities and continuity of its messages, Runs, events, original-file references and shared unsent draft; it MUST NOT fork or replace the conversation or create duplicate list identities. Every Task MUST retain at most one directly associated main Session, and every Session MUST retain at most one associated Task. Only an unbound Session and a Task without a main Session MAY be bound. Phase one MUST NOT replace or detach an established binding or migrate it across projects. Creation, execution, retrieval and association MUST enforce authorization. A failed association MUST leave the original conversation, ownership and visibility intact.

## Verification

### VER-LH-001

- Method: real database and authenticated Web/HTTP/MCP CRUD scenarios, all five task business states, execution-state independence, cross-project access, protected project/task deletion and cancellation with retained history.
- covers: `REQ-LH-001`
- Pass condition: all entry points expose the same persisted result and five task states, Run completion does not silently complete tasks, unauthorized access is rejected and execution ownership is preserved. Active execution or required historical results block project/task deletion without changing stored ownership, relationships or bytes; marking a Task Cancelled retains that history and does not implicitly interrupt execution.

### VER-LH-002

- Method: disposable new and existing active desktop sessions in the configured execution environment, with recorded version and connection identity.
- covers: `REQ-LH-002`, `REQ-LH-003`
- Pass condition: the same real thread/turn can be observed and controlled for input, approval, denial and interrupt; a substitute session is a failure.

### VER-LH-003

- Method: duplicate commands, competing approval responses, lost acknowledgements, connection interruption and independent process restarts.
- covers: `REQ-LH-003`, `REQ-LH-004`
- Pass condition: no automatic duplicate authorization or repeated established side effect occurs; ambiguous execution remains visible until reconciled and persisted events can be replayed.

### VER-LH-004

- Method: actual generated file byte comparison, permission/path rejection, separate-process concurrent writers/reconciliation, fault injection and process interruption at staging, intent, publication, repair-intent and readiness boundaries, lost database commit responses, blocked-input cancellation, and retrieval after restart and deployment cutover.
- covers: `REQ-LH-005`, `REQ-LH-008`
- Pass condition: authorized downloads retain the original bytes and association while revoked or out-of-scope requests fail. Repeated reconciliation and identical retries converge without duplicate metadata or overwritten bytes; explicit staging-loss repair obeys its reason, authorization, byte-validation and durable-intent conditions. Conflicting retries fail, incomplete or corrupt objects remain unavailable, and an ambiguous database outcome never deletes potentially committed bytes. Metadata and download revalidate ready bytes; cancellation during a blocked input returns within the five-second cleanup budget without a lingering copy goroutine or stalled unrelated upload. Unknown/previously-ready unavailable states and conflicting final objects are not repaired by this path. Package recovery evidence does not substitute for authenticated application integration.

### VER-LH-005

- Method: explicit owner PRD confirmation and resolution of the affected business decisions before implementation, followed by owner review of the complete UI design, controlled component/page evidence, real-backend interaction and install/update/offline scenarios, including global/project navigation, conversation-context file access, system theme changes and independent client theme preferences.
- covers: `REQ-LH-006`
- Pass condition: product implementation follows the confirmed product requirements and design; the two top-level entries, projectless Conversations group, Workbench All Conversations action, project/conversation tree and project panels expose the correct authorized scope, including taskless project conversations. The theme initially follows the system, manual choices survive reload independently per client, returning to system preference works, and both themes retain readable states and equal capability. The application installs, update retains context and offline control cannot silently execute later. No host-management or standalone artifacts surface is introduced.

### VER-LH-006

- Method: isolated fixed-candidate blue-green failure and cutover scenarios with durable data, connected clients and running work.
- covers: `REQ-LH-004`, `REQ-LH-005`, `REQ-LH-007`
- Pass condition: health rejection, drain, fencing, reconnection, artifact retention and compatible switchback are demonstrated against actual candidate identities.

### VER-LH-007

- Method: deployment-admin enrollment/revocation of the configured Connector and real authentication scenarios, including authenticated membership list/grant/update/revoke HTTP/MCP requests, project-creator member grants, read-only/operator action matrices, scope-restricted credential issuance and native desktop actions during platform observation.
- covers: `REQ-LH-008`
- Pass condition: revoked credentials cannot issue new commands, project scopes remain enforced and observed native state is reconciled without moving Codex secrets to the platform. Read-only members cannot mutate tasks, execute or approve; operators can perform those actions only within their project authority and cannot manage project/member grants. Membership operations enforce the authenticated caller and current project scope, reject ownership assignment or creator revocation, and keep existing task/result ownership intact. Derived credentials cannot broaden scope through empty, omitted or additional project selections, and membership changes constrain subsequent credential-backed actions.

### VER-LH-008

- Method: sanitized real Codex content fixtures containing known and unknown event shapes, byte/count/record budget boundaries, blocked runtime-input cancellation and fixture-admission versus runtime-codec checks.
- covers: `REQ-LH-009`
- Pass condition: round trips retain original fields and raw bytes, unknown content has a readable non-executing fallback, and fixture-only sanitizer rules do not rewrite authorized runtime payloads. Record/total/count excess and cancellation produce explicit errors without successful truncation or unbounded input accumulation. Real credentials and private data are not introduced into fixtures, logs or public errors.

### VER-LH-009

- Method: authenticated HTTP/MCP round trips for both cross-project parent/child relationships and prerequisite dependencies, self-links, same-project/cross-project cycles and concurrent opposing-edge mutations, database restart, unauthorized-endpoint scenarios and list/board/graph interaction in global and project contexts.
- covers: `REQ-LH-001`, `REQ-LH-006`, `REQ-LH-010`
- Pass condition: both cross-project relationship types persist and remain distinct; self-links and cycles within either graph are rejected even under concurrent mutation, with the two relationship types checked independently and no automatic execution started by legal edges. Task project, main Session and execution ownership stay unchanged, endpoint authorization holds and no protected task content leaks through relationships. All views reference the same tasks, external project identities and graph edge types remain distinguishable, and each context's chosen view survives reload without altering task or execution state.

### VER-LH-010

- Method: concurrent authorized desktop/mobile clients, draft changes and explicit send, competing approvals, reconnect, navigation changes and scoped view-preference reloads.
- covers: `REQ-LH-003`, `REQ-LH-004`, `REQ-LH-006`, `REQ-LH-008`, `REQ-LH-011`
- Pass condition: clients observe shared durable work and private same-user draft state without device takeover; draft conflicts converge to the last modification, sending preserves newer input, and synchronization/recovery alone never executes work. Conflicting or uncertain commands retain their defined results and each client's current navigation and reading position remain independent.

### VER-LH-011

- Method: authenticated Web/HTTP/MCP creation of a conversation without a project or task, real execution and file production, later task association, failure/conflict and authorization scenarios, reconnect and process restart.
- covers: `REQ-LH-003`, `REQ-LH-004`, `REQ-LH-005`, `REQ-LH-008`, `REQ-LH-011`, `REQ-LH-012`
- Pass condition: projectless conversations are creator-private and executable; association requires explicit sharing confirmation, preserves Session/Run/event/message/file/draft continuity and applies target-project history permissions while keeping drafts private. Both association cardinalities hold, occupied/replacement/detach and cross-project Session reassociation operations are rejected, and failed association leaves prior state intact. Cross-project task hierarchy and prerequisite relationships remain supported independently of Session binding.

## Related ADRs

- [Control plane and host execution](../../adr/0001-control-plane-and-host-execution.md)
- [Immutable candidates and state-compatible blue-green](../../adr/0002-immutable-candidates-and-blue-green.md)
- [Versioned public protocol and reconciliation boundary](../../adr/0003-public-protocol-and-reconciliation.md)
- [Bounded file publication and content input](../../adr/0005-bounded-file-publication-and-content-input.md)

## References

- [Implementation coverage](IMPLEMENTATION.md)
- [Topic history](HISTORY.md)
