# ADR 0004: Recoverable conversation file publication

## Context

Conversation file bytes live on a persistent filesystem volume while their identity, ownership association and metadata live in PostgreSQL. A filesystem operation and a database commit do not share one transaction. Publishing a final file before recording a durable intent can leave an untracked object after a crash. Deleting that file after a database timeout can instead destroy bytes whose metadata committed successfully. Process-local serialization does not protect blue and green Server instances sharing the same volume and database.

The existing original-file retention and restart requirements require a recovery protocol inside ArtifactStore. Application routing, principal authorization and Session/Run ownership resolution remain separate integration boundaries; their absence cannot be used to defer the storage recovery contract or to claim authenticated product acceptance.

## Decision

Use a recoverable publication state machine with durable PostgreSQL intent and immutable, verified file bytes. Internal publication state is not a new public Artifact field or a separate product workflow. The storage package owns publication, idempotent retry and reconciliation; application composition owns invoking recovery and supplying real authorization and ownership services.

1. Authorize the intended association, stream into a uniquely named private staging file, validate the complete size and SHA-256, and make the bytes and staging directory entry durable. Streaming must be cancellable and must not serialize unrelated files behind a package-wide write lock.
2. Persist a pending publication intent identifying the artifact, canonical immutable metadata, validated size/hash and the exact private staging object. Confirm or reconcile that commit before making a final object visible. An ambiguous commit is not a failed commit and does not authorize deleting a possibly referenced staging or final object.
3. Publish the verified final object without overwriting an existing object and sync the containing directory. Serialize publication and recovery for the same identity across processes using durable database coordination. A process-local mutex alone is insufficient. Do not hold a database coordination lock while receiving an unbounded input stream.
4. Mark the metadata ready only after final bytes are durable and verified. Return success only after readiness is confirmed. Ordinary metadata/download operations expose only ready publications and still enforce current association authorization. Download must reject missing, nonregular or mismatched bytes rather than reporting successful availability.

The artifact ID is the retry identity. Repeating the same authorized immutable metadata and content converges on the existing publication; a conflicting association, metadata or content cannot overwrite it. A server-assigned creation timestamp is retained on retry rather than regenerated into a false conflict. Authorization is checked before returning an existing object's metadata or bytes.

Reconciliation is bounded, cancellable and safe to repeat from another process after a crash. For a pending intent, verify the final object first; if it matches, finish readiness. Otherwise publish the matching recorded staging object and finish readiness. Missing or corrupt bytes remain explicitly unavailable and diagnosable; recovery must not invent content, mark them ready or silently replace conflicting bytes. Unknown database outcomes are resolved by reading durable intent/readiness using a fresh valid context before any destructive compensation. Cancellation must preserve recoverable state rather than run an unbounded request cleanup.

Staging files with no confirmed intent are inaccessible and cannot block unrelated uploads. They may be retained for diagnosis; this slice does not require an automatic garbage collector. Any cleanup must prove that the exact object is unreferenced, is not owned by an active writer or reconciler and has no ambiguous database outcome. Never infer that an object is disposable solely from an error or its age.

## Integration and compatibility

ArtifactStore supplies an explicit bounded recovery entry point and reports unresolved states without exposing host paths through public errors. Server composition must run recovery before admitting file publication/download and arrange repeated bounded reconciliation for incomplete work. The principal/project authorizer and Session/Run ownership resolver are mandatory, fail closed when absent, and remain supplied by their application domains. REST and MCP must call that same service; the package must not import an unfinished sibling domain or add a permissive production fallback.

The storage package is independently acceptable only with real PostgreSQL/filesystem crash and retry evidence. Authenticated Web/API/MCP operation, production route/configuration wiring and real session/run ownership remain required integration acceptance; package tests do not satisfy those gates.

No artifact schema has been integrated or deployed before this decision. The unpublished initial artifact migration may define pending/ready state and its recovery fields. Once a migration is integrated or deployed it is immutable; later changes use a new ordered migration. Record the file and database state compatibility range together, including mixed-process behavior and the limits of switchback. Application rollback does not delete objects or reverse state migrations. This decision adds no public wire field and does not require a new queue, external storage service or distributed transaction coordinator.

## Verification

Use real PostgreSQL and the persistent file layout in the task's session-owned VM. Exercise process interruption after staged-file durability, intent admission, final-object publication and readiness commit, including a committed database operation whose response is lost. Recreate the Store in a new process, reconcile repeatedly and compare the original bytes and association. A failure injected through a returned error alone does not establish process-crash recovery.

Exercise concurrent same-ID writers and a reconciler from separate processes, identical retry, conflicting content/association, cancelled input, unavailable database, missing/corrupt files and denied authorization. Verify that ambiguous failures never delete confirmed or potentially committed bytes, incomplete objects are not exposed, unrelated uploads continue and recovery does not duplicate metadata or overwrite another publication.

## Consequences

This retains PostgreSQL plus a local persistent file volume and makes their non-atomic boundary explicit. Pending work can temporarily consume disk until recovery or deliberate cleanup; that is preferable to destroying potentially committed bytes. Recovery and publication state add implementation work within the original storage responsibility. They do not create a separate task, change product permissions or waive the later authenticated integration and complete-product blue-green observations.
