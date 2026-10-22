# Connector Journal

The Connector journal is a host-local, append-only JSONL file owned by one Connector process at a time; it is not a PostgreSQL migration and it is not a public pairing or WebSocket protocol.

The journal is created with a mode 0700 parent directory and mode 0600 file permissions, and each record carries an explicit format version so a reader can reject an incompatible state instead of guessing.

## Records

`command` records contain the complete versioned `protocol.Command`, a canonical payload digest, and the first durable ACK state; `command_update` records contain the latest ACK state, result, operation identity, run identity and API error.

`event` records contain the generated `protocol.Event` and preserve the complete app-server JSON-RPC object in `event.payload`, including fields unknown to the current adapter.

For journaled RPC responses, the raw app-server event is followed by a host-observation correlation event containing the Gateway generation, method and generation-qualified operation identity. Unknown ACKs use that identity so reused JSON-RPC IDs from different process generations cannot be misattributed; older records without a correlation event fall back only when the raw ID is unique.

session records contain only the Loomhelm session ID, opaque external thread reference, host generation and update time; credentials, access tokens and Desktop process state are not journal data.

session_start records contain the host generation intent, explicit creation command_id, payload digest and pending/resolved/failed state. The digest covers project_id, task_id and prompt; the caller identity is stored separately so equal prompts do not collapse distinct sessions.

reconciliation records contain the command ID, observed state, optional event cursor and a note explaining why an outcome was confirmed, not found or left unknown.

## Compatibility

The current Connector writes format version 2 and reads both version 1 and version 2 records. Version 1 session-start records have no caller identity; they remain readable for session and command recovery but are never matched to a new creation request. A version 2 request requires a nonempty creation command_id, and the same identity with a different payload is an idempotency conflict.

The reader rejects unknown format versions and does not reinterpret an existing record as a newer record type. A v1 binary must not be treated as able to read a journal after v2 records are appended; upgrading is a forward-only compatibility boundary, not a mixed-version safe-write claim.

Forward-compatible additions preserve the append-only record order and retain unknown JSON fields; a structural format change requires a new reader or forward-repair release rather than an in-place rewrite or automatic rollback.

The only startup repair performed by the current reader is truncating a final incomplete JSONL record and appending an `unknown` command update for commands left in `accepted` or `executing` state. A malformed terminated record is corruption and stops startup.

## Reconciliation

An ACK loss, context timeout, partial transport write or process restart makes the command outcome `unknown` when the side effect may have been delivered. A duplicate command ID returns the durable result without sending another app-server request; the same ID with a different canonical payload returns `idempotency_conflict`.

Explicit reconciliation reads the known host-owned thread history and records a command as confirmed only when a unique matching turn or persisted operation identity is observed. A missing, ambiguous or unavailable observation remains unknown or not found and is never replayed automatically; an operator or higher-level controller must issue a new command ID after making that decision.

Cold `thread/resume` recovery is a new host-owned app-server generation. It is recorded as reconciliation and is not treated as attachment to the currently running ChatGPT Desktop process. When the Gateway has already completed that resume, the Adapter binds the recovered transport without issuing a second `thread/resume` request.

## Validation

The focused Connector tests cover explicit session identities, v1 read/v2 write compatibility, legacy identity isolation, large-number command digests, journal-path symlink rejection, duplicate IDs, conflicting payloads, incomplete final writes, restart conversion to unknown, ordered event cursors, pending approval rebuild, partial transport writes, JSONL request/response flow, ACK-loss reconciliation, approval decisions, steer, interrupt and unsupported active-session attachment.

The real acceptance surface remains a disposable host-owned app-server session using the exact installed CLI identity from R01; Desktop hot attachment, production WSS pairing and owner-bound Desktop callbacks remain outside this implementation.
