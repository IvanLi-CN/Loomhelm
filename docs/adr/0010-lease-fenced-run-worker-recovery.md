# ADR 0010: Lease-fenced run control and durable Worker recovery

## Context

Execution commands and runs are durable, but the current Server controller only has process-local active-command state and the current Gateway ACK path only resolves an in-memory pending request. A Server restart, a second controller, an expired lease or a late ACK can therefore make a command appear dispatchable without proving that the process still owns control, or can cause an old result to overwrite a newer control generation.

The existing `execution_control_leases` table already represents the required run-control authority and has a thirty-second lifetime. The existing platform Worker lease and its generation fence represent deployment ownership, not an individual run's control authority. The queue producer also already has a transaction-bound insert-only seam, while the Worker runtime can register real River workers. The missing boundary is their production composition and the durable fact path between them.

## Decision

Every process that can issue a run side effect has a unique control OwnerID and is bound to the exact candidate source SHA and artifact digest. A run control lease uses the existing `execution_control_leases` row, a stable run-derived LeaseKey, the persisted SessionID, RunID and Run generation, and a thirty-second TTL renewed at TTL/2. Command admission and lease reservation occur in the same database transaction. A command is never accepted as visibly dispatchable without the matching lease, and an empty process-local active map cannot authorize a disconnected command.

Lease authority and durable facts are separate. Losing a lease prevents new side effects, replay and old-generation state transitions, but it does not discard an exact late ACK. The ACK ingress persists the original command result through a dedicated exact-identity fact/CAS path keyed by the durable command ID, SessionID, RunID, generation and command payload digest. An equal duplicate is idempotent. A conflicting result, a mismatched identity or an attempt to affect a newer generation is rejected without overwriting the already persisted fact or the newer terminal state. This path is used by the existing Gateway ACK callback and does not add a WSS frame or public field.

The Server remains an authenticated durable ingress and an insert-only queue producer. Existing Gateway event handling and command ACK handling persist their facts atomically with the existing command, run and event stores. The Server does not start the queue consumer or acquire the deployment Worker lease. The Worker consumes only authenticated durable command, run and event facts through a bounded job cursor and uses a real Observer; absence of evidence produces unknown or retryable state, never an inferred not-found or completed result, and the Worker does not resend native commands.

The Worker composes a real RunWorker with the durable Observer and the existing `jobs.WorkerEnvironment.CheckLease` deployment fence. The application also passes `CheckLeaseTx`, which locks and validates the exact deployment lease row inside the same PostgreSQL transaction that applies the Run observation. Its run-control lease identity is separate from the jobs worker generation. Before applying an observation it checks both fences and the exact run generation. An old deployment Worker or old run-control owner cannot submit new state after fencing. Server and Worker restart recovery is exercised as independent processes with a generation handoff and a lease-held duplicate case.

This slice changes only internal composition and durable execution behavior. It adds no migration, public REST/MCP field, command kind, native frame or retry semantic. Existing approval and interrupt commands retain their exact run identity even though their Run.CommandID remains the original `run.send` command; control-command reconciliation must therefore validate kind-specific identity rather than require every command ID to equal Run.CommandID.

## Consequences

Server admission becomes transactionally coupled to run-control ownership, so a failed lease reservation rolls back the visible command/run admission and its queue insertion. A process restart can reacquire an expired run lease with a new OwnerID and candidate identity, while an active previous owner remains fenced until its lease expires. The thirty-second lease and half-TTL renewal add bounded database traffic and require lease loss to be handled as a control result rather than as permission to guess.

Late ACKs remain auditable after the in-memory pending request has gone away. The exact fact path may preserve a result for an older generation, but it cannot advance a new generation or change a conflicting terminal fact. Worker convergence depends on durable cursors and evidence, so database or cursor failures remain visible as unavailable or unknown instead of becoming a false terminal outcome.

The platform Worker lease continues to fence deployment generations and is not reused as a run generation. The existing schema and protocol compatibility classification remain unchanged for this slice; the behavioral contract is covered by focused store, controller, Gateway callback, Observer and independent restart tests.

## Verification

Focused tests cover lease-held duplicate admission, expiry and takeover, exact late ACK persistence, equal duplicate ACK idempotency, conflicting ACK and new-generation protection, control-command Run identity, bounded Observer evidence rules and deployment/run lease fencing. A VM-backed process test starts Server and Worker independently, restarts the Server, hands the deployment Worker generation to a replacement and verifies that the old process cannot submit new state.

## References

- [Control plane and host execution](0001-control-plane-and-host-execution.md)
- [Immutable candidates and state-compatible blue-green](0002-immutable-candidates-and-blue-green.md)
- [Public protocol and reconciliation](0003-public-protocol-and-reconciliation.md)
- [Durable execution identity correlation](0009-durable-execution-identity-correlation.md)
