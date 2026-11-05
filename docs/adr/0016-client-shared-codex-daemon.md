# ADR 0016: Client Uses the Shared Codex App-Server Daemon

## Status

Accepted for the phase-one Codex integration requirements.

## Context

The project terminology defines three product endpoints: Server, Client and Web App. The Client runs independently on a Host and provides Codex interaction and development-task assistance. The existing implementation starts a private `codex app-server` child from the Host-side process. Codex CLI, however, can browse and queue messages through the Host's managed app-server daemon over its Unix control socket. A private child cannot see the daemon's loaded threads, active turns, approval ownership or event stream, so it cannot satisfy existing-session control.

The product requirement is stronger than importing copied history: an authorized user must operate the same real Codex `thread_id` and active `turn_id`, including input, approvals, denial, interruption, streaming events and recovery. A second app-server process, a fork, copied content or a cold resume in another runtime is not evidence of that capability.

## Decision

The Loomhelm Client connects to the existing Host-local managed Codex app-server daemon through a configured Unix WebSocket control socket. It does not start a replacement app-server for the product path. The Client and Codex CLI therefore use the same Codex runtime and thread store.

The Client keeps its independent platform credential and local journal. Codex login credentials remain on the Host. The Server remains the authority for Loomhelm users, Host ownership/sharing, project authorization, command identity, event cursors and operation reconciliation. The Codex daemon remains the authority for thread, turn, item, approval callback and live execution state.

The Client MUST use the daemon protocol for thread listing, history pagination, resume, turn submission, event observation, approval resolution and interruption. It MUST preserve native thread and turn identities. A lost acknowledgement MUST become `unknown` until the Client queries the daemon and reconciles the side effect; it MUST NOT replay the operation automatically.

The Host socket is a local capability boundary. The Client MUST fail closed when the configured socket is absent, inaccessible, or protocol-incompatible. The platform connection state, socket state and daemon readiness state MUST be reported separately so a process that is merely running cannot appear online.

## Alternatives Rejected

- Start an independent app-server from the Client: rejected because it creates a separate runtime and cannot control the shared CLI/Desktop thread.
- Read or write rollout files directly: rejected as a runtime control mechanism because file visibility does not provide event delivery, active-turn ownership or approval routing.
- Use a copied thread, fork or cold resume as existing-session control: rejected because it changes the runtime identity and cannot prove same-turn control.
- Treat an internal Desktop plugin pipe as the Client protocol: rejected because it is not the documented app-server transport or a stable third-party contract.
- Expose the Host socket to the public network: rejected because the socket is a local capability and platform authorization belongs at the Server/Client boundary.

## Compatibility and Migration

The current private-process transport is incompatible with this decision. The Client transport must gain a Unix WebSocket daemon implementation and make the socket path configurable with a safe local default. Existing local journal records remain readable for reconciliation, but a journal record must not be interpreted as proof that a thread is currently loaded or controllable.

Product-facing documentation, protocol descriptions, configuration references, logs and UI copy MUST use the established term Client. Historical ADRs and migration records MAY retain the former implementation name when describing past states.

## Verification

Acceptance requires one real daemon-backed thread and one active turn. The evidence must show the same thread and turn identities across history reads, input, streamed events, approval, denial, interruption, Client disconnect/reconnect and post-ACK reconciliation. A separate app-server process, a different thread, or history-only evidence fails the gate.
