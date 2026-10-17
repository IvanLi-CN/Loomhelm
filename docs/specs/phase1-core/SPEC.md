# Loomhelm core workspace

## Context and Scope

Loomhelm connects project management with human-supervised Codex execution on selected hosts. Its users are individuals and small teams operating a self-hosted Web/PWA, HTTP interface or MCP client.

The topic owns projects, tasks, hosts, Codex sessions and runs, approvals, original artifacts, recovery and the initial product interface. Autonomous master/project/task Agent orchestration, arbitrary plugin view hosting, rich document conversion and production release operations are outside this topic.

## Terms and Interfaces

- Project: the authorization and organization scope containing tasks and execution results.
- Task: a durable work item whose business status is independent from the execution status of any Run.
- Host: a paired machine with a local Connector and locally held Codex authentication.
- Session: a platform association with an actual Codex thread, including an existing active desktop thread when supported by the verified adapter.
- Run: one execution attempt bound to a task, host and session, with observable state and event history.
- Approval: a versioned request requiring an explicit approve or deny response.
- Artifact: an original execution result file with metadata, task/session association and controlled access.
- Public interfaces: authenticated HTTP under `/api/v1`, browser event streaming, MCP tools/resources and the authenticated outbound Connector link.

## Requirements

### REQ-LH-001

The system MUST persist project and task creation, reading, updates and deletion subject to project permissions. It MUST protect active execution and retained results from becoming unowned through deletion. Web, HTTP and MCP MUST share the same application behavior and authorization.

### REQ-LH-002

The system MUST support creating a Codex session on a selected paired host and controlling an existing active Codex desktop session on that host. Existing-session acceptance MUST retain the actual thread/turn identity; history-only access, a fork, a copied resume or another independent process MUST NOT satisfy live-session control.

### REQ-LH-003

An authorized user MUST be able to associate a session with a task, send input, observe streamed execution, approve or deny a pending request and interrupt a run. Stale or repeated approval responses MUST NOT authorize additional execution.

### REQ-LH-004

The system MUST persist command identity and ordered events across connection loss and Server, Worker or Connector restart. It MUST distinguish accepted, executing and finished work, deduplicate repeated delivery, and expose an explicit unknown result when an external side effect cannot yet be established. Recovery MUST reconcile before repeating an ambiguous operation.

### REQ-LH-005

The system MUST retain original artifacts and metadata associated with tasks and sessions, provide authorized query/download and preserve them across process restart and deployment cutover. It MUST reject cross-project access and paths outside the authorized source scope.

### REQ-LH-006

The product MUST provide a responsive, installable Web/PWA for projects, tasks, hosts, sessions, approvals and artifacts. A single complete UI design task MUST involve the owner and produce the approved information architecture, prototype, desktop/mobile visuals, component states and implementation handoff before product UI implementation. Offline control commands MUST NOT be queued or automatically replayed.

### REQ-LH-007

The deployment system MUST bind candidates to actual source SHA and artifact digest, build once for promotion, prevent an unhealthy candidate from receiving traffic, drain retiring HTTP instances and fence obsolete Worker generations. Durable state and old client assets MUST remain available within the declared compatibility window. Application switchback MUST NOT silently reverse deployed state migrations.

### REQ-LH-008

Host pairing and credentials MUST be authenticated and revocable. Project authorization MUST cover commands, events and original files. Codex credentials MUST remain on the selected host. Platform control leases MUST govern platform-issued commands, while native desktop actions MUST be observed and reconciled from Codex state.

### REQ-LH-009

The system MUST preserve original Codex event fields and unknown content types. Initial presentation MUST provide readable basic messages, code/tool state and an unknown-content fallback without requiring arbitrary interactive plugin hosting.

## Verification

### VER-LH-001

- Method: real database and authenticated Web/HTTP/MCP CRUD scenarios, including cross-project and deletion conflicts.
- covers: `REQ-LH-001`
- Pass condition: all entry points expose the same persisted result, reject unauthorized access and preserve execution ownership.

### VER-LH-002

- Method: disposable new and existing active desktop sessions on a specified host, with recorded version and connection identity.
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

- Method: owner review of the complete UI design, controlled component/page evidence, real-backend interaction and install/update/offline scenarios.
- covers: `REQ-LH-006`
- Pass condition: implemented desktop/mobile flows match the confirmed design, the application installs, update retains context and offline control cannot silently execute later.

### VER-LH-006

- Method: isolated fixed-candidate blue-green failure and cutover scenarios with durable data, connected clients and running work.
- covers: `REQ-LH-004`, `REQ-LH-005`, `REQ-LH-007`
- Pass condition: health rejection, drain, fencing, reconnection, artifact retention and compatible switchback are demonstrated against actual candidate identities.

### VER-LH-007

- Method: real pairing/revocation and authentication scenarios, including native desktop actions during platform observation.
- covers: `REQ-LH-008`
- Pass condition: revoked credentials cannot issue new commands, project scopes remain enforced and observed native state is reconciled without moving Codex secrets to the platform.

### VER-LH-008

- Method: sanitized real Codex content fixtures containing known and unknown event shapes.
- covers: `REQ-LH-009`
- Pass condition: round trips retain original fields and unknown content has a readable fallback.

## Related ADRs

- [Control plane and host execution](../../adr/0001-control-plane-and-host-execution.md)
- [Immutable candidates and state-compatible blue-green](../../adr/0002-immutable-candidates-and-blue-green.md)

## References

- [Implementation coverage](IMPLEMENTATION.md)
- [Topic history](HISTORY.md)
