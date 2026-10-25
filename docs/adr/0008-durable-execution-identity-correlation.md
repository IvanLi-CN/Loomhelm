# ADR 0008: Durable execution identity correlation

## Context

Loomhelm has two independent identity domains: the platform owns Session and Run identities, while the Connector owns adapter session, app-server thread, native turn and native JSON-RPC operation identities. Existing journal records persist each domain's facts, but do not provide a durable, exact relationship between them. Treating an adapter session as a platform session, copying a native turn into `Event.RunID`, or selecting the only active turn would make ACK loss, restart recovery, reused native IDs and approval or interrupt control unsafe.

The Connector also receives observations before a response ACK is available. A raw event can therefore be durable before its platform Run is known. Dropping that event loses evidence, while exposing it with an inferred Run can deliver it to the wrong platform command. The journal must preserve the observation and delay public materialization until exact evidence exists.

## Decision

Add a private Journal identity interface with three durable record families: `session_alias`, `run_binding` and `observed_event`. A `SessionAlias` explicitly binds `PlatformSessionID` to `AdapterSessionID`, `ExternalThreadRef`, `Generation` and the authorized creation `CommandID`. A `RunBinding` explicitly binds `PlatformSessionID` and `PlatformRunID` to `CommandID`, `AdapterSessionID`, `ExternalThreadRef`, `Generation`, `NativeTurnID` and optional `NativeOperationID`.

The Journal indexes adapter facts only with complete tuples. Session lookup uses `(adapter_session_id, external_thread_ref, generation)`; native turn and operation lookups use the same tuple plus the native identity; command lookup and platform lookup remain separate indexes. Conflicting relationships are rejected. Repeating the same relationship is idempotent. A pending or unknown RunBinding can advance only when the new record supplies compatible exact evidence; it cannot regress or replace an existing native identity.

`observed_event` persists the complete raw `protocol.Event` payload together with `EventObservation`. The identity-safe `ReadMappedEvents` and `MappedEvent` seams return no event while the observation lacks an exact SessionAlias or required RunBinding. Once bound, they materialize platform session and run IDs while retaining the original payload and event cursor. They never consult `activeTurn`, event proximity, a sole candidate, or an unqualified native ID.

The existing `event` and `ReadEvents` records remain available for raw compatibility and recovery. Future adapter event delivery must use the identity-safe materialization seam; this slice does not change Server wiring, public transport schemas, command kinds, approval handlers or Adapter initial-prompt behavior.

The journal advances from format v2 to format v3. The v3 reader accepts v1, v2 and v3 records; new records are v3. It appends identity records and never rewrites, compacts or deletes prior records. A v1 or v2 binary is not a supported reader for a journal after v3 records are appended and must fail closed on the explicit format version. Legacy session and session-start records remain recoverable only from their own facts. They have no platform session or caller command identity and cannot satisfy a new creation request or be used to invent one.

Journal startup replays identity records into exact indexes. Equal duplicate records are idempotent. Conflicting duplicate records, an orphan RunBinding without its SessionAlias, a mismatched thread or generation, malformed identity data and unknown format versions fail closed as journal corruption. A final incomplete JSONL record remains the only truncatable record; no historical identity is discarded.

The journal stores only opaque identifiers, timestamps, state and raw protocol payloads. Codex credentials, access tokens and process secrets are excluded from all identity records.

## Consequences

The next creation assembly can authorize the caller and validate project/task facts before checking any prior result, select the single configured host through the existing private host service seam, persist the creation intent, and then record the explicit SessionAlias after `session.start` resolves. `existing_active` remains an admission-time unsupported path with no fallback.

The next run assembly can persist a RunBinding before or while waiting for the native ACK, record a native operation identity when available, advance it with the exact native turn, and then use `ReadMappedEvents` for delivery. Unknown ACKs remain unknown until a reconciler records exact evidence. A future approval or interrupt path can reverse-lookup by the complete generation-qualified native identity without selecting an active or nearest turn.

This ADR does not introduce a public schema field, a new command kind, a PostgreSQL migration, a new reconciliation frame or a long-lived Worker loop. The Server remains responsible for public admission and command identity, the Connector remains responsible for local journal and app-server observation, and Worker remains a bounded short-job dispatcher or reconciler.

The persistent-state compatibility impact is minor: the candidate reads the immediately preceding v1/v2 state, writes v3 state that older binaries do not read, and provides no direct major skip. The public protocol impact of this slice is patch because public schemas and command kinds are unchanged; the separate session-creation `command_id` requirement remains governed by ADR 0007.

## Verification

Focused journal tests verify v1/v2 read and v3 write compatibility, append-only history, explicit alias and binding indexes, idempotent duplicates, conflicting associations, pending and unknown non-delivery, exact native turn and operation reverse lookup, event-before-binding materialization, restart recovery, orphan binding rejection and raw payload preservation.

## References

- [Public protocol and reconciliation](0003-public-protocol-and-reconciliation.md)
- [Explicit session creation identity](0007-explicit-session-creation-identity.md)
- [Connector journal](../development/connector/journal.md)
- [Phase-one specification](../specs/phase1-core/SPEC.md)
