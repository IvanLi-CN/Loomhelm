---
status: accepted
supersedes: 0004-recoverable-conversation-file-publication.md
---

# ADR 0005: Bounded file publication and content input

## Context

Original conversation files use a persistent local filesystem volume for bytes and PostgreSQL for identity, association and publication state. These stores have no atomic shared commit. [ADR 0004](0004-recoverable-conversation-file-publication.md) established durable intent, immutable verified bytes and reconciliation. Its retry and cancellation statements leave two unresolved cases: a recorded staging object can disappear before readiness, and an arbitrary `io.Reader` can block inside `Read` after context cancellation. Content classification also needs aggregate bounds without confusing sanitized repository fixtures with lossless runtime data.

This decision supersedes ADR 0004, preserves its durability and authorization requirements, and fixes these implementation contracts within the existing conversation-file responsibility. It adds no product page, permission, public wire field or background orchestration service.

## Publication and retry

Authorize the intended association before admitting input or exposing an existing publication. Stream into a unique private staging file; validate size and SHA-256 and sync the file and directory. Commit and confirm a pending intent before publishing final bytes without overwrite, sync the containing directory, and confirm readiness before returning success. Canonical immutable metadata and the server-assigned creation time remain stable across retries. PostgreSQL timestamp precision must not create false metadata conflicts.

Use database-backed per-identity coordination across all participating processes. Never hold that coordination while receiving input or serialize unrelated files behind a package-wide write lock. A concurrent writer or reconciler that has already reached the same verified ready publication is a successful converged result. Different content, association or immutable metadata remains a conflict.

| Durable state | Read and recovery behavior | Identical authorized Put |
| - | - | - |
| Pending | Prefer a matching final object; otherwise publish matching recorded staging bytes and confirm ready. Record unavailable when the recorded bytes are missing or corrupt. | Converge through the same per-identity coordination. |
| Ready | Metadata and download verify final bytes before reporting availability. Missing, nonregular or mismatched bytes become unavailable. | Return the same verified publication; never overwrite an existing final object. |
| Unavailable because a never-ready staging object was missing or corrupt | Remain unavailable until an explicit retry supplies verified original bytes; background recovery must not invent content. | May return to pending only under the repair conditions below. |
| Other unavailable state, unknown reason or conflicting final object | Remain unavailable and diagnosable. | Return an explicit unavailable or conflict result; no replacement or resurrection. |

The narrow unavailable-to-pending repair requires all of: a reason proving pre-readiness staging loss or corruption; current authorization; identical canonical identity, association and metadata; newly staged bytes matching the recorded size and SHA-256; and no final object when checked under the same database coordination. Persist and confirm the replacement staging reference and pending state before publication. If a matching final object appeared through a cooperating process, reconcile it instead; an existing mismatching or nonregular final object is never removed or overwritten. A record that was already ready does not use this repair path. This is an explicit caller retry through Put, not automatic repair from guessed or substituted bytes.

Resolve ambiguous database outcomes by reading durable intent/readiness with a fresh bounded context. An error, age or cancellation never proves that staged or final bytes are disposable. Cleanup may remove only the exact caller-owned staging object after proving it unreferenced, inactive and free of an ambiguous database outcome. Unconfirmed staging may be retained for diagnosis and cannot block unrelated uploads. Background recovery is bounded, cancellable and safe to repeat from another process. Public errors do not contain host paths or raw content.

## Input and cancellation

Keep the existing `ArtifactStore.Put(context.Context, Artifact, io.Reader)` Go method and all REST/MCP types. Its source contract requires an `io.ReadCloser` whose Close may run concurrently with Read, returns promptly and unblocks a pending Read. Put validates this capability before staging, owns the admitted source and closes it exactly once on completion or cancellation. A no-op closer is valid only for a known finite nonblocking in-memory source; it cannot make an arbitrary blocking reader cancellable. Callers supply adapters that satisfy this contract rather than passing unchecked arbitrary readers.

After cancellation, Put has a five-second total cleanup budget, must preserve any recoverable intent/bytes and must leave no blocked copy goroutine. Admission, cancellation and cleanup do not acquire a package-wide input lock. Transaction rollback, lock release, source-close coordination and diagnostic database probes share that bounded budget; `context.Background()` without a deadline is not a cleanup policy. The implementation must distinguish an unsupported input from a storage failure and must not claim success after cancellation interrupted publication.

## Filesystem trust and supported storage

Production file storage targets a dedicated local Linux filesystem root owned by the Server service identity, mode 0700. macOS development checks do not establish Windows storage support. The deployment administrator protects the root and its parent directories from untrusted writers; the storage volume is not an Agent workspace or a user-selected remote filesystem. Blue and green Server processes may share that service identity and volume and must cooperate through the publication protocol.

Project members, user-provided paths and HTTP/MCP inputs remain untrusted. Validate identifiers, enforce source scope, reject traversal and final symlinks/nonregular files, verify size/hash, preserve current authorization and never overwrite final objects. A hostile process already controlling the Server service identity and mutating its configured private storage root is outside this application's filesystem isolation guarantee. This assumption does not waive cross-process correctness, permit symlink traversal from public input or imply isolation between mutually hostile processes under the same service identity. Directory-FD isolation and Windows storage support are separate future choices.

## Lossless bounded content

The content module is a non-executing lossless codec. Decode/encode retains original envelopes, unknown fields and payloads for authorized runtime data. Fixture admission sanitizes repository examples; its sensitive-key and private-path rules are not an implicit runtime redaction algorithm. Authentication and scope checks surround runtime ingestion/access, and logs/public errors must not dump raw envelopes, credentials or private paths. Presentation treats content as untrusted data and provides a non-executing fallback.

Retain the 4 MiB default and maximum record budget. A JSONL batch is limited to 64 MiB of consumed input, including whitespace and separators, and 10,000 decoded records. Validate configured per-record limits before allocation and reject values outside 1 byte through 4 MiB. Single-record Decode/Encode must also enforce the record budget. Exceeding a record, byte or count bound returns ErrTooLarge with no successful truncated result; bounds and sequence checks do not rewrite accepted bytes.

The existing ParseJSONL entry point is restricted to finite nonblocking fixture/in-memory input. Runtime streams use an additional internal ParseJSONLContext entry point accepting a context and a cancellable `io.ReadCloser`, with the same close/unblock contract and batch bounds. A synchronous legacy parser cannot promise cancellation of an arbitrary blocking source. No REST/MCP schema change is required for this internal adapter.

## Integration and compatibility

ArtifactStore owns bounded publication, retry and recovery. Application composition supplies real principal/project authorization, Session/Run ownership and cancellable input adapters, invokes a bounded recovery pass before file admission, and arranges subsequent bounded reconciliation. Missing authorization or ownership resolution fails closed. REST and MCP reuse these same operations. A package test does not establish authenticated application acceptance.

Public wire compatibility remains patch: no REST/MCP operation, field, permission or identity changes. The internal Go source precondition is tightened while its method type is retained; callers must be checked and adapted before integration. Persistent-state impact is minor because repair adds a state transition. No artifact migration has been integrated or deployed; the unpublished migration and its compatibility record must describe every transition, reason and stopped-release recovery case. Integrated or deployed migrations remain immutable, with later changes handled by a new ordered migration. Mixed-process compatibility and switchback eligibility require evidence for the file layout and state machine together; rollback neither deletes bytes nor reverses migrations.

## Verification

Use real PostgreSQL and the persistent filesystem in a session-owned VM. Kill separate processes after staging durability, intent admission, final publication, readiness commit and repair-intent admission, including committed operations with lost responses. Reopen and reconcile in new processes, compare original bytes/associations and exercise separate-process same-ID writers and reconcilers. Confirm identical retries, exact staging-loss repair, conflicting final/content/association rejection, ready byte revalidation, timestamp precision and preserved ambiguous outcomes.

Cancel a source while Read is blocked and assert prompt completion, close/unblock behavior, no lingering copy goroutine and no stalled unrelated upload. Reject unsupported inputs before staging and cover cleanup deadlines, limit boundaries, repeated recovery, denied/revoked authorization and path-safe failures. Content tests cover total byte/count/record boundaries, whitespace, cancellation during a blocked read, raw/unknown-field round trips and fixture-only sanitizer behavior without recording real secrets.
