# Client–Codex Daemon Integration Requirements

## Scope

The Client is the independently runnable local Loomhelm program on a Host. It connects Loomhelm to the Host's shared Codex app-server daemon and provides authorized Codex conversation operations. The Server provides platform authorization and durable application state; the Web App provides the browser/PWA interface.

## Runtime boundary

The Client MUST connect to the Host's existing managed Codex app-server daemon through its Unix WebSocket control socket. It MUST NOT start an independent app-server for the product path, attach by copying rollout files, or treat a fork/cold resume as an existing-session attachment.

The socket path MUST be configurable and have a safe user-local default. Missing, inaccessible or protocol-incompatible sockets MUST fail closed. The Client MUST report platform connection, socket availability and daemon readiness as separate facts.

The Codex daemon is authoritative for native thread, turn, item, approval and live execution state. Loomhelm is authoritative for user identity, Host ownership and sharing, project permissions, command identity, operation records, event cursors and reconciliation state.

## Required capabilities

The Client MUST support:

- listing authorized daemon-visible threads;
- paginated history reads for threads, turns and items;
- resuming a recorded thread without changing its identity;
- submitting input to the real thread and active turn;
- forwarding streamed events with their native identities and ordering;
- receiving and resolving supported approvals, including denial;
- interrupting an active turn;
- reconnecting after Client or platform connection loss;
- reconciling ambiguous operations before another side-effecting command;
- preserving unknown events and fields for forward compatibility.

The Client MUST preserve the actual `thread_id` and `turn_id`. A successful operation response MUST be associated with the platform command identity and the native Codex identity that produced it.

## Authorization and credentials

The Client uses an independent Host credential for the Server. Browser session cookies MUST NOT be used as Client credentials. Codex login credentials MUST remain on the Host and MUST NOT be uploaded to the Server or exposed to the Web App.

The Server MUST authorize every thread operation through the caller's owned or explicitly shared Host and applicable project/session permissions. Project membership alone MUST NOT grant Host use. The Client MUST NOT accept a public request that selects an arbitrary machine outside the Server's resolved Host authorization.

## State and recovery

The Client journal MUST record platform command identity, native thread/turn identity, daemon generation, event cursor and reconciliation state. Repeated commands with the same identity and unchanged payload MUST converge to one operation. A changed payload under the same identity MUST be rejected as an idempotency conflict.

If an acknowledgement is lost or the daemon connection closes after delivery, the operation MUST be `unknown` until the Client reads daemon state and establishes whether the side effect occurred. The Client MUST NOT automatically resend an unknown command. Reconnection MUST restore subscriptions and cursors only after the daemon's current thread/turn state is reconciled.

If a thread is archived, removed or unavailable, Loomhelm MUST retain the last confirmed history and mark the current runtime state unavailable. It MUST NOT delete the platform session or create a replacement thread.

## Observable status

The product MUST distinguish at least:

- `platform_disconnected`: the Client cannot reach Loomhelm;
- `socket_unavailable`: the local daemon socket cannot be opened;
- `daemon_incompatible`: the daemon rejects the required protocol/capabilities;
- `daemon_ready`: the daemon is reachable and responds to readiness/thread queries;
- `thread_unavailable`: a previously known thread cannot currently be read or resumed;
- `reconciling`: a connection or side effect is being reconciled;
- `unknown`: an external side effect cannot yet be established.

The UI MUST NOT collapse these states into a generic online/offline flag.

## Acceptance evidence

The integration is complete only when one real daemon-backed thread and one active turn demonstrate:

1. history listing and paginated item reads;
2. input submission on the same `thread_id` and `turn_id`;
3. ordered streamed events;
4. approval and denial with the native request identity;
5. interruption of the same active turn;
6. Client disconnect and reconnect without changing thread identity;
7. lost-ACK handling that remains `unknown` until reconciliation;
8. consistent status across Client, Server and Web App.

An independent app-server, copied history, fork, cold resume in another runtime or a different thread does not satisfy this acceptance.
