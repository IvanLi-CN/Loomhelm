# ADR 0003: Versioned public protocol and reconciliation boundary

## Context

Loomhelm has two public entry points, REST and MCP, and one host-owned Codex execution boundary. The platform must preserve command identity, acknowledge admission separately from completion, replay ordered events after reconnect, and retain unknown Codex payload fields. R01 proves an independent Host Bridge/app-server generation for new sessions, while the current Desktop process has no verified path-addressable endpoint for active-session attachment.

## Decision

Use `contracts/loomhelm-v1.json` as the single versioned source for public wire types, REST operations, MCP tools/resources, and the command/ACK/event cursor vocabulary. The checked-in generator emits Go types and codecs under `internal/protocol/generated.go`, TypeScript protocol types under `packages/protocol/src/generated.ts`, and the typed REST client under `packages/api-client/src/generated.ts`; `go run ./cmd/codegen -check` is the no-drift gate.

The public command contract requires a caller-provided stable `command_id`. Reusing the same identity with the same request returns the persisted ACK and marks it deduplicated; reusing it with a different request returns `idempotency_conflict`. An ACK records platform admission and may still be `accepted` or `executing`; completion is established by the command state and ordered events, not by receipt of the ACK alone. A lost ACK requires reconciliation before a side-effecting retry, and an unresolved side effect remains `unknown`.

Event reads use an exclusive opaque `after_cursor` scoped to an authorized session or run stream. Pages are ordered by the stream sequence, carry a `next_cursor` only for the last returned position, and indicate continuation with `has_more`. An expired cursor returns `cursor_expired`; the client must reconcile from a fresh durable position rather than silently replaying a side effect. The event payload remains raw JSON so future Codex fields and unknown item types survive a round trip.

Approval history reads use an exclusive opaque, explicitly versioned cursor bound to the requested Run and ordered by the durable `(created_at, id, revision)` key. Public approval records project the stable persisted/native ID, revision, status, raw context and optional `requested_event_id`; the corresponding `approval.requested` event keeps its raw native payload unchanged. A legacy cursor is accepted only when its Run-bound `(created_at,id)` position maps to exactly one persisted history row; malformed, cross-Run and ambiguous positions fail closed. Historical approval rows remain readable across an old execution generation, while resolution continues to require the exact current Run, Session, generation and revision with durable CAS semantics. See ADR 0011 for the current projection/history rollout boundary.

The HostGateway and CodexAdapter interfaces expose separate new-session and active-session methods. The new path starts one pinned, host-owned app-server generation. The active path is attempted only when a verified endpoint and active thread reference are supplied; the current Desktop boundary returns `unsupported_path`/`ErrUnsupportedSessionPath` and never falls back to creating a new session. RunController owns command deduplication, ACK persistence, reconciliation and cursor reads. ArtifactStore owns authorized original bytes and metadata without creating a standalone product artifact surface.

REST and MCP describe the same minimum capabilities: authorized project/task reads and writes, explicit session start/attach, run submission, approval history reads and exact approval resolution, interruption, ordered event reads and authorized artifact metadata. They are adapters over shared service contracts, not independent business implementations.

## Consequences

The contract is additive and versioned independently from runtime implementations, so the phase-one generated clients can be compiled and tested before Server and Connector handlers exist. Raw JSON payload fields are preserved at the boundary, while derived categories and display choices remain outside the durable public schema. Adding a new operation or enum value is a minor compatibility change; changing field meaning, command identity, ACK states or cursor semantics requires a successor contract/ADR and an explicit compatibility assessment.

Compatibility assessment for the foundation is `public_api=minor` because it adds versioned operations and types without changing existing field meanings. The initial E01 read slice was `public_api=minor` and `persistent_state=patch` under migration 00011. ADR 0011 supersedes that persistence assessment for same-ID revision completion: the public impact remains `minor`, while `persistent_state=minor` because migration 00012 adds durable history and older projection-only writers/readers are not compatible with newly written complete revision history.

R02 fixtures are accepted as codec evidence only: they prove envelope and unknown-payload round trips, not live Desktop attachment or product API acceptance. The current implementation still requires authenticated runtime handlers, durable business persistence and the owner-controlled product acceptance gates described by the phase-one specification.

## References

- [R01 Host Bridge decision](../research/codex-r01-host-bridge-decision.md)
- [R02 Codex fixtures](../research/codex-r02-content-fixtures.md)
- [Durable approval revision history and cursor compatibility](0011-durable-approval-revision-history.md)
- [Phase-one specification](../specs/phase1-core/SPEC.md)
