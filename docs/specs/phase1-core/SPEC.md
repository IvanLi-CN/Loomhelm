# Loomhelm core workspace

## Context and Scope

Loomhelm connects project management with human-supervised Codex conversations in one configured execution environment. Its users are individuals and small teams operating a self-hosted Web/PWA, HTTP interface or MCP client. The primary interface supports one owner working concurrently from desktop and mobile clients.

The topic owns projects, tasks and their relationships, Codex sessions and runs, approvals, conversation-associated original files, shared drafts, recovery and the initial product interface. Autonomous master/project/task Agent orchestration, multiple execution environments, remote filesystem browsing, arbitrary plugin view hosting, rich document conversion and production release operations are outside this topic.

## Terms and Interfaces

- Project: the authorization and organization scope containing tasks and execution results.
- Task: a durable work item whose business status is independent from the execution status of any Run. Task hierarchy and prerequisite dependencies are distinct relationships; a subtask remains a Task.
- Execution environment: the single configured Codex execution endpoint for an installation. Connector enrollment and credentials are deployment concerns; public product operations do not select or manage hosts. The physical execution machine may be separate from Server and Worker.
- Session: a platform association with an actual Codex thread, presented to the user as a conversation, including an existing active desktop thread when supported by the verified adapter. Each Task has at most one directly associated Session; this does not establish the reverse cardinality.
- Run: one execution attempt bound to a task, the configured execution environment and a session, with observable state and event history. A Session may contain multiple Runs.
- Sub-agent: supporting work delegated within a task conversation's Codex context. Its activity is not automatically another Task or another directly associated task Session.
- Approval: a versioned request requiring an explicit approve or deny response.
- Conversation file: an original file referenced or produced in conversation context, with metadata, task/session association and controlled access. Artifact and ArtifactStore may remain internal technical names; they do not define an independent product module.
- Shared draft: unsent conversation input shared by the owner's authorized clients. Draft synchronization is separate from explicit command submission.
- Public interfaces: authenticated HTTP under `/api/v1`, browser event streaming, MCP tools/resources and the authenticated outbound Connector link.

## Requirements

### REQ-LH-001

The system MUST persist project and task creation, reading, updates and deletion subject to project permissions. It MUST protect active execution and retained results from becoming unowned through deletion. Web, HTTP and MCP MUST share the same application behavior and authorization.

### REQ-LH-002

The system MUST support creating a Codex session in the installation's configured execution environment and controlling an existing active Codex desktop session in that environment. Public requests MUST NOT select another execution machine. Existing-session acceptance MUST retain the actual thread/turn identity; history-only access, a fork, a copied resume or another independent process MUST NOT satisfy live-session control.

### REQ-LH-003

An authorized user MUST be able to associate at most one direct session with a task, send input, observe streamed execution, approve or deny a pending request and interrupt a run. Supported sub-agent activity MUST be inspectable within the task conversation using actual available events. Stale or repeated approval responses MUST NOT authorize additional execution.

### REQ-LH-004

The system MUST persist command identity and ordered events across connection loss and Server, Worker or Connector restart. It MUST distinguish accepted, executing and finished work, deduplicate repeated delivery, and expose an explicit unknown result when an external side effect cannot yet be established. Recovery MUST reconcile before repeating an ambiguous operation.

### REQ-LH-005

The system MUST retain original conversation-related files and metadata associated with tasks and sessions, provide authorized query/download and preserve them across process restart and deployment cutover. Available message references MUST retain their conversation context. The system MUST reject cross-project access and paths outside the authorized source scope. This contract does not require a standalone files page or access to an arbitrary remote filesystem.

### REQ-LH-006

The product MUST provide a responsive, installable Web/PWA with desktop/mobile capability parity. Global navigation MUST consist of Workbench, Tasks and Conversations spanning projects, with named projects separately switching the current project context. The workbench MUST prioritize pending decisions and exceptions; approval review MUST expose the full request and relevant context before explicit approve/deny actions. A task MUST open a combined conversation and task-information workspace. Files MUST appear in their conversation context; the product MUST NOT introduce a host-management surface, standalone artifacts navigation/page or task artifacts panel.

A single complete UI design task MUST involve the owner and produce the approved information architecture, prototype, desktop/mobile visuals, component states and implementation handoff before product UI implementation. Offline control commands MUST NOT be queued or automatically replayed.

### REQ-LH-007

The deployment system MUST bind candidates to actual source SHA and artifact digest, build once for promotion, prevent an unhealthy candidate from receiving traffic, drain retiring HTTP instances and fence obsolete Worker generations. Durable state and old client assets MUST remain available within the declared compatibility window. Application switchback MUST NOT silently reverse deployed state migrations.

### REQ-LH-008

The configured Connector's enrollment and credentials MUST be authenticated and revocable through deployment administration without introducing a user-facing multi-host resource model. Project authorization MUST cover commands, events, drafts, task relationships and original files. Codex credentials MUST remain on the execution machine. Platform control leases MUST govern platform-issued commands without making one browser or device the owner's sole authorized client. Native desktop actions MUST be observed and reconciled from Codex state.

### REQ-LH-009

The system MUST preserve original Codex event fields and unknown content types. Initial presentation MUST provide readable basic messages, code/tool state and an unknown-content fallback without requiring arbitrary interactive plugin hosting.

### REQ-LH-010

The system MUST persist task hierarchy and prerequisite dependencies as separate relationships and expose them consistently through the shared application services. Global Tasks and each project context MUST support list, board and graph views of the same Task identities. The board MUST group by task business state; the graph MUST distinguish project/task/subtask containment from directed prerequisite dependencies. Changing the presentation MUST NOT change task identity, task business state or Run execution state. Each client MUST remember the selected view separately for global Tasks and each project across reloads, with list as the initial default.

### REQ-LH-011

The owner's authorized Web/PWA clients MUST support concurrent work with synchronized task, conversation and submitted-operation state, without a device takeover step. A conversation MUST provide a live shared unsent draft; synchronizing that draft MUST NOT submit or queue a Codex command. Explicit submission MUST retain the command identity and reconciliation requirements. Each client MUST retain independent navigation, selected conversation and reading position; another client's navigation or view choice MUST NOT move its current view. Each event subscriber MUST be able to recover its own authorized event position.

## Verification

### VER-LH-001

- Method: real database and authenticated Web/HTTP/MCP CRUD scenarios, including cross-project and deletion conflicts.
- covers: `REQ-LH-001`
- Pass condition: all entry points expose the same persisted result, reject unauthorized access and preserve execution ownership.

### VER-LH-002

- Method: disposable new and existing active desktop sessions in the configured execution environment, with recorded version and connection identity.
- covers: `REQ-LH-002`, `REQ-LH-003`
- Pass condition: the same real thread/turn can be observed and controlled for input, approval, denial and interrupt; a substitute session is a failure.

### VER-LH-003

- Method: duplicate commands, competing approval responses, lost acknowledgements, connection interruption and independent process restarts.
- covers: `REQ-LH-003`, `REQ-LH-004`
- Pass condition: no automatic duplicate authorization or repeated established side effect occurs; ambiguous execution remains visible until reconciled and persisted events can be replayed.

### VER-LH-004

- Method: actual generated file byte comparison, permission/path rejection and retrieval after restart and deployment cutover.
- covers: `REQ-LH-005`, `REQ-LH-008`
- Pass condition: authorized downloads retain the original bytes and association while revoked or out-of-scope requests fail.

### VER-LH-005

- Method: owner review of the complete UI design, controlled component/page evidence, real-backend interaction and install/update/offline scenarios, including global/project navigation and conversation-context file access.
- covers: `REQ-LH-006`
- Pass condition: implemented desktop/mobile flows match the confirmed design and display the correct scope, the application installs, update retains context and offline control cannot silently execute later. No host-management or standalone artifacts surface is introduced.

### VER-LH-006

- Method: isolated fixed-candidate blue-green failure and cutover scenarios with durable data, connected clients and running work.
- covers: `REQ-LH-004`, `REQ-LH-005`, `REQ-LH-007`
- Pass condition: health rejection, drain, fencing, reconnection, artifact retention and compatible switchback are demonstrated against actual candidate identities.

### VER-LH-007

- Method: deployment-admin enrollment/revocation of the configured Connector and real authentication scenarios, including native desktop actions during platform observation.
- covers: `REQ-LH-008`
- Pass condition: revoked credentials cannot issue new commands, project scopes remain enforced and observed native state is reconciled without moving Codex secrets to the platform.

### VER-LH-008

- Method: sanitized real Codex content fixtures containing known and unknown event shapes.
- covers: `REQ-LH-009`
- Pass condition: round trips retain original fields and unknown content has a readable fallback.

### VER-LH-009

- Method: authenticated HTTP/MCP task-relationship round trips, database restart, and list/board/graph interaction in global and project contexts.
- covers: `REQ-LH-001`, `REQ-LH-006`, `REQ-LH-010`
- Pass condition: stored hierarchy and dependencies remain distinct and authorized, all views reference the same tasks, graph edge types remain distinguishable, and each context's chosen view survives reload without altering task or execution state.

### VER-LH-010

- Method: concurrent authorized desktop/mobile clients, draft changes and explicit send, competing approvals, reconnect, navigation changes and scoped view-preference reloads.
- covers: `REQ-LH-003`, `REQ-LH-004`, `REQ-LH-006`, `REQ-LH-008`, `REQ-LH-011`
- Pass condition: clients observe shared durable work and draft state without device takeover, draft synchronization alone never executes work, conflicting or uncertain commands retain their defined results, and each client's current navigation and reading position remain independent.

## Related ADRs

- [Control plane and host execution](../../adr/0001-control-plane-and-host-execution.md)
- [Immutable candidates and state-compatible blue-green](../../adr/0002-immutable-candidates-and-blue-green.md)

## References

- [Implementation coverage](IMPLEMENTATION.md)
- [Topic history](HISTORY.md)
